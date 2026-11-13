import { Controller, Get, Inject, Injectable, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { assetScope } from './domain-helpers';
import { can } from './policy';
import { AuthRequest, SessionGuard } from './security';

/**
 * Chart data for every dashboard, computed over exactly the assets the viewer may
 * see (same scope as the asset list). Money totals are returned only to people who
 * may see purchase costs; everyone else gets counts.
 */
@Injectable()
export class InsightsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async insights(req: AuthRequest) {
    const values: unknown[] = [];
    const scope = assetScope(req.user, values);
    const money = can(req.user, 'asset.view_private');
    const [row] = await this.db.query(
      `WITH scoped AS (
         SELECT a.*, (a.status IN ('Retired','Disposed','Sold','Scrapped','Lost','Stolen')) AS gone,
                coalesce(a.purchase_cost, 0)::float8 AS cost
         FROM assets a WHERE ${scope}
       ), live AS (SELECT * FROM scoped WHERE NOT gone)
       SELECT
         (SELECT count(*)::int FROM scoped) AS total,
         (SELECT count(*)::int FROM live) AS live,
         (SELECT coalesce(sum(cost),0)::float8 FROM live) AS live_value,
         (SELECT coalesce(json_agg(x ORDER BY x.count DESC),'[]') FROM
            (SELECT status AS label, count(*)::int AS count FROM scoped GROUP BY status) x) AS by_status,
         (SELECT coalesce(json_agg(x ORDER BY x.count DESC),'[]') FROM
            (SELECT asset_type AS label, count(*)::int AS count, sum(cost)::float8 AS value FROM live GROUP BY asset_type) x) AS by_type,
         (SELECT coalesce(json_agg(x ORDER BY x.count DESC),'[]') FROM
            (SELECT coalesce(d.name,'No department') AS label, count(*)::int AS count, sum(l.cost)::float8 AS value
             FROM live l LEFT JOIN departments d ON d.id=l.department_id GROUP BY 1) x) AS by_department,
         (SELECT coalesce(json_agg(x ORDER BY x.count DESC),'[]') FROM
            (SELECT condition AS label, count(*)::int AS count FROM live GROUP BY condition) x) AS by_condition,
         (SELECT coalesce(json_agg(x ORDER BY x.label),'[]') FROM
            (SELECT extract(year FROM purchase_date)::int::text AS label, count(*)::int AS count, sum(cost)::float8 AS value
             FROM scoped WHERE purchase_date IS NOT NULL GROUP BY 1) x) AS by_year,
         (SELECT coalesce(json_agg(x ORDER BY x.count DESC),'[]') FROM
            (SELECT supplier AS label, count(*)::int AS count, sum(cost)::float8 AS value
             FROM scoped WHERE nullif(btrim(supplier),'') IS NOT NULL GROUP BY supplier ORDER BY count(*) DESC LIMIT 8) x) AS by_supplier,
         (SELECT json_build_object(
            'underOne', count(*) FILTER (WHERE purchase_date > current_date - interval '1 year'),
            'oneToThree', count(*) FILTER (WHERE purchase_date <= current_date - interval '1 year' AND purchase_date > current_date - interval '3 years'),
            'threeToFive', count(*) FILTER (WHERE purchase_date <= current_date - interval '3 years' AND purchase_date > current_date - interval '5 years'),
            'overFive', count(*) FILTER (WHERE purchase_date <= current_date - interval '5 years'),
            'unknown', count(*) FILTER (WHERE purchase_date IS NULL)) FROM live) AS age,
         (SELECT json_build_object(
            'expired', count(*) FILTER (WHERE warranty_expiry < current_date),
            'within30', count(*) FILTER (WHERE warranty_expiry >= current_date AND warranty_expiry < current_date + 30),
            'within90', count(*) FILTER (WHERE warranty_expiry >= current_date + 30 AND warranty_expiry < current_date + 90),
            'later', count(*) FILTER (WHERE warranty_expiry >= current_date + 90),
            'unknown', count(*) FILTER (WHERE warranty_expiry IS NULL)) FROM live) AS warranty,
         (SELECT json_build_object(
            'held', count(*) FILTER (WHERE s.asset_id IS NOT NULL),
            'unheld', count(*) FILTER (WHERE s.asset_id IS NULL))
            FROM live l LEFT JOIN (SELECT asset_id FROM assignments WHERE ended_at IS NULL) s ON s.asset_id=l.id) AS custody,
         (SELECT json_build_object(
            'insured', count(*) FILTER (WHERE nullif(btrim(insurance_policy_number),'') IS NOT NULL AND (insurance_expiry IS NULL OR insurance_expiry >= current_date)),
            'expiring90', count(*) FILTER (WHERE insurance_expiry >= current_date AND insurance_expiry < current_date + 90),
            'uninsured', count(*) FILTER (WHERE nullif(btrim(insurance_policy_number),'') IS NULL OR insurance_expiry < current_date)) FROM live) AS insurance,
         (SELECT json_build_object(
            'within12m', count(*) FILTER (WHERE last_audit_date >= current_date - interval '12 months'),
            'older', count(*) FILTER (WHERE last_audit_date < current_date - interval '12 months'),
            'never', count(*) FILTER (WHERE last_audit_date IS NULL)) FROM live) AS audit`,
      values,
    );
    const stripMoney = (items: { label: string; count: number; value?: number | null }[]) =>
      items.map((item) => (money ? { ...item, value: item.value ?? 0 } : { label: item.label, count: item.count }));
    const holders = await this.holders(req);
    return {
      money,
      topHolders: holders.slice(0, 10),
      multiHolders: holders.filter((h) => h.count > 1).length,
      total: row.total,
      live: row.live,
      liveValue: money ? row.live_value : null,
      byStatus: row.by_status,
      byType: stripMoney(row.by_type),
      byDepartment: stripMoney(row.by_department),
      byCondition: row.by_condition,
      byYear: stripMoney(row.by_year),
      bySupplier: stripMoney(row.by_supplier),
      age: row.age,
      warranty: row.warranty,
      custody: row.custody,
      insurance: row.insurance,
      audit: row.audit,
    };
  }

  async brands(req: AuthRequest) {
    const values: unknown[] = [];
    const scope = assetScope(req.user, values);
    const rows = await this.db.query(
      `SELECT min(btrim(a.manufacturer)) AS name, count(*)::int AS count
       FROM assets a
       WHERE ${scope} AND nullif(btrim(a.manufacturer),'') IS NOT NULL
       GROUP BY lower(btrim(a.manufacturer))
       ORDER BY 1
       LIMIT 300`,
      values,
    );
    return rows as { name: string; count: number }[];
  }

  /** People who currently hold assets the viewer may see, most first (for charts and the filter). */
  async holders(req: AuthRequest) {
    const values: unknown[] = [];
    const scope = assetScope(req.user, values);
    const rows = await this.db.query(
      `SELECT u.id AS "userId", u.display_name AS name, d.name AS department, count(*)::int AS count
       FROM assets a
       JOIN assignments s ON s.asset_id=a.id AND s.ended_at IS NULL
       JOIN users u ON u.id=s.user_id
       LEFT JOIN departments d ON d.id=u.department_id
       WHERE ${scope}
       GROUP BY u.id, u.display_name, d.name
       ORDER BY count(*) DESC, u.display_name
       LIMIT 500`,
      values,
    );
    return rows as { userId: string; name: string; department: string | null; count: number }[];
  }
}

@Controller('dashboard')
@UseGuards(SessionGuard)
export class InsightsController {
  constructor(@Inject(InsightsService) private readonly service: InsightsService) {}

  @Get('insights')
  insights(@Req() req: AuthRequest) {
    return this.service.insights(req);
  }

  @Get('holders')
  async holders(@Req() req: AuthRequest) {
    return { items: await this.service.holders(req) };
  }

  /** Brands present in the assets the viewer may see (for the Brand column filter). */
  @Get('brands')
  async brands(@Req() req: AuthRequest) {
    return { items: await this.service.brands(req) };
  }
}
