import { useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, queryString } from '../api';
import { can, useSession } from '../session';
import { formatInr, fyOptions, humaniseAction } from '../admin-insights';
import {
  formatHours,
  summaryLine,
  teamTotals,
  type TeamStatusRow,
  type TrendWeek,
} from '../executive';
import { useReferences } from './References';
import { buttonClass, cx, displayDate, ErrorNotice, Loading } from './ui';
import {
  BarList,
  Card,
  ColumnChart,
  DonutChart,
  EmptyChart,
  PairedColumnChart,
  StatTile,
} from './charts';

interface Summary {
  assets?: {
    total: number;
    assigned: number;
    pendingAcknowledgements: number;
    warrantyExpiring: number;
  };
  tickets?: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    unassigned: number;
  };
  unknownCounts?: { warrantyExpiry: number; amcExpiry: number; financePending: number };
  imports?: { quarantined: number };
}
interface ExecutiveData {
  assetsByTeam: TeamStatusRow[];
  needsAttention: {
    pendingFinance: number;
    leftHoldersWithAssets: number;
    warrantyExpiring30: number;
    amcExpiring30: number;
    openHighTickets: number;
  };
  ticketTrends: {
    weeks: TrendWeek[];
    teams: {
      teamId: string;
      teamName: string;
      opened: number;
      completed: number;
      medianResolutionHours: number | null;
    }[];
  };
}
interface AdminData {
  filters: { fy: number; fyLabel: string };
  kpis: {
    totalAssets: number;
    totalSpend: number;
    fySpend: number;
    missingCost: number;
    assigned: number;
    assignedPct: number;
    openTickets: number;
    warrantyExpiring: number;
  };
  spendByYear: { label: string; spend: number; count: number }[];
  spendByCategory: { label: string; spend: number; count: number }[];
  spendByDepartment: { label: string; spend: number; count: number }[];
  statusCounts: { label: string; count: number }[];
  ticketWeeks: { weekStart: string; opened: number; completed: number }[];
  expiring: {
    assetId: string;
    assetCode: string;
    assetType: string;
    kind: 'Warranty' | 'AMC';
    date: string;
  }[];
  topReported: { assetId: string; assetCode: string; assetType: string; tickets: number }[];
  financeGaps: {
    assetId: string;
    assetCode: string;
    assetType: string;
    missingCost: boolean;
    missingDate: boolean;
  }[];
  recentActivity: { action: string; entityType: string; actor: string; occurredAt: string }[];
  /** When the figures were computed; totals are refreshed in the background. */
  asOf?: string;
}
type Filters = { fy: string; departmentId: string; category: string };
const noFilters: Filters = { fy: '', departmentId: '', category: '' };

