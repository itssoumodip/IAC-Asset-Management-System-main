import { formatInr } from '../admin-insights';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BarList, Card, DonutChart, PairedColumnChart, StatTile } from './charts';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import type { AssignablePerson } from '../types';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  tableWrapClass,
  buttonClass,
  tableClass,
  cx,
  displayDate,
  inputClass,
  PersonChip,
} from './ui';
import './store.css';

interface StoreLocation {
  id: string;
  code: string;
  name: string;
  level: string;
  parentId: string | null;
  assetCount: number;
  inStoreCount: number;
  assignedCount: number;
  purchaseValue: number;
}

interface AssetBrief {
  id: string;
  assetCode: string;
  description: string;
  assetType: string;
  status: string;
  locationId: string | null;
  locationName: string | null;
}

interface ActivityRow {
  id: string;
  occurredAt: string;
  action: string;
  assetCode: string;
  actorName: string | null;
  locationName: string | null;
}

const ACTIVITY_LABELS: Record<string, string> = {
  ASSET_RECEIVED: 'Received',
  ASSET_ISSUED: 'Issued',
  STORE_RETURN_RECEIVED: 'Return received',
};

const RETURN_CONDITIONS = ['Good', 'Needs repair', 'Damaged'] as const;

interface AssignmentRow {
  id: string;
  assetId: string;
  assetCode: string;
  description: string;
  status: string;
  userId: string;
  userName: string;
  userEmail: string;
  userDesignation?: string | null;
  userLeft?: boolean;
  userHasPhoto?: boolean;
  assignedAt: string;
}

interface StoreSummary {
  readyToIssue: number;
  underRepair: number;
  withStaff: number;
  storeValue: number;
  totalAssets: number;
  receivedLast4Weeks: number;
  issuedLast4Weeks: number;
  byType: { label: string; value: number }[];
  byCondition: { label: string; value: number }[];
  weeks: { weekStart: string; received: number; issued: number }[];
}

/** Store page: receive assets into store/rack, issue to users, view returns waiting. */
export function Store() {
  const { user } = useSession();
  // Permission gate lives here so StoreWorkspace's hooks always run in the same order.
  if (!can(user, 'store.operations'))
    return (
      <Panel>
        <p role="alert">You need store operations permission to view this page.</p>
      </Panel>
    );
  return <StoreWorkspace />;
}

