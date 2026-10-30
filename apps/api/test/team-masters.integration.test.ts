import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { TeamService } from '../src/teams';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Team master integration tests require a database name ending _test');
const tag = `teammaster-${randomUUID()}`;
const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(65 + (b % 26))).join('');
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

describe('team masters and memberships PostgreSQL integration', { skip: !connection }, () => {
  let db: Db, domain: DomainService, teams: TeamService;
  let superAdmin: any, itLead: any, itMember: any, employee: any;
  const make = async (roles: string[]) => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic team master user',
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
  const newTeam = (extra: Record<string, unknown> = {}) =>
    domain.createMaster(request(superAdmin), 'teams', {
      code: letters(4),
      name: `${tag} team ${randomUUID().slice(0, 6)}`,
      assetCodePrefix: letters(5),
      reason: 'Synthetic team',
      ...extra,
    });

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    teams = new TeamService(db);
    for (const [kind, code] of [
      ['CATEGORY', 'Team Master Category'],
      ['ASSET_TYPE', 'Team Master Type'],
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
    itLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', IT_TEAM_ID);
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    employee = await make(['EMPLOYEE']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('super admin creates a team and its first asset code uses the new prefix', async () => {
    const team: any = await newTeam();
    const asset = await domain.createAsset(request(superAdmin), {
      owningTeamId: team.id,
      category: 'Team Master Category',
      assetType: 'Team Master Type',
      description: `${tag} first asset`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
    });
    assert.equal(asset.assetCode, `IAC-${team.assetCodePrefix}-000001`);
    const listed = (await domain.references()).teams.find((t: any) => t.id === team.id);
    assert.equal(listed.prefixInUse, true);
    await assert.rejects(
      domain.updateMaster(request(superAdmin, team.version), 'teams', team.id, {
        assetCodePrefix: letters(5),
        reason: 'Try to rename a used prefix',
      }),
      status(409),
    );
  });
  it('duplicate prefix is 409', async () => {
    const team: any = await newTeam();
    await assert.rejects(newTeam({ assetCodePrefix: team.assetCodePrefix }), status(409));
  });
  it('non super admin cannot create teams or projects', async () => {
    await assert.rejects(
      domain.createMaster(request(itLead), 'projects', {
        code: `P-${letters(6)}`,
        name: 'Lead project',
        startDate: '2026-01-01',
        reason: 'Not allowed',
      }),
      status(403),
    );
  });
  it('project end date must not precede start date', async () => {
    await assert.rejects(
      domain.createMaster(request(superAdmin), 'projects', {
        code: `P-${letters(6)}`,
        name: 'Backwards project',
        startDate: '2026-05-01',
        endDate: '2026-01-01',
        reason: 'Synthetic',
      }),
      status(422),
    );
  });
  it('IT lead adds a member to IT but gets 403 for ADM', async () => {
    const result = await teams.put(request(itLead), IT_TEAM_ID, employee.id, {
      level: 'MEMBER',
      reason: 'Joined IT',
    });
    assert.equal(result.level, 'MEMBER');
    const members = await teams.members(request(itLead), IT_TEAM_ID);
    assert.ok(members.items.some((m: any) => m.userId === employee.id && m.level === 'MEMBER'));
    await assert.rejects(
      teams.put(request(itLead), ADM_TEAM_ID, employee.id, { level: 'MEMBER', reason: 'No' }),
      status(403),
    );
  });
  it('member cannot manage members', async () => {
    await assert.rejects(teams.members(request(itMember), IT_TEAM_ID), status(403));
    await assert.rejects(
      teams.remove(request(itMember), IT_TEAM_ID, itLead.id, { reason: 'Coup' }),
      status(403),
    );
  });
  it('lead adds a colleague by email', async () => {
    const colleague = await make(['EMPLOYEE']);
    const added = await teams.add(request(itLead), IT_TEAM_ID, {
      email: colleague.email.toUpperCase(),
      level: 'MEMBER',
      reason: 'New starter',
    });
    assert.equal(added.userId, colleague.id);
    await assert.rejects(
      teams.add(request(itLead), IT_TEAM_ID, {
        email: 'nobody@example.org',
        level: 'MEMBER',
        reason: 'Unknown',
      }),
      status(404),
    );
  });
  it('lead searches active colleagues to add, excluding current members', async () => {
    const colleague = await make(['EMPLOYEE']);
    const found = await teams.candidates(request(itLead), IT_TEAM_ID, { q: colleague.email });
    assert.deepEqual(
      found.items.map((p: any) => p.id),
      [colleague.id],
    );
    const existing = await teams.candidates(request(itLead), IT_TEAM_ID, { q: itMember.email });
    assert.equal(existing.items.length, 0);
    await assert.rejects(teams.candidates(request(itMember), IT_TEAM_ID, {}), status(403));
  });
  it('membership change revokes target sessions and is audited', async () => {
    const target = await make(['EMPLOYEE']);
    await db.query(
      "INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')",
      [randomBytes(16).toString('hex'), target.id],
    );
    await teams.put(request(superAdmin), IT_TEAM_ID, target.id, {
      level: 'LEAD',
      reason: 'Promoted',
    });
    await teams.remove(request(superAdmin), IT_TEAM_ID, target.id, { reason: 'Left IT' });
    const [{ open }] = await db.query(
      'SELECT count(*)::int AS open FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
      [target.id],
    );
    assert.equal(open, 0);
    const audits = await db.query(
      "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='TEAM_MEMBERSHIP_CHANGED' ORDER BY occurred_at",
      [target.id],
    );
    assert.deepEqual(
      audits.map((a: any) => [a.changes.before, a.changes.after]),
      [
        [null, 'LEAD'],
        ['LEAD', null],
      ],
    );
  });
  it('asset type requiresCustodian toggle round-trips', async () => {
    await domain.updateMaster(request(superAdmin), 'ASSET_TYPE', 'Team Master Type', {
      requiresCustodian: false,
      reason: 'Kept in rooms',
    });
    const policy = (await domain.references()).assetTypePolicies.find(
      (p: any) => p.assetTypeCode === 'Team Master Type',
    );
    assert.equal(policy.requiresCustodian, false);
    await domain.updateMaster(request(superAdmin), 'ASSET_TYPE', 'Team Master Type', {
      requiresCustodian: true,
      reason: 'Back to people',
    });
    const again = (await domain.references()).assetTypePolicies.find(
      (p: any) => p.assetTypeCode === 'Team Master Type',
    );
    assert.equal(again.requiresCustodian, true);
  });
});
