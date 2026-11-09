import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { Db } from '../src/db';
import { RoleFieldService } from '../src/role-field';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Roles migration test requires isolated _test DB');
process.env.DATABASE_URL = url;
const db = new Db();
after(async () => db.onModuleDestroy());
const IT = '00000000-0000-4000-8000-000000000001';
const ADM = '00000000-0000-4000-8000-000000000002';
class Rollback extends Error {}
// Runs fn in a transaction that is always rolled back so tests leave no state behind.
async function scratch(fn: (c: PoolClient) => Promise<void>) {
  await assert.rejects(
    db.tx(async (c) => {
      await fn(c);
      throw new Rollback('rollback');
    }),
    (e) => e instanceof Rollback,
  );
}
async function insertAsset(c: PoolClient, code: string, teamId?: string) {
  const cols = teamId ? ',owning_team_id' : '';
  const vals = teamId ? ',$2' : '';
  await c.query(
    `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level${cols}) VALUES($1,'Hardware','Laptop','Synthetic','Owned','Active','Good','Low'${vals})`,
    teamId ? [code, teamId] : [code],
  );
}
test('seeds three teams with fixed ids and prefixes', async () => {
  const rows = await db.query(
    "SELECT code, asset_code_prefix FROM teams WHERE code IN ('IT','ADM','PRJ') ORDER BY code",
  );
  assert.deepEqual(rows, [
    { code: 'ADM', asset_code_prefix: 'ADM' },
    { code: 'IT', asset_code_prefix: 'IT' },
    { code: 'PRJ', asset_code_prefix: 'PRJ' },
  ]);
});
test('rejects asset whose code prefix does not match its team', async () => {
  await scratch(async (c) => {
    await assert.rejects(insertAsset(c, 'IAC-ADM-000001'), (e: any) => e.code === '23514');
  });
});
test('allows a 3-letter prefix for its own team', async () => {
  await scratch(async (c) => {
    // Other suites create real ADM assets, so take the next unused number.
    const [{ code }] = (
      await c.query(
        "SELECT 'IAC-ADM-'||lpad((coalesce(max(substr(asset_code,9)::int),0)+1)::text,6,'0') AS code FROM assets WHERE asset_code LIKE 'IAC-ADM-%'",
      )
    ).rows;
    await insertAsset(c, code, ADM);
  });
});
test('refuses prefix change once used', async () => {
  await scratch(async (c) => {
    const n = String((await c.query("SELECT nextval('asset_number_seq') n")).rows[0].n).padStart(
      6,
      '0',
    );
    await insertAsset(c, `IAC-IT-${n}`);
    await assert.rejects(
      c.query("UPDATE teams SET asset_code_prefix='ITX' WHERE code='IT'"),
      (e: any) => e.code === '23514',
    );
  });
});
test('blocks legacy role grants', async () => {
  await scratch(async (c) => {
    const [{ id }] = (
      await c.query("INSERT INTO users(email,display_name) VALUES($1,'Legacy') RETURNING id", [
        `legacy-${randomUUID()}@example.test`,
      ])
    ).rows;
    await assert.rejects(
      c.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'IT_ADMIN')", [id]),
      (e: any) => e.code === '23514',
    );
  });
});
test('IT counter initialisation avoids collisions with sequence and existing codes', async () => {
  const init = async (c: PoolClient, last: number, called: boolean) =>
    BigInt((await c.query('SELECT it_counter_initial_value($1,$2) v', [last, called])).rows[0].v);
  await scratch(async (c) => {
    // Work above whatever IT codes the shared test DB already holds (the asset sequence
    // never rolls back, so earlier runs such as the scale probe can leave high numbers).
    const [{ max }] = (
      await c.query(
        "SELECT coalesce(max(substring(asset_code from 8)::int),0)::int AS max FROM assets WHERE asset_code ~ '^IAC-IT-[0-9]{6}$'",
      )
    ).rows;
    const base = BigInt(max);
    const seq = Number(base) + 100;
    // Sequence branch: is_called=true gives last_value+1; is_called=false gives 1.
    assert.ok((await init(c, seq, true)) >= BigInt(seq) + 1n);
    assert.ok((await init(c, seq, false)) < BigInt(seq));
    // Max-existing-code branch: a higher IT asset must push the result past it.
    const code = base + 200n;
    await insertAsset(c, `IAC-IT-${String(code).padStart(6, '0')}`);
    assert.equal(await init(c, 5, true), code + 1n);
    assert.equal(await init(c, 1, false), code + 1n);
    // Both branches: sequence higher than any code wins and stays strictly greater.
    const high = await init(c, Number(base) + 300, true);
    assert.equal(high, base + 301n);
    assert.ok(high > code);
  });
});
test('Printer and Networking are room-held', async () => {
  const rows = await db.query(
    "SELECT asset_type_code, requires_custodian FROM asset_type_policies WHERE asset_type_code IN ('Printer','Networking') ORDER BY asset_type_code",
  );
  assert.deepEqual(rows, [
    { asset_type_code: 'Networking', requires_custodian: false },
    { asset_type_code: 'Printer', requires_custodian: false },
  ]);
});
test('runtime role can use new tables', async () => {
  const grants = await readFile(resolve(__dirname, '../../../infra/runtime-grants.sql'), 'utf8');
  await scratch(async (c) => {
    await c.query(grants);
    const [{ id }] = (
      await c.query("INSERT INTO users(email,display_name) VALUES($1,'Member') RETURNING id", [
        `member-${randomUUID()}@example.test`,
      ])
    ).rows;
    await c.query('SET LOCAL ROLE iac_runtime');
    await c.query('UPDATE team_asset_counters SET next_value=next_value+1 WHERE team_id=$1', [IT]);
    await c.query("INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,'MEMBER')", [
      id,
      IT,
    ]);
  });
});
test('convert_legacy_roles converts ADMIN and IT_ADMIN grants and audits each user', async () => {
  await scratch(async (c) => {
    const mk = async (label: string) =>
      (
        await c.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [
          `${label}-${randomUUID()}@example.test`,
          label,
        ])
      ).rows[0].id as string;
    const admin = await mk('legacy-admin');
    const itAdmin = await mk('legacy-itadmin');
    // Recreate the pre-migration state: legacy codes must exist in `roles` and the
    // guards that now reject them must be absent, or the legacy grants cannot be stored.
    await c.query('ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_valid');
    await c.query("INSERT INTO roles(code) VALUES ('ADMIN'),('IT_ADMIN') ON CONFLICT DO NOTHING");
    await c.query('ALTER TABLE user_roles DROP CONSTRAINT user_roles_no_legacy');
    await c.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'ADMIN'),($2,'IT_ADMIN')", [
      admin,
      itAdmin,
    ]);
    await c.query('SELECT convert_legacy_roles()');
    const roles = async (id: string) =>
      (
        await c.query('SELECT role_code FROM user_roles WHERE user_id=$1 ORDER BY role_code', [id])
      ).rows.map((r) => r.role_code);
    assert.deepEqual(await roles(admin), ['SUPER_ADMIN']);
    assert.deepEqual(await roles(itAdmin), ['EMPLOYEE']);
    const teams = async (id: string) =>
      (await c.query('SELECT team_id, level FROM team_memberships WHERE user_id=$1', [id])).rows;
    assert.deepEqual(await teams(admin), []);
    assert.deepEqual(await teams(itAdmin), [{ team_id: IT, level: 'MEMBER' }]);
    const audit = async (id: string) =>
      (
        await c.query(
          "SELECT actor_kind, changes FROM audit_events WHERE entity_type='user' AND entity_id=$1 AND action='ROLE_MODEL_MIGRATED'",
          [id],
        )
      ).rows;
    assert.deepEqual(await audit(admin), [
      { actor_kind: 'SYSTEM', changes: { from: ['ADMIN'], to: ['SUPER_ADMIN'] } },
    ]);
    assert.deepEqual(await audit(itAdmin), [
      { actor_kind: 'SYSTEM', changes: { from: ['IT_ADMIN'], to: ['EMPLOYEE', 'IT:MEMBER'] } },
    ]);
    // Idempotent: a second run changes and audits nothing further.
    await c.query('SELECT convert_legacy_roles()');
    assert.equal((await audit(admin)).length, 1);
    assert.equal((await audit(itAdmin)).length, 1);
    assert.deepEqual(await roles(itAdmin), ['EMPLOYEE']);
  });
});
test('field permission rows keep their camelCase names for the admin page', async () => {
  const service = new RoleFieldService(db);
  const actor = { roles: ['SUPER_ADMIN'], teams: [] } as any;
  await scratch(async (c) => {
    await c.query(
      `INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit)
       VALUES('EMPLOYEE','description',true,true)
       ON CONFLICT (role_code, field_name) DO UPDATE SET can_view=true, can_edit=true`,
    );
    const result = await service.allFields({ user: actor } as any);
    const group = result.permissions.find((permission) => permission.roleCode === 'EMPLOYEE');
    assert.ok(group, 'the employee role must be returned');
    const field = group.fields.find((item: any) => item.fieldName === 'description');
    assert.ok(field, 'the description field must be returned');
    assert.equal(field.roleCode, 'EMPLOYEE');
    assert.equal(field.fieldName, 'description');
    assert.equal(field.canView, true);
    assert.equal(field.canEdit, true);
  });
});
