import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { LIVE_ASSET, assetScope, parse } from './domain-helpers';
import { LOCATION_PATHS_SQL } from './locations';
import { WRITE_OFF_STATUSES, can, type Action } from './policy';
import { assetFieldRestrictions, stripHiddenFields } from './role-field';
import type { Actor } from './security';

/**
 * Warranty, AMC and insurance registers and their counts.
 *
 * Built for large registers (tens of thousands of assets): the database does the counting and
 * sends one page of rows at a time; nothing loads the whole register into the browser.
 *
 * Who sees what:
 * - anyone holding one of `globalActions` sees every live asset;
 * - team leads and members see the assets of their own teams (the usual asset scope);
 * - everyone else is refused.
 * Written-off assets (sold, disposed, lost…) and assets removed from the register are left out.
 * A field hidden by Field permissions is hidden here too, along with any count built from it.
 */

export type Cover = 'warranty' | 'amc' | 'insurance';
export const COVER_STATES = ['expired', 'due30', 'due90', 'active', 'missing', 'none'] as const;
const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Where each kind of cover stands today, as SQL over `a`. */
const STATE_SQL: Record<Cover, string> = {
  warranty: band('a.warranty_expiry', 'a.warranty_expiry IS NULL'),
  amc: `CASE WHEN NOT a.amc_applies THEN 'none' ELSE ${band('a.amc_expiry', 'a.amc_expiry IS NULL')} END`,
  insurance: band('a.insurance_expiry', 'a.insurance_expiry IS NULL'),
};
function band(date: string, missing: string) {
  return `CASE WHEN ${missing} THEN 'missing'
               WHEN ${date} < ${today} THEN 'expired'
               WHEN ${date} <= ${today} + 30 THEN 'due30'
               WHEN ${date} <= ${today} + 90 THEN 'due90'
               ELSE 'active' END`;
}
const DATE_COLUMN: Record<Cover, string> = {
  warranty: 'a.warranty_expiry',
  amc: 'a.amc_expiry',
  insurance: 'a.insurance_expiry',
};
const DATE_FIELD: Record<Cover, string> = {
  warranty: 'warrantyExpiry',
  amc: 'amcExpiry',
  insurance: 'insuranceExpiry',
};

interface Scope {
  where: string;
  values: unknown[];
  hidden: Set<string>;
  showCustodian: boolean;
}

async function careScope(db: Db, actor: Actor, globalActions: Action[]): Promise<Scope> {
  const values: unknown[] = [[...WRITE_OFF_STATUSES]];
  let scope: string;
  if (globalActions.some((action) => can(actor, action))) scope = 'TRUE';
  else if ((actor.teams ?? []).length) scope = assetScope(actor, values);
  else throw new ForbiddenException('Insufficient permission');
  const { hidden } = await assetFieldRestrictions(db, actor);
  return {
    where: `${LIVE_ASSET} AND NOT (a.status = ANY($1::text[])) AND ${scope}`,
    values,
    hidden,
    // An outside insurer needs the cover, not the names of the staff using each item.
    showCustodian:
      actor.roles.some((role) => role !== 'INSURER' && role !== 'EMPLOYEE') ||
      (actor.teams ?? []).length > 0,
  };
}

const listQuery = z
  .object({
    cover: z.enum(['warranty', 'amc', 'insurance']).optional(),
    show: z.enum(COVER_STATES).optional(),
    teamId: z.string().uuid().optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().regex(/^\d{1,7}$/).optional(),
  })
  .strict();

/**
 * One page of the register, most urgent first for the chosen cover: expired (most recently
 * ended first), ending soon (soonest first), not recorded, then covered. For insurance the most
 * valuable assets come first within each group, since that is where a gap costs most.
 */
