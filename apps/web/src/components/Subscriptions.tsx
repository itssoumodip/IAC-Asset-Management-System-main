import { useEffect, useMemo, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { AssignablePerson, User } from '../types';
import { Card, ColumnChart, DonutChart, EmptyChart, StatTile } from './charts';
import { PersonPicker } from './PersonPicker';
import { ColumnFilter, FilterChips, FiltersButton, SortMenu, fromList, toList, type FilterGroup } from './ColumnFilter';
import { useReferences } from './References';
import {
  Avatar,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  PersonChip,
  Select,
  backLinkClass,
  buttonClass,
  cx,
  displayDate,
  inputClass,
  tableClass,
  tableWrapClass,
} from './ui';

/* ------------------------------------------------------------- access */

const IT_TEAM_ID = '00000000-0000-4000-8000-000000000001';
/** Only the IT team (any level) and Super Admin add, change or assign subscriptions. */
export function canManageSubscriptions(user: User | undefined) {
  return !!user && (user.roles.includes('SUPER_ADMIN') || (user.teams ?? []).some((t) => t.teamId === IT_TEAM_ID));
}
/** Leadership, Finance and auditors may look; everyone else sees only their own. */
export function canViewSubscriptions(user: User | undefined) {
  return canManageSubscriptions(user) || can(user, 'report.view') || can(user, 'asset.finance_edit');
}

/* -------------------------------------------------------------- types */

type Cycle = 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY' | 'ONE_TIME' | 'FREE';
type Status = 'TRIAL' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
type Audience = 'PEOPLE' | 'DEPARTMENT' | 'ORGANISATION';
const AUDIENCE_LABEL: Record<Audience, string> = { PEOPLE: 'Specific people', DEPARTMENT: 'A department', ORGANISATION: 'Everyone' };
interface Holder {
  userId: string;
  name: string;
  hasPhoto: boolean;
}
interface Subscription {
  id: string;
  code: string;
  name: string;
  vendor: string | null;
  category: string;
  plan: string | null;
  billingCycle: Cycle;
  cost: number | null;
  monthlyCost: number | null;
  /** The same in rupees at today's rate (null when no rate is known). */
  costInr?: number | null;
  monthlyCostInr?: number | null;
  currency: string;
  seatsTotal: number | null;
  seatsUsed: number;
  startDate: string | null;
  renewalDate: string | null;
  daysToRenewal: number | null;
  autoRenew: boolean;
  status: Status;
  accountEmail: string | null;
  website: string | null;
  paymentMethod: string | null;
  departmentId: string | null;
  department: string | null;
  audience: Audience;
  logoVersion: number | null;
  notes: string | null;
  holders: Holder[];
  version: number;
}
interface SubscriptionPerson {
  assignmentId: string;
  userId: string;
  name: string;
  email: string;
  designation: string | null;
  department: string | null;
  left: boolean;
  hasPhoto: boolean;
  assignedAt: string;
  note: string | null;
  assignedBy: string | null;
  endedAt: string | null;
  endNote: string | null;
  endedBy: string | null;
}
interface SubscriptionDetailData extends Subscription {
  people: SubscriptionPerson[];
  history: SubscriptionPerson[];
  canManage: boolean;
}
interface SubscriptionSummary {
  live: number;
  trials: number;
  monthlySpend: number | null; // null when Field permissions hide cost
  yearlySpend: number | null;
  renewalsDue30: number;
  renewalsPassed: number;
  seatsTotal: number;
  seatsUsed: number;
  peopleCount: number | null; // null when Field permissions hide people
  withFreeSeats: number;
  rates: { asOf: string | null; stale: boolean; unconverted: number };
  byCategory: { label: string; count: number; monthly: number }[];
  months: { month: string; renewals: number; cost: number }[];
  upcoming: { id: string; name: string; vendor: string | null; renewalDate: string; days: number; cost: number | null; costInr: number | null; currency: string; autoRenew: boolean }[];
  topPeople: { userId: string; name: string; hasPhoto: boolean; count: number; monthlyShare: number }[];
}

const CYCLE_LABEL: Record<Cycle, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Every 3 months',
  HALF_YEARLY: 'Every 6 months',
  YEARLY: 'Yearly',
  ONE_TIME: 'One-time',
  FREE: 'Free',
};
const STATUS_LABEL: Record<Status, string> = { TRIAL: 'Trial', ACTIVE: 'Active', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const STATUS_TONE: Record<Status, string> = {
  ACTIVE: 'bg-sky-50 text-sky-800 ring-sky-100',
  TRIAL: 'bg-yellow-50 text-yellow-800 ring-yellow-200',
  CANCELLED: 'bg-gray-100 text-gray-600 ring-gray-200',
  EXPIRED: 'bg-red-50 text-red-700 ring-red-100',
};
const money = (n: number | null | undefined, currency = 'INR') =>
  n == null ? '—' : currency === 'INR' ? formatInr(n) : `${currency} ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Amount in its own currency, with today's rupee value underneath for foreign currencies. */
function MoneyCell({ amount, currency, inr, sub }: { amount: number | null; currency: string; inr?: number | null; sub?: string }) {
  return (
    <>
      <span className="block whitespace-nowrap tabular-nums text-gray-900">{money(amount, currency)}</span>
      {currency !== 'INR' && amount != null ? (
        <span className="block whitespace-nowrap text-xs text-gray-500 tabular-nums">{inr != null ? `≈ ${formatInr(inr)}` : 'No rate today'}</span>
      ) : null}
      {sub ? <span className="text-xs text-gray-500">{sub}</span> : null}
    </>
  );
}

function StatusPill({ status }: { status: Status }) {
  return (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Renewal date plus how far away it is, red when passed and amber within 30 days. */
function RenewalCell({ s }: { s: Pick<Subscription, 'renewalDate' | 'daysToRenewal' | 'status' | 'autoRenew'> }) {
  if (!s.renewalDate) return <span className="text-gray-400">No date</span>;
  const live = s.status === 'ACTIVE' || s.status === 'TRIAL';
  const d = s.daysToRenewal ?? 0;
  return (
    <div className="flex flex-col">
      <span className="whitespace-nowrap text-gray-800">{displayDate(s.renewalDate)}</span>
      {live ? (
        <span className={cx('text-xs', d < 0 ? 'font-medium text-red-700' : d <= 30 ? 'font-medium text-yellow-800' : 'text-gray-500')}>
          {d < 0 ? `Passed ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'Today' : `In ${d} day${d === 1 ? '' : 's'}`}
          {s.autoRenew ? ' · auto-renews' : ''}
        </span>
      ) : null}
    </div>
  );
}

