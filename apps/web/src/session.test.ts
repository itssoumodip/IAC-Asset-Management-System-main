import { describe, expect, it } from 'vitest';
import { can, isStaff } from './session';
import type { User } from './types';

function makeUser(capabilities: User['capabilities']): User {
  return {
    id: 'u1',
    email: 'a@b.c',
    displayName: 'A',
    roles: ['EMPLOYEE'],
    teams: [],
    capabilities,
    state: 'ACTIVE',
    emailVerifiedAt: null,
    portalAcceptedAt: null,
    version: 1,
  };
}

describe('can', () => {
  it('global capability applies to any team', () => {
    const user = makeUser({ global: ['asset.view_all'], teams: {} });
    expect(can(user, 'asset.view_all')).toBe(true);
    expect(can(user, 'asset.view_all', 'team-1')).toBe(true);
    expect(can(user, 'asset.edit', 'team-1')).toBe(false);
  });

  it('team capability applies only to that team', () => {
    const user = makeUser({ global: [], teams: { 'team-1': ['asset.edit'] } });
    expect(can(user, 'asset.edit', 'team-1')).toBe(true);
    expect(can(user, 'asset.edit', 'team-2')).toBe(false);
    expect(can(user, 'asset.edit')).toBe(true);
    expect(can(user, 'asset.retire')).toBe(false);
  });

  it('undefined user can nothing', () => {
    expect(can(undefined, 'asset.view_all')).toBe(false);
    expect(can(undefined, 'asset.edit', 'team-1')).toBe(false);
  });
});

describe('isStaff', () => {
  it('executive with only report.view is not ticket staff', () => {
    expect(isStaff(makeUser({ global: ['report.view'], teams: {} }))).toBe(false);
    expect(isStaff(makeUser({ global: ['ticket.work'], teams: {} }))).toBe(true);
  });
});
