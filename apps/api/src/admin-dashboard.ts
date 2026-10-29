import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, text, uuid } from './domain-helpers';
import { AuthRequest, requireRole, SessionGuard } from './security';

const filterInput = z
  .object({
    fy: z
      .string()
      .regex(/^\d{4}$/)
      .transform(Number)
      .optional(),
    departmentId: uuid.optional(),
    category: text(100).optional(),
  })
  .strict();

const TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const fyLabel = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
const top = <T extends { spend: number; count: number }>(rows: T[], limit: number) =>
  rows.length <= limit
    ? rows
    : [
        ...rows.slice(0, limit - 1),
        rows.slice(limit - 1).reduce(
          (other, row) => ({
            label: 'Other',
            spend: other.spend + row.spend,
            count: other.count + row.count,
          }),
          { label: 'Other', spend: 0, count: 0 },
        ),
      ];

@Injectable()
export class AdminDashboardService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async summary(req: AuthRequest, query: unknown) {
    requireRole(req, 'ADMIN');
    const filters = parse(filterInput, query);
    const values: any[] = [];
    const where = ['TRUE'];
    if (filters.departmentId) {
      values.push(filters.departmentId);
      where.push(`a.department_id=$${values.length}`);
    }
    if (filters.category) {
      values.push(filters.category);
      where.push(`a.category=$${values.length}`);
    }
    const scoped = filters.departmentId !== undefined || filters.category !== undefined;
    const assetWhere = where.join(' AND ');
    // Financial year runs April to March; default to the current one for the KPI.
    const fyValues = [...values, filters.fy ?? null];
    const fy = `$${fyValues.length}::int`;
    const fyStart = `coalesce(${fy},extract(year FROM ${TODAY} - interval '3 months')::int)`;
    const inFy = `a.purchase_date>=make_date(${fyStart},4,1) AND a.purchase_date<make_date(${fyStart}+1,4,1)`;
    const spendFilter = filters.fy === undefined ? 'TRUE' : inFy;
    const priced = "a.purchase_cost IS NOT NULL AND a.currency='INR'";
    const ticketAsset = scoped
      ? `EXISTS(SELECT 1 FROM assets a WHERE a.id=t.asset_id AND ${assetWhere})`
      : 'TRUE';

