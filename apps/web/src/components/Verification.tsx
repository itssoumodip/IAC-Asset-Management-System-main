import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import { locationLabel, useReferences } from './References';
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
  assetCode: string;
  assetDescription: string;
  locationPath: string;
  status: string;
  expectedLocation: string;
  actualLocation: string;
  verified: boolean;
  verificationStatus: 'PENDING' | 'FOUND' | 'NOT_FOUND' | 'WRONG_PLACE';
  verifiedAt: string | null;
}

/** Verification page: auditor verification cycles and item-level found / not found / wrong place. */
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
      setActiveCycleId((result as { id?: string }).id ?? null);
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

  async function recordItem(assetId: string, status: 'FOUND' | 'NOT_FOUND' | 'WRONG_PLACE') {
    const reason = window.prompt(`Reason for ${status.toLowerCase()}:`);
    if (!reason || !reason.trim()) return;
    const result = await action
      .mutateAsync({
        path: `/verification/cycles/${activeCycleId}/items`,
        method: 'POST',
        body: { assetId, verificationStatus: status, reason: reason.trim() },
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
        title="Verification"
        description="Auditors start verification cycles, scan items, and mark found / not found / wrong place."
      />
      <ErrorNotice error={action.error ?? cycles.error} />

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
                          <button
                            className={buttonClass('secondary', 'sm')}
                            type="button"
                            disabled={action.isPending}
                            onClick={() => completeCycle(c.id)}
                          >
                            Completed
                          </button>
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
                                onClick={() => recordItem(item.id, 'FOUND')}
                                disabled={action.isPending}
                              >
                                Found
                              </button>
                              <button
                                className={buttonClass('secondary', 'sm')}
                                type="button"
                                onClick={() => recordItem(item.id, 'NOT_FOUND')}
                                disabled={action.isPending}
                              >
                                Not found
                              </button>
                              <button
                                className={buttonClass('secondary', 'sm')}
                                type="button"
                                onClick={() => recordItem(item.id, 'WRONG_PLACE')}
                                disabled={action.isPending}
                              >
                                Wrong place
                              </button>
                            </>
                          ) : (
                            <span className="muted">Verified</span>
                          )}
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
