import { Db } from './db';

const TZ = "'Asia/Kolkata'";
const TODAY = `(now() AT TIME ZONE ${TZ})::date`;
const PRICED = "a.purchase_cost IS NOT NULL AND a.currency='INR'";

export interface SummaryPayload {
  kpis: {
    totalAssets: number;
    totalSpend: number;
    fySpend: number;
    fyStart: number;
    missingCost: number;
    assigned: number;
    warrantyExpiring: number;
  };
  assetsByTeam: { teamId: string; teamName: string; status: string; count: number; value: number }[];
  attention: {
    pendingFinance: number;
    leftHoldersWithAssets: number;
    warrantyExpiring30: number;
    amcExpiring30: number;
  };
  spendByFy: { fyStart: number; spend: number; count: number }[];
  spendByCategory: { label: string; spend: number; count: number }[];
  spendByDepartment: { label: string; spend: number; count: number }[];
  statusCounts: { label: string; count: number }[];
}
export interface StoredSummary {
  payload: SummaryPayload;
  asOf: string;
}

/** Heavy aggregates for one scope. `teamId` null means the whole organisation. */
async function compute(db: Db, teamId: string | null): Promise<SummaryPayload> {
  const values: any[] = teamId ? [teamId] : [];
  const scope = teamId ? 'a.owning_team_id=$1' : 'TRUE';
  const fyStart = `extract(year FROM ${TODAY} - interval '3 months')::int`;
  const [kpis] = await db.query(
    `SELECT count(*)::int AS "totalAssets",
       coalesce(sum(a.purchase_cost) FILTER(WHERE ${PRICED}),0)::float8 AS "totalSpend",
       coalesce(sum(a.purchase_cost) FILTER(WHERE ${PRICED}
         AND a.purchase_date>=make_date(${fyStart},4,1) AND a.purchase_date<make_date(${fyStart}+1,4,1)),0)::float8 AS "fySpend",
       ${fyStart} AS "fyStart",
       count(*) FILTER(WHERE a.purchase_cost IS NULL)::int AS "missingCost",
       count(*) FILTER(WHERE a.status='Assigned')::int AS assigned,
       count(*) FILTER(WHERE a.warranty_expiry BETWEEN ${TODAY} AND ${TODAY}+30)::int AS "warrantyExpiring",
       count(*) FILTER(WHERE a.finance_status<>'APPROVED')::int AS "pendingFinance",
       count(*) FILTER(WHERE a.amc_applies AND a.amc_expiry BETWEEN ${TODAY} AND ${TODAY}+30)::int AS "amcExpiring30"
     FROM assets a WHERE ${scope}`,
    values,
  );
  const [holders] = await db.query(
    `SELECT count(DISTINCT g.asset_id)::int AS n FROM assignments g
       JOIN users u ON u.id=g.user_id JOIN assets a ON a.id=g.asset_id
     WHERE g.ended_at IS NULL AND u.left_at IS NOT NULL AND ${scope}`,
    values,
  );
  const assetsByTeam = await db.query(
    `SELECT a.owning_team_id AS "teamId",t.name AS "teamName",a.status,count(*)::int AS count,
       coalesce(sum(a.purchase_cost) FILTER(WHERE a.currency='INR'),0)::float8 AS value
     FROM assets a JOIN teams t ON t.id=a.owning_team_id WHERE ${scope}
     GROUP BY a.owning_team_id,t.name,a.status ORDER BY t.name,a.status`,
    values,
  );
  const spendByFy = await db.query(
    `SELECT extract(year FROM a.purchase_date - interval '3 months')::int AS "fyStart",
       sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
     FROM assets a WHERE ${scope} AND ${PRICED} AND a.purchase_date IS NOT NULL
     GROUP BY 1 ORDER BY 1 DESC LIMIT 15`,
    values,
  );
  const breakdown = (label: string, join = '') =>
    db.query(
      `SELECT ${label} AS label,sum(a.purchase_cost)::float8 AS spend,count(*)::int AS count
       FROM assets a ${join} WHERE ${scope} AND ${PRICED} GROUP BY 1 ORDER BY 2 DESC,1`,
      values,
    );
  const spendByCategory = await breakdown('a.category');
  const spendByDepartment = await breakdown(
    "coalesce(d.name,'No department')",
    'LEFT JOIN departments d ON d.id=a.department_id',
  );
  const statusCounts = await db.query(
    `SELECT a.status AS label,count(*)::int AS count FROM assets a WHERE ${scope}
     GROUP BY 1 ORDER BY 2 DESC,1`,
    values,
  );
  return {
    kpis: {
      totalAssets: kpis.totalAssets,
      totalSpend: kpis.totalSpend,
      fySpend: kpis.fySpend,
      fyStart: kpis.fyStart,
      missingCost: kpis.missingCost,
      assigned: kpis.assigned,
      warrantyExpiring: kpis.warrantyExpiring,
    },
    assetsByTeam,
    attention: {
      pendingFinance: kpis.pendingFinance,
      leftHoldersWithAssets: holders.n,
      warrantyExpiring30: kpis.warrantyExpiring,
      amcExpiring30: kpis.amcExpiring30,
    },
    spendByFy,
    spendByCategory,
    spendByDepartment,
    statusCounts,
  };
}

async function store(db: Db, scope: string, teamId: string | null): Promise<StoredSummary> {
  const payload = await compute(db, teamId);
  const [row] = await db.query(
    `INSERT INTO dashboard_daily(scope,payload,refreshed_at) VALUES($1,$2,now())
     ON CONFLICT(scope) DO UPDATE SET payload=EXCLUDED.payload,refreshed_at=now()
     RETURNING refreshed_at`,
    [scope, JSON.stringify(payload)],
  );
  return { payload, asOf: new Date(row.refreshed_at).toISOString() };
}

/**
 * Recomputes the ORG summary and one `TEAM:<code>` summary per team. A scope that fails keeps
 * its previous row, so readers always see the last good summary.
 */
export async function refreshDashboardSummary(db: Db): Promise<{ refreshed: number; failed: number }> {
  const teams: { id: string; code: string }[] = await db.query('SELECT id,code FROM teams');
  let refreshed = 0;
  let failed = 0;
  for (const [scope, teamId] of [
    ['ORG', null],
    ...teams.map((t) => [`TEAM:${t.code}`, t.id] as const),
  ] as const) {
    try {
      await store(db, scope, teamId);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}

/**
 * Last stored summary for a scope. When none exists it is computed once and stored. Returns null
 * only if that first computation also fails; callers then fall back to their live queries.
 */
export async function readDashboardSummary(
  db: Db,
  scope: string,
  teamId: string | null,
): Promise<StoredSummary | null> {
  if (process.env.NODE_ENV === 'test' && process.env.DASHBOARD_SUMMARY !== 'on') return null;
  try {
    const [row] = await db.query('SELECT payload,refreshed_at FROM dashboard_daily WHERE scope=$1', [
      scope,
    ]);
    if (row) return { payload: row.payload, asOf: new Date(row.refreshed_at).toISOString() };
    return await store(db, scope, teamId);
  } catch {
    return null;
  }
}
