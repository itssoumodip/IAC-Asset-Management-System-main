import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assetCarePage, assetCareSummary } from './asset-care';
import { assertCan, can } from './policy';
import { ticketScope } from './domain-helpers';

/** Specialized warranty/AMC and ticket timing views used by their owning sections. */
@Injectable()
export class ReportsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Every live asset in the viewer's scope with its warranty and AMC dates (see asset-care.ts). */
  async warrantyExpiry(req: AuthRequest, query: unknown) {
    return assetCarePage(this.db, req.user, ['report.view'], query, 'warranty');
  }

  /** Warranty and AMC counts for the page and the dashboards (worked out in the database). */
  async warrantySummary(req: AuthRequest) {
    return assetCareSummary(this.db, req.user, ['report.view']);
  }

  async ticketResponseTimes(req: AuthRequest) {
    if (!can(req.user, 'report.view') && !can(req.user, 'ticket.work'))
      assertCan(req.user, 'report.view');
    const values: any[] = [];
    const scope = can(req.user, 'report.view') ? 'TRUE' : ticketScope(req.user, values);
    const rows = await this.db.query(
      `
      SELECT t.id, t.ticket_number, t.subject, tm.name AS team_name,
             t.status, t.priority, t.created_at, t.completed_at,response.first_response_at,
             EXTRACT(EPOCH FROM (response.first_response_at - t.created_at)) / 3600 AS response_time_hours,
             EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600 AS resolution_time_hours
      FROM tickets t
      JOIN teams tm ON tm.id = t.team_id
      LEFT JOIN LATERAL (
        SELECT MIN(u.created_at) AS first_response_at FROM ticket_updates u
        WHERE u.ticket_id=t.id AND u.actor_id<>t.reporter_id AND u.visibility='PUBLIC'
          AND u.kind IN ('COMMENT','STATUS_CHANGED')
      ) response ON true
      WHERE ${scope}
      ORDER BY t.created_at DESC
    `,
      values,
    );
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        ticketNumber: r.ticket_number,
        subject: r.subject,
        teamName: r.team_name,
        status: r.status,
        priority: r.priority,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        firstResponseAt: r.first_response_at,
        responseTimeHours:
          r.response_time_hours != null
            ? Math.round(Number(r.response_time_hours) * 100) / 100
            : null,
        resolutionTimeHours:
          r.resolution_time_hours != null
            ? Math.round(Number(r.resolution_time_hours) * 100) / 100
            : null,
      })),
    };
  }
}

@Controller('reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly service: ReportsService) {}

  @Get('warranty-expiry/summary')
  warrantySummary(@Req() req: AuthRequest) {
    return this.service.warrantySummary(req);
  }

  @Get('warranty-expiry')
  warrantyExpiry(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.warrantyExpiry(req, query);
  }

  @Get('ticket-response-times')
  ticketResponseTimes(@Req() req: AuthRequest) {
    return this.service.ticketResponseTimes(req);
  }
}
