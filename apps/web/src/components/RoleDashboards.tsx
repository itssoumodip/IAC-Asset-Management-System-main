import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { useSession } from '../session';
import type { Asset } from '../types';
import { summaryLine } from '../executive';
import { inrShort } from './OverviewDashboard';
import { BarList, Card, EmptyChart, StatTile } from './charts';
import { Badge, ErrorNotice, Loading, buttonClass, displayDate } from './ui';

/*
  Dashboards for the global roles that are not Super Admin / Executive / team members:
  Finance, Store, Auditor, Insurer and Procurement (ROLES-AND-PAGES.md "Dashboards per role").
*/

const plain = (n: number) => n.toLocaleString('en-IN');
const viewLink = (to: string, label = 'Open') => (
  <Link to={to} className="text-xs font-medium text-navy-700 no-underline hover:underline">
    {label}
  </Link>
);

function Shell({
  title,
  line,
  actions,
  children,
}: {
  title: string;
  line?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-navy-900">{title}</h1>
          {line ? <p className="mt-1 text-sm text-gray-500">{line}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
      <MyItemsStrip />
    </div>
  );
}

/** Everyone is also an employee: a slim reminder of their own equipment. */
function MyItemsStrip() {
  const { user } = useSession();
  const assets = useQuery({
    queryKey: ['my-assets'],
    queryFn: ({ signal }) => api<{ items: Asset[] }>('/assets?limit=100', { signal }),
  });
  const mine = (assets.data?.items ?? []).filter((a) => a.currentAssignment?.userId === user?.id);
  const toConfirm = mine.filter((a) => a.currentAssignment?.acknowledgement === 'PENDING').length;
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
      <span className="text-gray-600">
        <span className="font-medium text-gray-900">Your own equipment:</span> {mine.length} with
        you
        {toConfirm ? (
          <span className="ml-2 font-medium text-yellow-800">· {toConfirm} to confirm</span>
        ) : null}
      </span>
      <span className="flex gap-2">
        <Link to="/my-assets" className={buttonClass('secondary', 'sm')}>
          My assets
        </Link>
        <Link to="/tickets/new" className={buttonClass('ghost', 'sm')}>
          Report a problem
        </Link>
      </span>
    </section>
  );
}

interface FinanceItem {
  id: string;
  assetCode: string;
  description: string;
  teamCode: string;
  missingCost: boolean;
  missingInvoice: boolean;
  financeRejectionReason: string | null;
  createdAt: string;
}
type Page<T> = { items: T[]; nextCursor: string | null };