    return this.db.tx(async (c) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], c);
      const [kpis] = await this.db.query(
        `SELECT count(*)::int AS total_assets,
        coalesce(sum(a.purchase_cost) FILTER(WHERE ${priced}),0)::float8 AS total_spend,
        coalesce(sum(a.purchase_cost) FILTER(WHERE ${priced} AND ${inFy}),0)::float8 AS fy_spend,
        ${fyStart} AS fy_start,
        count(*) FILTER(WHERE a.purchase_cost IS NULL)::int AS missing_cost,
        count(*) FILTER(WHERE a.status='Assigned')::int AS assigned,
        count(*) FILTER(WHERE a.warranty_expiry BETWEEN ${TODAY} AND ${TODAY}+30)::int AS warranty_expiring,
        (SELECT count(*)::int FROM tickets t WHERE t.status<>'COMPLETED' AND ${ticketAsset}) AS open_tickets
       FROM assets a WHERE ${assetWhere}`,
        fyValues,
      );
      const spendByYear = (
        await this.db.query(
          `SELECT extract(year FROM a.purchase_date - interval '3 months')::int AS fy_start,
          sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
         FROM assets a WHERE ${assetWhere} AND ${priced} AND a.purchase_date IS NOT NULL
         GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
          values,
        )
      )
        .reverse()
        .map((r) => ({ label: fyLabel(r.fy_start), spend: r.spend, count: r.count }));
      const breakdown = async (label: string, join = '') =>
        top(
          await this.db.query(
            `SELECT ${label} AS label,sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
           FROM assets a ${join} WHERE ${assetWhere} AND ${priced} AND ${spendFilter}
           GROUP BY 1 ORDER BY 2 DESC,1`,
            filters.fy === undefined ? values : fyValues,
          ),
          8,
        );
      const spendByCategory = await breakdown('a.category');
      const spendByDepartment = await breakdown(
        "coalesce(d.name,'No department')",
        'LEFT JOIN departments d ON d.id=a.department_id',
      );
      const statusCounts = await this.db.query(
        `SELECT a.status AS label,count(*)::int AS count FROM assets a WHERE ${assetWhere}
       GROUP BY 1 ORDER BY 2 DESC,1`,
        values,
      );
      const ticketWeeks = await this.db.query(
        `SELECT to_char(w,'YYYY-MM-DD') AS "weekStart",
        (SELECT count(*)::int FROM tickets t WHERE ${ticketAsset}
          AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date>=w AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::date<w+7) AS opened,
        (SELECT count(*)::int FROM tickets t WHERE ${ticketAsset}
          AND (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date>=w AND (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date<w+7) AS completed
       FROM generate_series(date_trunc('week',${TODAY})::date-77,date_trunc('week',${TODAY})::date,interval '7 days') AS g(ws),
        LATERAL (SELECT ws::date AS w) x ORDER BY w`,
        values,
      );
      const expiring = await this.db.query(
        `SELECT * FROM (
         SELECT a.id AS "assetId",a.asset_code AS "assetCode",a.asset_type AS "assetType",'Warranty' AS kind,a.warranty_expiry AS date
         FROM assets a WHERE ${assetWhere} AND a.warranty_expiry BETWEEN ${TODAY} AND ${TODAY}+60
         UNION ALL
         SELECT a.id,a.asset_code,a.asset_type,'AMC',a.amc_expiry
         FROM assets a WHERE ${assetWhere} AND a.amc_applies AND a.amc_expiry BETWEEN ${TODAY} AND ${TODAY}+60
       ) e ORDER BY date,"assetCode" LIMIT 10`,
        values,
      );
      const topReported = await this.db.query(
        `SELECT a.id AS "assetId",a.asset_code AS "assetCode",a.asset_type AS "assetType",count(t.id)::int AS tickets
       FROM tickets t JOIN assets a ON a.id=t.asset_id WHERE ${assetWhere}
       GROUP BY a.id ORDER BY 4 DESC,2 LIMIT 5`,
        values,
      );
      const financeGaps = await this.db.query(
        `SELECT a.id AS "assetId",a.asset_code AS "assetCode",a.asset_type AS "assetType",
        a.purchase_cost IS NULL AS "missingCost",a.purchase_date IS NULL AS "missingDate"
       FROM assets a WHERE ${assetWhere} AND (a.purchase_cost IS NULL OR a.purchase_date IS NULL)
       ORDER BY a.asset_code LIMIT 10`,
        values,
      );
      const recentActivity = await this.db.query(
        `SELECT e.action,e.entity_type AS "entityType",coalesce(u.display_name,'System') AS actor,e.occurred_at AS "occurredAt"
       FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.occurred_at DESC,e.id LIMIT 10`,
      );
      return {
        filters: { fy: kpis.fy_start, fyLabel: fyLabel(kpis.fy_start) },
        kpis: {
          totalAssets: kpis.total_assets,
          totalSpend: kpis.total_spend,
          fySpend: kpis.fy_spend,
          missingCost: kpis.missing_cost,
          assigned: kpis.assigned,
          assignedPct: kpis.total_assets
            ? Math.round((kpis.assigned / kpis.total_assets) * 100)
            : 0,
          openTickets: kpis.open_tickets,
          warrantyExpiring: kpis.warranty_expiring,
        },
        spendByYear,
        spendByCategory,
        spendByDepartment,
        statusCounts,
        ticketWeeks,
        expiring,
        topReported,
        financeGaps,
        recentActivity,
      };
    });
  }
}

@Controller('dashboard')
@UseGuards(SessionGuard)
export class AdminDashboardController {
  constructor(@Inject(AdminDashboardService) private readonly service: AdminDashboardService) {}

  @Get('admin')
  summary(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.summary(req, query);
  }
}
