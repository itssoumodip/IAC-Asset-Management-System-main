import 'reflect-metadata';
import { describe, it, expect } from 'node:test';
import { assetScope } from './src/domain-helpers';
import type { Actor } from './src/types';

describe('assetScope new behavior', () => {
  it('SUPER_ADMIN sees all assets (TRUE)', () => {
    const actor: Actor = { roles: ['SUPER_ADMIN'], teams: [] };
    expect(assetScope(actor, [])).toBe('TRUE');
  });

  it('FINANCE sees all assets (TRUE)', () => {
    const actor: Actor = { roles: ['FINANCE'], teams: [] };
    expect(assetScope(actor, [])).toBe('TRUE');
  });

  it('EXECUTIVE sees all assets (TRUE)', () => {
    const actor: Actor = { roles: ['EXECUTIVE'], teams: [] };
    expect(assetScope(actor, [])).toBe('TRUE');
  });

  it('IT team member sees only own team assets clause', () => {
    const actor: Actor = {
      roles: ['EMPLOYEE'],
      teams: [{ teamId: '00000000-0000-4000-8000-000000000001', teamCode: 'IT', level: 'MEMBER' }],
    };
    const scope = assetScope(actor, []);
    expect(scope).not.toBe('FALSE');
    expect(scope).toContain('owning_team_id');
  });

  it('EMPLOYEE without teams sees assets assigned to them clause', () => {
    const actor: Actor = { roles: ['EMPLOYEE'], teams: [] };
    const scope = assetScope(actor, []);
    expect(scope).not.toBe('FALSE');
    expect(scope).toContain('assignments');
  });

  it('EMPLOYEE with team but no assignments returns FALSE', () => {
    const actor: Actor = {
      roles: ['EMPLOYEE'],
      teams: [{ teamId: '00000000-0000-4000-8000-000000000001', teamCode: 'IT', level: 'MEMBER' }],
    };
    const scope = assetScope(actor, []);
    expect(scope).toBe('FALSE');
  });
});