import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse } from './domain-helpers';
import { can } from './policy';
import { AuthRequest, SessionGuard } from './security';

const period = z.object({ days: z.enum(['30', '90', '365', 'all']).optional() }).strict();

/**
 * Support desk insights: how many tickets were raised and fixed, how long a first reply and a fix
 * take, and how that splits by team, category and priority.
 *
 * Scope follows the role:
 * - Super Admin and reporting roles (Executive, Finance, Auditor) see every team;
 * - team leads and members see their own teams' queues only;
 * - everyone else sees the tickets they raised themselves.
 */
@Injectable()
export class TicketInsightsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async insights(req: AuthRequest, query: unknown) {
    const { days = '90' } = parse(period, query ?? {});
    const actor = req.user;
    const values: unknown[] = [];
    let scope: 'all' | 'team' | 'mine';
    let where: string;
    if (can(actor, 'report.view')) {
      scope = 'all';
      where = 'TRUE';
    } else if ((actor.teams ?? []).length) {
      scope = 'team';
      values.push(actor.teams.map((t) => t.teamId));
      where = `t.team_id = ANY($${values.length}::uuid[])`;
    } else {
      scope = 'mine';
      values.push(actor.id);
      where = `t.reporter_id = $${values.length}`;
    }
    const since =
      days === 'all' ? `'-infinity'::timestamptz` : `now() - interval '${Number(days)} days'`;

    // First public reply from someone other than the reporter (same rule as Response times).
    const withTimes = `
      SELECT t.*, tm.name AS team_name,
             EXTRACT(EPOCH FROM (fr.first_at - t.created_at)) / 3600 AS first_hours,
             EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600 AS fix_hours
        FROM tickets t
        JOIN teams tm ON tm.id = t.team_id
        LEFT JOIN LATERAL (
          SELECT MIN(u.created_at) AS first_at FROM ticket_updates u
           WHERE u.ticket_id = t.id AND u.actor_id <> t.reporter_id AND u.visibility = 'PUBLIC'
             AND u.kind IN ('COMMENT','STATUS_CHANGED')
        ) fr ON true
       WHERE ${where}`;

    const [[totals], byTeam, byCategory, byPriority, weeks, oldest] = await Promise.all([
      this.db.query(
        `WITH x AS (${withTimes})
         SELECT count(*) FILTER (WHERE created_at >= ${since})::int AS raised,
                count(*) FILTER (WHERE completed_at >= ${since})::int AS fixed,
                count(*) FILTER (WHERE status = 'OPEN')::int AS open,
                count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
                count(*) FILTER (WHERE status <> 'COMPLETED' AND owner_id IS NULL)::int AS unowned,
                count(*) FILTER (WHERE status <> 'COMPLETED' AND priority = 'HIGH')::int AS high_open,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY first_hours)
                  FILTER (WHERE created_at >= ${since} AND first_hours IS NOT NULL) AS median_first,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY fix_hours)
                  FILTER (WHERE completed_at >= ${since}) AS median_fix,
                avg(fix_hours) FILTER (WHERE completed_at >= ${since}) AS avg_fix,
                count(*) FILTER (WHERE completed_at >= ${since} AND fix_hours <= 48)::int AS fixed_in_2_days
           FROM x`,
        values,
      ),
      this.db.query(
        `WITH x AS (${withTimes})
         SELECT team_id, team_name,
                count(*) FILTER (WHERE created_at >= ${since})::int AS raised,
                count(*) FILTER (WHERE completed_at >= ${since})::int AS fixed,
                count(*) FILTER (WHERE status <> 'COMPLETED')::int AS open,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY fix_hours)
                  FILTER (WHERE completed_at >= ${since}) AS median_fix
           FROM x GROUP BY team_id, team_name ORDER BY raised DESC, team_name`,
        values,
      ),
      this.db.query(
        `SELECT t.category AS label, count(*)::int AS value
           FROM tickets t WHERE ${where} AND t.created_at >= ${since}
          GROUP BY 1 ORDER BY 2 DESC, 1`,
        values,
      ),
      this.db.query(
        `WITH x AS (${withTimes})
         SELECT priority AS label,
                count(*) FILTER (WHERE created_at >= ${since})::int AS raised,
                count(*) FILTER (WHERE status <> 'COMPLETED')::int AS open,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY fix_hours)
                  FILTER (WHERE completed_at >= ${since}) AS median_fix
           FROM x GROUP BY priority`,
        values,
      ),
      this.db.query(
        `WITH w AS (
           SELECT generate_series(date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') - interval '11 weeks',
                                  date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata'), interval '1 week') AS week_start)
         SELECT w.week_start,
                (SELECT count(*) FROM tickets t WHERE ${where}
                   AND t.created_at AT TIME ZONE 'Asia/Kolkata' >= w.week_start
                   AND t.created_at AT TIME ZONE 'Asia/Kolkata' < w.week_start + interval '1 week')::int AS opened,
                (SELECT count(*) FROM tickets t WHERE ${where}
                   AND t.completed_at AT TIME ZONE 'Asia/Kolkata' >= w.week_start
                   AND t.completed_at AT TIME ZONE 'Asia/Kolkata' < w.week_start + interval '1 week')::int AS completed
           FROM w ORDER BY w.week_start`,
        values,
      ),
      this.db.query(
        `SELECT t.id, t.ticket_number, t.subject, t.priority, t.status, t.owner_id, tm.name AS team_name,
                floor(EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400)::int AS age_days
           FROM tickets t JOIN teams tm ON tm.id = t.team_id
          WHERE ${where} AND t.status <> 'COMPLETED'
          ORDER BY t.created_at LIMIT 5`,
        values,
      ),
    ]);

    const hours = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
    return {
      scope,
      days,
      teams: scope === 'team' ? actor.teams.map((t) => t.teamCode) : [],
      totals: {
        raised: totals.raised,
        fixed: totals.fixed,
        open: totals.open,
        inProgress: totals.in_progress,
        unowned: totals.unowned,
        highOpen: totals.high_open,
        medianFirstResponseHours: hours(totals.median_first),
        medianFixHours: hours(totals.median_fix),
        averageFixHours: hours(totals.avg_fix),
        fixedWithinTwoDays: totals.fixed_in_2_days,
      },
      byTeam: byTeam.map((r: any) => ({
        teamId: r.team_id,
        team: r.team_name,
        raised: r.raised,
        fixed: r.fixed,
        open: r.open,
        medianFixHours: hours(r.median_fix),
      })),
      byCategory,
      byPriority: ['HIGH', 'MEDIUM', 'LOW'].map((p) => {
        const r: any = byPriority.find((x: any) => x.label === p) ?? {};
        return { priority: p, raised: r.raised ?? 0, open: r.open ?? 0, medianFixHours: hours(r.median_fix) };
      }),
      weeks: weeks.map((w: any) => ({ weekStart: w.week_start, opened: w.opened, completed: w.completed })),
      oldestOpen: oldest.map((r: any) => ({
        id: r.id,
        ticketNumber: Number(r.ticket_number),
        subject: r.subject,
        priority: r.priority,
        status: r.status,
        owned: !!r.owner_id,
        team: r.team_name,
        ageDays: r.age_days,
      })),
    };
  }
}

@Controller('support')
@UseGuards(SessionGuard)
export class TicketInsightsController {
  constructor(@Inject(TicketInsightsService) private readonly service: TicketInsightsService) {}

  @Get('insights')
  insights(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.insights(req, query);
  }
}
