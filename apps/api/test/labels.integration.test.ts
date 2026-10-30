import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { configuration, hash, signedCsrf, token } from '../src/config';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Labels integration requires a database name ending _test');
const tag = `labels-${randomUUID()}`;
describe('labels API integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, holder: any, itAdmin: any;
  let a1: any, a2: any, a3: any;
  const serial = `SN-${tag}`;
  const barcode = `BC-${tag}`;
  const req = (user: any, currentVersion?: number) =>
    ({
      user,
      get: (name: string) =>
        name.toLowerCase() === 'if-match'
          ? currentVersion === undefined
            ? undefined
            : `"${currentVersion}"`
          : name.toLowerCase() === 'idempotency-key'
            ? randomUUID()
            : undefined,
    }) as AuthRequest;
  const headers = (user: any) => ({
    Origin: configuration().origin,
    ...(user
      ? {
          Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
          'X-CSRF-Token': user.csrf,
        }
      : {}),
  });
  const get = async (user: any, path: string) => {
    const response = await fetch(`${base}${path}`, { headers: headers(user) });
    return { status: response.status, body: await response.json() };
  };
  const post = async (user: any, body: unknown) => {
    const response = await fetch(`${base}/asset-labels/prints`, {
      method: 'POST',
      headers: {
        ...headers(user),
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const printRows = async (...ids: string[]) =>
    db.query('SELECT 1 FROM asset_label_prints WHERE asset_id=ANY($1::uuid[])', [ids]);

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[], displayName: string) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName,
        roles,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [result.id, result.email, result.displayName, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [
          result.id,
          role,
        ]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(result.session), result.id, hash(result.csrf)],
      );
      return result;
    };
    admin = await user(['SUPER_ADMIN'], `${tag} Admin`);
    holder = await user(['EMPLOYEE'], `${tag} Holder Person`);
    itAdmin = await user(['EMPLOYEE'], `${tag} IT Person`);
    await joinTeam(db, itAdmin, 'MEMBER', ADM_TEAM_ID);
    const references = {
      CATEGORY: `${tag} category`,
      ASSET_TYPE: `${tag} type`,
      OWNERSHIP: `${tag} ownership`,
      CONDITION: `${tag} condition`,
      RISK: `${tag} risk`,
    };
    for (const [kind, code] of Object.entries(references))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
    const [department] = await db.query(
      'INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id',
      [`${tag}-dept`],
    );
    const [location] = await db.query(
      'INSERT INTO locations(code,site,floor,room) VALUES($1,$2,$3,$4) RETURNING id',
      [`${tag}-loc`, `${tag} site`, '2', '204'],
    );
    const create = (extra: Record<string, unknown> = {}) =>
      domain.createAsset(req(admin), {
        category: references.CATEGORY,
        assetType: references.ASSET_TYPE,
        description: `${tag} synthetic laptop`,
        manufacturer: 'Acme',
        model: 'X1',
        serialNumber: serial,
        barcode,
        ownershipType: references.OWNERSHIP,
        departmentId: department.id,
        locationId: location.id,
        status: 'In Store',
        condition: references.CONDITION,
        riskLevel: references.RISK,
        amcApplies: false,
        ...extra,
      });
    a1 = await create();
    a2 = await create();
    a3 = await create();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('admin records a print run', async () => {
    const result = await post(admin, { assetIds: [a1.id, a2.id], layout: 'A4_40' });
    assert.equal(result.status, 201);
    assert.equal(result.body.recorded, 2);
    assert.ok(result.body.printedAt);
    assert.equal((await printRows(a1.id, a2.id)).length, 2);
    const list = await get(admin, `/assets?q=${encodeURIComponent(tag)}&limit=100`);
    const byId = new Map(list.body.items.map((x: any) => [x.id, x]));
    for (const a of [a1, a2]) assert.ok((byId.get(a.id) as any).lastLabelPrintedAt);
    assert.equal((byId.get(a3.id) as any).lastLabelPrintedAt, null);
    const [audit] = await db.query(
      "SELECT changes FROM audit_events WHERE action='LABELS_PRINTED' AND actor_id=$1 AND entity_type='asset_labels' AND entity_id IS NULL",
      [admin.id],
    );
    assert.equal(audit.changes.count, 2);
    assert.equal(audit.changes.layout, 'A4_40');
    assert.deepEqual([...audit.changes.assetIds].sort(), [a1.id, a2.id].sort());
  });

  it('labelPrinted=no filter', async () => {
    const list = await get(admin, `/assets?q=${encodeURIComponent(tag)}&limit=100&labelPrinted=no`);
    const ids = list.body.items.map((x: any) => x.id);
    assert.equal(ids.includes(a1.id), false);
    assert.equal(ids.includes(a2.id), false);
    assert.equal(ids.includes(a3.id), true);
  });

  it('employee forbidden', async () => {
    assert.equal((await post(holder, { assetIds: [a3.id], layout: 'A4_24' })).status, 403);
    assert.equal((await post(itAdmin, { assetIds: [a3.id], layout: 'A4_24' })).status, 403);
    assert.equal((await printRows(a3.id)).length, 0);
  });

  it('limits', async () => {
    const many = Array.from({ length: 501 }, () => randomUUID());
    assert.equal((await post(admin, { assetIds: many, layout: 'A4_24' })).status, 422);
    assert.equal((await post(admin, { assetIds: [a3.id, a3.id], layout: 'A4_24' })).status, 422);
    assert.equal((await post(admin, { assetIds: [], layout: 'A4_24' })).status, 422);
    assert.equal((await post(admin, { assetIds: [a3.id], layout: 'BAD' })).status, 422);
    assert.equal(
      (await post(admin, { assetIds: [a3.id, randomUUID()], layout: 'A4_14' })).status,
      404,
    );
    assert.equal((await printRows(a3.id)).length, 0);
  });

  it('employee list has no lastLabelPrintedAt key and ignores labelPrinted', async () => {
    const list = await get(holder, '/assets?limit=100&labelPrinted=no');
    assert.equal(list.status, 200);
    for (const item of list.body.items) assert.equal('lastLabelPrintedAt' in item, false);
  });
});