function SeatsCell({ s }: { s: Pick<Subscription, 'seatsTotal' | 'seatsUsed'> }) {
  if (s.seatsTotal == null) return <span className="text-gray-700">{s.seatsUsed} <span className="text-xs text-gray-400">· no limit</span></span>;
  const pct = Math.min(100, Math.round((s.seatsUsed / s.seatsTotal) * 100));
  return (
    <div className="min-w-24">
      <span className="text-sm text-gray-800 tabular-nums">
        {s.seatsUsed} / {s.seatsTotal}
      </span>
      <span className="mt-1 block h-1.5 rounded-full bg-gray-100">
        <span
          data-grow="x"
          className={cx('block h-1.5 origin-left rounded-full', pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-yellow-500' : 'bg-navy-600')}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- list */

/** Columns the subscription list can show; the subscription column (logo, name) is always on. */
const subscriptionColumns = [
  { key: 'type', label: 'Type' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'plan', label: 'Plan' },
  { key: 'audience', label: 'For' },
  { key: 'people', label: 'People' },
  { key: 'seats', label: 'Seats' },
  { key: 'cost', label: 'Cost' },
  { key: 'monthly', label: 'Per month' },
  { key: 'billing', label: 'Billing' },
  { key: 'start', label: 'Started' },
  { key: 'renewal', label: 'Renewal' },
  { key: 'autoRenew', label: 'Auto-renew' },
  { key: 'status', label: 'Status' },
] as const;
type SubscriptionColumn = (typeof subscriptionColumns)[number]['key'];
const defaultSubscriptionColumns: SubscriptionColumn[] = ['type', 'audience', 'people', 'seats', 'cost', 'renewal', 'status'];
/** Header filters, kept in the URL as comma-separated lists. */
const FILTER_KEYS = ['type', 'vendor', 'audience', 'billing', 'renewal', 'status'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const renewalBand = (s: Subscription) =>
  !s.renewalDate ? 'none' : (s.daysToRenewal ?? 0) < 0 ? 'passed' : (s.daysToRenewal ?? 0) <= 30 ? 'due30' : 'later';
const audienceKey = (s: Subscription) => (s.audience === 'DEPARTMENT' ? `DEPT:${s.department ?? ''}` : s.audience);

/** Vendor logo (fetched by the server from the website's domain), or initials on a tile. */
export function SubscriptionLogo({ s, size = 32 }: { s: Pick<Subscription, 'id' | 'name' | 'logoVersion'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = s.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  const style = { width: size, height: size };
  return s.logoVersion != null && !failed ? (
    <img
      src={`/api/v1/subscriptions/${s.id}/logo?v=${s.logoVersion}`}
      alt=""
      loading="lazy"
      className="shrink-0 rounded-lg bg-white object-contain p-1 ring-1 ring-gray-200"
      style={style}
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg bg-navy-50 text-xs font-semibold text-navy-700 ring-1 ring-navy-100"
      style={style}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function SubscriptionList() {
  const { user } = useSession();
  const manage = canManageSubscriptions(user);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'renewal';
  const sel = (key: FilterKey) => toList(params.get(key));
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const timer = setTimeout(() => search.trim() !== q && update('q', search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  // The server searches (including the people using each one); filters and sort run here.
  const list = useQuery({
    queryKey: ['subscriptions', q],
    queryFn: ({ signal }) => api<{ items: Subscription[] }>(`/subscriptions${q ? `?q=${encodeURIComponent(q)}` : ''}`, { signal }),
    placeholderData: (previous) => previous,
  });
  const summary = useQuery({
    queryKey: ['subscriptions', 'summary'],
    queryFn: ({ signal }) => api<SubscriptionSummary>('/subscriptions/summary', { signal }),
  });
  const [columns, setColumns] = useState<SubscriptionColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('subscription-columns-v1') ?? 'null');
      return Array.isArray(saved)
        ? (saved.filter((k) => subscriptionColumns.some((c) => c.key === k)) as SubscriptionColumn[])
        : defaultSubscriptionColumns;
    } catch {
      return defaultSubscriptionColumns;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('subscription-columns-v1', JSON.stringify(columns));
    } catch {
      // Column choice still applies for this visit if storage is unavailable.
    }
  }, [columns]);
  const s = summary.data;
  const all = list.data?.items ?? [];
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-IN');

  const distinct = (pick: (x: Subscription) => string | null, label?: (v: string) => string) =>
    [...new Set(all.map(pick).filter(Boolean) as string[])]
      .sort((a, b) => (label ? label(a) : a).localeCompare(label ? label(b) : b))
      .map((v) => ({ value: v, label: `${label ? label(v) : v} (${all.filter((x) => pick(x) === v).length})` }));
  const audienceLabel = (v: string) => (v.startsWith('DEPT:') ? `Department: ${v.slice(5)}` : AUDIENCE_LABEL[v as Audience]);
  const groups: FilterGroup[] = [
    { key: 'type', title: 'Type', options: distinct((x) => x.category), selected: sel('type') },
    { key: 'vendor', title: 'Vendor', options: distinct((x) => x.vendor), selected: sel('vendor') },
    { key: 'audience', title: 'For', options: distinct(audienceKey, audienceLabel), selected: sel('audience') },
    { key: 'billing', title: 'Billing', options: distinct((x) => x.billingCycle, (v) => CYCLE_LABEL[v as Cycle]), selected: sel('billing') },
    {
      key: 'renewal',
      title: 'Renewal',
      options: [
        { value: 'passed', label: 'Renewal date passed' },
        { value: 'due30', label: 'Renews within 30 days' },
        { value: 'later', label: 'Later' },
        { value: 'none', label: 'No renewal date' },
      ],
      selected: sel('renewal'),
    },
    { key: 'status', title: 'Status', options: distinct((x) => x.status, (v) => STATUS_LABEL[v as Status]), selected: sel('status') },
  ];
  const matches = (x: Subscription) => {
    const has = (key: FilterKey, value: string | null) => !sel(key).length || (value != null && sel(key).includes(value));
    return (
      has('type', x.category) &&
      has('vendor', x.vendor) &&
      has('audience', audienceKey(x)) &&
      has('billing', x.billingCycle) &&
      has('renewal', renewalBand(x)) &&
      has('status', x.status)
    );
  };
  const items = all.filter(matches).sort((a, b) => {
    const live = (x: Subscription) => (x.status === 'ACTIVE' || x.status === 'TRIAL' ? 0 : 1);
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'cost') return (b.monthlyCostInr ?? 0) - (a.monthlyCostInr ?? 0);
    if (sort === 'people') return b.seatsUsed - a.seatsUsed;
    // Default: live ones first, soonest renewal first, no date last.
    return live(a) - live(b) || (a.renewalDate ?? '9999').localeCompare(b.renewalDate ?? '9999') || a.name.localeCompare(b.name);
  });
  const setFilter = (key: string, values: string[]) => update(key, fromList(values));
  const applyFilters = (next: Record<string, string[]>) => {
    const p = new URLSearchParams(params);
    for (const [key, values] of Object.entries(next)) {
      if (values.length) p.set(key, fromList(values));
      else p.delete(key);
    }
    setParams(p, { replace: true });
  };
  const shown = subscriptionColumns.filter((c) => columns.includes(c.key));
  const filterFor: Partial<Record<SubscriptionColumn, FilterKey>> = {
    type: 'type',
    vendor: 'vendor',
    audience: 'audience',
    billing: 'billing',
    renewal: 'renewal',
    status: 'status',
  };
  const header = (key: SubscriptionColumn, label: string) => {
    const fk = filterFor[key];
    const group = fk ? groups.find((g) => g.key === fk) : undefined;
    const right = key === 'cost' || key === 'monthly';
    return (
      <th key={key} className={right ? 'text-right' : undefined}>
        <span className="inline-flex items-center gap-1">
          {label}
          {group ? <ColumnFilter title={label} options={group.options} selected={group.selected} onApply={(v) => setFilter(group.key, v)} /> : null}
        </span>
      </th>
    );
  };
  const cell = (sub: Subscription, key: SubscriptionColumn): ReactNode => {
    switch (key) {
      case 'type':
        return sub.category;
      case 'vendor':
        return sub.vendor ?? '—';
      case 'plan':
        return sub.plan ?? '—';
      case 'audience':
        return sub.audience === 'PEOPLE' ? (
          <span className="text-sm text-gray-700">Named people</span>
        ) : (
          <span className="inline-flex rounded-full bg-navy-50 px-2 py-0.5 text-xs font-medium text-navy-700 ring-1 ring-navy-100 ring-inset">
            {sub.audience === 'ORGANISATION' ? 'Everyone' : `Dept: ${sub.department ?? '—'}`}
          </span>
        );
      case 'people':
        return sub.holders.length ? (
          <div className="flex items-center">
            <div className="flex -space-x-2">
              {sub.holders.slice(0, 4).map((h) => (
                <span key={h.userId} title={h.name} className="rounded-full ring-2 ring-white">
                  <AvatarSmall userId={h.userId} name={h.name} hasPhoto={h.hasPhoto} />
                </span>
              ))}
            </div>
            {sub.seatsUsed > 4 ? <span className="ml-2 text-xs text-gray-500">+{sub.seatsUsed - 4}</span> : null}
          </div>
        ) : (
          <span className="text-gray-400">{sub.audience === 'PEOPLE' ? 'Nobody yet' : '—'}</span>
        );
      case 'seats':
        return <SeatsCell s={sub} />;
      case 'cost':
        return <MoneyCell amount={sub.cost} currency={sub.currency} inr={sub.costInr} sub={CYCLE_LABEL[sub.billingCycle]} />;
      case 'monthly':
        return sub.monthlyCost ? <MoneyCell amount={sub.monthlyCost} currency={sub.currency} inr={sub.monthlyCostInr} /> : '—';
      case 'billing':
        return CYCLE_LABEL[sub.billingCycle];
      case 'start':
        return sub.startDate ? displayDate(sub.startDate) : '—';
      case 'renewal':
        return <RenewalCell s={sub} />;
      case 'autoRenew':
        return sub.autoRenew ? 'Yes' : 'No';
      case 'status':
        return <StatusPill status={sub.status} />;
    }
  };
  const filtering = FILTER_KEYS.some((k) => sel(k).length) || !!q;

  return (
    <>
      <PageTitle
        eyebrow="ASSETS"
        title="Subscriptions"
        description="Software, AI tools, cloud services and anything else paid for on a cycle, with who uses each one and when it renews."
        action={
          manage ? (
            <Link to="/subscriptions/new" className={buttonClass()}>
              Add subscription
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice error={summary.error ?? list.error} retry={() => void list.refetch()} />
      {s ? (
        <div className="mb-6 flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Active subscriptions" value={n(s.live)} detail={s.trials ? `${s.trials} on trial` : 'In use now'} to="/subscriptions" />
            <StatTile label="Monthly spend" value={s.monthlySpend == null ? '—' : formatInr(s.monthlySpend)} detail="Active plans, per month" />
            <StatTile label="Yearly spend" value={s.yearlySpend == null ? '—' : formatInr(s.yearlySpend)} detail="At today's plans" />
            <StatTile label="Renew in 30 days" value={n(s.renewalsDue30)} detail={s.renewalsPassed ? `${s.renewalsPassed} renewal date passed` : 'Plan ahead'} to="/subscriptions?renewal=due30" />
            <StatTile label="Seats used" value={s.seatsTotal ? `${n(s.seatsUsed)} / ${n(s.seatsTotal)}` : n(s.seatsUsed)} detail={s.withFreeSeats ? `${s.withFreeSeats} with free seats` : 'On plans with a seat limit'} />
            <StatTile label="People with access" value={s.peopleCount == null ? '—' : n(s.peopleCount)} detail="At least one subscription" />
          </div>
          <p className="-mt-3 text-xs text-gray-500">
            Spend is in rupees, converting other currencies at today's exchange rate
            {s.rates.asOf ? ` (rates of ${displayDate(s.rates.asOf)})` : ''}.
            {s.rates.stale ? ' The rates service could not be reached, so the last saved rates are used.' : ''}
            {s.rates.unconverted ? ` ${s.rates.unconverted} plan${s.rates.unconverted === 1 ? '' : 's'} in a currency without a rate are left out.` : ''}
          </p>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Monthly spend by type">
              <DonutChart
                valueLabel="Per month"
                labelHeader="Type"
                centerLabel="Per month"
                format={formatInr}
                empty="No active paid subscriptions"
                items={s.byCategory.map((c) => ({ label: c.label, value: c.monthly, to: `/subscriptions?type=${encodeURIComponent(c.label)}` }))}
              />
            </Card>
            <Card title="Renewals, next 12 months">
              <ColumnChart
                valueLabel="Renewal cost"
                labelHeader="Month"
                empty="No renewals in the next 12 months"
                format={formatInr}
                shortFormat={(v) => (v >= 1e5 ? `₹${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `₹${Math.round(v / 1e3)}k` : `₹${Math.round(v)}`)}
                items={s.months.map((m) => {
                  const label = new Date(m.month).toLocaleDateString('en-IN', { month: 'short' });
                  return { label, value: m.cost, detail: `${label}: ${m.renewals} renewal${m.renewals === 1 ? '' : 's'} · ${formatInr(m.cost)}` };
                })}
              />
            </Card>
            <Card title="Renewing soon">
              {s.upcoming.length ? (
                <ul className="divide-y divide-gray-100">
                  {s.upcoming.map((u) => (
                    <li key={u.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <Link to={`/subscriptions/${u.id}`} className="min-w-0 flex-1 no-underline">
                        <span className="block truncate font-medium text-gray-900 hover:text-navy-700">{u.name}</span>
                        <span className="text-xs text-gray-500">
                          {u.vendor ?? '—'} · {money(u.cost, u.currency)}{u.currency !== 'INR' && u.costInr != null ? ` (≈ ${formatInr(u.costInr)})` : ''}
                          {u.autoRenew ? ' · auto' : ''}
                        </span>
                      </Link>
                      <span className={cx('text-xs whitespace-nowrap', u.days < 0 ? 'font-semibold text-red-700' : u.days <= 30 ? 'font-medium text-yellow-800' : 'text-gray-500')}>
                        {u.days < 0 ? `${-u.days}d late` : u.days === 0 ? 'Today' : `${u.days}d`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Nothing renews in the next 60 days</EmptyChart>
              )}
            </Card>
          </div>
        </div>
      ) : null}

      <Panel title="All subscriptions" action={<span className="text-sm text-gray-500">{n(items.length)} of {n(all.length)} shown</span>}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            className={cx(inputClass, 'min-w-56 flex-1')}
            placeholder="Search name, vendor, plan or the person using it"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search subscriptions"
          />
          <SortMenu
            value={sort}
            onChange={(value) => update('sort', value === 'renewal' ? '' : value)}
            options={[
              { value: 'renewal', label: 'Renewing soonest' },
              { value: 'name', label: 'Name (A–Z)' },
              { value: 'cost', label: 'Highest monthly cost' },
              { value: 'people', label: 'Most people' },
            ]}
          />
          <details className="relative">
            <summary className={cx(buttonClass('secondary'), 'cursor-pointer list-none whitespace-nowrap')}>
              Columns ({shown.length + 1})
            </summary>
            <div className="absolute right-0 z-20 mt-1 max-h-80 w-56 overflow-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
              <div className="mb-2 flex justify-between border-b border-gray-100 pb-2 text-xs">
                <button type="button" className="font-medium text-navy-700" onClick={() => setColumns(subscriptionColumns.map((c) => c.key))}>
                  Select all
                </button>
                <button type="button" className="font-medium text-navy-700" onClick={() => setColumns(defaultSubscriptionColumns)}>
                  Reset
                </button>
              </div>
              {subscriptionColumns.map((column) => (
                <div key={column.key} className="py-1.5">
                  <Checkbox
                    label={column.label}
                    checked={columns.includes(column.key)}
                    onChange={(checked) =>
                      setColumns((current) => (checked ? [...current, column.key] : current.filter((k) => k !== column.key)))
                    }
                  />
                </div>
              ))}
            </div>
          </details>
          {/* Phones hide the table headers, so their filters live behind this button. */}
          <div className="md:hidden">
            <FiltersButton groups={groups} onApply={applyFilters} />
          </div>
        </div>
        <FilterChips
          groups={groups}
          onRemove={(key, value) => setFilter(key, sel(key as FilterKey).filter((v) => v !== value))}
          onClearAll={() => {
            const p = new URLSearchParams(params);
            FILTER_KEYS.forEach((k) => p.delete(k));
            setParams(p, { replace: true });
          }}
        />
        {list.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Subscription</th>
                  {shown.map((c) => header(c.key, c.label))}
                </tr>
              </thead>
              <tbody>
                {items.map((sub) => (
                  <tr key={sub.id}>
                    <td>
                      <div className="flex min-w-48 items-center gap-3">
                        <SubscriptionLogo s={sub} />
                        <div className="min-w-0">
                          <Link to={`/subscriptions/${sub.id}`} className="block truncate font-medium text-navy-700 no-underline hover:underline">
                            {sub.name}
                          </Link>
                          <span className="block truncate text-xs text-gray-500">
                            {sub.vendor ?? '—'}
                            <span className="ml-1 font-mono text-gray-400">{sub.code}</span>
                          </span>
                        </div>
                      </div>
                    </td>
                    {shown.map((c) => (
                      <td key={c.key} className={c.key === 'cost' || c.key === 'monthly' ? 'text-right' : undefined}>
                        {cell(sub, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={filtering ? 'Nothing matches' : 'No subscriptions yet'}
            action={
              manage && !filtering ? (
                <Link to="/subscriptions/new" className={buttonClass()}>
                  Add the first subscription
                </Link>
              ) : undefined
            }
          >
            {filtering
              ? 'Try another filter or clear the search.'
              : 'Record software, AI tools and services here, then give them to the people who use them.'}
          </Empty>
        )}
      </Panel>
    </>
  );
}

/** Small Zoho photo (or initials) used in stacked lists. */
function AvatarSmall({ userId, name, hasPhoto }: Holder) {
  return <Avatar userId={userId} name={name} hasPhoto={hasPhoto} size={28} />;
}

/* --------------------------------------------------------------- form */

interface FormState {
  name: string;
  vendor: string;
  category: string;
  plan: string;
  billingCycle: Cycle;
  cost: string;
  currency: string;
  seatsTotal: string;
  startDate: string;
  renewalDate: string;
  autoRenew: boolean;
  status: Status;
  accountEmail: string;
  website: string;
  paymentMethod: string;
  departmentId: string;
  audience: Audience;
  notes: string;
}
const emptyForm: FormState = {
  name: '',
  vendor: '',
  category: '',
  plan: '',
  billingCycle: 'MONTHLY',
  cost: '',
  currency: 'INR',
  seatsTotal: '',
  startDate: '',
  renewalDate: '',
  autoRenew: true,
  status: 'ACTIVE',
  accountEmail: '',
  website: '',
  paymentMethod: '',
  departmentId: '',
  audience: 'PEOPLE',
  notes: '',
};
/** Currencies offered on the form (Indian rupee first). */
const CURRENCIES = [
  { code: 'INR', name: 'Indian rupee' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'CAD', name: 'Canadian dollar' },
] as const;
const CYCLE_MONTHS: Partial<Record<Cycle, number>> = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };

/** Add or edit a subscription (IT team only), laid out like the asset form. */
export function SubscriptionForm() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useSession();
  const refs = useReferences();
  const client = useQueryClient();
  const action = useAction<{ id: string; code?: string }>();
  const existing = useQuery({
    queryKey: ['subscription', id],
    queryFn: ({ signal }) => api<SubscriptionDetailData>(`/subscriptions/${id}`, { signal }),
    enabled: editing,
  });
  const [form, setForm] = useState<FormState>(emptyForm);
  // People to give it to straight away (adding only; later changes happen on the subscription page).
  const [picked, setPicked] = useState<AssignablePerson[]>([]);
  const [personSearch, setPersonSearch] = useState('');
  const [personQ, setPersonQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPersonQ(personSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [personSearch]);
  const peopleQuery = useQuery({
    queryKey: ['assignable-people', 'subscription-form', personQ],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(`/assignable-people?limit=25${personQ ? `&q=${encodeURIComponent(personQ)}` : ''}`, { signal }),
    enabled: !editing && form.audience === 'PEOPLE',
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    const s = existing.data;
    if (!s) return;
    setForm({
      name: s.name,
      vendor: s.vendor ?? '',
      category: s.category,
      plan: s.plan ?? '',
      billingCycle: s.billingCycle,
      cost: s.cost != null ? String(s.cost) : '',
      currency: s.currency,
      seatsTotal: s.seatsTotal != null ? String(s.seatsTotal) : '',
      startDate: s.startDate?.slice(0, 10) ?? '',
      renewalDate: s.renewalDate?.slice(0, 10) ?? '',
      autoRenew: s.autoRenew,
      status: s.status,
      accountEmail: s.accountEmail ?? '',
      website: s.website ?? '',
      paymentMethod: s.paymentMethod ?? '',
      departmentId: s.departmentId ?? '',
      audience: s.audience ?? 'PEOPLE',
      notes: s.notes ?? '',
    });
  }, [existing.data]);
  const types = (refs.data?.values ?? []).filter((v) => v.kind === 'SUBSCRIPTION_CATEGORY' && v.active);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const monthly = useMemo(() => {
    const months = CYCLE_MONTHS[form.billingCycle];
    const cost = Number(form.cost);
    return months && form.cost && !Number.isNaN(cost) ? cost / months : null;
  }, [form.billingCycle, form.cost]);

  if (!canManageSubscriptions(user))
    return <Empty title="Access required">Only the IT team can add or change subscriptions.</Empty>;
  if (editing && existing.isPending) return <Loading label="Loading subscription…" />;

  /** Fills the renewal date one cycle after the start date when it is empty. */
  function suggestRenewal(start: string) {
    const months = CYCLE_MONTHS[form.billingCycle];
    if (!start || !months || form.renewalDate) return;
    const d = new Date(start);
    d.setMonth(d.getMonth() + months);
    update('renewalDate', d.toISOString().slice(0, 10));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (action.isPending) return;
    const body = {
      name: form.name.trim(),
      vendor: form.vendor.trim() || null,
      category: form.category,
      plan: form.plan.trim() || null,
      billingCycle: form.billingCycle,
      cost: form.billingCycle === 'FREE' || !form.cost.trim() ? null : Number(form.cost),
      currency: form.currency.trim().toUpperCase() || 'INR',
      seatsTotal: form.seatsTotal.trim() ? Number(form.seatsTotal) : null,
      startDate: form.startDate || null,
      renewalDate: form.renewalDate || null,
      autoRenew: form.autoRenew,
      status: form.status,
      accountEmail: form.accountEmail.trim() || null,
      website: form.website.trim() || null,
      paymentMethod: form.paymentMethod.trim() || null,
      departmentId: form.audience === 'ORGANISATION' ? null : form.departmentId || null,
      audience: form.audience,
      notes: form.notes.trim() || null,
      ...(editing ? { version: existing.data!.version } : { userIds: form.audience === 'PEOPLE' ? picked.map((p) => p.id) : [] }),
    };
    try {
      const result = await action.mutateAsync({
        path: editing ? `/subscriptions/${id}` : '/subscriptions',
        method: editing ? 'PUT' : 'POST',
        body,
      });
      void client.invalidateQueries({ queryKey: ['subscriptions'] });
      void client.invalidateQueries({ queryKey: ['subscription', id] });
      navigate(`/subscriptions/${editing ? id : result.id}`);
    } catch {
      /* shown by ErrorNotice */
    }
  }

  const section = (title: string, children: ReactNode, hint?: string) => (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-navy-900">{title}</h2>
      {hint ? <p className="mt-0.5 mb-4 text-sm text-gray-500">{hint}</p> : <div className="mb-4" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
  const input = (key: keyof FormState, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <Field label={label} htmlFor={`sub-${key}`} hint={hint}>
      <input
        id={`sub-${key}`}
        className={inputClass}
        value={form[key] as string}
        onChange={(e) => update(key, e.target.value as never)}
        {...props}
      />
    </Field>
  );

  return (
    <>
      <Link to={editing ? `/subscriptions/${id}` : '/subscriptions'} className={backLinkClass}>
        ← {editing ? 'Back to subscription' : 'Subscriptions'}
      </Link>
      <PageTitle
        eyebrow="ASSETS / SUBSCRIPTIONS"
        title={editing ? `Edit ${existing.data?.name ?? 'subscription'}` : 'Add subscription'}
        description="Record what the organisation pays for, then give it to the people who use it on the next screen."
      />
      <form className="flex flex-col gap-6" onSubmit={(e) => void submit(e)}>
        <ErrorNotice error={action.error} />
        {section(
          'What it is',
          <>
            {input('name', 'Name', { required: true, maxLength: 150, placeholder: 'For example: ChatGPT Team' })}
            {input('vendor', 'Vendor', { maxLength: 150, placeholder: 'For example: OpenAI' })}
            {input('website', 'Website', { maxLength: 500, placeholder: 'For example: openai.com' }, 'Used to show the vendor’s logo in the list.')}
            <Select
              label="Type"
              htmlFor="sub-category"
              value={form.category}
              onChange={(v) => update('category', v)}
              options={[{ value: '', label: 'Choose a type' }, ...types.map((t) => ({ value: t.code, label: t.label }))]}
              required
            />
            {input('plan', 'Plan', { maxLength: 150, placeholder: 'For example: Team, Pro, Business' })}
            <Select
              label="Status"
              htmlFor="sub-status"
              value={form.status}
              onChange={(v) => update('status', v as Status)}
              options={(Object.keys(STATUS_LABEL) as Status[]).map((k) => ({ value: k, label: STATUS_LABEL[k] }))}
            />
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label="Notes (optional)" htmlFor="sub-notes">
                <textarea
                  id="sub-notes"
                  className={cx(inputClass, 'h-auto py-2')}
                  rows={2}
                  maxLength={5000}
                  value={form.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  placeholder="Anything useful: who approved it, what it is used for, how to cancel"
                />
              </Field>
            </div>
          </>,
        )}
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-navy-900">Who uses it</h2>
          <p className="mt-0.5 mb-4 text-sm text-gray-500">
            Some plans are for named people (one seat each), some are for a whole department, and some are for everyone.
          </p>
          <div role="radiogroup" aria-label="Who uses it" className="mb-4 inline-flex flex-wrap rounded-lg border border-gray-200 bg-white p-1">
            {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={form.audience === a}
                onClick={() => update('audience', a)}
                className={cx(
                  'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                  form.audience === a ? 'bg-navy-700 text-white' : 'text-gray-600 hover:text-navy-700',
                )}
              >
                {AUDIENCE_LABEL[a]}
              </button>
            ))}
          </div>
          {form.audience === 'DEPARTMENT' ? (
            <div className="max-w-md">
              <Select
                label="Department"
                htmlFor="sub-department"
                value={form.departmentId}
                onChange={(v) => update('departmentId', v)}
                options={[
                  { value: '', label: 'Choose a department' },
                  ...(refs.data?.departments ?? []).filter((d) => d.active).map((d) => ({ value: d.id, label: d.name })),
                ]}
                hint="Everyone in this department counts as using it. You can still give named seats later."
                required
              />
            </div>
          ) : form.audience === 'ORGANISATION' ? (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">Available to everyone in the organisation, for example antivirus or the company email plan.</p>
          ) : editing ? (
            <p className="text-sm text-gray-600">
              Give or remove people on the{' '}
              <Link to={`/subscriptions/${id}`} className="font-medium text-navy-700">
                subscription page
              </Link>
              .
            </p>
          ) : (
            <div className="max-w-2xl">
              <PersonPicker
                label="Add people"
                people={(peopleQuery.data?.items ?? []).filter((p) => !picked.some((x) => x.id === p.id))}
                loading={peopleQuery.isFetching}
                search={personSearch}
                onSearch={setPersonSearch}
                selected={undefined}
                onSelect={(p) => {
                  if (p && !picked.some((x) => x.id === p.id)) setPicked([...picked, p]);
                  setPersonSearch('');
                }}
              />
              {picked.length ? (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {picked.map((p) => (
                    <li key={p.id} className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white py-1 pr-1.5 pl-1">
                      <Avatar userId={p.id} name={p.displayName} hasPhoto={p.hasPhoto} size={24} />
                      <span className="text-sm text-gray-800">{p.displayName}</span>
                      <button
                        type="button"
                        className="rounded-full px-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-700"
                        aria-label={`Remove ${p.displayName}`}
                        onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={cx('mt-2 text-xs', form.seatsTotal && picked.length > Number(form.seatsTotal) ? 'font-medium text-red-700' : 'text-gray-500')}>
                {picked.length
                  ? ` ${picked.length === 1 ? 'person' : 'people'} chosen${form.seatsTotal ? ` of ${form.seatsTotal} seats` : ''}.`
                  : 'Search and pick one or more people. You can also do this later.'}
              </p>
            </div>
          )}
        </section>
        {section(
          'Cost and renewal',
          <>
            <Select
              label="Billing"
              htmlFor="sub-cycle"
              value={form.billingCycle}
              onChange={(v) => update('billingCycle', v as Cycle)}
              options={(Object.keys(CYCLE_LABEL) as Cycle[]).map((k) => ({ value: k, label: CYCLE_LABEL[k] }))}
            />
            {form.billingCycle === 'FREE'
              ? null
              : input(
                  'cost',
                  'Cost per billing period',
                  { type: 'number', min: 0, step: '0.01', inputMode: 'decimal', placeholder: '0.00' },
                  monthly != null ? `About ${formatInr(monthly)} a month for the whole plan` : 'The price for the whole plan, not per person',
                )}
            <Select
              label="Currency"
              htmlFor="sub-currency"
              value={form.currency}
              onChange={(v) => update('currency', v)}
              options={CURRENCIES.map((cur) => ({ value: cur.code, label: `${cur.code} · ${cur.name}` }))}
            />
            {input('seatsTotal', 'Seats', { type: 'number', min: 1, step: 1, inputMode: 'numeric', placeholder: 'No limit' }, 'How many people the plan allows. Leave empty if not limited.')}
            <Field label="Start date" htmlFor="sub-startDate">
              <input
                id="sub-startDate"
                type="date"
                className={inputClass}
                value={form.startDate}
                onChange={(e) => {
                  update('startDate', e.target.value);
                  suggestRenewal(e.target.value);
                }}
              />
            </Field>
            {input('renewalDate', 'Next renewal', { type: 'date' }, 'Filled one billing period after the start date if left empty')}
            <div className="flex items-end pb-2 sm:col-span-2 lg:col-span-3">
              <Checkbox label="Renews automatically (the card is charged without asking)" checked={form.autoRenew} onChange={(v) => update('autoRenew', v)} />
            </div>
          </>,
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Link to={editing ? `/subscriptions/${id}` : '/subscriptions'} className={buttonClass('secondary')}>
            Cancel
          </Link>
          <button type="submit" className={buttonClass()} disabled={action.isPending || !form.name.trim() || !form.category || (form.audience === 'DEPARTMENT' && !form.departmentId)}>
            {action.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add subscription'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------- detail */

export function SubscriptionDetail() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['subscription', id],
    queryFn: ({ signal }) => api<SubscriptionDetailData>(`/subscriptions/${id}`, { signal }),
  });
  const client = useQueryClient();
  const action = useAction();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<AssignablePerson>();
  const [note, setNote] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const people = useQuery({
    queryKey: ['assignable-people', 'subscription', q],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(`/assignable-people?limit=25${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal }),
    enabled: !!query.data?.canManage,
    placeholderData: (previous) => previous,
  });
  const s = query.data;
  const refresh = () => {
    void query.refetch();
    void client.invalidateQueries({ queryKey: ['subscriptions'] });
  };

  if (query.isPending) return <Loading label="Loading subscription…" />;
  if (query.error || !s) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const holderIds = new Set(s.people.map((p) => p.userId));
  const full = s.seatsTotal != null && s.seatsUsed >= s.seatsTotal;
  const live = s.status === 'ACTIVE' || s.status === 'TRIAL';

  async function give() {
    if (!picked) return;
    try {
      await action.mutateAsync({ path: `/subscriptions/${id}/people`, method: 'POST', body: { userId: picked.id, note: note.trim() || null } });
      setPicked(undefined);
      setSearch('');
      setNote('');
      refresh();
    } catch {
      /* shown below */
    }
  }
  async function takeBack(person: SubscriptionPerson) {
    const why = window.prompt(`Remove ${person.name} from ${s!.name}? Optional note (for example: left the team):`, '');
    if (why === null) return;
    try {
      await action.mutateAsync({
        path: `/subscriptions/${id}/people/${person.assignmentId}/end`,
        method: 'POST',
        body: { note: why.trim() || null },
      });
      refresh();
    } catch {
      /* shown below */
    }
  }

  const fact = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value ?? '—'}</dd>
    </div>
  );

  return (
    <>
      <Link to="/subscriptions" className={backLinkClass}>
        ← Subscriptions
      </Link>
      <PageTitle
        eyebrow={`SUBSCRIPTION · ${s.code}`}
        title={s.name}
        description={[s.vendor, s.plan, s.category].filter(Boolean).join(' · ')}
        action={
          s.canManage ? (
            <Link to={`/subscriptions/${id}/edit`} className={buttonClass('secondary')}>
              Edit details
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice error={action.error} />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Status" value={STATUS_LABEL[s.status]} detail={s.autoRenew ? 'Renews automatically' : 'Renew by hand'} />
        <StatTile
          label="Cost"
          value={money(s.cost, s.currency)}
          detail={[
            s.currency !== 'INR' && s.costInr != null ? `≈ ${formatInr(s.costInr)} today` : null,
            s.billingCycle !== 'MONTHLY' && s.monthlyCostInr != null ? `about ${formatInr(s.monthlyCostInr)}/month` : CYCLE_LABEL[s.billingCycle],
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <StatTile label="Seats" value={s.seatsTotal ? `${s.seatsUsed} / ${s.seatsTotal}` : String(s.seatsUsed)} detail={s.seatsTotal ? (full ? 'All seats in use' : `${s.seatsTotal - s.seatsUsed} free`) : 'No seat limit'} />
        <StatTile
          label="Next renewal"
          value={s.renewalDate ? displayDate(s.renewalDate) : '—'}
          detail={s.daysToRenewal == null ? 'No date set' : s.daysToRenewal < 0 ? `Passed ${-s.daysToRenewal} days ago` : `In ${s.daysToRenewal} days`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Panel title={`People with access · ${s.people.length}`} className="lg:col-span-3">
          {s.audience !== 'PEOPLE' ? (
            <p className="mb-4 rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900">
              {s.audience === 'ORGANISATION'
                ? 'This subscription is for everyone in the organisation.'
                : `This subscription is for the ${s.department ?? ''} department: everyone there uses it.`}{' '}
              Named people below have their own seat.
            </p>
          ) : null}
          {s.canManage && live ? (
            <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <PersonPicker
                  label="Give to"
                  people={(people.data?.items ?? []).filter((p) => !holderIds.has(p.id))}
                  loading={people.isFetching}
                  search={search}
                  onSearch={setSearch}
                  selected={picked}
                  onSelect={setPicked}
                  disabled={full || action.isPending}
                />
                <button type="button" className={buttonClass()} disabled={!picked || full || action.isPending} onClick={() => void give()}>
                  {action.isPending ? 'Saving…' : 'Give access'}
                </button>
              </div>
              <input
                className={cx(inputClass, 'mt-3')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                placeholder="Note (optional), for example: needs it for report writing"
                aria-label="Note"
              />
              {full ? <p className="mt-2 text-xs font-medium text-red-700">All seats are in use. Remove someone or add seats in Edit details.</p> : null}
            </div>
          ) : null}
          {s.people.length ? (
            <ul className="divide-y divide-gray-100">
              {s.people.map((p) => (
                <li key={p.assignmentId} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <PersonChip
                      userId={p.userId}
                      name={p.name}
                      hasPhoto={p.hasPhoto}
                      detail={[p.designation, p.department].filter(Boolean).join(' · ') || undefined}
                      designation={p.designation}
                      department={p.department}
                      email={p.email}
                      holdingsHref={`/assets?holderId=${p.userId}`}
                    />
                    <span className="mt-0.5 block pl-1 text-xs text-gray-500">
                      Since {displayDate(p.assignedAt)}
                      {p.assignedBy ? ` · given by ${p.assignedBy}` : ''}
                      {p.note ? ` · ${p.note}` : ''}
                      {p.left ? <span className="ml-1 font-medium text-red-700">· has left, remove access</span> : null}
                    </span>
                  </div>
                  {s.canManage ? (
                    <button type="button" className={buttonClass('secondary', 'sm')} disabled={action.isPending} onClick={() => void takeBack(p)}>
                      Remove access
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyChart>Nobody has this subscription yet</EmptyChart>
          )}
        </Panel>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Panel title="Details">
            <div className="mb-4 flex items-center gap-3">
              <SubscriptionLogo s={s} size={48} />
              <div className="min-w-0">
                <span className="block truncate font-semibold text-navy-900">{s.name}</span>
                <span className="block truncate text-xs text-gray-500">{s.vendor ?? '—'}</span>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
              {fact('Type', s.category)}
              {fact('Plan', s.plan)}
              {fact('Vendor', s.vendor)}
              {fact('For', s.audience === 'DEPARTMENT' ? `${s.department ?? ''} department` : AUDIENCE_LABEL[s.audience])}
              {fact('Started', s.startDate ? displayDate(s.startDate) : null)}
              {fact('Billing', CYCLE_LABEL[s.billingCycle])}
              {s.accountEmail ? fact('Account email', s.accountEmail) : null}
              {s.website ? (
                <div className="col-span-2">
                  {fact(
                    'Website',
                    <a href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`} target="_blank" rel="noreferrer noopener" className="break-all text-navy-700">
                      {s.website}
                    </a>,
                  )}
                </div>
              ) : null}
              {s.notes ? <div className="col-span-2">{fact('Notes', <span className="whitespace-pre-wrap">{s.notes}</span>)}</div> : null}
            </dl>
          </Panel>
          <Panel title="Past access">
            {s.history.length ? (
              <ul className="divide-y divide-gray-100">
                {s.history.map((p) => (
                  <li key={p.assignmentId} className="py-2.5 text-sm">
                    <span className="font-medium text-gray-900">{p.name}</span>
                    <span className="block text-xs text-gray-500">
                      {displayDate(p.assignedAt)} – {p.endedAt ? displayDate(p.endedAt) : ''}
                      {p.endedBy ? ` · removed by ${p.endedBy}` : ''}
                      {p.endNote ? ` · ${p.endNote}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">No one has had access removed yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------ my subscriptions */

/** The signed-in person's subscriptions, for My assets. Hidden when they have none. */
export function MySubscriptions() {
  const query = useQuery({
    queryKey: ['subscriptions', 'mine'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; name: string; vendor: string | null; plan: string | null; category: string; status: Status; renewalDate: string | null; website: string | null; assignedAt: string | null; via: 'PERSON' | 'DEPARTMENT' | 'ORGANISATION' }[] }>(
        '/subscriptions/mine',
        { signal },
      ),
  });
  const items = query.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Panel title={`Your subscriptions · ${items.length}`} className="mt-6">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((s) => (
          <li key={s.id} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-gray-900">{s.name}</span>
              <StatusPill status={s.status} />
            </div>
            <span className="block text-xs text-gray-500">{[s.vendor, s.plan, s.category].filter(Boolean).join(' · ')}</span>
            <span className="mt-1 block text-xs text-gray-500">
              {s.via === 'PERSON' && s.assignedAt
                ? `Yours since ${displayDate(s.assignedAt)}`
                : s.via === 'DEPARTMENT'
                  ? 'Through your department'
                  : 'For everyone'}
            </span>
            {s.website ? (
              <a href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-xs font-medium text-navy-700">
                Open
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-gray-500">Need access to another tool, or no longer use one? Raise a support request so IT can update it.</p>
    </Panel>
  );
}

/**
 * Dashboard card for everyone who may view subscriptions (IT, Super Admin, Finance, leadership,
 * auditors): spend, renewals coming up and seat use, each opening the Subscriptions page.
 */
export function SubscriptionsCard() {
  const { user } = useSession();
  const allowed = canViewSubscriptions(user);
  const summary = useQuery({
    queryKey: ['subscriptions', 'summary'],
    queryFn: ({ signal }) => api<SubscriptionSummary>('/subscriptions/summary', { signal }),
    enabled: allowed,
  });
  if (!allowed) return null;
  const s = summary.data;
  const open = (to: string, label = 'Open') => (
    <Link to={to} className="text-xs font-medium text-navy-700 no-underline hover:underline">
      {label}
    </Link>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Subscriptions" action={open('/subscriptions')}>
        {!s ? (
          <Loading />
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
            <div>
              <dt className="text-xs text-gray-500">Active</dt>
              <dd className="mt-0.5 text-lg font-semibold text-navy-900 tabular-nums">{s.live.toLocaleString('en-IN')}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Per month</dt>
              <dd className="mt-0.5 text-lg font-semibold text-navy-900 tabular-nums">{s.monthlySpend == null ? '—' : formatInr(s.monthlySpend)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Renew in 30 days</dt>
              <dd className={cx('mt-0.5 text-lg font-semibold tabular-nums', s.renewalsDue30 ? 'text-yellow-800' : 'text-navy-900')}>
                <Link to="/subscriptions?renewal=due30" className="text-inherit no-underline hover:underline">
                  {s.renewalsDue30}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Renewal passed</dt>
              <dd className={cx('mt-0.5 text-lg font-semibold tabular-nums', s.renewalsPassed ? 'text-red-700' : 'text-navy-900')}>
                <Link to="/subscriptions?renewal=passed" className="text-inherit no-underline hover:underline">
                  {s.renewalsPassed}
                </Link>
              </dd>
            </div>
            <div className="col-span-2 text-xs text-gray-500">
              {s.yearlySpend == null ? '' : `${formatInr(s.yearlySpend)} a year · `}{s.peopleCount == null ? '' : `${s.peopleCount} people with access`}
              {s.seatsTotal ? ` · ${s.seatsUsed} of ${s.seatsTotal} seats used` : ''}
            </div>
          </dl>
        )}
      </Card>
      <Card title="Subscription spend by type" action={open('/subscriptions')}>
        {s ? (
          <DonutChart
            valueLabel="Per month"
            labelHeader="Type"
            centerLabel="Per month"
            format={formatInr}
            empty="No active paid subscriptions"
            items={s.byCategory.map((c) => ({ label: c.label, value: c.monthly, to: `/subscriptions?type=${encodeURIComponent(c.label)}` }))}
          />
        ) : (
          <Loading />
        )}
      </Card>
      <Card title="Subscriptions renewing soon" action={open('/subscriptions?renewal=due30')}>
        {s?.upcoming.length ? (
          <ul className="divide-y divide-gray-100">
            {s.upcoming.map((u) => (
              <li key={u.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Link to={`/subscriptions/${u.id}`} className="min-w-0 flex-1 truncate font-medium text-gray-900 no-underline hover:text-navy-700">
                  {u.name}
                </Link>
                <span className="text-xs whitespace-nowrap text-gray-500">{u.currency !== 'INR' && u.costInr != null ? formatInr(u.costInr) : money(u.cost, u.currency)}</span>
                <span className={cx('w-14 text-right text-xs whitespace-nowrap', u.days < 0 ? 'font-semibold text-red-700' : u.days <= 30 ? 'font-medium text-yellow-800' : 'text-gray-500')}>
                  {u.days < 0 ? `${-u.days}d late` : u.days === 0 ? 'Today' : `${u.days}d`}
                </span>
              </li>
            ))}
          </ul>
        ) : s ? (
          <EmptyChart>Nothing renews in the next 60 days</EmptyChart>
        ) : (
          <Loading />
        )}
      </Card>
    </div>
  );
}
