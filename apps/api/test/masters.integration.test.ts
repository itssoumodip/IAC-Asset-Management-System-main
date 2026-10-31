import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Master integration requires isolated _test database');
const tag = `master-${randomUUID()}`;
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
const status = (expected: number) => (error: any) => {
  assert.equal(error.status, expected);
  return true;
};
const reason = 'Synthetic master setup review';

describe('Master Control PostgreSQL integration', { concurrency: false }, () => {
  let db: Db, service: DomainService, admin: any, employee: any, itAdmin: any;
  let department: any, location: any, category: any;
  const base = {
    category: `${tag}-category`,
    assetType: 'Laptop',
    description: `${tag} device`,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Low',
  };
  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    service = new DomainService(db);
    const make = async (role: string) => {
      const user = {
        id: randomUUID(),
        email: `${tag}-${role.toLowerCase()}-${randomUUID()}@example.org`,
        displayName: 'Synthetic master test',
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
    itAdmin = await make('EMPLOYEE');
    await joinTeam(db, itAdmin, 'MEMBER', ADM_TEAM_ID);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });
  it('allows only Admin to manage setup and exposes fixed-kind restrictions', async () => {
    for (const actor of [employee, itAdmin]) {
      await assert.rejects(service.masterData(request(actor)), status(403));
      await assert.rejects(
        service.createMaster(request(actor), 'departments', { code: 'NO', name: 'No', reason }),
        status(403),
      );
      await assert.rejects(
        service.updateMaster(request(actor, 1), 'CATEGORY', 'Other', { label: 'No', reason }),
        status(403),
      );
      await assert.rejects(
        service.referenceUpdate(request(actor, 1), 'CATEGORY', 'Other', {
          label: 'No',
          active: true,
          reason,
        }),
        status(403),
      );
    }
    const data = await service.masterData(request(admin));
    assert.equal(data.kinds.find((item: any) => item.kind === 'STATUS')?.allowCreate, false);
    assert.equal(
      data.kinds.find((item: any) => item.kind === 'TICKET_CATEGORY')?.allowDeactivate,
      true,
    );
    assert.equal(
      data.values.some(
        (item: any) => item.kind === 'STATUS' && item.code === 'Assigned' && item.version > 0,
      ),
      true,
    );
    await assert.rejects(
      service.createMaster(request(admin), 'untrusted_table', { code: 'NO', label: 'No', reason }),
      status(422),
    );
    await assert.rejects(
      service.createMaster(request(admin), 'CATEGORY', { code: 'NO', label: 'No' }),
      status(422),
    );
  });
  it('creates departments, detailed locations and controlled vocabulary without case duplicates', async () => {
    department = await service.createMaster(request(admin), 'departments', {
      code: `${tag}-DEPT`,
      name: `${tag} department`,
      reason,
    });
    location = await service.createMaster(request(admin), 'locations', {
      code: `${tag}-LOC`,
      site: 'Synthetic site',
      building: 'B',
      floor: '2',
      room: '204',
      reason,
    });
    category = await service.createMaster(request(admin), 'CATEGORY', {
      code: base.category,
      label: `${tag} category`,
      reason,
    });
    assert.equal(department.version, 1);
    assert.equal(location.room, '204');
    assert.equal(category.active, true);
    for (const input of [
      { code: base.category.toUpperCase(), label: 'New label', reason },
      { code: `${tag}-other`, label: `${tag} CATEGORY`, reason },
    ])
      await assert.rejects(service.createMaster(request(admin), 'CATEGORY', input), status(409));
    await assert.rejects(
      service.createMaster(request(admin), 'departments', {
        code: `${tag}-other`,
        name: department.name.toUpperCase(),
        reason,
      }),
      status(409),
    );
    await assert.rejects(
      service.createMaster(request(admin), 'locations', {
        code: location.code.toUpperCase(),
        site: 'Different site',
        reason,
      }),
      status(409),
    );
    const races = await Promise.allSettled([
      service.createMaster(request(admin), 'CONDITION', {
        code: `${tag}-race`,
        label: `${tag} race`,
        reason,
      }),
      service.createMaster(request(admin), 'CONDITION', {
        code: `${tag}-RACE`,
        label: `${tag} RACE`,
        reason,
      }),
    ]);
    assert.equal(races.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(
      (races.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason.status,
      409,
    );
  });
  it('requires current versions, rejects code edits and records before/after reasons', async () => {
    await assert.rejects(
      service.updateMaster(request(admin), 'departments', department.id, {
        name: 'Ignored',
        reason,
      }),
      status(428),
    );
    const updated = await service.updateMaster(
      request(admin, department.version),
      'departments',
      department.id,
      { name: `${tag} renamed department`, reason },
    );
    assert.equal(updated.version, department.version + 1);
    await assert.rejects(
      service.updateMaster(request(admin, department.version), 'departments', department.id, {
        active: false,
        reason,
      }),
      status(412),
    );
    await assert.rejects(
      service.updateMaster(request(admin, updated.version), 'departments', department.id, {
        code: 'CHANGED',
        reason,
      }),
      status(422),
    );
    await assert.rejects(
      service.updateMaster(request(admin, 1), 'CATEGORY', category.code, {
        code: 'CHANGED',
        reason,
      }),
      status(422),
    );
    await assert.rejects(
      db.query('UPDATE departments SET code=$2 WHERE id=$1', [department.id, `${tag}-changed`]),
      (error: any) => error.code === '23514',
    );
    await assert.rejects(
      db.query("UPDATE reference_values SET code=$2 WHERE kind='CATEGORY' AND code=$1", [
        category.code,
        `${tag}-changed`,
      ]),
      (error: any) => error.code === '23514',
    );
    const [audit] = await db.query(
      "SELECT actor_id,changes FROM audit_events WHERE entity_id=$1 AND action='MASTER_UPDATED' ORDER BY occurred_at DESC LIMIT 1",
      [department.id],
    );
    assert.equal(audit.actor_id, admin.id);
    assert.equal(audit.changes.reason, reason);
    assert.equal(audit.changes.before.name, department.name);
    assert.equal(audit.changes.after.name, updated.name);
    department = updated;
  });
  it('preserves workflow codes and activation while supporting display labels', async () => {
    for (const kind of ['STATUS', 'TICKET_STATUS', 'TICKET_PRIORITY', 'DATA_WIPE']) {
      await assert.rejects(
        service.createMaster(request(admin), kind, {
          code: `${tag}-NEW`,
          label: 'Custom transition',
          reason,
        }),
        status(409),
      );
      const value = (await service.references()).values.find((item: any) => item.kind === kind)!;
      await assert.rejects(
        service.updateMaster(request(admin, value.version), kind, value.code, {
          active: false,
          reason,
        }),
        status(409),
      );
      await assert.rejects(
        service.referenceUpdate(request(admin, value.version), kind, value.code, {
          active: false,
          label: value.label,
          reason,
        }),
        status(409),
      );
    }
    const value = (await service.references()).values.find(
      (item: any) => item.kind === 'DATA_WIPE' && item.code === 'Yes',
    )!;
    const updated = await service.updateMaster(request(admin, value.version), 'DATA_WIPE', 'Yes', {
      label: 'Yes (label review)',
      reason,
    });
    assert.equal(updated.code, 'Yes');
    assert.equal(updated.active, true);
    await service.updateMaster(request(admin, updated.version), 'DATA_WIPE', 'Yes', {
      label: value.label,
      reason,
    });
    await assert.rejects(
      db.query("UPDATE reference_values SET active=false WHERE kind='STATUS' AND code='Assigned'"),
      (error: any) => error.code === '23514',
    );
  });
  it('uses custom ticket categories and newly configured optional asset selectors', async () => {
    const ticketCategory = await service.createMaster(request(admin), 'TICKET_CATEGORY', {
      code: `${tag}-SUPPORT`,
      label: `${tag} custom support`,
      reason,
    });
    const ticket = await service.createTicket(request(employee), {
      subject: `${tag} category test`,
      description: 'Synthetic support',
      category: ticketCategory.code,
      priority: 'MEDIUM',
    });
    assert.equal(ticket.category, ticketCategory.code);
    await service.updateMaster(
      request(admin, ticketCategory.version),
      'TICKET_CATEGORY',
      ticketCategory.code,
      { active: false, reason },
    );
    await assert.rejects(
      service.createTicket(request(employee), {
        subject: 'Inactive category',
        description: 'Synthetic support',
        category: ticketCategory.code,
        priority: 'MEDIUM',
      }),
      status(422),
    );
    assert.equal(
      (await service.ticket(request(employee), ticket.id)).category,
      ticketCategory.code,
    );
    for (const [kind, field] of [
      ['DEPRECIATION_METHOD', 'depreciationMethod'],
      ['DISPOSAL_METHOD', 'disposalMethod'],
      ['COMMENT_TYPE', 'commentType'],
    ] as const) {
      const ref = await service.createMaster(request(admin), kind, {
        code: `${tag}-${kind}`,
        label: `${tag} ${kind}`,
        reason,
      });
      const asset = await service.createAsset(request(admin), { ...base, [field]: ref.code });
      assert.equal(asset[field], ref.code);
      await service.updateMaster(request(admin, ref.version), kind, ref.code, {
        active: false,
        reason,
      });
      const changed = await service.editAsset(request(admin, asset.version), asset.id, {
        description: 'Unrelated legacy edit',
        reason,
      });
      assert.equal(changed[field], ref.code);
      await assert.rejects(
        service.createAsset(request(admin), { ...base, [field]: ref.code }),
        status(422),
      );
      await assert.rejects(
        service.createAsset(request(admin), { ...base, [field]: 'Not configured' }),
        status(422),
      );
    }
  });
  it('can retire legacy duplicate labels and retain long optional codes in full edits', async () => {
    const longCode = 'Legacy '.repeat(22) + tag;
    for (const code of [`${tag}-legacy-a`, `${tag}-legacy-b`])
      await db.query("INSERT INTO reference_values(kind,code,label) VALUES('COMMENT_TYPE',$1,$2)", [
        code,
        `${tag} legacy duplicate`,
      ]);
    const retired = await service.updateMaster(
      request(admin, 1),
      'COMMENT_TYPE',
      `${tag}-legacy-a`,
      { active: false, reason },
    );
    assert.equal(retired.active, false);
    await db.query(
      "INSERT INTO reference_values(kind,code,label) VALUES('DEPRECIATION_METHOD',$1,$2)",
      [longCode, `${tag} legacy method`],
    );
    let asset = await service.createAsset(request(admin), {
      ...base,
      depreciationMethod: longCode,
    });
    await service.updateMaster(request(admin, 1), 'DEPRECIATION_METHOD', longCode, {
      active: false,
      reason,
    });
    asset = await service.editAsset(request(admin, asset.version), asset.id, {
      depreciationMethod: longCode,
      description: 'Legacy full editor submission',
      reason,
    });
    assert.equal(asset.depreciationMethod, longCode);
  });
  it('keeps inactive historical asset values while rejecting new uses and preserves custody controls', async () => {
    let asset = await service.createAsset(request(admin), {
      ...base,
      departmentId: department.id,
      locationId: location.id,
    });
    category = await service.updateMaster(
      request(admin, category.version),
      'CATEGORY',
      category.code,
      { active: false, reason },
    );
    department = await service.updateMaster(
      request(admin, department.version),
      'departments',
      department.id,
      { active: false, reason },
    );
    location = await service.updateMaster(
      request(admin, location.version),
      'locations',
      location.id,
      { active: false, reason },
    );
    department = await service.updateMaster(
      request(admin, department.version),
      'departments',
      department.id,
      { name: `${tag} inactive rename`, reason },
    );
    category = await service.updateMaster(
      request(admin, category.version),
      'CATEGORY',
      category.code,
      { label: `${tag} inactive label`, reason },
    );
    location = await service.updateMaster(
      request(admin, location.version),
      'locations',
      location.id,
      { room: null, reason },
    );
    assert.equal(department.active, false);
    assert.equal(category.active, false);
    assert.equal(location.active, false);
    asset = await service.editAsset(request(admin, asset.version), asset.id, {
      description: 'Historical inactive references retained',
      reason,
    });
    assert.equal(asset.category, category.code);
    assert.equal(asset.departmentId, department.id);
    assert.equal(asset.locationId, location.id);
    const refs = await service.references();
    assert.equal(
      refs.values.find((row: any) => row.kind === 'CATEGORY' && row.code === category.code)?.active,
      false,
    );
    assert.equal(refs.departments.find((row: any) => row.id === department.id)?.active, false);
    for (const input of [
      { ...base },
      { ...base, category: 'Other', departmentId: department.id },
      { ...base, category: 'Other', locationId: location.id },
    ])
      await assert.rejects(service.createAsset(request(admin), input), status(422));
    await assert.rejects(
      service.editAsset(request(admin, asset.version), asset.id, { status: 'Assigned', reason }),
      status(409),
    );
    const alternate = await service.createAsset(request(admin), {
      ...base,
      category: 'Other',
      overrideReason: 'Synthetic historical reference test',
    });
    await assert.rejects(
      service.editAsset(request(admin, alternate.version), alternate.id, {
        category: category.code,
        reason,
      }),
      status(422),
    );
    // Existing custody may still be assigned and returned after reference retirement.
    const assignment = await service.assign(request(admin, asset.version), asset.id, {
      userId: employee.id,
    });
    const returned = await service.returnAsset(request(admin, assignment.version), assignment.id, {
      condition: 'Good',
      reason,
    });
    assert.ok(returned.assetVersion > asset.version);
    assert.equal((await service.asset(request(admin), asset.id)).status, 'In Store');
    category = await service.updateMaster(
      request(admin, category.version),
      'CATEGORY',
      category.code,
      { active: true, reason },
    );
    assert.equal(category.active, true);
  });
});
