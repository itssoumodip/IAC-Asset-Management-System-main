import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import { locationLabel, useReferences } from './References';
import { BarList, Card, DonutChart, PairedColumnChart, StatTile } from './charts';
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
} from './ui';

interface VerificationCycle {
  id: string;
  cycleId: string;
  locationName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  auditorName: string;
  totalItems: number;
  verifiedItems: number;
  notFoundItems: number;
  wrongPlaceItems: number;
}

interface VerificationItem {
  id: string;
  assetId: string;
  assetCode: string;
  assetDescription: string;
  locationPath: string;
  status: string;
  expectedLocation: string;
  actualLocation: string;
  actualLocationId: string | null;
  verified: boolean;
  verificationStatus: 'PENDING' | 'FOUND' | 'NOT_FOUND' | 'WRONG_PLACE';
  verifiedAt: string | null;
}

/** Verification page: auditor verification cycles and item-level found / not found / wrong place. */
interface VerificationInsightsData {
  activeCycles: number;
  completedCycles: number;
  results: { found: number; notFound: number; wrongPlace: number };
  liveAssets: number;
  checkedThisYear: number;
  neverChecked: number;
  months: { month: string; found: number; problems: number }[];
  staleLocations: { locationId: string; name: string; assets: number }[];
}

/** Numbers and charts above the cycles: coverage, results, monthly checks, places overdue. */
function VerificationInsights() {
  const query = useQuery({
    queryKey: ['verification', 'insights'],
    queryFn: ({ signal }) => api<VerificationInsightsData>('/verification/insights', { signal }),
  });
  const d = query.data;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (!d) return null;
  const n = (v: number) => v.toLocaleString('en-IN');
  const coverage = d.liveAssets ? Math.round((d.checkedThisYear / d.liveAssets) * 100) : 0;
  return (
    <div className="mb-6 flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Checked this year" value={`${coverage}%`} detail={`${n(d.checkedThisYear)} of ${n(d.liveAssets)} assets`} />
        <StatTile label="Never checked" value={n(d.neverChecked)} detail="No physical check yet" />
        <StatTile label="Open cycles" value={n(d.activeCycles)} detail="In progress" />
        <StatTile label="Cycles finished" value={n(d.completedCycles)} detail="Last 12 months" />
        <StatTile label="Not found" value={n(d.results.notFound)} detail="Last 12 months" />
        <StatTile label="Wrong place" value={n(d.results.wrongPlace)} detail="Last 12 months" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Checks per month">
          <PairedColumnChart
            series={['Found', 'Not found or misplaced']}
            empty="No checks in the last 12 months"
            xLabel={(key) => new Date(key).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            points={d.months.map((m) => ({
              key: m.month,
              label: new Date(m.month).toLocaleDateString('en-IN', { month: 'short' }),
              a: m.found,
              b: m.problems,
            }))}
          />
        </Card>
        <Card title="Results, last 12 months">
          <DonutChart
            valueLabel="Checks"
            labelHeader="Result"
            centerLabel="Checks"
            empty="No checks in the last 12 months"
            items={[
              { label: 'Found', value: d.results.found },
              { label: 'Not found', value: d.results.notFound },
              { label: 'Wrong place', value: d.results.wrongPlace },
            ]}
          />
        </Card>
        <Card title="Places not checked in a year">
          <BarList
            valueLabel="Assets"
            empty="Every place has been checked this year"
            items={d.staleLocations.map((l) => ({ label: l.name, value: l.assets, to: `/locations?locationId=${l.locationId}` }))}
          />
        </Card>
      </div>
    </div>
  );
}

export function Verification() {
  const { user } = useSession();
  const allowed = can(user, 'verification.perform');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need verification permission to view this page.</p>
      </Panel>
    );

  const cycles = useQuery({
    queryKey: ['verification-cycles'],
    queryFn: ({ signal }) =>
      api<{ items: VerificationCycle[] }>('/verification/cycles', { signal }),
  });
  const action = useAction();

  const [newCycleLocationId, setNewCycleLocationId] = useState('');
  const refs = useReferences();
  const [newCycleReason, setNewCycleReason] = useState('');
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [items, setItems] = useState<VerificationItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [wrongPlaceAssetId, setWrongPlaceAssetId] = useState<string | null>(null);
  const [actualLocationId, setActualLocationId] = useState('');

  async function startCycle(event: FormEvent) {
    event.preventDefault();
    if (!newCycleLocationId || !newCycleReason.trim() || action.isPending) return;
    const result = await action
      .mutateAsync({
        path: '/verification/cycles',
        method: 'POST',
        body: { locationId: newCycleLocationId, reason: newCycleReason.trim() },
      })
      .catch(() => undefined);
    if (result) {
      setNewCycleLocationId('');
      setNewCycleReason('');
      void cycles.refetch();
      const cycleId = (result as { id?: string }).id;
      if (cycleId) await loadItems(cycleId);
    }
  }

  async function loadItems(cycleId: string) {
    setActiveCycleId(cycleId);
    setItemsLoading(true);
    try {
      const data = await api<{ items: VerificationItem[] }>(
        `/verification/cycles/${cycleId}/items`,
      );
      setItems(data.items);
    } catch {
      setItems([]);
    } finally {
      setItemsLoading(false);
    }
  }

  async function recordItem(
    assetId: string,
    status: 'FOUND' | 'NOT_FOUND' | 'WRONG_PLACE',
    actualLocationId?: string,
  ) {
    const reason = window.prompt(`Reason for ${status.toLowerCase()}:`);
    if (!reason || !reason.trim()) return;
    const result = await action
      .mutateAsync({
        path: `/verification/cycles/${activeCycleId}/items`,
        method: 'POST',
        body: {
          assetId,
          verificationStatus: status,
          reason: reason.trim(),
          ...(actualLocationId ? { actualLocationId } : {}),
        },
      })
      .catch(() => undefined);
    if (result) {
      await loadItems(activeCycleId!);
    }
  }

  async function completeCycle(cycleId: string) {
    if (!window.confirm('Complete this verification cycle?')) return;
    const result = await action
      .mutateAsync({
        path: `/verification/cycles/${cycleId}/complete`,
        method: 'POST',
      })
      .catch(() => undefined);
    if (result) {
      void cycles.refetch();
      setActiveCycleId(null);
      setItems([]);
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="MAINTENANCE & AUDIT"
        title="Physical asset checks"
        description="Run a stocktake for a location and its sublocations. Compare each registered asset with what is physically there, then record found, not found, or the actual location when it is misplaced."
      />
      <ErrorNotice error={action.error ?? cycles.error} />
      <VerificationInsights />

      <Panel title="Verification cycles">
        <p className="muted">
          Start a cycle for a location, then scan or select each item and mark it found, not found,
          or wrong place.
        </p>
        {cycles.isPending ? (
          <Loading />
        ) : cycles.data?.items.length ? (
          <div className={tableWrapClass}>
            <table className={cx(tableClass, 'category-table')}>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Items</th>
                  <th>Verified</th>
                  <th>Not found</th>
                  <th>Wrong place</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cycles.data.items.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.cycleId}</td>
                    <td>{c.locationName}</td>
                    <td>
                      <Badge
                        value={
                          c.status === 'ACTIVE'
                            ? 'ACTIVE'
                            : c.status === 'COMPLETED'
                              ? 'COMPLETED'
                              : 'CANCELLED'
                        }
                      />
                    </td>
                    <td>{new Date(c.startedAt).toLocaleDateString('en-IN')}</td>
                    <td>{c.totalItems}</td>
                    <td>{c.verifiedItems}</td>
                    <td>{c.notFoundItems}</td>
                    <td>{c.wrongPlaceItems}</td>
                    <td>
                      <div className="form-actions">
                        {c.status === 'ACTIVE' ? (
                          <button
                            className={buttonClass('secondary', 'sm')}
                            type="button"
                            onClick={() => loadItems(c.id)}
                            disabled={itemsLoading}
                          >
                            View items
                          </button>
                        ) : (
                          <span className="muted">{c.status.toLowerCase()}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No verification cycles yet" />
        )}
        <div className="form-grid" style={{ marginTop: 20 }}>
          <Select
            label="Location"
            htmlFor="cycle-location"
            value={newCycleLocationId}
            onChange={setNewCycleLocationId}
            required
            options={[
              { value: '', label: 'Choose a location' },
              ...(refs.data?.locations ?? [])
                .filter((item) => item.active)
                .map((item) => ({ value: item.id, label: locationLabel(item) })),
            ]}
          />
          <Field label="Reason" htmlFor="cycle-reason">
            <input
              id="cycle-reason"
              value={newCycleReason}
              onChange={(e) => setNewCycleReason(e.target.value)}
              maxLength={1000}
              required
            />
          </Field>
          <div className="form-actions">
            <button
              className={buttonClass()}
              type="button"
              disabled={!newCycleLocationId || !newCycleReason.trim() || action.isPending}
              onClick={startCycle}
            >
              {action.isPending ? 'Starting…' : 'Start cycle'}
            </button>
          </div>
        </div>
      </Panel>

      {activeCycleId && (
        <Panel title={`Cycle items — ${activeCycleId}`}>
          <p className="muted">
            Mark each item as found, not found, or wrong place. Items already verified are shown
            below.
          </p>
          {itemsLoading ? (
            <Loading />
          ) : items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Description</th>
                    <th>Expected location</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td className="mono">{item.assetCode}</td>
                      <td>{item.assetDescription}</td>
                      <td>{item.expectedLocation}</td>
                      <td>
                        <Badge value={item.verificationStatus} />
                      </td>
                      <td>
                        <div className="form-actions">
                          {item.verificationStatus === 'PENDING' ? (
                            <>
                              <button
                                className={buttonClass('secondary', 'sm')}
                                type="button"
                                onClick={() => recordItem(item.assetId, 'FOUND')}
                                disabled={action.isPending}
                              >
                                Found
                              </button>
                              <button
                                className={buttonClass('secondary', 'sm')}
                                type="button"
                                onClick={() => recordItem(item.assetId, 'NOT_FOUND')}
                                disabled={action.isPending}
                              >
                                Not found
                              </button>
                              <button
                                className={buttonClass('secondary', 'sm')}
                                type="button"
                                onClick={() => {
                                  setWrongPlaceAssetId(item.assetId);
                                  setActualLocationId('');
                                }}
                                disabled={action.isPending}
                              >
                                Wrong place
                              </button>
                            </>
                          ) : (
                            <span className="muted">Verified</span>
                          )}
                          {wrongPlaceAssetId === item.assetId &&
                          item.verificationStatus === 'PENDING' ? (
                            <div className="form-actions">
                              <Select
                                label="Where was it found?"
                                htmlFor={`actual-location-${item.assetId}`}
                                value={actualLocationId}
                                onChange={setActualLocationId}
                                required
                                options={[
                                  { value: '', label: 'Choose actual location' },
                                  ...(refs.data?.locations ?? [])
                                    .filter((location) => location.active)
                                    .map((location) => ({
                                      value: location.id,
                                      label: locationLabel(location),
                                    })),
                                ]}
                              />
                              <button
                                type="button"
                                className={buttonClass()}
                                disabled={action.isPending || !actualLocationId}
                                onClick={async () => {
                                  await recordItem(item.assetId, 'WRONG_PLACE', actualLocationId);
                                  setWrongPlaceAssetId(null);
                                  setActualLocationId('');
                                }}
                              >
                                Save result
                              </button>
                              <button
                                type="button"
                                className={buttonClass('secondary')}
                                onClick={() => setWrongPlaceAssetId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No items in this cycle" />
          )}
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button
              className={buttonClass('secondary')}
              type="button"
              onClick={() => completeCycle(activeCycleId!)}
              disabled={action.isPending}
            >
              Complete cycle
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}