export function FinanceDashboard() {
  const pending = useQuery({
    queryKey: ['finance-dash', 'PENDING'],
    queryFn: ({ signal }) =>
      api<Page<FinanceItem>>('/finance/queue?status=PENDING&limit=50', { signal }),
  });
  const rejected = useQuery({
    queryKey: ['finance-dash', 'REJECTED'],
    queryFn: ({ signal }) =>
      api<Page<FinanceItem>>('/finance/queue?status=REJECTED&limit=50', { signal }),
  });
  const values = useQuery({
    queryKey: ['finance-dash', 'depreciation'],
    queryFn: ({ signal }) =>
      api<{ items: { purchaseCost: number | null; currentValue: number; category: string }[] }>(
        '/depreciation',
        { signal },
      ),
  });
  const count = (p: typeof pending) =>
    `${p.data?.items.length ?? 0}${p.data?.nextCursor ? '+' : ''}`;
  const waiting = pending.data?.items ?? [];
  const missingCost = waiting.filter((i) => i.missingCost).length;
  const noInvoice = waiting.filter((i) => i.missingInvoice).length;
  const totalCost = (values.data?.items ?? []).reduce((s, r) => s + (r.purchaseCost ?? 0), 0);
  const totalValue = (values.data?.items ?? []).reduce((s, r) => s + (r.currentValue ?? 0), 0);
  const byCategory = new Map<string, number>();
  for (const r of values.data?.items ?? [])
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + (r.purchaseCost ?? 0));

  return (
    <Shell
      title="Finance"
      line={summaryLine([
        { label: 'waiting for your review', count: waiting.length },
        { label: 'without a cost', count: missingCost },
        { label: 'sent back to teams', count: rejected.data?.items.length ?? 0 },
      ])}
      actions={
        <>
          <Link to="/depreciation" className={buttonClass('secondary')}>
            Depreciation
          </Link>
          <Link to="/finance" className={buttonClass()}>
            Review queue
          </Link>
        </>
      }
    >
      <ErrorNotice error={pending.error ?? rejected.error ?? values.error} />
      {pending.isPending ? (
        <Loading label="Loading Finance…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Waiting for review" value={count(pending)} detail="New and corrected assets" to="/finance" />
            <StatTile label="Missing cost" value={plain(missingCost)} detail={`${noInvoice} without an invoice`} to="/finance" />
            <StatTile label="Total purchase cost" value={inrShort(totalCost)} detail="Assets with a cost" to="/depreciation" />
            <StatTile label="Current book value" value={inrShort(totalValue)} detail="After depreciation" to="/depreciation" />
          </div>
          <div className="grid gap-6 lg:grid-cols-5">
            <Card title="Review queue" className="lg:col-span-3" action={viewLink('/finance', 'Open queue')}>
              {waiting.length ? (
                <ul className="divide-y divide-gray-100">
                  {waiting.slice(0, 8).map((i) => (
                    <li key={i.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link to="/finance" className="text-sm font-medium text-navy-700 no-underline hover:underline">
                          {i.assetCode}
                        </Link>
                        <span className="block truncate text-xs text-gray-500">
                          {i.teamCode} · {i.description}
                        </span>
                      </div>
                      {i.missingInvoice ? (
                        <Badge value="PENDING" label="No invoice" />
                      ) : i.missingCost ? (
                        <Badge value="PENDING" label="No cost" />
                      ) : (
                        <Badge value="OPEN" label="Ready" />
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Nothing waiting for review</EmptyChart>
              )}
            </Card>
            <Card title="Sent back to teams" className="lg:col-span-2">
              {rejected.data?.items.length ? (
                <ul className="divide-y divide-gray-100">
                  {rejected.data.items.slice(0, 6).map((i) => (
                    <li key={i.id} className="py-2.5 text-sm">
                      <span className="font-medium text-gray-900">{i.assetCode}</span>
                      <span className="text-xs text-gray-500"> · {i.teamCode}</span>
                      {i.financeRejectionReason ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-gray-600">“{i.financeRejectionReason}”</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Nothing waiting on a team’s correction</EmptyChart>
              )}
            </Card>
          </div>
          <Card title="Purchase cost by category">
            <BarList
              valueLabel="Cost"
              format={inrShort}
              empty="No priced assets yet"
              items={[...byCategory.entries()].map(([label, value]) => ({ label, value }))}
            />
          </Card>
        </>
      )}
    </Shell>
  );
}

export function StoreDashboard() {
  const stores = useQuery({
    queryKey: ['store-dash', 'locations'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; code: string; name: string; inStoreCount: number; assetCount: number; purchaseValue: number }[] }>(
        '/store',
        { signal },
      ),
  });
  const activity = useQuery({
    queryKey: ['store-dash', 'activity'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; occurredAt: string; action: string; assetCode: string; actorName: string; locationName: string | null }[] }>(
        '/store/activity',
        { signal },
      ),
  });
  const ready = useQuery({
    queryKey: ['store-dash', 'ready'],
    queryFn: ({ signal }) => api<{ items: Asset[] }>(`/assets?status=${encodeURIComponent('Ready to Assign')}&limit=50`, { signal }),
  });
  const items = stores.data?.items ?? [];
  const inStore = items.reduce((s, l) => s + l.inStoreCount, 0);
  const value = items.reduce((s, l) => s + l.purchaseValue, 0);
  const label: Record<string, string> = {
    ASSET_RECEIVED: 'Received into store',
    ASSET_ISSUED: 'Issued to a person',
    STORE_RETURN_RECEIVED: 'Return received',
  };
  return (
    <Shell
      title="Store"
      line={summaryLine([{ label: 'items in store', count: inStore }, { label: 'ready to assign', count: ready.data?.items.length ?? 0 }])}
      actions={
        <Link to="/store" className={buttonClass()}>
          Open store
        </Link>
      }
    >
      <ErrorNotice error={stores.error ?? activity.error} />
      {stores.isPending ? (
        <Loading label="Loading store…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="In store" value={plain(inStore)} detail="Across all stores and racks" to="/store" />
            <StatTile label="Ready to assign" value={plain(ready.data?.items.length ?? 0)} detail="Prepared for hand-over" to="/assets?status=Ready%20to%20Assign" />
            <StatTile label="Store locations" value={plain(items.length)} detail="Stores and racks" to="/locations" />
            <StatTile label="Value in store" value={inrShort(value)} detail="Purchase cost" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Items per store" action={viewLink('/store')}>
              <BarList
                valueLabel="In store"
                empty="No store locations yet"
                items={items.map((l) => ({ label: l.name || l.code, value: l.inStoreCount, note: l.purchaseValue ? inrShort(l.purchaseValue) : undefined }))}
              />
            </Card>
            <Card title="Recent store activity">
              {activity.data?.items.length ? (
                <ul className="divide-y divide-gray-100">
                  {activity.data.items.slice(0, 8).map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <span className="font-medium text-navy-700">{a.assetCode}</span>
                      <span className="flex-1 truncate text-gray-700">
                        {label[a.action] ?? a.action}
                        {a.locationName ? ` · ${a.locationName}` : ''}
                      </span>
                      <span className="text-xs whitespace-nowrap text-gray-500">{displayDate(a.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>No store activity yet</EmptyChart>
              )}
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}

interface Cycle {
  id: string;
  cycleId: string;
  locationName: string;
  status: string;
  startedAt: string;
  totalItems: number;
  verifiedItems: number;
  notFoundItems: number;
  wrongPlaceItems: number;
}
export function AuditorDashboard() {
  const cycles = useQuery({
    queryKey: ['verification-cycles'],
    queryFn: ({ signal }) => api<{ items: Cycle[] }>('/verification/cycles', { signal }),
  });
  const all = cycles.data?.items ?? [];
  const open = all.filter((c) => c.status !== 'COMPLETED');
  const sum = (k: keyof Cycle) => open.reduce((s, c) => s + Number(c[k] ?? 0), 0);
  const toVerify = sum('totalItems') - sum('verifiedItems') - sum('notFoundItems') - sum('wrongPlaceItems');
  return (
    <Shell
      title="Verification"
      line={summaryLine([{ label: 'cycles open', count: open.length }, { label: 'items still to check', count: Math.max(0, toVerify) }])}
      actions={
        <Link to="/verification" className={buttonClass()}>
          Start or continue a cycle
        </Link>
      }
    >
      <ErrorNotice error={cycles.error} />
      {cycles.isPending ? (
        <Loading label="Loading verification…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="To verify" value={plain(Math.max(0, toVerify))} detail="In open cycles" to="/verification" />
            <StatTile label="Verified" value={plain(sum('verifiedItems'))} detail="Found in place" to="/verification" />
            <StatTile label="Not found" value={plain(sum('notFoundItems'))} detail="Need follow-up" to="/verification" />
            <StatTile label="Wrong place" value={plain(sum('wrongPlaceItems'))} detail="Found elsewhere" to="/verification" />
          </div>
          <Card title="Verification cycles" action={viewLink('/verification')}>
            {all.length ? (
              <ul className="divide-y divide-gray-100">
                {all.slice(0, 8).map((c) => {
                  const done = c.verifiedItems + c.notFoundItems + c.wrongPlaceItems;
                  const pct = c.totalItems ? Math.round((done / c.totalItems) * 100) : 0;
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-gray-900">{c.locationName}</span>
                        <span className="text-xs text-gray-500"> · {c.cycleId} · started {displayDate(c.startedAt)}</span>
                        <span className="mt-1.5 block h-1.5 rounded-full bg-gray-100">
                          <span className="block h-1.5 rounded-full bg-chart-1" style={{ width: `${pct}%` }} />
                        </span>
                      </div>
                      <span className="w-20 text-right text-xs text-gray-500 tabular-nums">
                        {done}/{c.totalItems}
                      </span>
                      <Badge value={c.status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS'} label={c.status.toLowerCase().replace('_', ' ')} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyChart>No verification cycles yet</EmptyChart>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}

export function InsurerDashboard() {
  const assets = useQuery({
    queryKey: ['insurer-dash', 'assets'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; assetCode: string; description: string; category: string; purchaseCost: number | null; repairCount: number }[] }>(
        '/insurance',
        { signal },
      ),
  });
  const locations = useQuery({
    queryKey: ['insurer-dash', 'locations'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; name: string; code: string; assetCount: number; totalPurchasePrice: number }[] }>(
        '/insurance/locations',
        { signal },
      ),
  });
  const items = assets.data?.items ?? [];
  const total = items.reduce((s, a) => s + (a.purchaseCost ?? 0), 0);
  const repaired = items.filter((a) => a.repairCount > 0);
  return (
    <Shell
      title="Insurance"
      line={`${plain(items.length)} assets covered, purchase value ${formatInr(total)}.`}
      actions={
        <Link to="/insurance" className={buttonClass()}>
          Insurance view
        </Link>
      }
    >
      <ErrorNotice error={assets.error ?? locations.error} />
      {assets.isPending ? (
        <Loading label="Loading insurance…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Insured assets" value={plain(items.length)} detail="In the register" to="/insurance" />
            <StatTile label="Total purchase value" value={inrShort(total)} detail="Sum of purchase cost" to="/insurance" />
            <StatTile label="Locations" value={plain(locations.data?.items.length ?? 0)} detail="With insured assets" to="/insurance" />
            <StatTile label="Repaired assets" value={plain(repaired.length)} detail="With repair history" to="/insurance" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Value by location" action={viewLink('/insurance')}>
              <BarList
                valueLabel="Value"
                format={inrShort}
                empty="No location totals yet"
                items={(locations.data?.items ?? []).map((l) => ({ label: l.name || l.code, value: l.totalPurchasePrice, note: `${l.assetCount} assets` }))}
              />
            </Card>
            <Card title="Most repaired assets">
              {repaired.length ? (
                <ul className="divide-y divide-gray-100">
                  {[...repaired].sort((a, b) => b.repairCount - a.repairCount).slice(0, 6).map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <span className="font-medium text-navy-700">{a.assetCode}</span>
                      <span className="flex-1 truncate text-gray-700">{a.description}</span>
                      <span className="text-xs text-gray-500 tabular-nums">{a.repairCount} repairs</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>No repairs recorded</EmptyChart>
              )}
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}

export function ProcurementDashboard() {
  const toBuy = useQuery({
    queryKey: ['procurement-dash', 'to-buy'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; assetTypeCode: string; categoryCode: string; quantity: number; teamCode: string | null; requestNumber: number; neededBy: string | null; decidedAt: string; requesterName: string }[] }>(
        '/requests/to-buy',
        { signal },
      ),
  });
  const purchases = useQuery({
    queryKey: ['procurement-dash', 'purchases'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; purchaseCode: string; supplier: string; purchaseDate: string; quantity: number; amount: number }[] }>(
        '/procurement',
        { signal },
      ),
  });
  const lines = toBuy.data?.items ?? [];
  const units = lines.reduce((s, l) => s + l.quantity, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  const thisMonth = (purchases.data?.items ?? []).filter((p) => new Date(p.purchaseDate) >= monthStart);
  const spentThisMonth = thisMonth.reduce((s, p) => s + Number(p.amount || 0), 0);
  return (
    <Shell
      title="Procurement"
      line={summaryLine([{ label: 'approved items to buy', count: lines.length }])}
      actions={
        <Link to="/procurement" className={buttonClass()}>
          Record a purchase
        </Link>
      }
    >
      <ErrorNotice error={toBuy.error ?? purchases.error} />
      {toBuy.isPending ? (
        <Loading label="Loading procurement…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="To buy" value={plain(lines.length)} detail={`${units} units approved`} />
            <StatTile label="Purchases this month" value={plain(thisMonth.length)} detail="Recorded" to="/procurement" />
            <StatTile label="Spent this month" value={inrShort(spentThisMonth)} detail="Recorded amount" to="/procurement" />
            <StatTile label="All purchases" value={plain(purchases.data?.items.length ?? 0)} detail="On record" to="/procurement" />
          </div>
          <div className="grid gap-6 lg:grid-cols-5">
            <Card title="Approved requests to buy" className="lg:col-span-3">
              {lines.length ? (
                <ul className="divide-y divide-gray-100">
                  {lines.slice(0, 10).map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-gray-900">
                          {l.quantity} × {l.assetTypeCode}
                        </span>
                        <span className="block text-xs text-gray-500">
                          Request #{l.requestNumber} · {l.requesterName}
                          {l.teamCode ? ` · for ${l.teamCode}` : ''}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {l.neededBy ? `Needed by ${displayDate(l.neededBy)}` : `Approved ${displayDate(l.decidedAt)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Nothing approved is waiting to be bought</EmptyChart>
              )}
            </Card>
            <Card title="Recent purchases" className="lg:col-span-2" action={viewLink('/procurement')}>
              {purchases.data?.items.length ? (
                <ul className="divide-y divide-gray-100">
                  {purchases.data.items.slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-gray-900">{p.supplier}</span>
                        <span className="block text-xs text-gray-500">
                          {p.purchaseCode} · {displayDate(p.purchaseDate)}
                        </span>
                      </div>
                      <span className="text-sm text-gray-900 tabular-nums">{formatInr(Number(p.amount))}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>No purchases recorded yet</EmptyChart>
              )}
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}
