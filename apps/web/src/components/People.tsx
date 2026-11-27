import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { can, useSession } from '../session';
import type { User } from '../types';
import { StatTile } from './charts';
import { useReferences } from './References';
import {
  BLANK_FILTER,
  ColumnFilter,
  FilterChips,
  FiltersButton,
  TextColumnFilter,
  fromList,
  toList,
  type FilterGroup,
} from './ColumnFilter';

/** People-list filters kept in the address, like the asset catalog's. */
const FILTER_KEYS = ['departmentId', 'status', 'designation', 'assets', 'subscriptions'];
import { SubscriptionLogo, canViewSubscriptions } from './Subscriptions';
import {
  Avatar,
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  Panel,
  backLinkClass,
  buttonClass,
  cx,
  displayDate,
  inputClass,
  tableClass,
  tableWrapClass,
} from './ui';

/** Who may browse other people's holdings (each person can always open their own page). */
export function canBrowsePeople(user: User | undefined) {
  return can(user, 'asset.view_all') || can(user, 'report.view') || canViewSubscriptions(user);
}

interface PersonRow {
  id: string;
  name: string;
  email: string;
  designation: string | null;
  employeeCode: string | null;
  department: string | null;
  left: boolean;
  hasPhoto: boolean;
  assets: number;
  subscriptions: number;
}
interface Profile {
  person: {
    id: string;
    name: string;
    email: string;
    designation: string | null;
    employeeCode: string | null;
    department: string | null;
    manager: string | null;
    state: string;
    leftAt: string | null;
    hasPhoto: boolean;
  };
  totals: {
    assets: number;
    assetValue: number | null;
    pendingConfirmation: number;
    subscriptions: number | null;
    namedSubscriptions: number | null;
    monthlySubscriptionShare: number | null;
    pastAssets: number;
  };
  assets: {
    id: string;
    assetCode: string;
    description: string;
    category: string;
    assetType: string;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    status: string;
    warrantyExpiry: string | null;
    purchaseCost: number | null;
    assignedAt: string;
    acknowledgement: 'PENDING' | 'ACCEPTED' | 'DISPUTED';
  }[];
  pastAssets: { id: string; assetCode: string; description: string; assetType: string; assignedAt: string; endedAt: string }[];
  subscriptions:
    | {
        id: string;
        name: string;
        vendor: string | null;
        plan: string | null;
        category: string;
        status: string;
        renewalDate: string | null;
        via: 'PERSON' | 'DEPARTMENT' | 'ORGANISATION';
        assignedAt: string | null;
        logoVersion: number | null;
        monthlyShareInr: number | null;
      }[]
    | null;
  tickets: { id: string; ticketNumber: number; subject: string; status: string; priority: string; createdAt: string }[] | null;
  scopeNote: string | null;
}

/* --------------------------------------------------------------- list */

