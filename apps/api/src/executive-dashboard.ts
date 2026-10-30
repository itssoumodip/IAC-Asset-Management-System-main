import { Controller, ForbiddenException, Get, Inject, Injectable, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

const TZ = "'Asia/Kolkata'";
const TODAY = `(now() AT TIME ZONE ${TZ})::date`;
const fyLabel = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;

/** Executive overview: every section is one aggregate query; no per-row work in Node. */
@Injectable()
export class ExecutiveDashboardService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async summary(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const [assetsByTeam, [attention], spendByProject, spendByFy, weeks, teams] = await Promise.all([
      this.db.query(
        `SELECT a.owning_team_id AS "teamId",t.name AS "teamName",a.status,count(*)::int AS count,
           coalesce(sum(a.purchase_cost) FILTER(WHERE a.currency='INR'),0)::float8 AS value
         FROM assets a JOIN teams t ON t.id=a.owning_team_id
         GROUP BY a.owning_team_id,t.name,a.status ORDER BY t.name,a.status`,
      ),
      this.db.query(
        `SELECT
           (SELECT count(*)::int FROM assets WHERE finance_status<>'APPROVED') AS "pendingFinance",
           (SELECT count(DISTINCT g.asset_id)::int FROM assignments g JOIN users u ON u.id=g.user_id
             WHERE g.ended_at IS NULL AND u.left_at IS NOT NULL) AS "leftHoldersWithAssets",
           (SELECT count(*)::int FROM assets WHERE warranty_expiry BETWEEN ${TODAY} AND ${TODAY}+30) AS "warrantyExpiring30",
           (SELECT count(*)::int FROM assets WHERE amc_applies AND amc_expiry BETWEEN ${TODAY} AND ${TODAY}+30) AS "amcExpiring30",
           (SELECT count(*)::int FROM tickets WHERE status<>'COMPLETED' AND priority='HIGH') AS "openHighTickets"`,
      ),
      this.db.query(
        `SELECT a.project_id AS "projectId",coalesce(p.name,'No project') AS label,
           sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
         FROM assets a LEFT JOIN projects p ON p.id=a.project_id
         WHERE a.purchase_cost IS NOT NULL AND a.currency='INR'
         GROUP BY a.project_id,p.name ORDER BY spend DESC,label LIMIT 20`,
      ),
      this.db.query(
        `SELECT extract(year FROM a.purchase_date - interval '3 months')::int AS "fyStart",
           sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
         FROM assets a
         WHERE a.purchase_cost IS NOT NULL AND a.currency='INR' AND a.purchase_date IS NOT NULL
         GROUP BY 1 ORDER BY 1 DESC LIMIT 15`,
      ),
      this.db.query(
        `WITH bounds AS (
           SELECT (date_trunc('week',${TODAY})::date-77)::timestamp AT TIME ZONE ${TZ} AS since),
         o AS (
           SELECT t.team_id,date_trunc('week',t.created_at AT TIME ZONE ${TZ})::date AS ws,count(*)::int AS n
           FROM tickets t,bounds WHERE t.created_at>=bounds.since GROUP BY 1,2),
         c AS (
           SELECT t.team_id,date_trunc('week',t.completed_at AT TIME ZONE ${TZ})::date AS ws,count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.completed_at-t.created_at)/3600)::float8 AS median
           FROM tickets t,bounds WHERE t.completed_at>=bounds.since GROUP BY 1,2)
         SELECT coalesce(o.team_id,c.team_id) AS "teamId",to_char(coalesce(o.ws,c.ws),'YYYY-MM-DD') AS "weekStart",
           coalesce(o.n,0) AS opened,coalesce(c.n,0) AS completed,c.median AS "medianHours"
         FROM o FULL JOIN c ON c.team_id=o.team_id AND c.ws=o.ws ORDER BY 2,1`,
      ),
      this.db.query(
        `WITH bounds AS (
           SELECT (date_trunc('week',${TODAY})::date-77)::timestamp AT TIME ZONE ${TZ} AS since)
         SELECT t.id AS "teamId",t.name AS "teamName",
           count(k.id) FILTER(WHERE k.created_at>=bounds.since)::int AS opened,
           count(k.id) FILTER(WHERE k.completed_at>=bounds.since)::int AS completed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM k.completed_at-k.created_at)/3600)
             FILTER(WHERE k.completed_at>=bounds.since)::float8 AS "medianResolutionHours"
         FROM teams t CROSS JOIN bounds LEFT JOIN tickets k ON k.team_id=t.id
           AND (k.created_at>=bounds.since OR k.completed_at>=bounds.since)
         GROUP BY t.id,t.name ORDER BY t.name`,
      ),
    ]);
    return {
      assetsByTeam,
      needsAttention: attention,
      spendByProject,
      spendByFy: spendByFy.map((row: any) => ({ ...row, label: fyLabel(row.fyStart) })),
      ticketTrends: { weeks, teams },
    };
  }

  async team(req: AuthRequest) {
    const isGlobal = req.user.roles.some((r) => ['SUPER_ADMIN', 'FINANCE', 'EXECUTIVE'].includes(r));
    const userTeams = (req.user.teams ?? []).map((t) => t.teamId);
    if (!isGlobal && !userTeams.length) {
      throw new ForbiddenException('Team members only');
    }

    let scopedTeamIds: string[] | null = null;
    if (!isGlobal) {
      const grantRows = await this.db.query(
        'SELECT owner_team_id FROM team_view_grants WHERE viewer_team_id = ANY($1::uuid[])',
        [userTeams],
      );
      scopedTeamIds = Array.from(new Set([...userTeams, ...grantRows.map((r: any) => r.owner_team_id)]));
    }

    const assetFilter = scopedTeamIds
      ? 'WHERE a.owning_team_id = ANY($1::uuid[])'
      : '';
    const assetFilterAnd = scopedTeamIds
      ? 'AND a.owning_team_id = ANY($1::uuid[])'
      : '';
    const values = scopedTeamIds ? [scopedTeamIds] : [];

    const [assetsByTeam, [attention], openTickets] = await Promise.all([
      this.db.query(
        `SELECT a.owning_team_id AS "teamId",t.name AS "teamName",a.status,count(*)::int AS count,
           coalesce(sum(a.purchase_cost) FILTER(WHERE a.currency='INR'),0)::float8 AS value
         FROM assets a JOIN teams t ON t.id=a.owning_team_id
         ${assetFilter}
         GROUP BY a.owning_team_id,t.name,a.status ORDER BY t.name,a.status`,
        values,
      ),
      this.db.query(
        `SELECT
           (SELECT count(*)::int FROM assets a WHERE a.finance_status<>'APPROVED' ${assetFilterAnd}) AS "pendingFinance",
           (SELECT count(DISTINCT g.asset_id)::int FROM assignments g JOIN users u ON u.id=g.user_id JOIN assets a ON a.id=g.asset_id
             WHERE g.ended_at IS NULL AND u.left_at IS NOT NULL ${assetFilterAnd}) AS "leftHoldersWithAssets",
           (SELECT count(*)::int FROM assets a WHERE a.warranty_expiry BETWEEN ${TODAY} AND ${TODAY}+30 ${assetFilterAnd}) AS "warrantyExpiring30",
           (SELECT count(*)::int FROM assets a WHERE a.amc_applies AND a.amc_expiry BETWEEN ${TODAY} AND ${TODAY}+30 ${assetFilterAnd}) AS "amcExpiring30"`,
        values,
      ),
      this.db.query(
        `SELECT count(*)::int AS count
         FROM tickets t
         WHERE t.status<>'COMPLETED' ${userTeams.length && !isGlobal ? 'AND t.team_id = ANY($1::uuid[])' : ''}`,
        userTeams.length && !isGlobal ? [userTeams] : [],
      ),
    ]);

    return {
      assetsByTeam,
      needsAttention: attention,
      openTickets: openTickets[0]?.count ?? 0,
      scopedTeamIds: scopedTeamIds ?? 'ALL',
    };
  }
}

@Controller('dashboard')
@UseGuards(SessionGuard)
export class ExecutiveDashboardController {
  constructor(@Inject(ExecutiveDashboardService) private readonly service: ExecutiveDashboardService) {}

  @Get('executive')
  summary(@Req() req: AuthRequest) {
    return this.service.summary(req);
  }

  @Get('team')
  team(@Req() req: AuthRequest) {
    return this.service.team(req);
  }
}