const plain = (n: number) => n.toLocaleString('en-IN');
/** ₹ in Indian units for headline numbers: ₹4.2 Cr, ₹18.5 L, ₹45,999. */
export function inrShort(value: number) {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(value >= 1e8 ? 0 : 1)} Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(value >= 1e6 ? 0 : 1)} L`;
  return formatInr(value);
}
const activityLabel = (action: string) =>
  ({
    LOGIN_MFA: 'Signed in (two-step)',
    LOGIN: 'Signed in',
    ZOHO_SYNC_COMPLETED: 'Zoho sync completed',
  })[action] ?? humaniseAction(action);

function useAdminData(filters: Filters) {
  return useQuery({
    queryKey: ['dashboard-admin', filters],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api<AdminData>(`/dashboard/admin${queryString(filters)}`, { signal }),
  });
}

type Tone = 'danger' | 'warning' | 'neutral';
interface AttentionItem {
  label: string;
  count: number | undefined;
  to?: string;
  tone: Tone;
}
const toneDot: Record<Tone, string> = {
  danger: 'bg-red-600',
  warning: 'bg-yellow-500',
  neutral: 'bg-navy-500',
};

function AttentionList({ items }: { items: AttentionItem[] }) {
  const open = items.filter((i) => (i.count ?? 0) > 0);
  const clear = items.filter((i) => !((i.count ?? 0) > 0));
  const row = (item: AttentionItem) => {
    const active = (item.count ?? 0) > 0;
    const body = (
      <>
        <span
          className={cx(
            'size-2 shrink-0 rounded-full',
            active ? toneDot[item.tone] : 'bg-gray-200',
          )}
          aria-hidden="true"
        />
        <span className={cx('flex-1 truncate text-sm', active ? 'text-gray-800' : 'text-gray-400')}>
          {item.label}
        </span>
        <span
          className={cx(
            'text-sm tabular-nums',
            active ? 'font-semibold text-gray-900' : 'text-gray-400',
          )}
        >
          {item.count ?? '—'}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={cx(
            'size-3.5 shrink-0',
            item.to ? 'text-gray-300 group-hover:text-navy-700' : 'invisible',
          )}
          aria-hidden="true"
        >
          <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </>
    );
    const cls = 'group flex items-center gap-3 px-1 py-2.5';
    return (
      <li key={item.label}>
        {item.to ? (
          <Link to={item.to} className={cx(cls, 'rounded-md no-underline hover:bg-gray-50')}>
            {body}
          </Link>
        ) : (
          <div className={cls}>{body}</div>
        )}
      </li>
    );
  };
  return (
    <>
      {open.length === 0 ? (
        <p className="mb-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
          Everything is in order. Nothing needs action right now.
        </p>
      ) : null}
      {open.length ? <ul className="divide-y divide-gray-100">{open.map(row)}</ul> : null}
      {clear.length ? (
        <details className="group mt-auto border-t border-gray-100 pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-gray-500 select-none hover:text-navy-700 [&::-webkit-details-marker]:hidden">
            <span className="size-2 rounded-full bg-sky-500" aria-hidden="true" />
            {clear.length} other {clear.length === 1 ? 'check is' : 'checks are'} clear
            <svg
              viewBox="0 0 16 16"
              className="size-3 transition-transform group-open:rotate-90"
              aria-hidden="true"
            >
              <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </summary>
          <ul className="mt-1 divide-y divide-gray-100">{clear.map(row)}</ul>
        </details>
      ) : null}
    </>
  );
}

function MiniTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: { key: string; cells: ReactNode[] }[];
  empty: string;
}) {
  if (!rows.length) return <EmptyChart>{empty}</EmptyChart>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-0 border-collapse text-left text-sm">
        <thead>
          <tr className="text-xs text-gray-500">
            {headers.map((h, i) => (
              <th
                key={h}
                className={cx('px-5 pb-2 font-medium', i === headers.length - 1 && 'text-right')}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-gray-100">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={cx(
                    'px-5 py-2.5 text-gray-700',
                    i === row.cells.length - 1 && 'text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const assetLink = (id: string, code: string) => (
  <Link to={`/assets/${id}`} className="font-medium text-navy-700 no-underline hover:underline">
    {code}
  </Link>
);

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs font-medium text-gray-500">
      {label}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-40 rounded-lg border border-gray-300 bg-white px-3 text-sm font-normal text-gray-800 focus-visible:outline-2 focus-visible:outline-navy-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OverviewDashboard() {
  const { user } = useSession();
  const now = new Date();
  const [filters, setFilters] = useState<Filters>(noFilters);
  const refs = useReferences();
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api<Summary>('/dashboard', { signal }),
  });
  const exec = useQuery({
    queryKey: ['dashboard', 'executive'],
    queryFn: ({ signal }) => api<ExecutiveData>('/dashboard/executive', { signal }),
  });
  const all = useAdminData(noFilters);
  const spend = useAdminData(filters);
  const isAdmin = can(user, 'system.admin');

  const attention = exec.data?.needsAttention;
  const k = all.data?.kpis;
  const statuses = all.data?.statusCounts ?? [];
  const totalAssets = k?.totalAssets ?? 0;
  const inStore = statuses.find((s) => s.label === 'In Store')?.count ?? 0;
  const teams = exec.data ? teamTotals(exec.data.assetsByTeam) : [];

  const items: AttentionItem[] = [
    {
      label: 'Waiting for Finance review',
      count: attention?.pendingFinance,
      // Only Finance can open the review queue; others (e.g. Executive) just see the count.
      to: can(user, 'asset.finance_edit') ? '/finance' : undefined,
      tone: 'warning',
    },
    {
      label: 'Assets held by people who have left',
      count: attention?.leftHoldersWithAssets,
      to: isAdmin ? '/admin/directory' : undefined,
      tone: 'danger',
    },
    {
      label: 'High-priority tickets open',
      count: attention?.openHighTickets,
      to: '/tickets?priority=HIGH',
      tone: 'danger',
    },
    {
      label: 'Support requests without an owner',
      count: summary.data?.tickets?.unassigned,
      to: '/tickets',
      tone: 'warning',
    },
    {
      label: 'Warranty ending in 30 days',
      count: attention?.warrantyExpiring30,
      to: '/assets',
      tone: 'warning',
    },
    {
      label: 'AMC ending in 30 days',
      count: attention?.amcExpiring30,
      to: '/assets',
      tone: 'warning',
    },
    {
      label: 'Custody not yet confirmed',
      count: summary.data?.assets?.pendingAcknowledgements,
      to: '/assets',
      tone: 'neutral',
    },
    ...(isAdmin
      ? [
          {
            label: 'Import rows to review',
            count: summary.data?.imports?.quarantined,
            to: '/admin/imports',
            tone: 'neutral' as Tone,
          },
        ]
      : []),
    {
      label: 'Assets missing purchase cost',
      count: k?.missingCost,
      to: '/assets',
      tone: 'neutral',
    },
    {
      label: 'Assets with unknown warranty date',
      count: summary.data?.unknownCounts?.warrantyExpiry,
      to: '/assets',
      tone: 'neutral',
    },
  ];
  const openCount = items.filter((i) => (i.count ?? 0) > 0).length;
  const headline = attention
    ? summaryLine([
        { label: 'waiting for Finance', count: attention.pendingFinance },
        { label: 'assets to recover', count: attention.leftHoldersWithAssets },
        { label: 'high-priority tickets', count: attention.openHighTickets },
      ])
    : '';

  const error = summary.error ?? exec.error ?? all.error ?? spend.error ?? refs.error;
  const categories = refs.data?.values.filter((v) => v.kind.toLowerCase() === 'category') ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-navy-900">
            Overview
          </h1>
          {headline ? <p className="mt-1 text-sm text-gray-500">{headline}</p> : null}
          {all.data?.asOf ? (
            <p className="mt-1 text-xs text-gray-400">
              Figures as of {displayDate(all.data.asOf, true)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {can(user, 'report.view') ? (
            <Link to="/reports" className={buttonClass('secondary')}>
              Reports
            </Link>
          ) : null}
          {can(user, 'asset.create') ? (
            <Link to="/assets/new" className={buttonClass()}>
              Add asset
            </Link>
          ) : null}
        </div>
      </header>

      <ErrorNotice
        error={error}
        retry={() => {
          void summary.refetch();
          void exec.refetch();
          void all.refetch();
          void spend.refetch();
          void refs.refetch();
        }}
      />

      {all.isPending || exec.isPending ? (
        <Loading label="Loading dashboard…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Total assets"
              value={plain(totalAssets)}
              detail="In the register"
              to="/assets"
            />
            <StatTile
              label="Assigned"
              value={plain(k?.assigned ?? 0)}
              detail={`${k?.assignedPct ?? 0}% of all assets`}
              to="/assets?status=Assigned"
            />
            <StatTile
              label="In store"
              value={plain(inStore)}
              detail="Ready to issue"
              to="/assets?status=In%20Store"
            />
            <StatTile
              label="Open tickets"
              value={plain(k?.openTickets ?? 0)}
              detail="Support requests"
              to="/tickets"
            />
            <StatTile
              label="Total spend"
              value={inrShort(k?.totalSpend ?? 0)}
              detail="Recorded purchase cost"
            />
            <StatTile
              label={`Spend in ${all.data?.filters.fyLabel ?? 'this FY'}`}
              value={inrShort(k?.fySpend ?? 0)}
              detail="April to March"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card
              title="Needs attention"
              className="lg:col-span-3"
              action={
                openCount ? (
                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                    {openCount} open
                  </span>
                ) : null
              }
            >
              <AttentionList items={items} />
            </Card>
            <Card title="Assets by status" className="lg:col-span-2">
              <DonutChart
                valueLabel="Assets"
                labelHeader="Status"
                centerLabel="Assets"
                empty="No assets yet"
                items={statuses.map((s) => ({
                  label: s.label,
                  value: s.count,
                  to: `/assets?status=${encodeURIComponent(s.label)}`,
                }))}
              />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Assets by team">
              <BarList
                valueLabel="Assets"
                empty="No team-owned assets yet"
                items={teams.map((t) => ({
                  label: t.label,
                  value: t.count,
                  note: t.value ? inrShort(t.value) : undefined,
                  to: `/assets?owningTeamId=${t.teamId}`,
                }))}
              />
            </Card>
            <Card title="Support tickets, last 12 weeks">
              <PairedColumnChart
                series={['Opened', 'Completed']}
                empty="No tickets in the last 12 weeks"
                xLabel={(key) => `Week of ${displayDate(key)}`}
                points={(all.data?.ticketWeeks ?? []).map((w) => ({
                  key: w.weekStart,
                  label: displayDate(w.weekStart).replace(/,?\s*\d{4}$/, ''),
                  a: w.opened,
                  b: w.completed,
                }))}
              />
              {exec.data?.ticketTrends.teams.length ? (
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  {exec.data.ticketTrends.teams.map((t) => (
                    <Link
                      key={t.teamId}
                      to={`/tickets?teamId=${t.teamId}`}
                      className="rounded-lg bg-gray-50 px-3 py-2 no-underline transition-colors hover:bg-navy-50"
                    >
                      <span className="block text-xs font-medium text-gray-700">{t.teamName}</span>
                      <span className="block text-[11px] text-gray-500">
                        {t.opened} opened · {t.completed} done · median{' '}
                        {formatHours(t.medianResolutionHours)}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : null}
            </Card>
          </div>

          <section aria-labelledby="spend-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-gray-200 pt-6">
              <div>
                <h2 id="spend-heading" className="text-base font-semibold text-navy-900">
                  Spend
                </h2>
                <p className="text-xs text-gray-500">
                  Purchase cost of priced assets in INR
                  {spend.isFetching && spend.data ? ' · updating…' : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <FilterSelect
                  id="dash-fy"
                  label="Financial year"
                  value={filters.fy}
                  onChange={(fy) => setFilters({ ...filters, fy })}
                  options={[{ value: '', label: 'All years' }, ...fyOptions(now)]}
                />
                <FilterSelect
                  id="dash-department"
                  label="Department"
                  value={filters.departmentId}
                  onChange={(departmentId) => setFilters({ ...filters, departmentId })}
                  options={[
                    { value: '', label: 'All departments' },
                    ...(refs.data?.departments ?? []).map((d) => ({
                      value: d.id,
                      label: `${d.name}${d.active ? '' : ' (inactive)'}`,
                    })),
                  ]}
                />
                <FilterSelect
                  id="dash-category"
                  label="Category"
                  value={filters.category}
                  onChange={(category) => setFilters({ ...filters, category })}
                  options={[
                    { value: '', label: 'All categories' },
                    ...categories.map((c) => ({
                      value: c.code,
                      label: `${c.label}${c.active ? '' : ' (inactive)'}`,
                    })),
                  ]}
                />
              </div>
            </div>
            <div
              className={cx(
                'grid gap-6 transition-opacity lg:grid-cols-3',
                spend.isFetching && spend.data && 'opacity-70',
              )}
            >
              <Card title="By financial year">
                <ColumnChart
                  valueLabel="Spend"
                  empty="No priced assets yet"
                  format={formatInr}
                  shortFormat={inrShort}
                  items={(spend.data?.spendByYear ?? []).map((y) => ({
                    label: y.label.replace('FY ', ''),
                    value: y.spend,
                    detail: `${y.label}: ${formatInr(y.spend)} · ${y.count} assets`,
                  }))}
                />
              </Card>
              <Card title="By category">
                <BarList
                  valueLabel="Spend"
                  empty="No priced assets yet"
                  format={inrShort}
                  items={(spend.data?.spendByCategory ?? []).map((c) => ({
                    label: c.label,
                    value: c.spend,
                  }))}
                />
              </Card>
              <Card title="By department">
                <BarList
                  valueLabel="Spend"
                  empty="No priced assets yet"
                  format={inrShort}
                  items={(spend.data?.spendByDepartment ?? []).map((d) => ({
                    label: d.label,
                    value: d.spend,
                  }))}
                />
              </Card>
            </div>
          </section>

          <div className="grid gap-6 border-t border-gray-200 pt-6 lg:grid-cols-2">
            <Card title="Warranty and AMC ending in 60 days">
              <MiniTable
                empty="Nothing ending in the next 60 days"
                headers={['Asset', 'Type', 'Cover', 'Ends']}
                rows={(all.data?.expiring ?? []).map((r) => ({
                  key: `${r.assetId}-${r.kind}`,
                  cells: [
                    assetLink(r.assetId, r.assetCode),
                    r.assetType,
                    r.kind,
                    displayDate(r.date),
                  ],
                }))}
              />
            </Card>
            <Card
              title="Missing finance details"
              action={
                all.data?.financeGaps.length ? (
                  <Link
                    to="/assets"
                    className="text-xs font-medium text-navy-700 no-underline hover:underline"
                  >
                    Open catalog
                  </Link>
                ) : null
              }
            >
              <MiniTable
                empty="Every asset has its cost and purchase date"
                headers={['Asset', 'Type', 'Missing']}
                rows={(all.data?.financeGaps ?? []).map((r) => ({
                  key: r.assetId,
                  cells: [
                    assetLink(r.assetId, r.assetCode),
                    r.assetType,
                    [r.missingCost && 'Cost', r.missingDate && 'Purchase date']
                      .filter(Boolean)
                      .join(', '),
                  ],
                }))}
              />
            </Card>
            <Card title="Most-reported assets">
              <MiniTable
                empty="No tickets raised against assets yet"
                headers={['Asset', 'Type', 'Tickets']}
                rows={(all.data?.topReported ?? []).map((r) => ({
                  key: r.assetId,
                  cells: [assetLink(r.assetId, r.assetCode), r.assetType, r.tickets],
                }))}
              />
            </Card>
            <Card title="Recent activity">
              <MiniTable
                empty="No activity yet"
                headers={['What happened', 'By', 'When']}
                rows={(all.data?.recentActivity ?? []).map((r, i) => ({
                  key: `${r.occurredAt}-${i}`,
                  cells: [
                    activityLabel(r.action),
                    r.actor,
                    <time
                      key="t"
                      dateTime={r.occurredAt}
                      className="whitespace-nowrap text-gray-500"
                    >
                      {displayDate(r.occurredAt, true)}
                    </time>,
                  ],
                }))}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
