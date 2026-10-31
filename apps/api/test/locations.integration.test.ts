import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { LocationService } from '../src/locations';
import { allocateAssetCode } from '../src/domain-assets';
import { IT_TEAM_ID } from './team-fixtures';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Location integration tests require a database name ending _test');
const tag = `loc-${randomUUID().slice(0, 8)}`;
const request = (actor: any, version?: number) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match' && version !== undefined ? `"${version}"` : undefined,
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('location tree PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, locations: LocationService, domain: DomainService;
  let admin: any, employee: any;
  const make = async (roles: string[]) => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic location user',
      roles,
      teams: [],
      state: 'ACTIVE',
      version: 1,
    };
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [user.id, user.email, user.displayName],
    );
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    return user;
  };
  const add = (name: string, level: string, parentId?: string) =>
    locations.create(request(admin), { name: `${tag} ${name}`, level, parentId, reason: 'Test' });

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    locations = new LocationService(db);
    domain = new DomainService(db);
    admin = await make(['SUPER_ADMIN']);
    employee = await make(['EMPLOYEE']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('builds a tree and returns full paths to any signed-in user', async () => {
    const site = await add('Campus', 'SITE');
    const building = await add('Tower A', 'BUILDING', site.id);
    const flat = await add('Flat 3B', 'UNIT', building.id);
    const tree = await locations.tree(request(employee));
    const row = tree.items.find((l: any) => l.id === flat.id);
    assert.equal(row.path, `${tag} Campus › ${tag} Tower A › ${tag} Flat 3B`);
    assert.equal(row.parentId, building.id);
    assert.ok(tree.levels.some((l: any) => l.code === 'RACK'));
    const refs = await domain.references();
    assert.equal(refs.locations.find((l: any) => l.id === flat.id).path, row.path);
  });

  it('rejects a parent at the same or an inner level (422)', async () => {
    const site = await add('Site X', 'SITE');
    const floor = await add('Floor 1', 'FLOOR', site.id);
    await assert.rejects(add('Bad building', 'BUILDING', floor.id), status(422));
    await assert.rejects(add('Bad floor', 'FLOOR', floor.id), status(422));
  });

  it('rejects a move that would create a loop (422)', async () => {
    const site = await add('Loop site', 'SITE');
    const zone = await add('Loop zone', 'ZONE', site.id);
    const other = await add('Other zone', 'ZONE', site.id);
    // A zone cannot go under another zone (level rule) nor a site under its own child.
    await assert.rejects(
      locations.update(request(admin, zone.version), zone.id, { parentId: other.id, reason: 'x' }),
      status(422),
    );
    await assert.rejects(
      locations.update(request(admin, site.version), site.id, { parentId: zone.id, reason: 'x' }),
      status(422),
    );
  });

  it('renames and moves with version checks; employees cannot edit', async () => {
    const site = await add('Move site', 'SITE');
    const b1 = await add('B1', 'BUILDING', site.id);
    const store = await add('Store', 'STORE');
    const moved = await locations.update(request(admin, store.version), store.id, {
      parentId: b1.id,
      name: `${tag} Main store`,
      reason: 'Put store in B1',
    });
    assert.equal(moved.parentId, b1.id);
    assert.equal(moved.name, `${tag} Main store`);
    await assert.rejects(
      locations.update(request(admin, store.version), store.id, { name: 'stale', reason: 'x' }),
      status(412),
    );
    await assert.rejects(
      locations.create(request(employee), { name: 'nope', level: 'SITE', reason: 'x' }),
      status(403),
    );
  });

  it('blocks deactivating a location that still holds assets or active children (409)', async () => {
    const site = await add('Busy site', 'SITE');
    const room = await add('Busy room', 'UNIT', site.id);
    await db.tx(async (c) =>
      db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,location_id,owning_team_id)
         VALUES($1,'C','T','${tag} chair','Owned','In Store','Good','Low',$2,$3)`,
        [await allocateAssetCode(db, IT_TEAM_ID, c), room.id, IT_TEAM_ID],
        c,
      ),
    );
    await assert.rejects(
      locations.update(request(admin, site.version), site.id, { active: false, reason: 'x' }),
      status(409),
    );
    await assert.rejects(
      locations.update(request(admin, room.version), room.id, { active: false, reason: 'x' }),
      status(409),
    );
    const empty = await add('Empty room', 'UNIT', site.id);
    const off = await locations.update(request(admin, empty.version), empty.id, {
      active: false,
      reason: 'Closed',
    });
    assert.equal(off.active, false);
  });

  it('filters assets by the selected location and all descendants', async () => {
    const site = await add('Filter site', 'SITE');
    const room = await add('Filter room', 'UNIT', site.id);
    const outside = await add('Outside room', 'UNIT');
    const insertAsset = async (locationId: string) =>
      db.tx(async (c) => {
        const code = await allocateAssetCode(db, IT_TEAM_ID, c);
        const [row] = await db.query(
          `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,location_id,owning_team_id)
           VALUES($1,'C','T',$2,'Owned','In Store','Good','Low',$3,$4) RETURNING id`,
          [code, `${tag} filter asset`, locationId, IT_TEAM_ID],
          c,
        );
        return row.id;
      });
    const descendantAsset = await insertAsset(room.id);
    await insertAsset(outside.id);

    const result = await domain.assets(request(admin), { locationId: site.id, q: tag, limit: 100 });
    assert.deepEqual(result.items.map((item: any) => item.id), [descendantAsset]);
  });

  it('legacy flat locations still insert and get a level and name', async () => {
    const [row] = await db.query(
      "INSERT INTO locations(code,site,floor,room) VALUES($1,'Old site','2','Room 9') RETURNING level,name",
      [`${tag}-legacy`],
    );
    assert.deepEqual(row, { level: 'UNIT', name: 'Room 9' });
  });
});
