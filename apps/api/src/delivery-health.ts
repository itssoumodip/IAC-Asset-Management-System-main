import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole } from './security';
@Injectable()
export class DeliveryHealthService {
  constructor(@Inject(Db) private readonly db: Db) {}
  async overview(req: AuthRequest, query: unknown = {}) {
    requireRole(req, 'ADMIN');
    const p = z
      .object({
        state: z.enum(['ALL', 'PENDING', 'LEASED', 'ACCEPTED', 'DEAD']).default('ALL'),
        before: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(query);
    const values: any[] = [],
      where = ['TRUE'];
    if (p.state !== 'ALL') {
      values.push(p.state);
      where.push(`d.state=$${values.length}`);
    }
    if (p.before) {
      values.push(p.before);
      where.push(`d.id<$${values.length}::uuid`);
    }
    values.push(p.limit + 1);
    const [totals, rows] = await Promise.all([
      this.db.query(
        `SELECT count(*) FILTER(WHERE state='PENDING')::int AS pending,count(*) FILTER(WHERE state='LEASED')::int AS leased,count(*) FILTER(WHERE state='ACCEPTED')::int AS accepted,count(*) FILTER(WHERE state='DEAD')::int AS dead,count(*) FILTER(WHERE state='PENDING' AND next_attempt_at<now()-interval '5 minutes')::int AS overdue,count(*) FILTER(WHERE state='LEASED' AND leased_until<now())::int AS expired_leases FROM email_deliveries`,
      ),
      this.db.query(
        `SELECT d.id,d.recipient,d.state,d.attempts,d.next_attempt_at,d.leased_until,d.last_error_code,d.accepted_at,d.provider_message_id,o.template,o.created_at,o.expires_at,(SELECT json_agg(a ORDER BY a.attempt_number DESC) FROM (SELECT attempt_number,result_code,occurred_at FROM email_attempts WHERE delivery_id=d.id ORDER BY attempt_number DESC LIMIT 6) a) AS attempt_history FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT $${values.length}`,
        values,
      ),
    ]);
    return {
      summary: totals[0],
      items: rows.slice(0, p.limit),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1].id : null,
    };
  }
}
@Controller('admin/deliveries')
@UseGuards(SessionGuard)
export class DeliveryHealthController {
  constructor(@Inject(DeliveryHealthService) private readonly service: DeliveryHealthService) {}
  @Get() overview(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.overview(req, query);
  }
}