/** Everyone, with how much each holds; opens each person's page. */
export function PeopleDirectory() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const holding = params.get('holding') ?? 'any';
  const designation = params.get('designation') ?? '';
  const refs = useReferences();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.trim() === q) return;
      const next = new URLSearchParams(params);
      if (search.trim()) next.set('q', search.trim());
      else next.delete('q');
      setParams(next, { replace: true });
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ['people', q, holding, ...FILTER_KEYS.map((k) => params.get(k) ?? ''), offset],
    queryFn: ({ signal }) => {
      const search = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (holding !== 'all') search.set('holding', holding);
      if (q) search.set('q', q);
      for (const key of FILTER_KEYS) {
        const value = params.get(key);
        if (value) search.set(key, value);
      }
      return api<{
        items: PersonRow[];
        nextOffset: number | null;
        showsSubscriptions: boolean;
        counts?: { all: number; any: number; assets: number | null; subscriptions: number | null; assetsHeld: number | null };
      }>(`/people?${search}`, { signal });
    },
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.items ?? [];
  const subs = query.data?.showsSubscriptions;
  const counts = query.data?.counts;
  /** Sets one filter in the address ('' clears it) and goes back to the first page. */
  const setFilter = (key: string, value: string, clearValue = '') => {
    const next = new URLSearchParams(params);
    if (value === clearValue) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setOffset(0);
  };
  const setHolding = (value: string) => setFilter('holding', value, 'any');
  const setList = (key: string, values: string[]) => setFilter(key, fromList(values));
  // The catalog's filter groups: each column's funnel, the phone Filters button and the chips.
  const filterGroups: FilterGroup[] = [
    {
      key: 'status',
      title: 'Staff',
      options: [
        { value: 'current', label: 'Current staff' },
        { value: 'left', label: 'Has left' },
      ],
      selected: toList(params.get('status')),
    },
    {
      key: 'departmentId',
      title: 'Department',
      options: [
        { value: 'none', label: 'No department' },
        ...(refs.data?.departments ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({ value: d.id, label: `${d.name}${d.active ? '' : ' (inactive)'}` })),
      ],
      selected: toList(params.get('departmentId')),
    },
    {
      key: 'assets',
      title: 'Assets',
      options: [
        { value: '0', label: 'None' },
        { value: '1', label: '1' },
        { value: '2-4', label: '2 to 4' },
        { value: '5+', label: '5 or more' },
      ],
      selected: toList(params.get('assets')),
    },
    ...(subs
      ? [
          {
            key: 'subscriptions',
            title: 'Subscriptions',
            options: [
              { value: '0', label: 'None' },
              { value: '1+', label: '1 or more' },
            ],
            selected: toList(params.get('subscriptions')),
          },
        ]
      : []),
  ];
  const groupOf = (key: string) => filterGroups.find((g) => g.key === key) ?? { options: [], selected: [] };
  const tabCount = (value: string) =>
    counts ? (value === 'all' ? counts.all : value === 'any' ? counts.any : value === 'assets' ? counts.assets : counts.subscriptions) : null;
  const shown = tabCount(holding);

  return (
    <>
      <PageTitle
        eyebrow="ASSETS"
        title="People"
        description="Everyone and what they hold. Open a person to see their equipment, subscriptions, what they had before, and their support requests."
      />
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            className={cx(inputClass, 'min-w-56 flex-1')}
            placeholder="Search name, email, employee code or designation"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search people"
          />
          {/* Phones hide the table headers, so their filters live behind this button (as in the catalog). */}
          <div className="flex-none md:hidden">
            <FiltersButton
              groups={filterGroups}
              onApply={(next) => {
                const search = new URLSearchParams(params);
                for (const [key, values] of Object.entries(next)) {
                  if (values.length) search.set(key, fromList(values));
                  else search.delete(key);
                }
                setParams(search, { replace: true });
                setOffset(0);
              }}
            />
          </div>
          <div role="tablist" aria-label="Show" className="inline-flex max-w-full flex-wrap rounded-lg border border-gray-200 bg-white p-1">
            {[
              ['any', 'Holding something'],
              ['assets', 'With assets'],
              ...(subs ? [['subscriptions', 'With subscriptions']] : []),
              ['all', 'Everyone'],
            ].map(([value, label]) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={holding === value}
                onClick={() => setHolding(value)}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  holding === value ? 'bg-navy-700 text-white' : 'text-gray-600 hover:text-navy-700',
                )}
              >
                {label}
                {tabCount(value) != null ? (
                  <span
                    className={cx(
                      'ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums',
                      holding === value ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600',
                    )}
                  >
                    {tabCount(value)!.toLocaleString('en-IN')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <FilterChips
          groups={[
            ...filterGroups,
            ...(designation
              ? [{ key: 'designation', title: 'Designation', options: [{ value: designation, label: designation === BLANK_FILTER ? 'Blank' : designation }], selected: [designation] }]
              : []),
          ]}
          onRemove={(key, value) => setList(key, toList(params.get(key)).filter((v) => v !== value))}
          onClearAll={() => {
            setSearch('');
            const next = new URLSearchParams(params);
            for (const key of ['q', ...FILTER_KEYS]) next.delete(key);
            setParams(next, { replace: true });
            setOffset(0);
          }}
        />
        {shown != null ? (
          <p className="mb-3 text-sm text-gray-500" aria-live="polite">
            Total matching people: <span className="font-medium text-gray-900">{shown.toLocaleString('en-IN')}</span>
            {counts?.assetsHeld != null ? (
              <>
                {' · '}Assets they hold: <span className="font-medium text-gray-900">{counts.assetsHeld.toLocaleString('en-IN')}</span>
              </>
            ) : null}
            {' · '}Showing {rows.length.toLocaleString('en-IN')}
          </p>
        ) : null}
        {query.isPending ? (
          <Loading />
        ) : rows.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>
                    Person
                    <ColumnFilter title="Staff" options={groupOf('status').options} selected={groupOf('status').selected} onApply={(v) => setList('status', v)} />
                  </th>
                  <th>
                    Designation
                    <TextColumnFilter title="Designation" value={designation} onApply={(v) => setFilter('designation', v)} placeholder="Part of a designation…" />
                  </th>
                  <th>
                    Department
                    <ColumnFilter title="Department" options={groupOf('departmentId').options} selected={groupOf('departmentId').selected} onApply={(v) => setList('departmentId', v)} />
                  </th>
                  <th className="text-right">
                    Assets
                    <ColumnFilter title="Assets" options={groupOf('assets').options} selected={groupOf('assets').selected} onApply={(v) => setList('assets', v)} />
                  </th>
                  {subs ? (
                    <th className="text-right">
                      Subscriptions
                      <ColumnFilter title="Subscriptions" options={groupOf('subscriptions').options} selected={groupOf('subscriptions').selected} onApply={(v) => setList('subscriptions', v)} />
                    </th>
                  ) : null}
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/people/${p.id}`} className="flex items-center gap-3 no-underline">
                        <Avatar userId={p.id} name={p.name} hasPhoto={p.hasPhoto} size={32} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-gray-900 hover:text-navy-700">{p.name}</span>
                          <span className="block truncate text-xs text-gray-500">
                            {p.email}
                            {p.left ? <span className="ml-1 font-medium text-red-700">· has left</span> : null}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="text-sm">{p.designation ?? '—'}</td>
                    <td className="text-sm">{p.department ?? '—'}</td>
                    <td className="text-right tabular-nums">{p.assets || <span className="text-gray-400">0</span>}</td>
                    {subs ? <td className="text-right tabular-nums">{p.subscriptions || <span className="text-gray-400">0</span>}</td> : null}
                    <td className="text-right">
                      <Link to={`/people/${p.id}`} className={buttonClass('secondary', 'sm')}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nobody matches">Try another search or show everyone.</Empty>
        )}
        {offset > 0 || query.data?.nextOffset != null ? (
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" className={buttonClass('secondary', 'sm')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Previous
            </button>
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              disabled={query.data?.nextOffset == null}
              onClick={() => setOffset(query.data?.nextOffset ?? offset)}
            >
              Next
            </button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}

/* --------------------------------------------------------------- page */

const VIA_LABEL = { PERSON: 'Given to them', DEPARTMENT: 'Through their department', ORGANISATION: 'For everyone' } as const;
const ACK = {
  PENDING: { value: 'PENDING', label: 'Not confirmed' },
  ACCEPTED: { value: 'ACCEPTED', label: 'Confirmed' },
  DISPUTED: { value: 'DISPUTED', label: 'Reported a problem' },
} as const;

/** Everything one person holds: equipment, subscriptions, past equipment and support requests. */
export function PersonPage() {
  const { id } = useParams();
  const { user } = useSession();
  const self = user?.id === id;
  const query = useQuery({
    queryKey: ['person', id],
    queryFn: ({ signal }) => api<Profile>(`/people/${id}`, { signal }),
  });
  const d = query.data;
  if (query.isPending) return <Loading label="Loading person…" />;
  if (query.error || !d) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const p = d.person;
  const t = d.totals;
  const section = (title: string, count: number | null, children: ReactNode, action?: ReactNode) => (
    <Panel title={count == null ? title : `${title} · ${count}`} action={action}>
      {children}
    </Panel>
  );

  return (
    <>
      {canBrowsePeople(user) ? (
        <Link to="/people" className={backLinkClass}>
          ← People
        </Link>
      ) : null}
      <section className="mb-6 flex flex-wrap items-center gap-5 rounded-xl border border-gray-200 bg-white p-5">
        <Avatar userId={p.id} name={p.name} hasPhoto={p.hasPhoto} size={72} />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[11px] font-semibold tracking-[0.16em] text-red-600 uppercase">{self ? 'Your profile' : 'Person'}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-900">{p.name}</h1>
          <p className="mt-0.5 text-sm text-gray-600">{[p.designation, p.department].filter(Boolean).join(' · ') || '—'}</p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <a href={`mailto:${p.email}`} className="text-navy-700">
              {p.email}
            </a>
            {p.employeeCode ? <span>Employee code {p.employeeCode}</span> : null}
            {p.manager ? <span>Reports to {p.manager}</span> : null}
          </p>
        </div>
        {p.leftAt ? (
          <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-medium text-red-700 ring-1 ring-red-100">Left on {displayDate(p.leftAt)}</span>
        ) : p.state !== 'ACTIVE' ? (
          <Badge value={p.state} />
        ) : null}
      </section>
      {d.scopeNote ? <p className="mb-4 text-sm text-gray-500">{d.scopeNote}</p> : null}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Assets held" value={String(t.assets)} detail={t.pendingConfirmation ? `${t.pendingConfirmation} not confirmed` : 'All confirmed'} />
        {t.assetValue != null ? <StatTile label="Value of assets" value={formatInr(t.assetValue)} detail="Purchase cost" /> : null}
        {t.subscriptions != null ? (
          <StatTile label="Subscriptions" value={String(t.subscriptions)} detail={`${t.namedSubscriptions ?? 0} given by name`} />
        ) : null}
        {t.monthlySubscriptionShare != null ? (
          <StatTile label="Subscription cost" value={formatInr(t.monthlySubscriptionShare)} detail="Their seats, per month" />
        ) : null}
        <StatTile label="Held before" value={String(t.pastAssets)} detail="Returned or moved on" />
        {d.tickets ? <StatTile label="Support requests" value={String(d.tickets.length)} detail="Most recent 10" /> : null}
      </div>

      <div className="flex flex-col gap-6">
        {section(
          'Equipment',
          d.assets.length,
          d.assets.length ? (
            <div className={tableWrapClass}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Type</th>
                    <th>Serial</th>
                    <th>Since</th>
                    <th>Confirmation</th>
                    <th>Status</th>
                    <th>Warranty</th>
                    {t.assetValue != null ? <th className="text-right">Cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {d.assets.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={`/assets/${a.id}`} className="block font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                          {a.assetCode}
                        </Link>
                        <span className="block max-w-64 truncate text-sm text-gray-800">
                          {[a.manufacturer, a.model].filter(Boolean).join(' ') || a.description}
                        </span>
                      </td>
                      <td className="text-sm">{a.assetType || a.category}</td>
                      <td className="font-mono text-xs">{a.serialNumber ?? '—'}</td>
                      <td className="whitespace-nowrap text-sm">{displayDate(a.assignedAt)}</td>
                      <td>
                        <Badge value={ACK[a.acknowledgement].value} label={ACK[a.acknowledgement].label} />
                      </td>
                      <td>
                        <Badge value={a.status} />
                      </td>
                      <td className="whitespace-nowrap text-sm">{a.warrantyExpiry ? displayDate(a.warrantyExpiry) : '—'}</td>
                      {t.assetValue != null ? (
                        <td className="text-right tabular-nums">{a.purchaseCost != null ? formatInr(a.purchaseCost) : '—'}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No equipment is with {self ? 'you' : 'them'} right now.</p>
          ),
          canBrowsePeople(user) && d.assets.length ? (
            <Link to={`/assets?holderId=${p.id}`} className="text-xs font-medium text-navy-700 no-underline hover:underline">
              Open in the catalog
            </Link>
          ) : undefined,
        )}

        {d.subscriptions
          ? section(
              'Subscriptions',
              d.subscriptions.length,
              d.subscriptions.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {d.subscriptions.map((s) => (
                    <li key={s.id}>
                      <Link
                        to={canViewSubscriptions(user) ? `/subscriptions/${s.id}` : '#'}
                        className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 no-underline hover:border-navy-200"
                      >
                        <SubscriptionLogo s={s} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-gray-900">{s.name}</span>
                          <span className="block truncate text-xs text-gray-500">{[s.vendor, s.plan, s.category].filter(Boolean).join(' · ')}</span>
                          <span className="mt-1 block text-xs text-gray-500">
                            {VIA_LABEL[s.via]}
                            {s.via === 'PERSON' && s.assignedAt ? ` since ${displayDate(s.assignedAt)}` : ''}
                            {s.monthlyShareInr ? ` · ${formatInr(s.monthlyShareInr)}/month` : ''}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No subscriptions.</p>
              ),
            )
          : null}

        <div className="grid gap-6 lg:grid-cols-2">
          {section(
            'Held before',
            d.pastAssets.length,
            d.pastAssets.length ? (
              <ul className="divide-y divide-gray-100">
                {d.pastAssets.map((a) => (
                  <li key={`${a.id}-${a.endedAt}`} className="flex items-center gap-3 py-2.5 text-sm">
                    <Link to={`/assets/${a.id}`} className="font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                      {a.assetCode}
                    </Link>
                    <span className="min-w-0 flex-1 truncate text-gray-700">{a.description}</span>
                    <span className="text-xs whitespace-nowrap text-gray-500">
                      {displayDate(a.assignedAt)} – {displayDate(a.endedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Nothing returned yet.</p>
            ),
          )}
          {d.tickets
            ? section(
                'Support requests',
                d.tickets.length,
                d.tickets.length ? (
                  <ul className="divide-y divide-gray-100">
                    {d.tickets.map((tk) => (
                      <li key={tk.id} className="flex items-center gap-3 py-2.5 text-sm">
                        <Link to={`/tickets/${tk.id}`} className="min-w-0 flex-1 no-underline">
                          <span className="block truncate font-medium text-gray-900 hover:text-navy-700">{tk.subject}</span>
                          <span className="text-xs text-gray-500">
                            #{tk.ticketNumber} · {displayDate(tk.createdAt)}
                          </span>
                        </Link>
                        <Badge value={tk.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">No support requests.</p>
                ),
              )
            : null}
        </div>
      </div>
    </>
  );
}
