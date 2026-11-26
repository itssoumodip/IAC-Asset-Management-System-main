import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { BarList, Card, ColumnChart, DonutChart, StatTile } from './charts';
import { ErrorNotice, Select } from './ui';

interface Slice {
  label: string;
  count: number;
  value?: number;
}
export interface Holder {
  userId: string;
  name: string;
  department: string | null;
  count: number;
}
interface InsightsData {
  money: boolean;
  teamId: string | null;
  teams: { id: string; name: string; count: number }[];
  topHolders: Holder[];
  multiHolders: number;
  total: number;
  live: number;
  liveValue: number | null;
  byStatus: Slice[];
  byType: Slice[];
  byCategory: Slice[];
  byDepartment: (Slice & { id?: string | null })[];
  byCondition: Slice[];
  byLocation: (Slice & { id?: string | null })[];
  completeness: { total: number; serial: number; model: number; brand: number; cost: number; purchaseDate: number; warranty: number; location: number };
  idle: { under30: number; to90: number; to180: number; over180: number };
  byYear: Slice[];
  bySupplier: Slice[];
  age: { underOne: number; oneToThree: number; threeToFive: number; overFive: number; unknown: number };
  warranty: { expired: number; within30: number; within90: number; later: number; unknown: number };
  custody: { held: number; unheld: number };
  insurance: { insured: number; expiring90: number; uninsured: number };
  audit: { within12m: number; older: number; never: number };
}

/** Which charts each role sees, closest to their daily work first. */
export type InsightsVariant =
  | 'overview'
  | 'finance'
  | 'store'
  | 'auditor'
  | 'insurer'
  | 'procurement'
  | 'team'
  | 'employee';

type ChartKey =
  | 'holders'
  | 'category'
  | 'department'
  | 'type'
  | 'status'
  | 'condition'
  | 'year'
  | 'age'
  | 'warranty'
  | 'custody'
  | 'insurance'
  | 'audit'
  | 'supplier'
  | 'valueDepartment'
  | 'location'
  | 'completeness'
  | 'idle';

// Even counts so the two-column grid has no empty half-rows.
const CHARTS: Record<InsightsVariant, ChartKey[]> = {
  overview: ['department', 'holders', 'category', 'type', 'location', 'status', 'completeness', 'idle', 'year', 'warranty', 'age', 'custody'],
  finance: ['valueDepartment', 'year', 'supplier', 'age', 'type', 'completeness'],
  store: ['custody', 'idle', 'status', 'condition', 'location', 'type', 'department', 'holders'],
  auditor: ['audit', 'completeness', 'department', 'location', 'condition', 'holders', 'status', 'custody'],
  insurer: ['insurance', 'warranty', 'department', 'type', 'age', 'condition'],
  procurement: ['year', 'supplier', 'age', 'type', 'warranty', 'department'],
  team: ['department', 'holders', 'category', 'type', 'location', 'status', 'completeness', 'idle', 'warranty', 'condition'],
  employee: ['type', 'warranty'],
};

const plain = (n: number) => n.toLocaleString('en-IN');
const shortInr = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : formatInr(n);
/** Bar lists that show every row (no "Other"); long ones scroll inside the card. */
const ALL_ROWS = Number.POSITIVE_INFINITY;
const scrollBox = 'max-h-80 overflow-y-auto pr-1';
export function useHolders() {
  return useQuery({
    queryKey: ['dashboard', 'holders'],
    queryFn: ({ signal }) => api<{ items: Holder[] }>('/dashboard/holders', { signal }),
    staleTime: 60_000,
  });
}

export function useBrands() {
  return useQuery({
    queryKey: ['dashboard', 'brands'],
    queryFn: ({ signal }) => api<{ items: { name: string; count: number }[] }>('/dashboard/brands', { signal }),
    staleTime: 60_000,
  });
}

/** Charts below each role dashboard, computed over the assets that person may see. */
const TEAM_KEY = 'iac.insights.team';
function savedTeam() {
  try {
    return localStorage.getItem(TEAM_KEY) ?? '';
  } catch {
    return '';
  }
}

