import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import type { AssignablePerson } from '../types';
import { Badge, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, Select } from './ui';

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

interface AssignmentRow {
  id: string;
  assetId: string;
  assetCode: string;
  description: string;
  status: string;
  userId: string;
  userName: string;
  userEmail: string;
  assignedAt: string;
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
  const action = useAction();

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
      })
      .catch(() => undefined);
  }

  const people = useQuery({
    queryKey: ['assignable-people-store'],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>('/assignable-people?limit=50', { signal }),
    enabled: true,
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

  return (
    <>
      <PageTitle
        eyebrow="INVENTORY & STORE"
        title="Store"
        description="Receive assets into store or rack locations, issue them to users, and track returns waiting."
      />
      <ErrorNotice error={action.error} />
      <ErrorNotice error={locations.error ?? returns.error} />

      <Panel title="Store locations">
        <p className="muted">
          Each store or rack shows how many assets it holds and their combined purchase value.
        </p>
        {locations.isPending ? (
          <Loading />
        ) : storeLocations.length ? (
          <div className="table-scroll">
            <table className="category-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Level</th>
                  <th>Assets</th>
                  <th>In store</th>
                  <th>Assigned</th>
                  <th>Purchase value</th>
                </tr>
              </thead>
              <tbody>
                {storeLocations.map((loc) => (
                  <tr key={loc.id}>
                    <td>
                      <strong>{loc.name || loc.code}</strong>
                      <span className="muted small-text block">· {loc.code}</span>
                    </td>
                    <td>
                      <Badge value={loc.level} />
                    </td>
                    <td>{loc.assetCount}</td>
                    <td>{loc.inStoreCount}</td>
                    <td>{loc.assignedCount}</td>
                    <td>
                      {loc.purchaseValue > 0 ? (
                        <span className="mono">₹{loc.purchaseValue.toLocaleString('en-IN')}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No store locations yet" />
        )}
      </Panel>

      <Panel title="Receive into store">
        <p className="muted">
          Find an asset by its code, choose the store or rack, and record the reason. The asset must
          be In Store or Ready to Assign.
        </p>
        <div className="form-grid">
          <Field label="Asset code" htmlFor="receive-asset-code">
            <div className="asset-search-wrapper">
              <input
                id="receive-asset-code"
                value={receiveAssetCode}
                onChange={(e) => {
                  setReceiveAssetCode(e.target.value);
                  void searchAssets(e.target.value);
                }}
                onBlur={() => setTimeout(() => setAssetSearchResults([]), 150)}
                autoComplete="off"
                maxLength={40}
                required
              />
              {receiveSearching ? <span className="muted small-text">Searching…</span> : null}
              {receiveMatches.length > 0 ? (
                <div className="search-dropdown">
                  {receiveMatches.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="search-dropdown-item"
                      onClick={() => pickAsset(a)}
                    >
                      <div>{a.assetCode}</div>
                      <span className="muted small-text">{a.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </Field>
          {receiveAsset && (
            <div className="asset-confirmed">
              <strong>Found:</strong> {receiveAsset.assetCode} · {receiveAsset.description}{' '}
              <span className="muted small-text">
                · {receiveAsset.assetType} · status <Badge value={receiveAsset.status} />
              </span>
            </div>
          )}
          <Field label="Store / rack" htmlFor="receive-location">
            <Select
              label=""
              htmlFor="receive-location"
              value={receiveLocationId}
              onChange={setReceiveLocationId}
              options={[
                { value: '', label: 'Select location' },
                ...storeLocations.map((l) => ({
                  value: l.id,
                  label: `${l.name || l.code} (${l.level})`,
                })),
              ]}
              required
            />
          </Field>
          <Field label="Reason" htmlFor="receive-reason">
            <input
              id="receive-reason"
              value={receiveReason}
              onChange={(e) => setReceiveReason(e.target.value)}
              maxLength={1000}
              required
            />
          </Field>
          <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={
                !receiveAsset || !receiveLocationId || !receiveReason.trim() || action.isPending
              }
              onClick={submitReceive}
            >
              {action.isPending ? 'Saving…' : 'Receive into store'}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="Issue to user">
        <p className="muted">
          Choose an asset currently in store or ready to assign, pick an employee, and record the
          handover reason.
        </p>
        <div className="form-grid">
          <Field label="Asset" htmlFor="issue-asset">
            <Select
              label=""
              htmlFor="issue-asset"
              value={issueAssetId}
              onChange={setIssueAssetId}
              options={[
                { value: '', label: 'Select asset' },
                ...issuableAssets.map((a) => ({
                  value: a.id,
                  label: `${a.assetCode} · ${a.description}`,
                })),
              ]}
              required
            />
          </Field>
          <Field label="Employee" htmlFor="issue-user">
            <Select
              label=""
              htmlFor="issue-user"
              value={issueUserId}
              onChange={setIssueUserId}
              options={[
                { value: '', label: 'Select employee' },
                ...(people.data?.items ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.displayName} · ${p.email}`,
                })),
              ]}
              required
            />
          </Field>
          <Field label="Reason" htmlFor="issue-reason">
            <input
              id="issue-reason"
              value={issueReason}
              onChange={(e) => setIssueReason(e.target.value)}
              maxLength={1000}
              required
            />
          </Field>
          <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={!issueAssetId || !issueUserId || !issueReason.trim() || action.isPending}
              onClick={submitIssue}
            >
              {action.isPending ? 'Saving…' : 'Issue to user'}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="Returns waiting">
        <p className="muted">
          Assets currently assigned to users. Issue again from the asset page or receive back into
          store from here.
        </p>
        {returns.isPending ? (
          <Loading />
        ) : returns.data?.items.length ? (
          <div className="table-scroll">
            <table className="category-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Assigned to</th>
                  <th>Status</th>
                  <th>Assigned at</th>
                </tr>
              </thead>
              <tbody>
                {returns.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.assetCode}</strong>
                      <span className="muted small-text block">{a.description}</span>
                    </td>
                    <td>
                      <strong>{a.userName}</strong>
                      <span className="muted small-text block">{a.userEmail}</span>
                    </td>
                    <td>
                      <Badge value={a.status} />
                    </td>
                    <td>{new Date(a.assignedAt).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No returns waiting" />
        )}
      </Panel>
    </>
  );
}
