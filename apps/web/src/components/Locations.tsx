import { useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { can, useSession } from '../session';
import type { LocationTreeNode, LocationAsset } from '../types';
import {
  Badge,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  buttonClass,
  noticeClass,
  tableWrapClass,
  filterBarClass,
  tableClass,
  cx,
  formStackClass,
} from './ui';
import './locations.css';

const LEVELS = ['SITE', 'ZONE', 'BUILDING', 'FLOOR', 'UNIT', 'STORE', 'RACK'];
type Editor =
  | { kind: 'create'; parentId: string }
  | { kind: 'edit'; node: LocationTreeNode }
  | { kind: 'status'; node: LocationTreeNode };

function descendantIds(nodes: LocationTreeNode[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes)
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
  }
  return out;
}

function LocationEditor({
  editor,
  nodes,
  onClose,
  onSaved,
}: {
  editor: Editor;
  nodes: LocationTreeNode[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const node = editor.kind === 'create' ? undefined : editor.node;
  const [code, setCode] = useState('');
  const [name, setName] = useState(node?.name ?? '');
  const [level, setLevel] = useState(() => {
    if (editor.kind !== 'create') return node?.level ?? 'UNIT';
    const parent = nodes.find((n) => n.id === editor.parentId);
    return LEVELS[Math.min(LEVELS.length - 1, parent ? LEVELS.indexOf(parent.level) + 1 : 0)];
  });
  const [parentId, setParentId] = useState(
    editor.kind === 'create' ? editor.parentId : (node?.parentId ?? ''),
  );
  const [reason, setReason] = useState('');
  const blocked = editor.kind === 'edit' ? descendantIds(nodes, editor.node.id) : new Set<string>();
  const rank = LEVELS.indexOf(level);
  const parents = nodes.filter(
    (n) => n.active && !blocked.has(n.id) && LEVELS.indexOf(n.level) < rank,
  );
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editor.kind === 'create'
        ? api('/locations', { method: 'POST', body })
        : api(`/locations/${encodeURIComponent(editor.node.id)}`, {
            method: 'PATCH',
            version: editor.node.version,
            body,
          }),
  });
  const activating = editor.kind === 'status' && !editor.node.active;
  const title =
    editor.kind === 'create'
      ? 'Add location'
      : editor.kind === 'edit'
        ? `Edit ${editor.node.name || editor.node.code}`
        : `${activating ? 'Reactivate' : 'Deactivate'} ${editor.node.name || editor.node.code}`;
  const invalid =
    !reason.trim() ||
    (editor.kind !== 'status' && !name.trim()) ||
    (editor.kind === 'create' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,49}$/.test(code.trim()));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    let body: Record<string, unknown>;
    if (editor.kind === 'create')
      body = {
        code: code.trim(),
        name: name.trim(),
        level,
        parentId: parentId || null,
        reason: reason.trim(),
      };
    else if (editor.kind === 'edit') {
      body = { reason: reason.trim() };
      if (name.trim() !== editor.node.name) body.name = name.trim();
      if ((parentId || null) !== editor.node.parentId) body.parentId = parentId || null;
      if (Object.keys(body).length === 1) return;
    } else body = { active: activating, reason: reason.trim() };
    try {
      await mutation.mutateAsync(body);
      onSaved(
        editor.kind === 'create'
          ? `${name.trim()} created.`
          : editor.kind === 'edit'
            ? `${name.trim()} updated.`
            : `${editor.node.name || editor.node.code} ${activating ? 'reactivated' : 'deactivated'}.`,
      );
    } catch {
      /* The API error is shown with the draft intact. */
    }
  }
  return (
    <Panel title={title} className="location-editor">
      <form className={formStackClass} onSubmit={submit}>
        {editor.kind === 'create' ? (
          <div className="form-grid">
            <Field
              label="Code"
              htmlFor="loc-code"
              hint="Permanent and unique. Saved in uppercase; cannot be changed later."
            >
              <input
                id="loc-code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                maxLength={50}
                required
              />
            </Field>
            <Select
              label="Level"
              htmlFor="loc-level"
              value={level}
              onChange={(value) => {
                setLevel(value);
                const parent = nodes.find((n) => n.id === parentId);
                if (parent && LEVELS.indexOf(parent.level) >= LEVELS.indexOf(value))
                  setParentId('');
              }}
              options={LEVELS.map((value) => ({ value, label: levelLabel(value) }))}
            />
          </div>
        ) : null}
        {editor.kind !== 'status' ? (
          <div className="form-grid">
            <Field label="Name" htmlFor="loc-name">
              <input
                id="loc-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={150}
                required
              />
            </Field>
            <Select
              label="Parent"
              htmlFor="loc-parent"
              value={parentId}
              onChange={setParentId}
              hint={`Only locations above the ${levelLabel(level)} level are listed.`}
              options={[
                { value: '', label: 'None (top level)' },
                ...parents.map((n) => ({
                  value: n.id,
                  label: `${'– '.repeat(n.depth - 1)}${n.name || n.code} (${levelLabel(n.level)})`,
                })),
              ]}
            />
          </div>
        ) : (
          <p className="muted">
            {activating
              ? 'The location will return to the tree and can be used again.'
              : 'Deactivated locations keep their code and history. Assets and active sub-locations must be moved first.'}
          </p>
        )}
        <Field label="Reason (recorded in the audit log)" htmlFor="loc-reason">
          <textarea
            id="loc-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            rows={2}
            required
          />
        </Field>
        <ErrorNotice error={mutation.error} />
        <div className="form-actions">
          <button className={buttonClass()} type="submit" disabled={invalid || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button className={buttonClass('secondary')} type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

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
  const { user } = useSession();
  const canManage = can(user, 'system.admin');
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const tree = useQuery({
    queryKey: ['location-tree', showInactive],
    queryFn: ({ signal }) =>
      api<{ locations: LocationTreeNode[] }>(
        `/locations/tree${showInactive ? '?includeInactive=true' : ''}`,
        { signal },
      ),
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
  const childMap = new Map<string, LocationTreeNode[]>();
  for (const n of nodes)
    if (n.parentId) childMap.set(n.parentId, [...(childMap.get(n.parentId) ?? []), n]);
  const childrenOf = (id: string) => childMap.get(id) ?? [];
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

  const query = search.trim().toLowerCase();
  const visible = new Set<string>();
  if (query)
    for (const n of nodes)
      if (n.name.toLowerCase().includes(query) || n.code.toLowerCase().includes(query)) {
        let cur: LocationTreeNode | undefined = n;
        while (cur && !visible.has(cur.id)) {
          visible.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
  const isExpanded = (n: LocationTreeNode) =>
    query !== '' || (expandedOverride[n.id] ?? n.depth < 2);

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
      {notice ? (
        <p className={noticeClass('success')} role="status">
          {notice}
        </p>
      ) : null}
      {editor ? (
        <LocationEditor
          key={`${editor.kind}-${'node' in editor ? editor.node.id : editor.parentId}`}
          editor={editor}
          nodes={nodes}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setNotice(message);
            void queryClient.invalidateQueries({ queryKey: ['location-tree'] });
            void queryClient.invalidateQueries({ queryKey: ['master-data'] });
            void queryClient.invalidateQueries({ queryKey: ['references'] });
          }}
        />
      ) : null}
      <div className="flex flex-col gap-6">
        <Panel
          title="Location tree"
          action={
            canManage ? (
              <button
                className={buttonClass('primary', 'sm')}
                type="button"
                onClick={() => {
                  setNotice('');
                  setEditor({ kind: 'create', parentId: selectedId ?? '' });
                }}
              >
                Add location
              </button>
            ) : undefined
          }
        >
          <div className="location-toolbar">
            <Field label="Search locations" htmlFor="loc-tree-search">
              <input
                id="loc-tree-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or code"
                maxLength={100}
              />
            </Field>
            <Checkbox label="Show inactive" checked={showInactive} onChange={setShowInactive} />
          </div>
          {roots.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'location-tree-table')}>
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
              {query && !visible.size ? <Empty title="No matching locations" /> : null}
            </div>
          ) : (
            <Empty title="No locations yet" />
          )}
        </Panel>
        {selectedNode && assetsPage ? (
          <Panel title={`Assets at ${selectedNode.name} · ${formatPath(selectedNode)}`}>
            <ErrorNotice error={assetError} />
            <div className={filterBarClass}>
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
              <div className={tableWrapClass}>
                <table className={cx(tableClass, 'location-assets-table')}>
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

  function renderTree(list: LocationTreeNode[]): React.ReactNode[] {
    return list.flatMap((node) => {
      if (query && !visible.has(node.id)) return [];
      const kids = childrenOf(node.id);
      const open = isExpanded(node);
      const label = node.name || node.code;
      const row = (
        <tr key={node.id} className={node.active ? '' : 'location-row-inactive'}>
          <td>
            <div
              className="location-name-cell"
              style={{ paddingLeft: `${Math.max(0, node.depth - 1) * 20}px` }}
            >
              {kids.length ? (
                <button
                  type="button"
                  className="location-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
                  disabled={query !== ''}
                  onClick={() => setExpandedOverride((prev) => ({ ...prev, [node.id]: !open }))}
                >
                  {open ? '▾' : '▸'}
                </button>
              ) : (
                <span className="location-toggle-spacer" aria-hidden="true" />
              )}
              <button
                type="button"
                className={`location-node ${selectedId === node.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(node.id);
                }}
              >
                {label}
              </button>
              <span className="location-code mono">{node.code}</span>
              {node.active ? null : <Badge value="INACTIVE" label="Inactive" />}
              {kids.length ? (
                <span className="muted small-text">
                  {' '}
                  · {kids.length} child{kids.length !== 1 ? 'ren' : ''}
                </span>
              ) : null}
            </div>
          </td>
          <td>
            <Badge value={node.level} label={levelLabel(node.level)} />
          </td>
          <td>{node.assetCount}</td>
          <td>{money(node.purchaseValue)}</td>
          <td>
            <div className="location-row-actions">
              <button
                className={buttonClass('secondary', 'sm')}
                type="button"
                aria-label={`View assets at ${label}`}
                onClick={() => {
                  setSelectedId(node.id);
                }}
              >
                View assets
              </button>
              {canManage ? (
                <>
                  <button
                    className={buttonClass('secondary', 'sm')}
                    type="button"
                    aria-label={`Edit ${label}`}
                    onClick={() => {
                      setNotice('');
                      setEditor({ kind: 'edit', node });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className={buttonClass('secondary', 'sm')}
                    type="button"
                    aria-label={`${node.active ? 'Deactivate' : 'Reactivate'} ${label}`}
                    onClick={() => {
                      setNotice('');
                      setEditor({ kind: 'status', node });
                    }}
                  >
                    {node.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </>
              ) : null}
            </div>
          </td>
        </tr>
      );
      return open ? [row, ...renderTree(kids)] : [row];
    });
  }
}
