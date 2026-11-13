import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { can } from '../src/policy';
import { applyViewAs, parseViewAs } from '../src/view-as-core';
import { ViewAsController } from '../src/view-as';
import { IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('View-as integration requires a database ending _test');

const actor = (roles: string[], extra: Record<string, unknown> = {}): any => ({
  id: randomUUID(),
  email: `view-as-${randomUUID()}@example.org`,
  displayName: 'View as test',
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
  ...extra,
});
const req = (method: string, header?: string): any => ({
  method,
  get: (name: string) => (name.toLowerCase() === 'x-view-as' ? header : undefined),
});
const status = (code: number) => (error: any) => {
  assert.equal(error.status ?? error.getStatus?.(), code);
  return true;
};

describe('parseViewAs', () => {
  it('accepts roles and team levels, rejects anything else', () => {
    assert.deepEqual(parseViewAs('role:FINANCE'), { kind: 'role', role: 'FINANCE' });
    assert.deepEqual(parseViewAs(`team:${IT_TEAM_ID}:LEAD`), {
      kind: 'team',
      teamId: IT_TEAM_ID,
      level: 'LEAD',
    });
    for (const bad of ['role:SUPER_ADMIN', 'role:FINANCE:x', 'team:not-a-uuid:LEAD', `team:${IT_TEAM_ID}:BOSS`, ''])
      assert.throws(() => parseViewAs(bad), status(422), bad);
  });
});

describe('View as PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db;
  before(() => {
    db = new Db();
  });
  after(async () => db?.onModuleDestroy());

  it('leaves requests without a preview untouched', async () => {
    const admin = actor(['SUPER_ADMIN']);
    assert.equal(await applyViewAs(db, req('GET'), admin), admin);
  });

  it('only a Super Admin with MFA may preview', async () => {
    await assert.rejects(applyViewAs(db, req('GET', 'role:FINANCE'), actor(['FINANCE'])), status(403));
    await assert.rejects(
      applyViewAs(db, req('GET', 'role:FINANCE'), actor(['SUPER_ADMIN'], { mfaVerifiedAt: null })),
      status(403),
    );
  });

  it('a role preview gets exactly that role and loses admin rights', async () => {
    const admin = actor(['SUPER_ADMIN']);
    const finance = await applyViewAs(db, req('GET', 'role:FINANCE'), admin);
    assert.deepEqual(finance.roles, ['FINANCE', 'EMPLOYEE']);
    assert.deepEqual(finance.teams, []);
    assert.equal(finance.id, admin.id);
    assert.equal(finance.viewAs?.label, 'Finance');
    assert.equal(can(finance, 'asset.finance_edit'), true);
    assert.equal(can(finance, 'system.admin'), false);
  });

  it('a team preview acts as a member or lead of that team only', async () => {
    const admin = actor(['SUPER_ADMIN']);
    const lead = await applyViewAs(db, req('GET', `team:${IT_TEAM_ID}:LEAD`), admin);
    assert.deepEqual(lead.roles, ['EMPLOYEE']);
    assert.equal(lead.teams[0]?.teamId, IT_TEAM_ID);
    assert.equal(can(lead, 'team.manage_members', IT_TEAM_ID), true);
    assert.equal(can(lead, 'system.admin'), false);
    const member = await applyViewAs(db, req('GET', `team:${IT_TEAM_ID}:MEMBER`), admin);
    assert.equal(can(member, 'team.manage_members', IT_TEAM_ID), false);
    await assert.rejects(
      applyViewAs(db, req('GET', `team:${randomUUID()}:MEMBER`), admin),
      status(422),
    );
  });

  it('a preview is read-only: every change is refused', async () => {
    const admin = actor(['SUPER_ADMIN']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      await assert.rejects(applyViewAs(db, req(method, 'role:STORE'), admin), status(403), method);
  });

  it('starting a preview is audited', async () => {
    const admin = actor(['SUPER_ADMIN']);
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [admin.id, admin.email, admin.displayName],
    );
    const controller = new ViewAsController(db);
    const started = await controller.start({ user: admin } as any, { target: 'role:AUDITOR' });
    assert.equal(started.label, 'Auditor');
    const [audit] = await db.query(
      "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='VIEW_AS_STARTED'",
      [admin.id],
    );
    assert.equal(audit.changes.target, 'role:AUDITOR');
    await assert.rejects(controller.start({ user: actor(['FINANCE']) } as any, { target: 'role:AUDITOR' }), status(403));
  });
});
