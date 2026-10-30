import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { PeopleService } from '../src/people';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID as ADM, IT_TEAM_ID as IT, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('People integration tests require a database name ending _test');
const tag = `people-${randomUUID()}`;
const request = (actor: any) =>
  ({
    user: actor,
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('assignable people PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, people: PeopleService;
  let superAdmin: any, itMember: any, admMember: any, asset: any;
  const person = async (
    state: string,
    extra: { name?: string; code?: string; left?: boolean; merged?: boolean; unaccepted?: boolean } = {},
  ) => {
    const userId = randomUUID();
    await db.query(
      `INSERT INTO users(id,email,display_name,state,employee_code,left_at,email_verified_at,portal_accepted_at,portal_notice_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'1')`,
      [
        userId,
        `${tag}-${userId}@example.org`,
        extra.name ?? `${tag} person`,
        state,
        extra.code ?? null,
        extra.left ? new Date() : null,
        state === 'ACTIVE' ? new Date() : null,
        state === 'ACTIVE' && !extra.unaccepted ? new Date() : null,
      ],
    );
    await db.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'EMPLOYEE')", [userId]);
    if (extra.merged)
      await db.query('UPDATE users SET merged_into_user_id=$2 WHERE id=$1', [userId, superAdmin.id]);
    return userId;
  };
  const make = async (roles: string[]) => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-actor-${randomUUID()}@example.org`,
      displayName: 'Synthetic people test',
      roles,
      teams: [],
      state: 'ACTIVE',
      version: 1,
      portalAcceptedAt: new Date().toISOString(),
      emailVerifiedAt: new Date().toISOString(),
      mfaEnrolled: true,
      mfaVerifiedAt: new Date().toISOString(),
      sessionScope: 'APP',
      sessionHash: 'test-only',
    };
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [user.id, user.email, `${tag} actor`],
    );
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    return user;
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    people = new PeopleService(db);
    for (const [kind, code] of [
      ['CATEGORY', 'People Category'],
      ['ASSET_TYPE', 'People Type'],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    superAdmin = await make(['SUPER_ADMIN']);
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT);
    admMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', ADM);
    asset = await domain.createAsset(request(superAdmin), {
      category: 'People Category',
      assetType: 'People Type',
      description: `${tag} device`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      owningTeamId: IT,
    });
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('team custody holder sees eligible directory and active people only', async () => {
    const directory = await person('DIRECTORY', { name: `${tag} Directory`, code: 'ZX-1' });
    const active = await person('ACTIVE', { name: `${tag} Active` });
    const left = await person('DIRECTORY', { name: `${tag} Left`, left: true });
    const merged = await person('DIRECTORY', { name: `${tag} Merged`, merged: true });
    const disabled = await person('DISABLED', { name: `${tag} Disabled` });
    const pending = await person('ACTIVE', { name: `${tag} Pending`, unaccepted: true });
    const result = await people.assignable(request(itMember), asset.id, { q: tag });
    const ids = result.items.map((p: any) => p.id);
    assert.ok(ids.includes(directory));
    assert.ok(ids.includes(active));
    for (const excluded of [left, merged, disabled, pending]) assert.ok(!ids.includes(excluded));
    const row = result.items.find((p: any) => p.id === directory);
    assert.equal(row.state, 'DIRECTORY');
    assert.equal(row.employeeCode, 'ZX-1');
    assert.equal(row.hasPhoto, false);
    for (const key of ['displayName', 'email', 'designation', 'department']) assert.ok(key in row);
  });

  it('searches by name, email and employee code', async () => {
    const userId = await person('DIRECTORY', {
      name: `${tag} Searchable Zebra`,
      code: `EC-${tag.slice(-6)}`,
    });
    for (const q of ['searchable zebra', `${tag}-${userId}`, `ec-${tag.slice(-6)}`]) {
      const r = await people.assignable(request(itMember), asset.id, { q });
      assert.ok(
        r.items.some((p: any) => p.id === userId),
        `query ${q}`,
      );
    }
    const none = await people.assignable(request(itMember), asset.id, { q: 'nobody-matches-xyz' });
    assert.equal(none.items.length, 0);
  });

  it('paginates with a cursor, 25 per page', async () => {
    for (let i = 0; i < 27; i++)
      await person('DIRECTORY', { name: `${tag} Page ${String(i).padStart(2, '0')}` });
    const first = await people.assignable(request(itMember), asset.id, { q: `${tag} Page` });
    assert.equal(first.items.length, 25);
    assert.ok(first.nextCursor);
    const second = await people.assignable(request(itMember), asset.id, {
      q: `${tag} Page`,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 2);
    assert.equal(second.nextCursor, null);
    const all = new Set([...first.items, ...second.items].map((p: any) => p.id));
    assert.equal(all.size, 27);
    await assert.rejects(people.assignable(request(itMember), asset.id, { cursor: 'bad' }), status(400));
  });

  it('a member of another team is forbidden; unknown asset is 404', async () => {
    await assert.rejects(people.assignable(request(admMember), asset.id, {}), status(403));
    await assert.rejects(people.assignable(request(itMember), randomUUID(), {}), status(404));
  });
});
