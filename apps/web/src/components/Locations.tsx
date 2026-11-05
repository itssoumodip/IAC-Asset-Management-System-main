import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { LocationTreeNode, LocationAsset } from '../types';
import { Badge, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, Select } from './ui';

function levelLabel(level: string): string {
  const labels: Record<string, string> = {
    SITE: 'Site',
    ZONE: 'Zone',
    BUILDING: 'Building',
    FLOOR: 'Floor',
    UNIT: 'Unit / Room',
    STORE: 'Store',
    RACK: 'Rack',
  };
  return labels[level] ?? level;
}

function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function Locations() {
  const tree = useQuery({
    queryKey: ['location-tree'],
    queryFn: ({ signal }) => api<{ locations: LocationTreeNode[] }>('/locations/tree', { signal }),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assetsPage, setAssetsPage] = useState<{
    location: LocationTreeNode;
    items: LocationAsset[];
  } | null>(null);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetStatus, setAssetStatus] = useState('');
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [assetError, setAssetError] = useState<unknown>(null);

  const nodes = tree.data?.locations ?? [];
  const roots = nodes.filter((n) => n.depth === 1);
  const childrenOf = (id: string) => nodes.filter((n) => n.parentId === id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const selectedNode = nodes.find((n) => n.id === selectedId);

  async function fetchLocationAssets() {
    if (!selectedId) return;
    setLoadingAssets(true);
    setAssetError(null);
    const params = new URLSearchParams();
    if (assetSearch) params.set('q', assetSearch);
    if (assetStatus) params.set('status', assetStatus);
    try {
      const data = await api<{
        location: LocationTreeNode;
        items: LocationAsset[];
        nextCursor: string | null;
      }>(`/locations/${encodeURIComponent(selectedId)}/assets?${params}`);
      setAssetsPage({ location: data.location, items: data.items });
    } catch (error) {
      setAssetError(error);
      setAssetsPage(null);
    } finally {
      setLoadingAssets(false);
    }
  }

  useEffect(() => {
    if (selectedId) void fetchLocationAssets();
  }, [selectedId, assetSearch, assetStatus]);

  function formatPath(node: LocationTreeNode): string {
    const path: string[] = [];
    let current: LocationTreeNode | undefined = node;
    while (current) {
      path.unshift(`${levelLabel(current.level)}: ${current.name}`);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path.join(' › ');
  }

  if (tree.isPending) return <Loading label="Loading locations…" />;
  if (tree.error) return <ErrorNotice error={tree.error} />;

  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / LOCATIONS"
        title="Locations"
        description="Site › Zone › Building › Floor › Unit/Room › Store › Rack. Select a node to see its assets."
      />
      <ErrorNotice error={tree.error} />
      <div className="dashboard-columns">
        <Panel title="Location tree">
          {roots.length ? (
            <div className="table-scroll">
              <table className="location-tree-table">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Level</th>
                    <th>Assets</th>
                    <th>Purchase value</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>{renderTree(roots)}</tbody>
              </table>
            </div>
          ) : (
            <Empty title="No locations yet" />
          )}
        </Panel>
        {selectedNode && assetsPage ? (
          <Panel title={`Assets at ${selectedNode.name} · ${formatPath(selectedNode)}`}>
            <ErrorNotice error={assetError} />
            <div className="filter-bar">
              <Field label="Search assets" htmlFor="loc-asset-search">
                <input
                  id="loc-asset-search"
                  type="search"
                  value={assetSearch}
                  onChange={(event) => setAssetSearch(event.target.value)}
                  placeholder="Asset ID or description"
                  maxLength={100}
                />
              </Field>
              <Field label="Status" htmlFor="loc-asset-status">
                <Select
                  label=""
                  htmlFor="loc-asset-status"
                  value={assetStatus}
                  onChange={setAssetStatus}
                  options={[
                    { value: '', label: 'All statuses' },
                    { value: 'Active', label: 'Active' },
                    { value: 'In Store', label: 'In Store' },
                    { value: 'Assigned', label: 'Assigned' },
                    { value: 'In Use', label: 'In Use' },
                    { value: 'Under Repair', label: 'Under Repair' },
                    { value: 'Ready to Assign', label: 'Ready to Assign' },
                  ]}
                />
              </Field>
            </div>
            <div className="mini-stats">
              <span>Assets: {assetsPage.items.length}</span>
              <span>
                Purchase value:{' '}
                {money(assetsPage.items.reduce((s, a) => s + Number(a.purchaseCost || 0), 0))}
              </span>
            </div>
            {loadingAssets ? (
              <Loading label="Loading assets…" />
            ) : assetsPage.items.length ? (
              <div className="table-scroll">
                <table className="location-assets-table">
                  <thead>
                    <tr>
                      <th>Asset ID</th>
                      <th>Type</th>
                      <th>Description</th>
                      <th>Status</th>
                      <th>Purchase cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assetsPage.items.map((asset) => (
                      <tr key={asset.id}>
                        <td className="mono">{asset.assetCode}</td>
                        <td>{asset.assetType}</td>
                        <td>{asset.description}</td>
                        <td>
                          <Badge value={asset.status} />
                        </td>
                        <td>{money(Number(asset.purchaseCost || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No assets at this location" />
            )}
          </Panel>
        ) : selectedNode && !assetsPage && !loadingAssets ? (
          <Panel title={`Assets at ${selectedNode.name} · ${formatPath(selectedNode)}`}>
            <p className="muted">Choose a status or search, then choose Show assets.</p>
          </Panel>
        ) : null}
      </div>
    </>
  );

  function renderTree(nodes: LocationTreeNode[]): React.ReactNode[] {
    return nodes.map((node) => {
      const kids = childrenOf(node.id);
      return (
        <tr key={node.id}>
          <td>
            <button
              type="button"
              className={`location-node ${selectedId === node.id ? 'selected' : ''}`}
              style={{ paddingLeft: `${Math.max(0, node.depth - 1) * 20}px` }}
              onClick={() => {
                setSelectedId(node.id);
              }}
            >
              {node.depth > 1 ? (
                <span className="location-branch" aria-hidden="true">
                  └
                </span>
              ) : null}
              {node.name}
            </button>
            {kids.length ? (
              <span className="muted small-text">
                {' '}
                · {kids.length} child{kids.length !== 1 ? 'ren' : ''}
              </span>
            ) : null}
          </td>
          <td>
            <Badge value={node.level} />
          </td>
          <td>{node.assetCount}</td>
          <td>{money(node.purchaseValue)}</td>
          <td>
            <button
              className="button secondary small"
              type="button"
              aria-label={`View assets at ${node.name}`}
              onClick={() => {
                setSelectedId(node.id);
              }}
            >
              View assets
            </button>
          </td>
        </tr>
      );
    });
  }
}
