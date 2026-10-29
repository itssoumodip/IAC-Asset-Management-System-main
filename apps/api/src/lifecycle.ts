import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole } from './security';
import { camel } from './domain-helpers';
@Injectable()
export class LifecycleService {
  constructor(@Inject(Db) private readonly db: Db) {}
  async expiry(req: AuthRequest, query: unknown = {}) {
    requireRole(req, 'ADMIN');
    const p = z
      .object({
        window: z.enum(['EXPIRED', 'DUE30', 'DUE90', 'MISSING']).default('DUE30'),
        after: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(query);
    return this.db.tx(async (c) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], c);
      const [today] = await this.db.query(
        "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date today",
        [],
        c,
      );
      const condition =
        p.window === 'EXPIRED'
          ? '(a.warranty_expiry<$1 OR a.amc_applies AND a.amc_expiry<$1)'
          : p.window === 'MISSING'
            ? '($1::date IS NOT NULL AND (a.warranty_expiry IS NULL OR a.amc_applies AND a.amc_expiry IS NULL))'
            : `(a.warranty_expiry BETWEEN $1::date AND $1::date+${p.window === 'DUE30' ? 30 : 90} OR a.amc_applies AND a.amc_expiry BETWEEN $1::date AND $1::date+${p.window === 'DUE30' ? 30 : 90})`;
      const [counts] = await this.db.query(
        `SELECT count(*)::int total FROM assets a WHERE ${condition}`,
        [today.today],
        c,
      );
      const rows = await this.db.query(
        `SELECT a.id,a.asset_code,a.description,a.status,a.warranty_expiry,a.amc_applies,a.amc_expiry,d.name AS department,l.site,l.room FROM assets a LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN locations l ON l.id=a.location_id WHERE ${condition} AND ($2::text IS NULL OR a.asset_code>$2) ORDER BY a.asset_code LIMIT $3`,
        [today.today, p.after ?? null, p.limit + 1],
        c,
      );
      const items = rows.slice(0, p.limit).map(camel);
      return {
        items,
        total: counts.total,
        today: today.today,
        timezone: 'Asia/Kolkata',
        nextCursor: rows.length > p.limit ? items.at(-1)!.assetCode : null,
        definition:
          'All registered asset statuses; dates are recorded warranty/AMC evidence, not verified vendor coverage. Due windows include today and the endpoint. AMC dates apply only when AMC applies. Missing dates need review, not automatic renewal. No notification, purchase or renewal is sent by viewing this queue.',
      };
    });
  }
  async recovery(req: AuthRequest, query: unknown = {}) {
    requireRole(req, 'ADMIN');
    const p = z
      .object({
        q: z.string().trim().max(100).optional(),
        after: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(query);
    return this.db.tx(async (c) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], c);
      const values = [p.q ?? '', p.after ?? null, p.limit + 1];
      const rows = await this.db.query(
        `SELECT u.id,u.display_name,u.email,u.state,u.designation,d.name department,count(a.id)::int outstanding,count(a.id)FILTER(WHERE a.acknowledgement='DISPUTED')::int disputed,min(a.assigned_at) AS earliest_assignment FROM users u JOIN assignments a ON a.user_id=u.id AND a.ended_at IS NULL LEFT JOIN departments d ON d.id=u.department_id WHERE ($1='' OR strpos(lower(u.display_name||' '||u.email),lower($1))>0) AND ($2::uuid IS NULL OR u.id>$2) GROUP BY u.id,d.name ORDER BY u.id LIMIT $3`,
        values,
        c,
      );
      const items = rows.slice(0, p.limit).map(camel);
      return {
        items,
        nextCursor: rows.length > p.limit ? items.at(-1)!.id : null,
        definition:
          'Current outstanding custody for recovery planning, including disabled or role-changed accounts. This is not a list of confirmed leavers. Open a person to review and return each item through the existing reason/version-checked return flow. No bulk return, account disable, HR action or employee liability decision is inferred.',
      };
    });
  }
}
@Controller('lifecycle')
@UseGuards(SessionGuard)
export class LifecycleController {
  constructor(@Inject(LifecycleService) private readonly service: LifecycleService) {}
  @Get('expiry') expiry(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.service.expiry(r, q);
  }
  @Get('recovery') recovery(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.service.recovery(r, q);
  }
}
