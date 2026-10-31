import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { LocationReference } from '../types';
import { ErrorNotice, Field, Loading, PageTitle, Panel, Select } from './ui';

type LocationLevel = {
  code: string;
  label: string;
  sortOrder: number;
  active: boolean;
};
type LocationNode = LocationReference & {
  path: string;
  level: string;
  parentId: string | null;
  assetCount: number;
};
type LocationTree = { levels: LocationLevel[]; items: LocationNode[] };

export function innerLocationLevels(levels: LocationLevel[], parentLevel: string) {
  if (!parentLevel) {
    const first = levels.filter((level) => level.active).sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return first ? [first] : [];
  }
  const parent = levels.find((level) => level.code === parentLevel);
  return levels.filter((level) => level.active && parent && level.sortOrder > parent.sortOrder);
}

export function visibleTreeItems(items: LocationNode[], search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return items;
  const matches = new Set(items.filter((item) => item.path.toLowerCase().includes(term)).map((item) => item.id));
  for (const item of items) {
    let parentId = item.parentId;
    while (parentId) {
      if (matches.has(item.id)) matches.add(parentId);
      parentId = items.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  }
  return items.filter((item) => matches.has(item.id));
}

function LocationForm({
  levels,
  parent,
  onSave,
}: {
  levels: LocationLevel[];
  parent?: LocationNode;
  onSave: (body: unknown) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [level, setLevel] = useState(innerLocationLevels(levels, parent?.level ?? '').at(0)?.code ?? '');
  const [reason, setReason] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave({ name: name.trim(), level, parentId: parent?.id ?? null, reason: reason.trim() });
    setName('');
    setReason('');
  };
  const options = innerLocationLevels(levels, parent?.level ?? '').map((item) => ({
    value: item.code,
    label: item.label,
  }));
  return (
    <form className="form-grid subsection" onSubmit={submit}>
      <Field label="Name" htmlFor={`location-name-${parent?.id ?? 'root'}`}>
        <input
          id={`location-name-${parent?.id ?? 'root'}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={150}
        />
      </Field>
      <Select
        label="Level"
        htmlFor={`location-level-${parent?.id ?? 'root'}`}
        value={level}
        onChange={setLevel}
        required
        options={options}
      />
      <Field label="Reason" htmlFor={`location-reason-${parent?.id ?? 'root'}`}>
        <input
          id={`location-reason-${parent?.id ?? 'root'}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          maxLength={1000}
        />
      </Field>
      <button className="button small" disabled={!level || !name.trim() || !reason.trim()}>
        Add location
      </button>
    </form>
  );
}

function LocationRow({
  node,
  all,
  levels,
  expanded,
  onToggle,
  onSave,
}: {
  node: LocationNode;
  all: LocationNode[];
  levels: LocationLevel[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSave: (path: string, method: 'POST' | 'PATCH', body: unknown, version?: number) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'add' | 'rename' | 'move' | 'deactivate' | null>(null);
  const [name, setName] = useState(node.name ?? '');
  const [parentId, setParentId] = useState(node.parentId ?? '');
  const [reason, setReason] = useState('');
  const children = all.filter((item) => item.parentId === node.id);
  const descendantIds = new Set<string>();
  const pending = [node.id];
  while (pending.length) {
    const parentId = pending.pop();
    for (const child of all.filter((item) => item.parentId === parentId)) {
      descendantIds.add(child.id);
      pending.push(child.id);
    }
  }
  const inner = innerLocationLevels(levels, node.level);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await onSave(`/locations/${node.id}`, 'PATCH', {
      ...(mode === 'rename' ? { name: name.trim() } : { parentId: parentId || null }),
      reason: reason.trim(),
    }, node.version);
    setMode(null);
    setReason('');
  };
  return (
    <li>
      <div className="row-list-item">
        <button type="button" className="button text small" onClick={() => onToggle(node.id)} aria-label={`${expanded.has(node.id) ? 'Collapse' : 'Expand'} ${node.name}`}>
        {children.length ? (expanded.has(node.id) ? '−' : '+') : '·'}
        </button>
        <div>
          <strong>{node.name}</strong>
          <span className="muted"> · {node.path}</span>
          <div>
            <span className="badge">{node.level}</span>{' '}
            <span className="muted">{node.assetCount} asset{node.assetCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="actions">
          {inner.length ? <button className="button text small" type="button" onClick={() => setMode(mode === 'add' ? null : 'add')}>Add inside</button> : null}
          <button className="button text small" type="button" onClick={() => setMode(mode === 'rename' ? null : 'rename')}>Rename</button>
          <button className="button text small" type="button" onClick={() => setMode(mode === 'move' ? null : 'move')}>Move</button>
          {node.active ? <button className="button text small" type="button" onClick={() => setMode('deactivate')}>Deactivate</button> : null}
        </div>
      </div>
      {mode === 'add' ? <LocationForm levels={levels} parent={node} onSave={(body) => onSave('/locations', 'POST', body)} /> : null}
      {mode === 'rename' || mode === 'move' ? (
        <form className="form-grid subsection" onSubmit={save}>
          {mode === 'rename' ? (
            <Field label="New name" htmlFor={`rename-${node.id}`}>
              <input id={`rename-${node.id}`} value={name} onChange={(event) => setName(event.target.value)} required />
            </Field>
          ) : (
            <Select
              label="New parent"
              htmlFor={`move-${node.id}`}
              value={parentId}
              onChange={setParentId}
              options={[
                { value: '', label: 'Top level' },
                ...all
                  .filter((item) => item.id !== node.id && !descendantIds.has(item.id) && item.active)
                  .map((item) => ({ value: item.id, label: item.path })),
              ]}
            />
          )}
          <Field label="Reason" htmlFor={`${mode}-reason-${node.id}`}>
            <input id={`${mode}-reason-${node.id}`} value={reason} onChange={(event) => setReason(event.target.value)} required />
          </Field>
          <button className="button small" disabled={!reason.trim()}>Save change</button>
        </form>
      ) : null}
      {mode === 'deactivate' ? (
        <form className="form-grid subsection" onSubmit={save}>
          <Field label="Reason" htmlFor={`deactivate-reason-${node.id}`}>
            <input id={`deactivate-reason-${node.id}`} value={reason} onChange={(event) => setReason(event.target.value)} required />
          </Field>
          <button className="button small" disabled={!reason.trim()}>Deactivate</button>
        </form>
      ) : null}
      {expanded.has(node.id) && children.length ? <ul className="row-list location-children">{children.map((child) => <LocationRow key={child.id} node={child} all={all} levels={levels} expanded={expanded} onToggle={onToggle} onSave={onSave} />)}</ul> : null}
    </li>
  );
}

export function Locations() {
  const query = useQuery({ queryKey: ['locations-tree'], queryFn: () => api<LocationTree>('/locations/tree') });
  const action = useAction();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const data = query.data;
  const visible = useMemo(() => visibleTreeItems(data?.items ?? [], search), [data?.items, search]);
  const roots = visible.filter((item) => !item.parentId);
  useEffect(() => {
    if (!data) return;
    setExpanded(new Set(data.items.filter((item) => data.items.some((child) => child.parentId === item.id)).map((item) => item.id)));
  }, [data]);
  const save = async (path: string, method: 'POST' | 'PATCH', body: unknown, version?: number) => {
    await action.mutateAsync({ path, method, body, version });
    await query.refetch();
  };
  if (query.isPending) return <Loading />;
  if (query.error || !data) return <ErrorNotice error={query.error ?? new Error('Locations unavailable')} retry={() => void query.refetch()} />;
  return (
    <>
      <PageTitle title="Locations" description="Keep the location tree clear so every asset has a useful place." />
      <ErrorNotice error={action.error} />
      <Panel title="Find a location">
        <Field label="Search by path" htmlFor="location-search">
          <input id="location-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Site / building / floor" />
        </Field>
      </Panel>
      <Panel title="Location tree">
        <LocationForm levels={data.levels} onSave={(body) => save('/locations', 'POST', body)} />
        <ul className="location-tree">
          {roots.map((node) => (
            <LocationRow
              key={node.id}
              node={node}
              all={visible}
              levels={data.levels}
              expanded={expanded}
              onToggle={(id) => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })}
              onSave={save}
            />
          ))}
        </ul>
      </Panel>
    </>
  );
}