function StoreWorkspace() {
  const locations = useQuery({
    queryKey: ['store-locations'],
    queryFn: ({ signal }) => api<{ items: StoreLocation[] }>('/store', { signal }),
  });
  const returns = useQuery({
    queryKey: ['store-returns'],
    queryFn: ({ signal }) => api<{ items: AssignmentRow[] }>('/store/returns', { signal }),
  });
  const activity = useQuery({
    queryKey: ['store-activity'],
    queryFn: ({ signal }) => api<{ items: ActivityRow[] }>('/store/activity', { signal }),
  });
  const action = useAction();

  const [returnOpenId, setReturnOpenId] = useState<string | null>(null);
  const [returnCondition, setReturnCondition] = useState<string>('Good');
  const [returnLocationId, setReturnLocationId] = useState('');
  const [returnNote, setReturnNote] = useState('');

  const [receiveAssetCode, setReceiveAssetCode] = useState('');
  const [receiveLocationId, setReceiveLocationId] = useState('');
  const [receiveReason, setReceiveReason] = useState('');
  const [receiveAsset, setReceiveAsset] = useState<AssetBrief | null>(null);
  const [receiveSearching, setReceiveSearching] = useState(false);

  const [issueAssetId, setIssueAssetId] = useState('');
  const [issueUserId, setIssueUserId] = useState('');
  const [issueReason, setIssueReason] = useState('');
  const [assetSearchResults, setAssetSearchResults] = useState<AssetBrief[]>([]);

  const storeLocations = (locations.data?.items ?? []).filter(
    (l) => l.level === 'STORE' || l.level === 'RACK',
  );

  async function searchAssets(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      setAssetSearchResults([]);
      return;
    }
    setReceiveSearching(true);
    try {
      const data = await api<{ items: AssetBrief[]; nextCursor: string | null }>(
        `/assets?q=${encodeURIComponent(trimmed)}&limit=10`,
        { signal: undefined },
      );
      setAssetSearchResults(data.items);
    } catch {
      setAssetSearchResults([]);
    } finally {
      setReceiveSearching(false);
    }
  }

  function pickAsset(asset: AssetBrief) {
    setReceiveAssetCode(asset.assetCode);
    setReceiveAsset(asset);
    setAssetSearchResults([]);
  }

  async function submitReceive(event: FormEvent) {
    event.preventDefault();
    if (!receiveAsset || !receiveLocationId || !receiveReason.trim() || action.isPending) return;
    await action
      .mutateAsync({
        path: '/store/receive',
        method: 'POST',
        body: {
          assetId: receiveAsset.id,
          locationId: receiveLocationId,
          reason: receiveReason.trim(),
        },
      })
      .then(() => {
        setReceiveAssetCode('');
        setReceiveAsset(null);
        setReceiveLocationId('');
        setReceiveReason('');
        void locations.refetch();
        void returns.refetch();
        void storeStock.refetch();
        void activity.refetch();
      })
      .catch(() => undefined);
  }

  async function submitIssue(event: FormEvent) {
    event.preventDefault();
    if (!issueAssetId || !issueUserId || !issueReason.trim() || action.isPending) return;
    await action
      .mutateAsync({
        path: '/store/issue',
        method: 'POST',
        body: {
          assetId: issueAssetId,
          userId: issueUserId,
          reason: issueReason.trim(),
        },
      })
      .then(() => {
        setIssueAssetId('');
        setIssueUserId('');
        setIssueReason('');
        void locations.refetch();
        void returns.refetch();
        void storeStock.refetch();
        void activity.refetch();
      })
      .catch(() => undefined);
  }

  function openReturnForm(id: string) {
    setReturnOpenId(id);
    setReturnCondition('Good');
    setReturnLocationId('');
    setReturnNote('');
  }

  async function submitReturn(event: FormEvent) {
    event.preventDefault();
    if (!returnOpenId || !returnLocationId || action.isPending) return;
    await action
      .mutateAsync({
        path: `/store/returns/${returnOpenId}/receive`,
        method: 'POST',
        body: {
          condition: returnCondition,
          locationId: returnLocationId,
          note: returnNote.trim() || undefined,
        },
      })
      .then(() => {
        setReturnOpenId(null);
        void locations.refetch();
        void returns.refetch();
        void storeStock.refetch();
        void activity.refetch();
      })
      .catch(() => undefined);
  }

  const [peopleSearch, setPeopleSearch] = useState('');
  const [peopleQ, setPeopleQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPeopleQ(peopleSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [peopleSearch]);
  const people = useQuery({
    queryKey: ['assignable-people-store', peopleQ],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(
        `/assignable-people?limit=50${peopleQ ? `&q=${encodeURIComponent(peopleQ)}` : ''}`,
        { signal },
      ),
    placeholderData: (previous) => previous,
  });

  // Receive search matches (any status the receive rule allows).
  const receiveMatches = assetSearchResults.filter(
    (a: AssetBrief) => a.status === 'In Store' || a.status === 'Ready to Assign',
  );
  // Issue has its own list: assets currently available in store.
  const storeStock = useQuery({
    queryKey: ['store-issuable-assets'],
    queryFn: async ({ signal }) => {
      const [inStore, ready] = await Promise.all(
        ['In Store', 'Ready to Assign'].map((status) =>
          api<{ items: AssetBrief[] }>(`/assets?status=${encodeURIComponent(status)}&limit=100`, {
            signal,
          }),
        ),
      );
      return [...inStore.items, ...ready.items];
    },
  });
  const issuableAssets = storeStock.data ?? [];

  const summary = useQuery({
    queryKey: ['store-summary'],
    queryFn: ({ signal }) => api<StoreSummary>('/store/summary', { signal }),
  });
  const s = summary.data;
  const refreshAll = () => {
    void summary.refetch();
  };
  useEffect(() => {
    if (action.isSuccess) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.isSuccess]);
  const [withStaffSearch, setWithStaffSearch] = useState('');
  const staffRows = (returns.data?.items ?? []).filter((a) => {
    const term = withStaffSearch.trim().toLowerCase();
    return !term || [a.assetCode, a.description, a.userName, a.userEmail].some((v) => v?.toLowerCase().includes(term));
  });
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-IN');
  const formStack = 'flex flex-col gap-4';

  return (
    <>
      <PageTitle
        eyebrow="INVENTORY & STORE"
        title="Store"
        description="Receive assets into a store or rack, issue them to staff, and take returns back in. Numbers and charts below update as you work."
      />
      <ErrorNotice error={action.error} />
      <ErrorNotice error={locations.error ?? returns.error ?? activity.error ?? summary.error} />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Ready to issue" value={n(s?.readyToIssue)} detail="In store or ready" to="/assets?status=In%20Store,Ready%20to%20Assign" />
          <StatTile label="With staff" value={n(s?.withStaff)} detail="Out on assignment" to="/assets?status=In%20Use,Assigned" />
          <StatTile label="Under repair" value={n(s?.underRepair)} detail="Not issuable yet" to="/assets?status=Under%20Repair" />
          <StatTile label="Value in store" value={s ? formatInr(s.storeValue) : '—'} detail="Purchase cost of stock" />
          <StatTile label="Received" value={n(s?.receivedLast4Weeks)} detail="Last 4 weeks, incl. returns" />
          <StatTile label="Issued" value={n(s?.issuedLast4Weeks)} detail="Last 4 weeks" />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Store movements, last 8 weeks">
            <PairedColumnChart
              series={['Received', 'Issued']}
              empty="No receive or issue in the last 8 weeks"
              xLabel={(key) => `Week of ${displayDate(key)}`}
              points={(s?.weeks ?? []).map((w) => ({
                key: w.weekStart,
                label: displayDate(w.weekStart).replace(/,?\s*\d{4}$/, ''),
                a: w.received,
                b: w.issued,
              }))}
            />
          </Card>
          <Card title="Available stock by type">
            <BarList
              valueLabel="Available"
              empty="Nothing in store right now"
              items={(s?.byType ?? []).map((t) => ({
                label: t.label,
                value: t.value,
                to: `/assets?status=In%20Store,Ready%20to%20Assign&assetType=${encodeURIComponent(t.label)}`,
              }))}
            />
          </Card>
          <Card title="Condition of store stock">
            <DonutChart
              valueLabel="Assets"
              labelHeader="Condition"
              centerLabel="Assets"
              empty="Nothing in store or repair"
              items={(s?.byCondition ?? []).map((t) => ({ label: t.label, value: t.value }))}
            />
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Receive into store">
            <p className="mb-4 text-sm text-gray-500">
              Find the asset, choose the store or rack, and say why. The asset must be In Store or Ready to Assign.
            </p>
            <div className={formStack}>
              <Field label="Asset code" htmlFor="receive-asset-code">
                <div className="relative">
                  <input
                    id="receive-asset-code"
                    className={inputClass}
                    value={receiveAssetCode}
                    onChange={(e) => {
                      setReceiveAssetCode(e.target.value);
                      setReceiveAsset(null);
                      void searchAssets(e.target.value);
                    }}
                    onBlur={() => setTimeout(() => setAssetSearchResults([]), 150)}
                    placeholder="e.g. IAC-IT-000012"
                    autoComplete="off"
                    maxLength={40}
                    required
                  />
                  {receiveSearching ? <span className="mt-1 block text-xs text-gray-500">Searching…</span> : null}
                  {receiveMatches.length > 0 ? (
                    <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                      {receiveMatches.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            className="flex w-full flex-col px-3 py-2 text-left hover:bg-gray-50"
                            onClick={() => pickAsset(a)}
                          >
                            <span className="font-mono text-xs font-medium text-navy-700">{a.assetCode}</span>
                            <span className="truncate text-sm text-gray-700">{a.description}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Field>
              {receiveAsset ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
                  <span className="font-mono text-xs font-semibold">{receiveAsset.assetCode}</span>
                  <span className="min-w-0 flex-1 truncate">{receiveAsset.description}</span>
                  <Badge value={receiveAsset.status} />
                </div>
              ) : null}
              <Select
                label="Store / rack"
                htmlFor="receive-location"
                value={receiveLocationId}
                onChange={setReceiveLocationId}
                options={[
                  { value: '', label: 'Select location' },
                  ...storeLocations.map((l) => ({ value: l.id, label: `${l.name || l.code} (${l.level})` })),
                ]}
                required
              />
              <Field label="Reason" htmlFor="receive-reason">
                <input
                  id="receive-reason"
                  className={inputClass}
                  value={receiveReason}
                  onChange={(e) => setReceiveReason(e.target.value)}
                  placeholder="e.g. New stock from supplier"
                  maxLength={1000}
                  required
                />
              </Field>
              <div>
                <button
                  className={buttonClass()}
                  type="button"
                  disabled={!receiveAsset || !receiveLocationId || !receiveReason.trim() || action.isPending}
                  onClick={submitReceive}
                >
                  {action.isPending ? 'Saving…' : 'Receive into store'}
                </button>
              </div>
            </div>
          </Card>

          <Card title="Issue to staff">
            <p className="mb-4 text-sm text-gray-500">
              Pick an asset that is in store or ready, choose the person, and record the handover reason.
            </p>
            <div className={formStack}>
              <Select
                label={`Asset (${issuableAssets.length} available)`}
                htmlFor="issue-asset"
                value={issueAssetId}
                onChange={setIssueAssetId}
                options={[
                  { value: '', label: issuableAssets.length ? 'Select asset' : 'Nothing in store' },
                  ...issuableAssets.map((a) => ({ value: a.id, label: `${a.assetCode} · ${a.description}` })),
                ]}
                required
              />
              <Field label="Find person" htmlFor="issue-user-search">
                <input
                  id="issue-user-search"
                  className={inputClass}
                  type="search"
                  value={peopleSearch}
                  onChange={(event) => setPeopleSearch(event.target.value)}
                  placeholder="Name, email or employee code"
                  autoComplete="off"
                />
              </Field>
              <Select
                label="Person"
                htmlFor="issue-user"
                value={issueUserId}
                onChange={setIssueUserId}
                options={[
                  {
                    value: '',
                    label: people.data?.items.length ? 'Select person' : peopleQ ? 'No one matches that search' : 'Select person',
                  },
                  ...(people.data?.items ?? []).map((p) => ({
                    value: p.id,
                    label: `${p.displayName} · ${p.email}${p.state === 'DIRECTORY' ? ' (no portal account)' : ''}`,
                  })),
                ]}
                required
              />
              <Field label="Reason" htmlFor="issue-reason">
                <input
                  id="issue-reason"
                  className={inputClass}
                  value={issueReason}
                  onChange={(e) => setIssueReason(e.target.value)}
                  placeholder="e.g. New joiner laptop"
                  maxLength={1000}
                  required
                />
              </Field>
              <div>
                <button
                  className={buttonClass()}
                  type="button"
                  disabled={!issueAssetId || !issueUserId || !issueReason.trim() || action.isPending}
                  onClick={submitIssue}
                >
                  {action.isPending ? 'Saving…' : 'Issue to staff'}
                </button>
              </div>
            </div>
          </Card>
        </div>

        <Panel title="Store locations">
          {locations.isPending ? (
            <Loading />
          ) : storeLocations.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, '[&_.num]:text-right [&_.num]:tabular-nums')}>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Level</th>
                    <th className="num">Assets</th>
                    <th className="num">In store</th>
                    <th className="num">With staff</th>
                    <th className="num">Purchase value</th>
                  </tr>
                </thead>
                <tbody>
                  {storeLocations.map((loc) => (
                    <tr key={loc.id}>
                      <td>
                        <Link to={`/locations?locationId=${loc.id}`} className="font-medium text-navy-700 no-underline hover:underline">
                          {loc.name || loc.code}
                        </Link>
                        <span className="block font-mono text-xs text-gray-500">{loc.code}</span>
                      </td>
                      <td>
                        <Badge value={loc.level} />
                      </td>
                      <td className="num">{loc.assetCount}</td>
                      <td className="num">{loc.inStoreCount}</td>
                      <td className="num">{loc.assignedCount}</td>
                      <td className="num">{loc.purchaseValue > 0 ? formatInr(loc.purchaseValue) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No store locations yet">
              Add a location with level Store or Rack on the Locations page to start receiving stock.
            </Empty>
          )}
        </Panel>

        <Panel
          title="Assets with staff"
          action={<span className="text-sm text-gray-500">{n(returns.data?.items.length)} out · receive one back when it is returned</span>}
        >
          <input
            type="search"
            className={cx(inputClass, 'mb-4 max-w-md')}
            placeholder="Search asset, person or email"
            value={withStaffSearch}
            onChange={(e) => setWithStaffSearch(e.target.value)}
            aria-label="Search assets with staff"
          />
          {returns.isPending ? (
            <Loading />
          ) : staffRows.length ? (
            <div className={tableWrapClass}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Held by</th>
                    <th>Status</th>
                    <th>Since</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {staffRows.map((a) => (
                    <Fragment key={a.id}>
                      <tr>
                        <td>
                          <Link to={`/assets/${a.assetId}`} className="font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                            {a.assetCode}
                          </Link>
                          <span className="block max-w-64 truncate text-sm text-gray-700">{a.description}</span>
                        </td>
                        <td>
                          <PersonChip
                            userId={a.userId}
                            name={a.userName}
                            hasPhoto={a.userHasPhoto}
                            detail={a.userDesignation ?? undefined}
                            designation={a.userDesignation}
                            email={a.userEmail}
                            holdingsHref={`/assets?holderId=${a.userId}`}
                          />
                          {a.userLeft ? <span className="block pl-1 text-xs font-medium text-red-700">Has left</span> : null}
                        </td>
                        <td>
                          <Badge value={a.status} />
                        </td>
                        <td className="whitespace-nowrap">{displayDate(a.assignedAt)}</td>
                        <td>
                          <button
                            className={buttonClass('secondary', 'sm')}
                            type="button"
                            aria-expanded={returnOpenId === a.id}
                            onClick={() => (returnOpenId === a.id ? setReturnOpenId(null) : openReturnForm(a.id))}
                          >
                            Receive return
                          </button>
                        </td>
                      </tr>
                      {returnOpenId === a.id ? (
                        <tr>
                          <td colSpan={5} className="bg-gray-50">
                            <form className="grid gap-4 py-2 sm:grid-cols-3" onSubmit={submitReturn}>
                              <Select
                                label="Condition"
                                htmlFor={`return-condition-${a.id}`}
                                value={returnCondition}
                                onChange={setReturnCondition}
                                options={RETURN_CONDITIONS.map((c) => ({ value: c, label: c }))}
                                required
                              />
                              <Select
                                label="Store location"
                                htmlFor={`return-location-${a.id}`}
                                value={returnLocationId}
                                onChange={setReturnLocationId}
                                options={[
                                  { value: '', label: 'Select location' },
                                  ...storeLocations.map((l) => ({ value: l.id, label: `${l.name || l.code} (${l.level})` })),
                                ]}
                                required
                              />
                              <Field label="Note" htmlFor={`return-note-${a.id}`}>
                                <input
                                  id={`return-note-${a.id}`}
                                  className={inputClass}
                                  value={returnNote}
                                  onChange={(e) => setReturnNote(e.target.value)}
                                  maxLength={1000}
                                />
                              </Field>
                              <div className="flex gap-2 sm:col-span-3">
                                <button className={buttonClass()} type="submit" disabled={!returnLocationId || action.isPending}>
                                  {action.isPending ? 'Saving…' : 'Confirm return'}
                                </button>
                                <button className={buttonClass('secondary')} type="button" onClick={() => setReturnOpenId(null)}>
                                  Cancel
                                </button>
                              </div>
                            </form>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={withStaffSearch ? 'Nothing matches' : 'Nothing is with staff'} />
          )}
        </Panel>

        <Panel title="Recent store activity" action={<span className="text-sm text-gray-500">Last 20 receive, issue and return events</span>}>
          {activity.isPending ? (
            <Loading />
          ) : activity.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Asset</th>
                    <th>What</th>
                    <th>By</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.data.items.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap">{displayDate(e.occurredAt, true)}</td>
                      <td className="font-mono text-xs font-medium">{e.assetCode}</td>
                      <td>
                        <Badge value={e.action === 'ASSET_ISSUED' ? 'IN_PROGRESS' : 'ACCEPTED'} label={ACTIVITY_LABELS[e.action] ?? e.action} />
                      </td>
                      <td>{e.actorName ?? '—'}</td>
                      <td>{e.locationName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No store activity yet" />
          )}
        </Panel>
      </div>
    </>
  );
}
