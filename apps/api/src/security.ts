import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { configuration, equal, hash, isAllowedAppOrigin, validCsrf } from './config';
export interface Actor {
  requestId?: string;
  id: string;
  email: string;
  displayName: string;
  designation?: string | null;
  departmentId?: string | null;
  department?: string | null;
  pendingEmail?: string | null;
  roles: string[];
  state: string;
  version: number;
  portalAcceptedAt: string | null;
  portalNoticeVersion?: string | null;
  emailVerifiedAt: string | null;
  mfaEnrolled: boolean;
  mfaVerifiedAt: string | null;
  sessionScope: string;
  sessionHash: string;
}
export interface AuthRequest extends Request {
  user: Actor;
}
export const privileged = (user: Pick<Actor, 'roles'>) =>
  user.roles.some((r) => ['ADMIN', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE'].includes(r));
export const staff = (user: Pick<Actor, 'roles'>) => user.roles.some(r => r === 'ADMIN' || r === 'IT_ADMIN');
export function requireRole(req: AuthRequest, ...roles: string[]): void {
  if (!req.user.roles.some((r) => roles.includes(r)))
    throw new ForbiddenException('Insufficient permission');
}
export function assertVersion(req: Request, currentVersion: number): void {
  const match = req.get('If-Match');
  if (!match) throw new HttpException('If-Match is required', 428);
  if (match !== `"${currentVersion}"`)
    throw new HttpException('This record changed. Refresh and try again.', 412);
}
export async function resolveSession(db: Db, req: Request): Promise<Actor> {
  const id = req.cookies?.[configuration().sessionCookie];
  if (typeof id !== 'string' || id.length > 128)
    throw new UnauthorizedException('Sign in required');
  const [row] = await db.query(
    `SELECT u.*,d.name AS department,s.scope,s.mfa_verified_at,s.id_hash,coalesce(array_agg(ur.role_code) FILTER(WHERE ur.role_code IS NOT NULL),'{}') AS roles FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN user_roles ur ON ur.user_id=u.id WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND u.state='ACTIVE' GROUP BY u.id,d.name,s.id_hash`,
    [hash(id)],
  );
  if (!row || !row.email_verified_at) throw new UnauthorizedException('Sign in required');
  await db.query(
    "UPDATE sessions SET last_seen_at=now() WHERE id_hash=$1 AND last_seen_at<now()-interval '1 minute'",
    [row.id_hash],
  );
  return {
    requestId: String(req.res?.getHeader('X-Request-Id') || ''),
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    designation: row.designation,
    departmentId: row.department_id,
    department: row.department,
    pendingEmail: row.pending_email,
    roles: row.roles,
    state: row.state,
    version: row.version,
    portalAcceptedAt: row.portal_accepted_at,
    portalNoticeVersion: row.portal_notice_version,
    emailVerifiedAt: row.email_verified_at,
    mfaEnrolled: !!row.mfa_enrolled_at,
    mfaVerifiedAt: row.mfa_verified_at,
    sessionScope: row.scope,
    sessionHash: row.id_hash,
  };
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Db) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    req.user = await resolveSession(this.db, req);
    if (req.user.sessionScope !== 'APP' || (privileged(req.user) && !req.user.mfaVerifiedAt))
      throw new ForbiddenException('MFA enrollment or verification is required');
    if (
      !req.user.portalAcceptedAt ||
      req.user.portalNoticeVersion !== configuration().noticeVersion
    )
      throw new ForbiddenException('Accept portal access first');
    return true;
  }
}
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  if (!isAllowedAppOrigin(req.get('Origin') || '')) {
    res.status(403).json({
      error: {
        code: 'ORIGIN_INVALID',
        message: 'Request origin is not allowed',
        requestId: res.getHeader('X-Request-Id'),
      },
    });
    return;
  }
  const header = req.get('X-CSRF-Token');
  const cookie = req.cookies?.[configuration().csrfCookie];
  if (!validCsrf(cookie) || typeof header !== 'string' || !equal(header, cookie)) {
    res.status(403).json({
      error: {
        code: 'CSRF_INVALID',
        message: 'Refresh the page and try again',
        requestId: res.getHeader('X-Request-Id'),
      },
    });
    return;
  }
  next();
}
export const publicUser = (user: Actor) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  designation: user.designation ?? null,
  departmentId: user.departmentId ?? null,
  department: user.department ?? null,
  pendingEmail: user.pendingEmail ?? null,
  roles: user.roles,
  state: user.state,
  version: user.version,
  portalAcceptedAt: user.portalAcceptedAt,
  emailVerifiedAt: user.emailVerifiedAt,
  mfaEnrolled: user.mfaEnrolled,
  portalNoticeVersion: user.portalNoticeVersion,
  currentNoticeVersion: configuration().noticeVersion,
  enrollmentOnly: user.sessionScope === 'MFA_ENROLLMENT',
  mfaEnrollmentRequired: user.sessionScope === 'MFA_ENROLLMENT',
});
