import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import {
  can, assertCan, teamsFor, capabilities, privileged, TEAM_SCOPED, FINANCE_FIELDS, WRITE_OFF_STATUSES,
  type Action, type PolicyActor
} from '../src/policy';

const IT = '00000000-0000-4000-8000-000000000001';
const ADM = '00000000-0000-4000-8000-000000000002';
const ALL: Action[] = [
  'asset.view_all', 'asset.view_private', 'asset.create', 'asset.edit', 'asset.custody', 'asset.retire',
  'asset.import', 'asset.label', 'asset.photo', 'asset.finance_edit', 'asset.change_team',
  'team.manage_members', 'ticket.work', 'announcement.send', 'report.view', 'system.admin'
];
const TEAM_ALL: Action[] = ['asset.create', 'asset.edit', 'asset.custody', 'asset.retire', 'asset.import', 'asset.label', 'asset.photo', 'team.manage_members'];
const MEMBER_OWN: Action[] = ['asset.create', 'asset.edit', 'asset.custody', 'asset.label', 'asset.photo'];
const ANY_TEAM: Action[] = ['asset.view_all', 'asset.view_private', 'ticket.work', 'announcement.send'];

const sa: PolicyActor = { roles: ['SUPER_ADMIN', 'EMPLOYEE'] };
const itLead: PolicyActor = { roles: ['EMPLOYEE'], teams: [{ teamId: IT, teamCode: 'IT', level: 'LEAD' }] };
const itMember: PolicyActor = { roles: ['EMPLOYEE'], teams: [{ teamId: IT, teamCode: 'IT', level: 'MEMBER' }] };
const finance: PolicyActor = { roles: ['FINANCE', 'EMPLOYEE'] };
const exec: PolicyActor = { roles: ['EXECUTIVE', 'EMPLOYEE'] };
const employee: PolicyActor = { roles: ['EMPLOYEE'] };

// [label, actor, allowed on own team (IT), allowed globally (no team scoping / other team)]
const grants: Array<[string, PolicyActor, Set<Action>, Set<Action>]> = [
  ['super admin', sa, new Set(ALL), new Set(ALL)],
  ['IT lead', itLead, new Set([...TEAM_ALL, ...ANY_TEAM]), new Set(ANY_TEAM)],
  ['IT member', itMember, new Set([...MEMBER_OWN, ...ANY_TEAM]), new Set(ANY_TEAM)],
  ['finance', finance, new Set<Action>(['asset.view_all', 'asset.view_private', 'asset.finance_edit']), new Set<Action>(['asset.view_all', 'asset.view_private', 'asset.finance_edit'])],
  ['executive', exec, new Set<Action>(['asset.view_all', 'asset.view_private', 'report.view']), new Set<Action>(['asset.view_all', 'asset.view_private', 'report.view'])],
  ['employee', employee, new Set<Action>(), new Set<Action>()]
];

const expectations: Array<[string, PolicyActor, Action, string | undefined, boolean]> = [];
for (const [name, actor, own, other] of grants) {
  for (const action of ALL) {
    expectations.push([`${name} ${action} IT`, actor, action, IT, own.has(action)]);
    expectations.push([`${name} ${action} ADM`, actor, action, ADM, name === 'IT lead' || name === 'IT member' ? other.has(action) : own.has(action)]);
    // no teamId: team-scoped actions only for super admin
    const noTeam = TEAM_ALL.includes(action) ? name === 'super admin' : own.has(action);
    expectations.push([`${name} ${action} no team`, actor, action, undefined, noTeam]);
  }
}

for (const [label, actor, action, teamId, expected] of expectations) {
  test(`policy: ${label}`, () => assert.equal(can(actor, action, teamId), expected));
}

test('multi-team uses the level for the asset\'s team', () => {
  const a: PolicyActor = { roles: ['EMPLOYEE'], teams: [
    { teamId: IT, teamCode: 'IT', level: 'MEMBER' }, { teamId: ADM, teamCode: 'ADM', level: 'LEAD' }] };
  assert.equal(can(a, 'asset.retire', ADM), true);
  assert.equal(can(a, 'asset.retire', IT), false);
  assert.equal(can(a, 'asset.edit', IT), true);
});

test('teamsFor returns ALL for super admin and own ids otherwise', () => {
  assert.equal(teamsFor(sa, 'asset.edit'), 'ALL');
  assert.deepEqual(teamsFor(itLead, 'asset.retire'), [IT]);
  assert.deepEqual(teamsFor(itMember, 'asset.retire'), []);
  assert.deepEqual(teamsFor(itMember, 'asset.edit'), [IT]);
  assert.deepEqual(teamsFor(employee, 'asset.edit'), []);
  assert.equal(teamsFor(finance, 'asset.finance_edit'), 'ALL');
  assert.equal(teamsFor(itMember, 'asset.view_all'), 'ALL');
  assert.deepEqual(teamsFor(employee, 'asset.view_all'), []);
});

test('FINANCE + IT MEMBER combines global and team grants', () => {
  const a: PolicyActor = { roles: ['FINANCE', 'EMPLOYEE'], teams: [{ teamId: IT, teamCode: 'IT', level: 'MEMBER' }] };
  assert.equal(can(a, 'asset.finance_edit', ADM), true);
  assert.equal(can(a, 'asset.finance_edit', IT), true);
  assert.equal(can(a, 'asset.edit', IT), true);
  assert.equal(can(a, 'asset.edit', ADM), false);
});

test('capabilities lists every team of a two-team actor', () => {
  const a: PolicyActor = { roles: ['EMPLOYEE'], teams: [
    { teamId: IT, teamCode: 'IT', level: 'MEMBER' }, { teamId: ADM, teamCode: 'ADM', level: 'LEAD' }] };
  const c = capabilities(a);
  assert.deepEqual(new Set(Object.keys(c.teams)), new Set([IT, ADM]));
  assert.ok(!c.teams[IT].includes('asset.retire'));
  assert.ok(c.teams[ADM].includes('asset.retire'));
});

test('privileged false only for plain EMPLOYEE without teams', () => {
  assert.equal(privileged(employee), false);
  assert.equal(privileged({ roles: [] }), false);
  assert.equal(privileged(itMember), true);
  assert.equal(privileged(finance), true);
  assert.equal(privileged(exec), true);
  assert.equal(privileged(sa), true);
});

test('assertCan throws 403', () => {
  assert.throws(() => assertCan(employee, 'asset.edit', IT), (e: unknown) =>
    e instanceof ForbiddenException && e.getStatus() === 403 && e.message === 'Insufficient permission');
  assert.doesNotThrow(() => assertCan(itMember, 'asset.edit', IT));
});

test('capabilities is JSON-serialisable and splits global vs team', () => {
  const c = capabilities(itLead);
  assert.deepEqual(new Set(c.global), new Set(ANY_TEAM));
  assert.deepEqual(new Set(c.teams[IT]), new Set(TEAM_ALL));
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  assert.deepEqual(new Set(capabilities(sa).global), new Set(ALL));
  assert.deepEqual(capabilities(employee), { global: [], teams: {} });
  assert.deepEqual(new Set(capabilities(finance).global), new Set(['asset.view_all', 'asset.view_private', 'asset.finance_edit']));
});

test('constants', () => {
  assert.deepEqual([...TEAM_SCOPED].sort(), [...TEAM_ALL].sort());
  assert.equal(FINANCE_FIELDS.length, 11);
  assert.ok(FINANCE_FIELDS.includes('financePending'));
  assert.deepEqual([...WRITE_OFF_STATUSES].sort(), ['Disposed', 'Lost', 'Retired', 'Sold', 'Stolen']);
});
