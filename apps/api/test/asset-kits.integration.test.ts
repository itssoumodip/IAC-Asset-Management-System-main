import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Asset kit integration tests require a database name ending _test');
const tag = `kits-${randomUUID()}`;
const request = (actor: any, version?: number, key = randomUUID()) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match'
        ? version === undefined
          ? undefined
          : `"${version}"`
        : name.toLowerCase() === 'idempotency-key'
          ? key
          : undefined,
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('asset kits PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: DomainService;
  let itMember: any, admLead: any, employee: any;
  let locationId: string;
  const input = {
    category: 'Kit Category',
    assetType: 'Kit Type',
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
      displayName: 'Synthetic kit test',
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
  const create = (actor: any, extra: Record<string, unknown> = {}) =>
    service.createAsset(request(actor), {
      ...input,
      description: `${tag} item ${randomUUID()}`,
      owningTeamId: IT_TEAM_ID,
      ...extra,
    });
  const attach = (actor: any, parent: any, part: any, reason = 'Synthetic bundle') =>
    service.attachKitPart(request(actor), parent.id, { partAssetId: part.id, reason });
  const fresh = (asset: any) => service.asset(request(itMember), asset.id);
  const assignTo = async (actor: any, asset: any, user: any) =>
    service.assign(
      request(actor, (await fresh(asset)).version),
      asset.id,
      { userId: user.id },
      false,
      {
        sendEmail: false,
      },
    );
  const row = async (assetId: string) =>
    (await db.query('SELECT * FROM assets WHERE id=$1', [assetId]))[0];
  const custody = async (assetId: string) =>
    (
      await db.query('SELECT * FROM assignments WHERE asset_id=$1 AND ended_at IS NULL', [assetId])
    )[0];
  const audits = async (entityId: string, action: string) =>
    db.query('SELECT * FROM audit_events WHERE entity_id=$1 AND action=$2', [entityId, action]);

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    service = new DomainService(db);
    for (const [kind, code] of [
      ['CATEGORY', input.category],
      ['ASSET_TYPE', input.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    [{ id: locationId }] = await db.query(
      "INSERT INTO locations(code,site) VALUES($1,'Synthetic site') RETURNING id",
      [`${tag}-room`],
    );
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    admLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', ADM_TEAM_ID);
    employee = await make(['EMPLOYEE']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('attach and detach are audited and shown on asset detail', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    const attached = await attach(itMember, parent, part);
    assert.deepEqual(
      attached.kitParts.map((p: any) => p.id),
      [part.id],
    );
    assert.equal(attached.kitParts[0].assetCode, part.assetCode);
    const partView = await fresh(part);
    assert.equal(partView.kitParent.id, parent.id);
    assert.equal(partView.kitParent.assetCode, parent.assetCode);
    assert.equal((await audits(parent.id, 'KIT_PART_ATTACHED')).length, 1);
    const detached = await service.detachKitPart(request(itMember), parent.id, part.id, {
      reason: 'Synthetic split',
    });
    assert.equal(detached.kitParts.length, 0);
    assert.equal((await audits(parent.id, 'KIT_PART_DETACHED')).length, 1);
    assert.equal((await fresh(part)).kitParent, null);
  });
  it('requires custody permission and a reason', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    await assert.rejects(attach(employee, parent, part), status(403));
    await assert.rejects(attach(admLead, parent, part), status(403));
    await assert.rejects(attach(itMember, parent, part, ''), status(422));
  });
  it('cross-team attach is rejected', async () => {
    const parent = await create(itMember);
    const part = await create(admLead, { owningTeamId: ADM_TEAM_ID });
    await assert.rejects(attach(itMember, parent, part), (e: any) => [403, 422].includes(e.status));
  });
  it('nested kits are rejected', async () => {
    const a = await create(itMember);
    const b = await create(itMember);
    const c = await create(itMember);
    await attach(itMember, a, b);
    await assert.rejects(attach(itMember, b, c), status(422));
    await assert.rejects(attach(itMember, c, a), status(422));
    await assert.rejects(attach(itMember, c, b), status(409));
    await assert.rejects(attach(itMember, a, a), status(422));
  });
  it('attach requires part unassigned or held by the parent custodian', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    const other = await make(['EMPLOYEE']);
    await assignTo(itMember, part, employee);
    await assert.rejects(attach(itMember, parent, part), status(409));
    await assignTo(itMember, parent, other);
    await assert.rejects(attach(itMember, parent, part), status(409));
    const parent2 = await create(itMember);
    await assignTo(itMember, parent2, employee);
    const ok = await attach(itMember, parent2, part);
    assert.equal(ok.kitParts.length, 1);
  });
  it('attaching an in-store part to an assigned parent assigns it to the same holder', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    await assignTo(itMember, parent, employee);
    await attach(itMember, parent, part);
    assert.equal((await row(part.id)).status, 'Assigned');
    assert.equal((await custody(part.id)).user_id, employee.id);
    const moves = await db.query('SELECT kind FROM asset_movements WHERE asset_id=$1', [part.id]);
    assert.ok(moves.some((m: any) => m.kind === 'ASSIGN'));
  });
  it('assigning a parent assigns every part; returning returns them', async () => {
    const parent = await create(itMember);
    const p1 = await create(itMember);
    const p2 = await create(itMember);
    await attach(itMember, parent, p1);
    await attach(itMember, parent, p2);
    await assignTo(itMember, parent, employee);
    for (const a of [parent, p1, p2]) {
      assert.equal((await row(a.id)).status, 'Assigned');
      assert.equal((await custody(a.id)).user_id, employee.id);
    }
    const parentAssignment = await custody(parent.id);
    await service.returnAsset(request(itMember, parentAssignment.version), parentAssignment.id, {
      reason: 'Synthetic return',
      condition: 'Good',
      locationId,
    });
    for (const a of [parent, p1, p2]) {
      const r = await row(a.id);
      assert.equal(r.status, 'In Store');
      assert.equal(r.location_id, locationId);
      assert.equal(await custody(a.id), undefined);
      const moves = await db.query('SELECT kind FROM asset_movements WHERE asset_id=$1', [a.id]);
      assert.ok(moves.some((m: any) => m.kind === 'ASSIGN'));
      assert.ok(moves.some((m: any) => m.kind === 'RETURN'));
    }
  });
  it('reassigning a parent moves parts to the new custodian', async () => {
    const other = await make(['EMPLOYEE']);
    const parent = await create(itMember);
    const part = await create(itMember);
    await attach(itMember, parent, part);
    await assignTo(itMember, parent, employee);
    await service.assign(
      request(itMember, (await fresh(parent)).version),
      parent.id,
      { userId: other.id, reason: 'Synthetic handover' },
      true,
      { sendEmail: false },
    );
    assert.equal((await custody(part.id)).user_id, other.id);
    assert.equal((await custody(parent.id)).user_id, other.id);
  });
  it('direct assign/reassign/return of an attached part is 409', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    await attach(itMember, parent, part);
    await assert.rejects(assignTo(itMember, part, employee), (e: any) => {
      assert.equal(e.status, 409);
      assert.match(e.message, new RegExp(`part of kit ${parent.assetCode}; detach it first`));
      return true;
    });
    await assignTo(itMember, parent, employee);
    const partAssignment = await custody(part.id);
    await assert.rejects(
      service.returnAsset(request(itMember, partAssignment.version), partAssignment.id, {
        reason: 'x',
        condition: 'Good',
      }),
      status(409),
    );
    await assert.rejects(
      service.assign(
        request(itMember),
        part.id,
        { userId: (await make(['EMPLOYEE'])).id, reason: 'x' },
        true,
        { sendEmail: false },
      ),
      status(409),
    );
  });
  it('detach then assign works', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    await attach(itMember, parent, part);
    await service.detachKitPart(request(itMember), parent.id, part.id, { reason: 'Synthetic' });
    await assignTo(itMember, part, employee);
    assert.equal((await row(part.id)).status, 'Assigned');
    assert.equal((await row(parent.id)).status, 'In Store');
  });
  it('retiring a parent with parts is 409', async () => {
    const parent = await create(itMember);
    const part = await create(itMember);
    await attach(itMember, parent, part);
    const sa = await make(['SUPER_ADMIN']);
    await assert.rejects(
      service.editAsset(request(sa, (await fresh(parent)).version), parent.id, {
        status: 'Retired',
        disposalDate: '2026-10-01',
        disposalReference: 'DISP-1',
        reason: 'Synthetic retire',
      }),
      status(409),
    );
  });
  it('detach racing a parent return never deadlocks (either id order)', async () => {
    const races: (() => Promise<PromiseSettledResult<unknown>[]>)[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await create(itMember);
      const b = await create(itMember);
      // Alternate which of the pair is the parent so part.id < parent.id happens half the time.
      const [low, high] = a.id < b.id ? [a, b] : [b, a];
      const [parent, part] = i % 2 === 0 ? [high, low] : [low, high];
      await attach(itMember, parent, part);
      await assignTo(itMember, parent, employee);
      const assignment = await custody(parent.id);
      races.push(() =>
        Promise.allSettled([
          service.detachKitPart(request(itMember), parent.id, part.id, { reason: 'Synthetic race' }),
          service.returnAsset(request(itMember, assignment.version), assignment.id, {
            reason: 'Synthetic race return',
            condition: 'Good',
            locationId,
          }),
        ]),
      );
    }
    const settled = (await Promise.all(races.map((r) => r()))).flat();
    for (const r of settled)
      if (r.status === 'rejected') {
        const e: any = r.reason;
        assert.notEqual(e?.code, '40P01', 'deadlock detected');
        assert.ok(e?.status && e.status < 500, `unexpected failure: ${e?.message}`);
      }
  });
  it('auto-assigning on attach refuses an ineligible holder', async () => {
    const holder = await make(['EMPLOYEE']);
    const parent = await create(itMember);
    const part = await create(itMember);
    await assignTo(itMember, parent, holder);
    await db.query("UPDATE users SET state='DISABLED' WHERE id=$1", [holder.id]);
    await assert.rejects(attach(itMember, parent, part), status(422));
    assert.equal((await row(part.id)).parent_asset_id, null);
  });
  it('assigning a parent skips parts that were retired', async () => {
    const parent = await create(itMember);
    const live = await create(itMember);
    const dead = await create(itMember);
    await attach(itMember, parent, live);
    await attach(itMember, parent, dead);
    await db.query("UPDATE assets SET status='Retired',disposal_date=current_date,disposal_reference='X' WHERE id=$1", [dead.id]);
    await assignTo(itMember, parent, employee);
    assert.equal((await custody(live.id)).user_id, employee.id);
    assert.equal(await custody(dead.id), undefined);
  });
});
