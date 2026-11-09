import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { LocationsService } from '../src/locations';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Location integration requires isolated _test database');
const tag = `LM${randomBytes(4).toString('hex').toUpperCase()}`;
const reason = 'Synthetic location management review';
const request = (actor: any, version?: number) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match' && version !== undefined ? `"${version}"` : undefined,
  }) as AuthRequest;
const status = (expected: number) => (error: any) => {
  assert.equal(error.status, expected);
  return true;
};

describe('Location management PostgreSQL integration', { concurrency: false }, () => {
  let db: Db, service: LocationsService, admin: any, employee: any;
  let site: any, building: any, floor: any;
  before(async () => {
    process.env.DATABASE_URL = connection;
    db = new Db();
    service = new LocationsService(db);
    const make = async (role: string) => {
      const user = {
        id: randomUUID(),
        email: `${tag.toLowerCase()}-${role.toLowerCase()}-${randomUUID()}@example.org`,
        displayName: 'Synthetic location test',
        roles: [role],
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
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
      return user;
    };
    admin = await make('SUPER_ADMIN');
    employee = await make('EMPLOYEE');
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('creates a hierarchy and uppercases codes', async () => {
    site = await service.create(request(admin), {
      code: `${tag.toLowerCase()}-site`,
      name: 'Test site',
      level: 'SITE',
      reason,
    });
    assert.equal(site.code, `${tag}-SITE`);
    building = await service.create(request(admin), {
      code: `${tag}-BLD`,
      name: 'Test building',
      level: 'BUILDING',
      parentId: site.id,
      reason,
    });
    floor = await service.create(request(admin), {
      code: `${tag}-FLR`,
      name: 'Test floor',
      level: 'FLOOR',
      parentId: building.id,
      reason,
    });
    assert.equal(building.parentId, site.id);
    const tree = await service.tree(request(admin), {});
    assert.equal(tree.locations.find((n: any) => n.id === floor.id)?.depth, 3);
    await assert.rejects(
      service.create(request(admin), {
        code: `${tag}-BAD`,
        name: 'Wrong order',
        level: 'SITE',
        parentId: building.id,
        reason,
      }),
      status(422),
    );
  });

  it('rejects duplicate codes with 409', async () => {
    await assert.rejects(
      service.create(request(admin), {
        code: `${tag}-bld`,
        name: 'Duplicate',
        level: 'BUILDING',
        parentId: site.id,
        reason,
      }),
      status(409),
    );
  });

  it('renames, and prevents moving a node under its own descendant', async () => {
    const renamed = await service.update(request(admin, building.version), building.id, {
      name: 'Renamed building',
      reason,
    });
    assert.equal(renamed.name, 'Renamed building');
    assert.equal(renamed.version, building.version + 1);
    await assert.rejects(
      service.update(request(admin, building.version), building.id, { name: 'x', reason }),
      status(412),
    );
    await assert.rejects(
      service.update(request(admin, renamed.version), building.id, {
        parentId: floor.id,
        reason,
      }),
      status(422),
    );
    await assert.rejects(
      service.update(request(admin, site.version), site.id, { parentId: floor.id, reason }),
      status(422),
    );
    building = renamed;
  });

  it('blocks deactivation while assets or active children remain', async () => {
    await db.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,location_id)
       VALUES($1,'Cat','Type','Location test asset','Owned','In Store','Good','Low',$2,$3)`,
      [`IAC-ADM-${String(randomInt(0, 999999)).padStart(6, '0')}`, ADM_TEAM_ID, floor.id],
    );
    await assert.rejects(
      service.update(request(admin, floor.version), floor.id, { active: false, reason }),
      (error: any) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /Move the 1 asset first/);
        return true;
      },
    );
    await assert.rejects(
      service.update(request(admin, building.version), building.id, { active: false, reason }),
      status(409),
    );
    await db.query('UPDATE assets SET location_id=NULL WHERE location_id=$1', [floor.id]);
    const off = await service.update(request(admin, floor.version), floor.id, {
      active: false,
      reason,
    });
    assert.equal(off.active, false);
    const hidden = await service.tree(request(admin), {});
    assert.equal(
      hidden.locations.some((n: any) => n.id === floor.id),
      false,
    );
    const shown = await service.tree(request(admin), { includeInactive: 'true' });
    assert.equal(
      shown.locations.some((n: any) => n.id === floor.id),
      true,
    );
    const on = await service.update(request(admin, off.version), floor.id, {
      active: true,
      reason,
    });
    assert.equal(on.active, true);
  });

  it('forbids non-admins', async () => {
    await assert.rejects(
      service.create(request(employee), { code: `${tag}-NO`, name: 'No', level: 'SITE', reason }),
      status(403),
    );
    await assert.rejects(
      service.update(request(employee, site.version), site.id, { name: 'No', reason }),
      status(403),
    );
  });
});