export async function assetCarePage(db: Db, actor: Actor, globalActions: Action[], query: unknown, defaultCover: Cover) {
  const p = parse(listQuery, query ?? {});
  const cover = p.cover ?? defaultCover;
  const s = await careScope(db, actor, globalActions);
  if (s.hidden.has(DATE_FIELD[cover])) throw new ForbiddenException('Insufficient permission');
  const values = [...s.values];
  const where = [s.where];
  const state = STATE_SQL[cover];
  if (p.show) {
    values.push(p.show);
    where.push(`(${state}) = $${values.length}`);
  }
  if (p.teamId) {
    values.push(p.teamId);
    where.push(`a.owning_team_id = $${values.length}`);
  }
  if (p.q) {
    values.push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`);
    const i = values.length;
    where.push(`(a.asset_code ILIKE $${i} OR a.description ILIKE $${i} OR a.model ILIKE $${i}
      OR a.manufacturer ILIKE $${i} OR a.serial_number ILIKE $${i} OR a.insurance_policy_number ILIKE $${i}
      OR holder.display_name ILIKE $${i})`);
  }
  const limit = p.limit ?? 25;
  const offset = Number(p.cursor ?? 0);
  values.push(limit + 1, offset);
  const days = `(${DATE_COLUMN[cover]} - ${today})`;
  const order =
    cover === 'insurance'
      ? `rank, coalesce(a.purchase_cost, 0) DESC, a.asset_code`
      : `rank, CASE WHEN state = 'expired' THEN -${days} ELSE ${days} END, a.asset_code`;

  const rows = await db.query(
    `${LOCATION_PATHS_SQL}
     SELECT * FROM (
       SELECT a.id, a.asset_code, a.description, a.category, a.asset_type, a.manufacturer, a.model,
              a.serial_number, a.status, a.owning_team_id, t.code AS team_code, t.name AS team_name,
              a.warranty_expiry, a.amc_applies, a.amc_expiry,
              a.insurance_policy_number, a.insurance_expiry,
              a.purchase_date, a.purchase_cost, a.supplier,
              (a.warranty_expiry - ${today}) AS warranty_days,
              (a.amc_expiry - ${today}) AS amc_days,
              (a.insurance_expiry - ${today}) AS insurance_days,
              coalesce(tree.path, l.name) AS location,
              holder.id AS custodian_id, holder.display_name AS custodian_name,
              holder.designation AS custodian_designation, (holder.left_at IS NOT NULL) AS custodian_left,
              d.name AS custodian_department,
              EXISTS(SELECT 1 FROM user_photos up WHERE up.user_id = holder.id) AS custodian_has_photo,
              (SELECT count(*)::int FROM tickets wo
                WHERE wo.asset_id = a.id AND wo.category = 'HARDWARE' AND wo.status <> 'OPEN') AS repair_count,
              ${state} AS state,
              CASE ${state} WHEN 'expired' THEN 0 WHEN 'due30' THEN 1 WHEN 'due90' THEN 2
                            WHEN 'missing' THEN 3 WHEN 'active' THEN 4 ELSE 5 END AS rank
         FROM assets a
         LEFT JOIN teams t ON t.id = a.owning_team_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN tree ON tree.id = a.location_id
         LEFT JOIN assignments ca ON ca.asset_id = a.id AND ca.ended_at IS NULL
         LEFT JOIN users holder ON holder.id = ca.user_id
         LEFT JOIN departments d ON d.id = holder.department_id
        WHERE ${where.join(' AND ')}
     ) a
     ORDER BY ${order}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const more = rows.length > limit;
  const items: Record<string, unknown>[] = rows.slice(0, limit).map((r: any) => ({
    id: r.id,
    assetCode: r.asset_code,
    description: r.description,
    category: r.category,
    assetType: r.asset_type,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    status: r.status,
    owningTeam: r.team_name,
    teamCode: r.team_code,
    location: r.location,
    warrantyExpiry: r.warranty_expiry,
    warrantyDaysRemaining: r.warranty_days,
    amcApplies: r.amc_applies,
    amcExpiry: r.amc_expiry,
    amcDaysRemaining: r.amc_days,
    insurancePolicyNumber: r.insurance_policy_number,
    insuranceExpiry: r.insurance_expiry,
    insuranceDaysRemaining: r.insurance_days,
    purchaseDate: r.purchase_date,
    purchaseCost: r.purchase_cost != null ? Number(r.purchase_cost) : null,
    supplier: r.supplier,
    repairCount: r.repair_count,
    custodian:
      s.showCustodian && r.custodian_id
        ? {
            userId: r.custodian_id,
            name: r.custodian_name,
            hasPhoto: r.custodian_has_photo,
            designation: r.custodian_designation,
            department: r.custodian_department,
            left: r.custodian_left,
          }
        : null,
  }));
  // Values derived from a field go with it: a hidden date hides its countdown, a hidden location
  // hides the location path, a hidden team hides the team name.
  const derived: Record<string, string[]> = {
    warrantyExpiry: ['warrantyDaysRemaining'],
    amcExpiry: ['amcDaysRemaining'],
    insuranceExpiry: ['insuranceDaysRemaining'],
    locationId: ['location'],
    owningTeamId: ['owningTeam', 'teamCode'],
  };
  const strip = new Set(s.hidden);
  for (const field of s.hidden) for (const extra of derived[field] ?? []) strip.add(extra);
  stripHiddenFields(items, strip);
  return { items, nextCursor: more ? String(offset + limit) : null };
}

/**
 * Counts for the pages and dashboards, worked out in the database: how many assets are in each
 * state for warranty, AMC and insurance, what ends in each of the next 12 months, the soonest
 * end dates, missing details, value covered and at risk, age of the fleet and the teams in view.
 * A count built on a field the viewer may not see comes back as null.
 */
export async function assetCareSummary(db: Db, actor: Actor, globalActions: Action[]) {
  const s = await careScope(db, actor, globalActions);
  const sees = (field: string) => !s.hidden.has(field);
  const covers = (['warranty', 'amc', 'insurance'] as const).filter((c) => sees(DATE_FIELD[c]));
  const counts = covers
    .flatMap((c) =>
      COVER_STATES.map((st) => `count(*) FILTER (WHERE ${STATE_SQL[c]} = '${st}')::int AS ${c}_${st}`),
    )
    .join(',\n');
  const base = `FROM assets a WHERE ${s.where}`;
  const cost = sees('purchaseCost');
  const insuredCover = `${STATE_SQL.insurance} IN ('active','due30','due90')`;

  const [[totals], months, soonest, teams, gaps, repaired] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS total
              ${counts ? `,${counts}` : ''},
              count(*) FILTER (WHERE a.purchase_date IS NULL)::int AS no_date,
              count(*) FILTER (WHERE a.location_id IS NULL)::int AS no_location,
              ${cost ? `count(*) FILTER (WHERE a.purchase_cost IS NULL)::int AS no_cost,
              coalesce(sum(a.purchase_cost),0)::float8 AS value_total,
              coalesce(sum(a.purchase_cost) FILTER (WHERE ${insuredCover}),0)::float8 AS value_insured,` : ''}
              count(*) FILTER (WHERE a.purchase_date > ${today} - 365)::int AS age_0,
              count(*) FILTER (WHERE a.purchase_date <= ${today} - 365 AND a.purchase_date > ${today} - 730)::int AS age_1,
              count(*) FILTER (WHERE a.purchase_date <= ${today} - 730 AND a.purchase_date > ${today} - 1095)::int AS age_2,
              count(*) FILTER (WHERE a.purchase_date <= ${today} - 1095 AND a.purchase_date > ${today} - 1461)::int AS age_3,
              count(*) FILTER (WHERE a.purchase_date <= ${today} - 1461 AND a.purchase_date > ${today} - 1826)::int AS age_4,
              count(*) FILTER (WHERE a.purchase_date <= ${today} - 1826)::int AS age_5
         ${base}`,
      s.values,
    ),
    // One pass over the register: each asset contributes its three end dates, grouped by month.
    db.query(
      `WITH m AS (SELECT generate_series(date_trunc('month', ${today}), date_trunc('month', ${today}) + interval '11 months', interval '1 month')::date AS month),
            e AS (
              SELECT date_trunc('month', v.d)::date AS month, v.kind
                FROM assets a
                CROSS JOIN LATERAL (VALUES
                  ('warranty', ${sees('warrantyExpiry') ? 'a.warranty_expiry' : 'NULL::date'}),
                  ('amc', ${sees('amcExpiry') ? 'CASE WHEN a.amc_applies THEN a.amc_expiry END' : 'NULL::date'}),
                  ('insurance', ${sees('insuranceExpiry') ? 'a.insurance_expiry' : 'NULL::date'})
                ) v(kind, d)
               WHERE ${s.where} AND v.d >= ${today} AND v.d < date_trunc('month', ${today}) + interval '12 months')
       SELECT m.month,
              count(e.kind) FILTER (WHERE e.kind = 'warranty')::int AS warranty,
              count(e.kind) FILTER (WHERE e.kind = 'amc')::int AS amc,
              count(e.kind) FILTER (WHERE e.kind = 'insurance')::int AS insurance
         FROM m LEFT JOIN e ON e.month = m.month
        GROUP BY m.month ORDER BY m.month`,
      s.values,
    ),
    covers.length
      ? db.query(
          `SELECT * FROM (${covers
            .map(
              (c) => `SELECT a.id, a.asset_code, '${c}' AS cover, ${DATE_COLUMN[c]} AS date, (${DATE_COLUMN[c]} - ${today}) AS days
                ${base} ${c === 'amc' ? 'AND a.amc_applies' : ''}
                AND ${DATE_COLUMN[c]} BETWEEN ${today} AND ${today} + 90`,
            )
            .join(' UNION ALL ')}) x ORDER BY days, asset_code LIMIT 6`,
          s.values,
        )
      : Promise.resolve([]),
    sees('owningTeamId')
      ? db.query(
          `SELECT t.id, t.name, count(*)::int AS assets FROM assets a JOIN teams t ON t.id = a.owning_team_id
            WHERE ${s.where} GROUP BY t.id, t.name ORDER BY t.name`,
          s.values,
        )
      : Promise.resolve([]),
    cost && sees('insuranceExpiry')
      ? db.query(
          `SELECT a.id, a.asset_code, a.manufacturer, a.model, a.description, a.purchase_cost::float8 AS cost
             ${base} AND NOT (${insuredCover}) AND a.purchase_cost > 0
            ORDER BY a.purchase_cost DESC, a.asset_code LIMIT 6`,
          s.values,
        )
      : Promise.resolve([]),
    db.query(
      `SELECT count(DISTINCT wo.asset_id)::int AS assets
         FROM tickets wo JOIN assets a ON a.id = wo.asset_id
        WHERE wo.category = 'HARDWARE' AND wo.status <> 'OPEN' AND ${s.where}`,
      s.values,
    ),
  ]);

  const state = (c: Cover) =>
    covers.includes(c as never)
      ? Object.fromEntries(COVER_STATES.map((st) => [st, totals[`${c}_${st}`] as number]))
      : null;
  return {
    total: totals.total,
    warranty: state('warranty'),
    amc: state('amc'),
    insurance: state('insurance'),
    months: months.map((m: any) => ({
      month: m.month,
      warranty: m.warranty,
      amc: m.amc,
      insurance: m.insurance,
    })),
    soonest: soonest.map((r: any) => ({
      id: r.id,
      assetCode: r.asset_code,
      cover: r.cover as Cover,
      date: r.date,
      days: r.days,
    })),
    gaps: {
      purchaseCost: cost ? totals.no_cost : null,
      purchaseDate: sees('purchaseDate') ? totals.no_date : null,
      location: sees('locationId') ? totals.no_location : null,
    },
    value: cost
      ? {
          total: Number(totals.value_total),
          insured: Number(totals.value_insured),
          atRisk: Number(totals.value_total) - Number(totals.value_insured),
        }
      : null,
    biggestGaps: gaps.map((r: any) => ({
      id: r.id,
      assetCode: r.asset_code,
      name: [r.manufacturer, r.model].filter(Boolean).join(' ') || r.description,
      cost: Number(r.cost),
    })),
    repairedAssets: repaired[0]?.assets ?? 0,
    ages: sees('purchaseDate')
      ? [0, 1, 2, 3, 4, 5].map((i) => totals[`age_${i}`] as number)
      : null,
    teams: teams.map((t: any) => ({ id: t.id, name: t.name, assets: t.assets })),
  };
}