export function AssetInsights({ variant }: { variant: InsightsVariant }) {
  // '' = every team the viewer can see; remembered per browser.
  const [teamId, setTeamId] = useState(savedTeam);
  const query = useQuery({
    queryKey: ['dashboard', 'insights', teamId],
    queryFn: ({ signal }) =>
      api<InsightsData>(`/dashboard/insights${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`, { signal }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
  const chooseTeam = (value: string) => {
    setTeamId(value);
    try {
      if (value) localStorage.setItem(TEAM_KEY, value);
      else localStorage.removeItem(TEAM_KEY);
    } catch {
      // The choice still applies for this visit.
    }
  };
  // A remembered team the viewer no longer sees falls back to all teams.
  const staleTeam = !!teamId && !!query.data && !query.data.teams.some((t) => t.id === teamId);
  useEffect(() => {
    if (staleTeam) chooseTeam('');
  }, [staleTeam]); // eslint-disable-line react-hooks/exhaustive-deps
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const d = query.data;
  if (!d || staleTeam || (d.total === 0 && !teamId)) return null;

  const counts = (items: Slice[]) => items.map((s) => ({ label: s.label, value: s.count }));
  // Chart links open the asset catalog with the same team chosen.
  const assetsLink = (key: string, value: string) =>
    `/assets?${new URLSearchParams({ [key]: value, ...(teamId ? { owningTeamId: teamId } : {}) })}`;
  const teamName = d.teams.find((t) => t.id === teamId)?.name;
  const card = (key: ChartKey) => {
    switch (key) {
      case 'holders':
        return (
          <Card
            key={key}
            title="Who holds the most"
            action={<span className="text-xs text-gray-500">{plain(d.multiHolders)} hold more than one</span>}
          >
            {/* The top 10 people, each with their own bar (no "Other"); everyone is on People. */}
            <BarList
              items={d.topHolders.map((h) => ({
                label: h.name,
                value: h.count,
                note: h.department ?? undefined,
                to: assetsLink('holderId', h.userId),
              }))}
              limit={ALL_ROWS}
              valueLabel="Assets held"
              empty="Nobody holds an asset yet"
            />
            <Link to="/people?holding=assets" className="mt-3 inline-block text-xs text-navy-700 no-underline hover:underline">
              See everyone who holds assets →
            </Link>
          </Card>
        );
      case 'department':
        return (
          <Card key={key} title="Assets by department" action={<span className="text-xs text-gray-500">{plain(d.byDepartment.length)} departments</span>}>
            {/* Every department, largest first; each row opens its assets. */}
            <div className={scrollBox}>
              <BarList
                items={d.byDepartment.map((s) => ({
                  label: s.label,
                  value: s.count,
                  note: d.money ? shortInr(s.value ?? 0) : undefined,
                  to: assetsLink('departmentId', s.id ?? 'none'),
                }))}
                limit={ALL_ROWS}
                valueLabel="Assets"
              />
            </div>
          </Card>
        );
      case 'location':
        return (
          <Card key={key} title="By location" action={<span className="text-xs text-gray-500">{plain(d.byLocation.length)} places</span>}>
            <div className={scrollBox}>
              <BarList
                items={d.byLocation.map((s) => ({
                  label: s.label,
                  value: s.count,
                  note: d.money ? shortInr(s.value ?? 0) : undefined,
                  to: assetsLink('locationId', s.id ?? 'none'),
                }))}
                limit={ALL_ROWS}
                valueLabel="Assets"
              />
            </div>
          </Card>
        );
      case 'completeness': {
        // Share of assets with each detail filled in; a row opens the ones missing it.
        const c = d.completeness;
        const rows: [string, number, string, string][] = [
          ['Serial number', c.serial, 'serialNumber', '__blank__'],
          ['Model', c.model, 'model', '__blank__'],
          ['Brand', c.brand, 'manufacturer', 'none'],
          ['Location', c.location, 'locationId', 'none'],
          ['Warranty date', c.warranty, 'warrantyExpiry', '__blank__'],
          ['Purchase date', c.purchaseDate, 'purchaseDate', '__blank__'],
          ...(d.money ? ([['Purchase cost', c.cost, 'purchaseCost', '__blank__']] as [string, number, string, string][]) : []),
        ];
        const filled = rows.reduce((sum, [, missing]) => sum + (c.total - missing), 0);
        const score = c.total && rows.length ? Math.round((filled / (c.total * rows.length)) * 100) : 100;
        return (
          <Card key={key} title="Data completeness" action={<span className="text-xs text-gray-500">{score}% filled in</span>}>
            <BarList
              items={rows.map(([label, missing, param, blank]) => ({
                label,
                value: c.total ? Math.round(((c.total - missing) / c.total) * 100) : 100,
                note: missing ? `${plain(missing)} missing` : 'complete',
                to: missing ? assetsLink(param, blank) : undefined,
              }))}
              format={(v) => `${v}%`}
              limit={ALL_ROWS}
              valueLabel="Filled in"
            />
          </Card>
        );
      }
      case 'idle':
        return (
          <Card key={key} title="Sitting in store" action={<span className="text-xs text-gray-500">Unassigned, by time since last moved</span>}>
            <ColumnChart
              items={[
                { label: 'Under 30 days', value: d.idle.under30 },
                { label: '30–90 days', value: d.idle.to90 },
                { label: '3–6 months', value: d.idle.to180 },
                { label: 'Over 6 months', value: d.idle.over180 },
              ].map((s) => ({ ...s, detail: `${s.label}: ${plain(s.value)}` }))}
              format={plain}
              valueLabel="Assets"
              labelHeader="Idle for"
              empty="Nothing is sitting in store"
            />
          </Card>
        );
      case 'valueDepartment':
        return (
          <Card key={key} title={d.money ? 'Purchase value by department' : 'Assets by department'}>
            <BarList
              items={d.byDepartment
                .map((s) => ({ label: s.label, value: d.money ? (s.value ?? 0) : s.count, note: `${plain(s.count)} assets` }))
                .sort((a, b) => b.value - a.value)}
              format={d.money ? formatInr : plain}
              valueLabel={d.money ? 'Purchase value' : 'Assets'}
            />
          </Card>
        );
      case 'category':
        return (
          <Card key={key} title="By category">
            <div className="max-h-80 overflow-y-auto pr-1">
              <BarList
                items={d.byCategory.map((s) => ({
                  label: s.label,
                  value: s.count,
                  note: d.money ? shortInr(s.value ?? 0) : undefined,
                  to: assetsLink('category', s.label),
                }))}
                limit={Number.POSITIVE_INFINITY}
                valueLabel="Assets"
              />
            </div>
          </Card>
        );
      case 'type':
        return (
          <Card key={key} title="By subcategory">
            {/* Every subcategory (there are dozens, too many for a donut); the list scrolls. */}
            <div className="max-h-80 overflow-y-auto pr-1">
              <BarList
                items={counts(d.byType).map((s, _, all) => ({
                  ...s,
                  note: `${Math.round((s.value / all.reduce((sum, t) => sum + t.value, 0)) * 100)}%`,
                  to: assetsLink('assetType', s.label),
                }))}
                limit={Number.POSITIVE_INFINITY}
                valueLabel="Assets"
              />
            </div>
          </Card>
        );
      case 'status':
        return (
          <Card key={key} title="By status">
            <DonutChart items={counts(d.byStatus).map((s) => ({ ...s, to: assetsLink('status', s.label) }))} valueLabel="Assets" labelHeader="Status" centerLabel="Assets" />
          </Card>
        );
      case 'condition':
        return (
          <Card key={key} title="By condition">
            <DonutChart items={counts(d.byCondition)} valueLabel="Assets" labelHeader="Condition" centerLabel="Assets" />
          </Card>
        );
      case 'year':
        return (
          <Card key={key} title={d.money ? 'Purchases by year (value)' : 'Purchases by year'}>
            <ColumnChart
              items={d.byYear.map((s) => ({
                label: s.label,
                value: d.money ? (s.value ?? 0) : s.count,
                detail: `${plain(s.count)} assets`,
              }))}
              format={d.money ? formatInr : plain}
              shortFormat={d.money ? shortInr : plain}
              valueLabel={d.money ? 'Purchase value' : 'Assets'}
              labelHeader="Year"
            />
          </Card>
        );
      case 'supplier':
        return (
          <Card key={key} title="Top suppliers">
            <BarList
              items={d.bySupplier.map((s) => ({
                label: s.label,
                value: s.count,
                note: d.money ? formatInr(s.value ?? 0) : undefined,
              }))}
              valueLabel="Assets"
            />
          </Card>
        );
      case 'age':
        return (
          <Card key={key} title="Age of assets in use">
            <ColumnChart
              items={[
                { label: 'Under 1 yr', value: d.age.underOne },
                { label: '1–3 yrs', value: d.age.oneToThree },
                { label: '3–5 yrs', value: d.age.threeToFive },
                { label: 'Over 5 yrs', value: d.age.overFive },
                { label: 'Unknown', value: d.age.unknown },
              ]}
              format={plain}
              valueLabel="Assets"
              labelHeader="Age"
            />
          </Card>
        );
      case 'warranty':
        return (
          <Card key={key} title="Warranty">
            <DonutChart
              items={[
                { label: 'Expired', value: d.warranty.expired },
                { label: 'Ends within 30 days', value: d.warranty.within30 },
                { label: 'Ends in 30–90 days', value: d.warranty.within90 },
                { label: 'Covered beyond 90 days', value: d.warranty.later },
                { label: 'Not recorded', value: d.warranty.unknown },
              ]}
              valueLabel="Assets" labelHeader="Warranty" centerLabel="Assets"
            />
          </Card>
        );
      case 'custody':
        return (
          <Card key={key} title="Held by someone">
            <DonutChart
              items={[
                { label: 'Held by a person', value: d.custody.held, to: assetsLink('status', 'In Use') },
                { label: 'Not held', value: d.custody.unheld },
              ]}
              valueLabel="Assets" labelHeader="Custody" centerLabel="Assets"
            />
          </Card>
        );
      case 'insurance':
        return (
          <Card key={key} title="Insurance">
            <DonutChart
              items={[
                { label: 'Insured', value: d.insurance.insured },
                { label: 'Expiring in 90 days', value: d.insurance.expiring90 },
                { label: 'Not insured', value: d.insurance.uninsured },
              ]}
              valueLabel="Assets" labelHeader="Insurance" centerLabel="Assets"
            />
          </Card>
        );
      case 'audit':
        return (
          <Card key={key} title="Last audit">
            <DonutChart
              items={[
                { label: 'Audited in last 12 months', value: d.audit.within12m },
                { label: 'Audited over a year ago', value: d.audit.older },
                { label: 'Never audited', value: d.audit.never },
              ]}
              valueLabel="Assets" labelHeader="Audit" centerLabel="Assets"
            />
          </Card>
        );
    }
  };

  return (
    <section className="mt-8" aria-label="Asset charts">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-gray-900">Asset insights</h2>
          <span className="text-xs text-gray-500">
            {teamName ? `${teamName} team’s assets` : 'Based on the assets you can see'}
          </span>
        </div>
        {d.teams.length > 1 ? (
          <div className="w-56">
            <Select
              label="Team"
              htmlFor="insights-team"
              value={teamId}
              onChange={chooseTeam}
              options={[
                { value: '', label: 'All teams' },
                ...d.teams.map((t) => ({ value: t.id, label: `${t.name} (${plain(t.count)})` })),
              ]}
            />
          </div>
        ) : null}
      </div>
      {d.total === 0 ? <p className="mb-4 text-sm text-gray-500">This team has no assets yet.</p> : null}
      {variant !== 'employee' ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Assets in use or in store" value={plain(d.live)} detail={`${plain(d.total)} on the register`} to="/assets" />
          <StatTile label="Held by people" value={plain(d.custody.held)} detail={d.multiHolders === 1 ? '1 person holds more than one' : `${plain(d.multiHolders)} people hold more than one`} />
          <StatTile label="Warranty ending in 90 days" value={plain(d.warranty.within30 + d.warranty.within90)} detail={`${plain(d.warranty.expired)} already expired`} />
          <StatTile
            label={d.money ? 'Purchase value in use' : 'Departments'}
            value={d.money ? formatInr(d.liveValue ?? 0) : plain(d.byDepartment.length)}
            detail={d.money ? 'At purchase cost' : 'With assets'}
          />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">{CHARTS[variant].map(card)}</div>
    </section>
  );
}
