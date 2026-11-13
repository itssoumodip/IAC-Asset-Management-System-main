import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import { Db } from './db';
import type { Actor } from './security';

/**
 * Super Admin "View as": see the portal exactly as another role or team sees it.
 *
 * The browser sends `X-View-As: role:FINANCE` or `team:<teamId>:LEAD|MEMBER`.
 * The server then evaluates every permission, page and data scope as that role,
 * keeps the admin's own identity (id, email) for anything personal, and refuses
 * every change: the preview is strictly read-only. Starting a preview is audited.
 */
export const VIEW_AS_HEADER = 'x-view-as';
export const VIEW_AS_ROLES = [
  'FINANCE',
  'EXECUTIVE',
  'STORE',
  'TECHNICIAN',
  'AUDITOR',
  'INSURER',
  'PROCUREMENT',
  'EMPLOYEE',
] as const;
type ViewAsRole = (typeof VIEW_AS_ROLES)[number];
export type ViewAsTarget =
  | { kind: 'role'; role: ViewAsRole }
  | { kind: 'team'; teamId: string; level: 'LEAD' | 'MEMBER' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseViewAs(value: string): ViewAsTarget {
  const [kind = '', first = '', second = '', ...rest] = value.trim().split(':');
  if (rest.length === 0 && kind === 'role' && second === '' && (VIEW_AS_ROLES as readonly string[]).includes(first))
    return { kind: 'role', role: first as ViewAsRole };
  if (
    rest.length === 0 &&
    kind === 'team' &&
    UUID.test(first) &&
    (second === 'LEAD' || second === 'MEMBER')
  )
    return { kind: 'team', teamId: first.toLowerCase(), level: second };
  throw new UnprocessableEntityException('Unknown "View as" choice');
}

export async function simulate(db: Db, actor: Actor, target: ViewAsTarget): Promise<Actor> {
  if (target.kind === 'team') {
    const [team] = await db.query('SELECT id,code,name,active FROM teams WHERE id=$1', [target.teamId]);
    if (!team || !team.active) throw new UnprocessableEntityException('That team is not active');
    return {
      ...actor,
      roles: ['EMPLOYEE'],
      teams: [{ teamId: team.id, teamCode: team.code, level: target.level }],
      assetViewFields: undefined,
      viewAs: {
        target: `team:${team.id}:${target.level}`,
        label: `${team.name} team ${target.level === 'LEAD' ? 'lead' : 'member'}`,
      },
    };
  }
  const roles = target.role === 'EMPLOYEE' ? ['EMPLOYEE'] : [target.role, 'EMPLOYEE'];
  const assetViewFields =
    target.role === 'INSURER'
      ? (
          await db.query(
            `SELECT field_name FROM role_field_permissions
             WHERE role_code='INSURER' AND can_view ORDER BY field_name`,
          )
        ).map((row) => row.field_name)
      : undefined;
  const label = target.role.charAt(0) + target.role.slice(1).toLowerCase();
  return {
    ...actor,
    roles,
    teams: [],
    assetViewFields,
    viewAs: { target: `role:${target.role}`, label },
  };
}

/**
 * Applies a requested preview to an already authenticated, MFA-verified actor.
 * Only a real Super Admin may preview, and only with read requests.
 */
export async function applyViewAs(db: Db, req: Request, actor: Actor): Promise<Actor> {
  const raw = req.get(VIEW_AS_HEADER);
  if (!raw) return actor;
  if (raw.length > 100) throw new UnprocessableEntityException('Unknown "View as" choice');
  if (!actor.roles.includes('SUPER_ADMIN'))
    throw new ForbiddenException('Only a Super Admin can use "View as"');
  if (!actor.mfaVerifiedAt) throw new ForbiddenException('Verify MFA before using "View as"');
  if (!['GET', 'HEAD'].includes(req.method))
    throw new ForbiddenException('"View as" is read-only. Exit the preview to make changes.');
  return simulate(db, actor, parseViewAs(raw));
}
