import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { BarList, Card, ColumnChart, DonutChart, StatTile } from './charts';
import { ErrorNotice } from './ui';

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
  topHolders: Holder[];
  multiHolders: number;
  total: number;
  live: number;
  liveValue: number | null;
  byStatus: Slice[];
  byType: Slice[];
  byDepartment: Slice[];
  byCondition: Slice[];
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
  | 'valueDepartment';

const CHARTS: Record<InsightsVariant, ChartKey[]> = {
  overview: ['department', 'holders', 'type', 'status', 'year', 'warranty', 'age', 'custody'],
  finance: ['valueDepartment', 'year', 'supplier', 'age', 'type', 'warranty'],
  store: ['custody', 'status', 'condition', 'type', 'department', 'holders'],
  auditor: ['audit', 'department', 'condition', 'holders', 'status', 'custody'],
  insurer: ['insurance', 'warranty', 'department', 'type', 'age', 'condition'],
  procurement: ['year', 'supplier', 'age', 'type', 'warranty', 'department'],
  team: ['department', 'holders', 'type', 'status', 'warranty', 'condition'],
  employee: ['type', 'warranty'],
};

const plain = (n: number) => n.toLocaleString('en-IN');
const shortInr = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : formatInr(n);
/** Largest first, the rest summed as "Other" so charts stay readable. */
function topWithOther(items: { label: string; value: number }[], keep: number) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  if (sorted.length <= keep + 1) return sorted;
  const rest = sorted.slice(keep).reduce((sum, i) => sum + i.value, 0);
  return [...sorted.slice(0, keep), { label: 'Other', value: rest }];
}
const assetsLink = (key: string, value: string) => `/assets?${new URLSearchParams({ [key]: value })}`;

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
export function AssetInsights({ variant }: { variant: InsightsVariant }) {
  const query = useQuery({
    queryKey: ['dashboard', 'insights'],
    queryFn: ({ signal }) => api<InsightsData>('/dashboard/insights', { signal }),
    staleTime: 60_000,
  });
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const d = query.data;
  if (!d || d.total === 0) return null;

  const counts = (items: Slice[]) => items.map((s) => ({ label: s.label, value: s.count }));
  const card = (key: ChartKey) => {
    switch (key) {
      case 'holders':
        return (
          <Card
            key={key}
            title="Who holds the most"
            action={<span className="text-xs text-gray-500">{plain(d.multiHolders)} hold more than one</span>}
          >
            <BarList
              items={d.topHolders.map((h) => ({
                label: h.name,
                value: h.count,
                note: h.department ?? undefined,
                to: assetsLink('holderId', h.userId),
              }))}
              valueLabel="Assets held"
              empty="Nobody holds an asset yet"
            />
          </Card>
        );
      case 'department':
        return (
          <Card key={key} title="Assets by department">
            <ColumnChart
              items={topWithOther(counts(d.byDepartment), 7).map((s) => ({ ...s, detail: `${s.label}: ${plain(s.value)}` }))}
              format={plain}
              valueLabel="Assets"
              labelHeader="Department"
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
      case 'type':
        return (
          <Card key={key} title="By subcategory">
            <DonutChart items={counts(d.byType).map((s) => ({ ...s, to: assetsLink('assetType', s.label) }))} valueLabel="Assets" labelHeader="Subcategory" centerLabel="Assets" />
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
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-base font-medium text-gray-900">Asset insights</h2>
        <span className="text-xs text-gray-500">Based on the assets you can see</span>
      </div>
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
