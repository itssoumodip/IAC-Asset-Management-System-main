import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { ExecutiveDashboardService } from '../src/executive-dashboard';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Team permission integration tests require a database name ending _test');
const IT = '00000000-0000-4000-8000-000000000001';
const ADM = '00000000-0000-4000-8000-000000000002';
const PRJ = '00000000-0000-4000-8000-000000000003';
const teamCodes: Record<string, string> = { [IT]: 'IT', [ADM]: 'ADM', [PRJ]: 'PRJ' };
const tag = `teamperm-${randomUUID()}`;
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

describe('team permissions PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: DomainService, execService: ExecutiveDashboardService;
  let admMember: any, prjMember: any, projectId: string, locationId: string;
  let superAdmin: any, itMember: any, itLead: any, finance: any, executive: any, employee: any;
  const input = {
    category: 'Team Perm Category',
    assetType: 'Team Perm Type',
    description: `${tag} device`,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
    amcApplies: false,
  };
  const make = async (roles: string[], teams: { teamId: string; level: 'LEAD' | 'MEMBER' }[] = []) => {
    const user = {
      id: randomUUID(),
      email: `${tag}-${roles[0]!.toLowerCase()}-${randomUUID()}@example.org`,
      displayName: 'Synthetic team permission test',
      roles,
      teams: teams.map((t) => ({ teamId: t.teamId, teamCode: teamCodes[t.teamId]!, level: t.level })),
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
    await db.query('INSERT INTO approved_emails(email) VALUES($1)', [user.email]);
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    for (const t of teams)
      await db.query('INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,$3)', [
        user.id,
        t.teamId,
        t.level,
      ]);
    return user;
  };
  const createAsset = async (team = IT, extra: Record<string, unknown> = {}) => {
    const created = await service.createAsset(request(superAdmin), {
      ...input,
      description: `${tag} device ${randomUUID()}`,
      ...extra,
    });
    if (team !== IT)
      await db.query('UPDATE assets SET owning_team_id=$2 WHERE id=$1', [created.id, team]);
    return created;
  };
  const snapshot = async (assetId: string) =>
    (await db.query('SELECT to_jsonb(a) AS s FROM assets a WHERE id=$1', [assetId]))[0].s;

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
      ['STATUS', 'Retired'],
      ['STATUS', 'In Store'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    superAdmin = await make(['SUPER_ADMIN']);
    itMember = await make(['EMPLOYEE'], [{ teamId: IT, level: 'MEMBER' }]);
    itLead = await make(['EMPLOYEE'], [{ teamId: IT, level: 'LEAD' }]);
    finance = await make(['FINANCE']);
    executive = await make(['EXECUTIVE']);
    employee = await make(['EMPLOYEE']);
    admMember = await make(['EMPLOYEE'], [{ teamId: ADM, level: 'MEMBER' }]);
    prjMember = await make(['EMPLOYEE'], [{ teamId: PRJ, level: 'MEMBER' }]);
    execService = new ExecutiveDashboardService(db);
    for (const [kind, code] of [
      ['ASSET_TYPE', 'Laptop'],
      ['ASSET_TYPE', 'Chair'],
      ['CATEGORY', 'HARDWARE'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    const [prjRow] = await db.query(
      "INSERT INTO projects(code,name,start_date) VALUES($1,'Dept Rules Project','2026-01-01') ON CONFLICT(code) DO UPDATE SET name=excluded.name RETURNING id",
      [tag.slice(0, 10)],
    );
    projectId = prjRow.id;
    const [locRow] = await db.query("INSERT INTO locations(code,site,floor,room) VALUES($1,'Site','1','Room') ON CONFLICT(code) DO UPDATE SET room=excluded.room RETURNING id", [tag.slice(0, 10)]);
    locationId = locRow.id;
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('IT member can edit IT asset but not ADM asset', async () => {
    const itAsset = await createAsset(IT);
    const admAsset = await createAsset(ADM);
    const edited = await service.editAsset(request(itMember, itAsset.version), itAsset.id, {
      description: `${tag} edited by IT member`,
      reason: 'Team member edit',
    });
    assert.equal(edited.description, `${tag} edited by IT member`);
    const before = await snapshot(admAsset.id);
    await assert.rejects(
      service.editAsset(request(itMember, admAsset.version), admAsset.id, {
        description: `${tag} cross-team edit`,
        reason: 'Cross-team edit',
      }),
      status(403),
    );
    assert.deepEqual(await snapshot(admAsset.id), before);
  });

  it('team member sees only own team assets; global roles see all', async () => {
    await createAsset(IT);
    await createAsset(ADM);
    const all = await service.assets(request(superAdmin), { limit: 100, q: tag });
    const mine = await service.assets(request(itMember), { limit: 100, q: tag });
    const fin = await service.assets(request(finance), { limit: 100, q: tag });
    const exec = await service.assets(request(executive), { limit: 100, q: tag });
    assert.ok(all.items.some((a: any) => a.owningTeamId === ADM));
    assert.ok(mine.items.length > 0);
    assert.ok(mine.items.every((a: any) => a.owningTeamId === IT));
    assert.equal(fin.items.length, all.items.length);
    assert.equal(exec.items.length, all.items.length);
    const anyAdm = (await db.query('SELECT id FROM assets WHERE owning_team_id=$1 AND description LIKE $2 LIMIT 1', [ADM, `${tag}%`]))[0];
    await assert.rejects(service.asset(request(itMember), anyAdm.id), status(404));
  });

  it('team member still sees another team asset assigned to them', async () => {
    const adm = await createAsset(ADM);
    await service.assign(request(superAdmin, adm.version), adm.id, { userId: itMember.id });
    assert.equal((await service.asset(request(itMember), adm.id)).id, adm.id);
  });

  it('member cannot retire, lead can', async () => {
    const a = await createAsset(IT);
    const retire = {
      status: 'Retired',
      disposalDate: '2026-01-01',
      disposalReference: `${tag}-DISPOSAL-1`,
      reason: 'End of life',
    };
    await assert.rejects(service.editAsset(request(itMember, a.version), a.id, retire), status(403));
    const [{ status: unchanged }] = await db.query('SELECT status FROM assets WHERE id=$1', [a.id]);
    assert.equal(unchanged, 'In Store');
    const retired = await service.editAsset(request(itLead, a.version), a.id, retire);
    assert.equal(retired.status, 'Retired');
  });

  it('finance edits purchaseCost but not description', async () => {
    const a = await createAsset(IT);
    const edited = await service.editAsset(request(finance, a.version), a.id, {
      purchaseCost: '250.00',
      reason: 'Invoice received',
    });
    assert.equal(edited.purchaseCost, '250.00');
    await assert.rejects(
      service.editAsset(request(finance, edited.version), a.id, {
        description: `${tag} finance rewrite`,
        reason: 'Finance edit of non-finance field',
      }),
      status(403),
    );
    await assert.rejects(
      service.createAsset(request(itMember), {
        ...input,
        description: `${tag} member with cost`,
        purchaseCost: '10.00',
      }),
      (error: any) => {
        assert.equal(error.status, 403);
        assert.equal(error.message, 'Finance fields are set by Finance');
        return true;
      },
    );
    const plain = await service.createAsset(request(itMember), {
      ...input,
      description: `${tag} member create`,
    });
    assert.match(plain.assetCode, /^IAC-IT-\d{6}$/);
  });

  it('mixed finance and non-finance patch by member is rejected and nothing changes', async () => {
    const a = await createAsset(IT);
    const before = await snapshot(a.id);
    await assert.rejects(
      service.editAsset(request(itMember, a.version), a.id, {
        description: `${tag} mixed`,
        purchaseCost: '999.00',
        reason: 'Mixed patch',
      }),
      status(403),
    );
    const after = await snapshot(a.id);
    assert.deepEqual(after, before);
    assert.equal(after.version, a.version);
  });

  it('executive can list and read private columns but every write is 403', async () => {
    const a = await createAsset(IT, { purchaseCost: '77.00', supplier: 'Exec supplier' });
    const list = await service.assets(request(executive), { limit: 100, q: tag });
    assert.ok(list.items.some((x: any) => x.id === a.id));
    const read = await service.asset(request(executive), a.id);
    assert.equal(read.purchaseCost, '77.00');
    assert.equal(read.supplier, 'Exec supplier');
    const before = await snapshot(a.id);
    await assert.rejects(
      service.createAsset(request(executive), { ...input, description: `${tag} exec` }),
      status(403),
    );
    await assert.rejects(
      service.editAsset(request(executive, a.version), a.id, {
        description: 'Executive edit',
        reason: 'Not allowed',
      }),
      status(403),
    );
    await assert.rejects(
      service.editAsset(request(executive, a.version), a.id, {
        purchaseCost: '1.00',
        reason: 'Not allowed',
      }),
      status(403),
    );
    await assert.rejects(
      service.assign(request(executive, a.version), a.id, { userId: employee.id }),
      status(403),
    );
    assert.deepEqual(await snapshot(a.id), before);
  });

  it('employee still sees only own assigned assets', async () => {
    const mineAsset = await createAsset(IT);
    const notMine = await createAsset(ADM);
    await service.assign(request(superAdmin, mineAsset.version), mineAsset.id, {
      userId: employee.id,
    });
    const list = await service.assets(request(employee), { limit: 100, q: tag });
    assert.deepEqual(
      list.items.map((x: any) => x.id),
      [mineAsset.id],
    );
    assert.equal('purchaseCost' in list.items[0], false);
    await assert.rejects(service.asset(request(employee), notMine.id), status(404));
  });

  it('IT member can assign and return an IT asset but not an ADM asset', async () => {
    const itAsset = await createAsset(IT);
    const admAsset = await createAsset(ADM);
    const assigned = await service.assign(request(itMember, itAsset.version), itAsset.id, {
      userId: employee.id,
    });
    await assert.rejects(
      service.assign(request(itMember, admAsset.version), admAsset.id, { userId: employee.id }),
      status(403),
    );
    const admAssigned = await service.assign(request(superAdmin, admAsset.version), admAsset.id, {
      userId: employee.id,
    });
    await assert.rejects(
      service.returnAsset(request(itMember, admAssigned.version), admAssigned.id, {
        condition: 'Good',
        reason: 'Cross-team return',
      }),
      status(403),
    );
    const returned = await service.returnAsset(request(itMember, assigned.version), assigned.id, {
      condition: 'Good',
      reason: 'Team return',
    });
    assert.ok(returned.endedAt);
  });

  it('IT notification group resolves to IT team members', async () => {
    const notMember = await make(['EMPLOYEE']);
    await assert.rejects(
      service.updateGroup(request(superAdmin), 'IT', { enabled: true, recipients: [notMember.email] }),
      status(422),
    );
    await assert.rejects(
      service.updateGroup(request(itMember), 'IT', { enabled: true, recipients: [itMember.email] }),
      status(403),
    );
    await service.updateGroup(request(superAdmin), 'IT', {
      enabled: true,
      recipients: [itMember.email],
    });
    await service.updateGroup(request(superAdmin), 'ADMIN', {
      enabled: true,
      recipients: [superAdmin.email],
    });
    const recipients = await db.tx((c) => service.staffRecipients(c));
    assert.ok(recipients.includes(itMember.email));
    assert.ok(recipients.includes(superAdmin.email));
    const admins = await db.tx((c) => service.adminRecipients(c));
    assert.ok(admins.includes(superAdmin.email));
    assert.equal(admins.includes(itMember.email), false);
  });

  it('type to team enforcement rejects mismatch with 422 and allows super admin override and Projects facility use', async () => {
    // 1. ADM member tries to create Laptop in ADM -> 422 This asset type belongs to another team
    await assert.rejects(
      service.createAsset(request(admMember), {
        ...input,
        assetType: 'Laptop',
        owningTeamId: ADM,
        description: tag + ' adm laptop',
      }),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /This asset type belongs to another team/i);
        return true;
      },
    );

    // 2. IT member tries to create Chair in IT -> 422
    await assert.rejects(
      service.createAsset(request(itMember), {
        ...input,
        assetType: 'Chair',
        owningTeamId: IT,
        locationId,
        description: tag + ' it chair',
      }),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /This asset type belongs to another team/i);
        return true;
      },
    );

    // 3. Super Admin can override (create Laptop for ADM)
    const overridden = await service.createAsset(request(superAdmin), {
      ...input,
      assetType: 'Laptop',
      owningTeamId: ADM,
      description: tag + ' super admin override',
    });
    assert.equal(overridden.owningTeamId, ADM);

    // 4. Projects member creates Admin facility type (Chair) -> allowed
    const prjChair = await service.createAsset(request(prjMember), {
      ...input,
      assetType: 'Chair',
      owningTeamId: PRJ,
      projectId,
      locationId,
      description: tag + ' prj chair',
    });
    assert.equal(prjChair.owningTeamId, PRJ);
  });

  it('shared viewing: ADM user sees PRJ assets but cannot edit them', async () => {
    const prjAsset = await service.createAsset(request(superAdmin), {
      ...input,
      assetType: 'Chair',
      owningTeamId: PRJ,
      projectId,
      locationId,
      description: tag + ' shared prj asset',
    });

    // ADM member sees PRJ asset in list
    const list = await service.assets(request(admMember), { limit: 100, q: tag });
    assert.ok(list.items.some((x: any) => x.id === prjAsset.id));

    // ADM member can view PRJ asset detail
    const viewed = await service.asset(request(admMember), prjAsset.id);
    assert.equal(viewed.id, prjAsset.id);

    // ADM member CANNOT edit PRJ asset
    await assert.rejects(
      service.editAsset(request(admMember, prjAsset.version), prjAsset.id, {
        description: 'ADM trying to edit PRJ asset',
        reason: 'Unauthorized cross-team edit',
      }),
      status(403),
    );
  });

  it('PRJ user cannot see IT assets', async () => {
    const itAsset = await createAsset(IT);

    // PRJ member does not see IT asset in list
    const list = await service.assets(request(prjMember), { limit: 100, q: tag });
    assert.equal(list.items.some((x: any) => x.id === itAsset.id), false);

    // PRJ member gets 404 when trying to view IT asset
    await assert.rejects(service.asset(request(prjMember), itAsset.id), status(404));
  });

  it('Projects-owned chair ticket routes to Admin', async () => {
    const prjChair = await service.createAsset(request(superAdmin), {
      ...input,
      assetType: 'Chair',
      owningTeamId: PRJ,
      projectId,
      locationId,
      description: tag + ' prj chair for ticket',
    });

    const ticket = await service.createTicket(request(employee), {
      assetId: prjChair.id,
      subject: tag + ' broken chair',
      description: 'The chair leg is broken',
      category: 'HARDWARE',
      priority: 'LOW',
    });

    assert.equal(ticket.teamId, ADM);
  });

  it('team dashboard counts only scoped items', async () => {
    const itAsset = await createAsset(IT, { purchaseCost: '1000.00' });
    const admAsset = await createAsset(ADM, { purchaseCost: '500.00' });
    const prjAsset = await service.createAsset(request(superAdmin), {
      ...input,
      assetType: 'Chair',
      owningTeamId: PRJ,
      projectId,
      locationId,
      purchaseCost: '300.00',
      description: tag + ' prj asset for dashboard',
    });

    // Verify dashboard reads scoped items; IT assets excluded
    void itAsset;
    void admAsset;
    void prjAsset;

    const dash = await execService.team(request(admMember));
    assert.ok(dash);
    // ADM member sees ADM and PRJ assets, but NOT IT assets
    const countedTeamIds = dash.assetsByTeam ? dash.assetsByTeam.map((x: any) => x.teamId) : [];
    assert.ok(countedTeamIds.includes(ADM) || countedTeamIds.includes(PRJ));
    assert.equal(countedTeamIds.includes(IT), false);
  });
});
