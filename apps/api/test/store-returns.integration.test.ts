import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { StoreService } from '../src/store';
import type { AuthRequest } from '../src/security';
import { IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Store return tests require a database name ending _test');
const tag = `store-returns-${randomUUID()}`;
const request = (actor: any, version?: number) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match'
        ? version === undefined
          ? undefined
          : `"${version}"`
        : name.toLowerCase() === 'idempotency-key'
          ? randomUUID()
          : undefined,
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('store returns PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, store: StoreService;
  let storeUser: any, itMember: any, employee: any;
  let storeLocationId: string;
  const input = {
    category: 'Store Return Category',
    assetType: 'Store Return Type',
    description: `${tag} item`,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
    amcApplies: false,
  };
  const make = async (roles: string[]) => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic store test',
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
      [user.id, user.email, user.displayName],
    );
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    return user;
  };
  /** Creates an In Store asset and assigns it, returning the open assignment. */
  const assigned = async () => {
    const asset = await domain.createAsset(request(itMember), {
      ...input,
      description: `${tag} item ${randomUUID()}`,
      owningTeamId: IT_TEAM_ID,
    });
    const fresh = await domain.asset(request(itMember), asset.id);
    await domain.assign(
      request(itMember, fresh.version),
      asset.id,
      { userId: employee.id },
      false,
      { sendEmail: false },
    );
    const [assignment] = await db.query(
      'SELECT * FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
      [asset.id],
    );
    return { asset, assignment };
  };
  const row = async (assetId: string) =>
    (await db.query('SELECT * FROM assets WHERE id=$1', [assetId]))[0];

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    store = new StoreService(db);
    for (const [kind, code] of [
      ['CATEGORY', input.category],
      ['ASSET_TYPE', input.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['CONDITION', 'Poor'],
      ['CONDITION', 'Damaged'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
      ['STATUS', 'Under Repair'],
      ['STATUS', 'Assigned'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    [{ id: storeLocationId }] = await db.query(
      "INSERT INTO locations(code,name,level,site) VALUES($1,'Synthetic store','STORE','Synthetic site') RETURNING id",
      [`${tag}-store`],
    );
    storeUser = await make(['STORE']);
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    employee = await make(['EMPLOYEE']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('receives a good return: closes custody, sets location and In Store', async () => {
    const { asset, assignment } = await assigned();
    const result = await store.receiveReturn(request(storeUser), assignment.id, {
      condition: 'Good',
      locationId: storeLocationId,
      note: 'Back from desk',
    });
    assert.equal(result.status, 'In Store');
    const after = await row(asset.id);
    assert.equal(after.status, 'In Store');
    assert.equal(after.condition, 'Good');
    assert.equal(after.location_id, storeLocationId);
    const [ended] = await db.query('SELECT * FROM assignments WHERE id=$1', [assignment.id]);
    assert.ok(ended.ended_at);
    assert.equal(ended.ended_by, storeUser.id);
    const audits = await db.query(
      "SELECT * FROM audit_events WHERE entity_id=$1 AND action='STORE_RETURN_RECEIVED'",
      [asset.id],
    );
    assert.equal(audits.length, 1);
    const activity = await store.listActivity(request(storeUser));
    assert.ok(activity.items.some((e: any) => e.assetCode === asset.assetCode));
  });

  it('Needs repair marks the asset Under Repair', async () => {
    const { asset, assignment } = await assigned();
    await store.receiveReturn(request(storeUser), assignment.id, {
      condition: 'Needs repair',
      locationId: storeLocationId,
    });
    const after = await row(asset.id);
    assert.equal(after.status, 'Under Repair');
    assert.equal(after.location_id, storeLocationId);
  });

  it('Damaged marks the asset Under Repair with condition Damaged', async () => {
    const { asset, assignment } = await assigned();
    await store.receiveReturn(request(storeUser), assignment.id, {
      condition: 'Damaged',
      locationId: storeLocationId,
    });
    const after = await row(asset.id);
    assert.equal(after.status, 'Under Repair');
    assert.equal(after.condition, 'Damaged');
  });

  it('denies users without store.operations', async () => {
    const { asset, assignment } = await assigned();
    await assert.rejects(
      store.receiveReturn(request(employee), assignment.id, {
        condition: 'Good',
        locationId: storeLocationId,
      }),
      status(403),
    );
    await assert.rejects(store.listActivity(request(employee)), status(403));
    const [still] = await db.query('SELECT ended_at FROM assignments WHERE id=$1', [assignment.id]);
    assert.equal(still.ended_at, null);
    assert.equal((await row(asset.id)).status, 'Assigned');
  });

  it('rejects receiving an already-closed assignment with 409', async () => {
    const { assignment } = await assigned();
    const body = { condition: 'Good', locationId: storeLocationId };
    await store.receiveReturn(request(storeUser), assignment.id, body);
    await assert.rejects(store.receiveReturn(request(storeUser), assignment.id, body), status(409));
    await assert.rejects(
      store.receiveReturn(request(storeUser), randomUUID(), body),
      status(404),
    );
  });

  it('rejects a non-store location', async () => {
    const { assignment } = await assigned();
    const [{ id: roomId }] = await db.query(
      "INSERT INTO locations(code,name,site) VALUES($1,'Synthetic room','Synthetic site') RETURNING id",
      [`${tag}-room-${randomUUID()}`],
    );
    await assert.rejects(
      store.receiveReturn(request(storeUser), assignment.id, {
        condition: 'Good',
        locationId: roomId,
      }),
      status(422),
    );
  });
});
