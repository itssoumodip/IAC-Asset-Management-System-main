import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { can, useSession } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  filterBarClass,
  inputClass,
  linkClass,
  Loading,
  PageTitle,
  Panel,
  Select,
  buttonClass,
  tableWrapClass,
  tableClass,
  cx,
} from './ui';
import { locationLabel, useReferences } from './References';

interface InventoryRow {
  category: string;
  asset_type: string;
  owning_team_id: string;
  team_code: string;
  team_name: string;
  total_count: number;
  in_store_count: number;
  ready_count: number;
  assigned_count: number;
  other_count: number;
  min_in_store: number;
  stock_status: string;
}

interface InventoryResponse {
  items: InventoryRow[];
  summary: { productTypes: number; low: number; out: number };
  scope: 'own' | 'all';
  defaultScope: 'own' | 'all';
}

type StatusView = 'all' | 'low' | 'out';
const ALL_TEAMS = '__all';

function MinCell({ item, canEdit }: { item: InventoryRow; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(String(item.min_in_store));
  useEffect(() => setDraft(String(item.min_in_store)), [item.min_in_store]);
  const save = useMutation({
    mutationFn: () =>
      api('/inventory/min-stock', {
        method: 'PUT',
        body: {
          category: item.category,
          assetType: item.asset_type,
          owningTeamId: item.owning_team_id,
          minInStore: Number(draft),
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inventory'] }),
  });
  if (!canEdit) return <>{item.min_in_store}</>;
  const valid = /^\d{1,7}$/.test(draft);
  const dirty = draft !== String(item.min_in_store);
  return (
    <span className="flex items-center gap-2">
      <input
        className={cx(inputClass, 'h-8 w-20')}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        aria-label={`Minimum in store for ${item.asset_type || item.category}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        className={buttonClass('secondary', 'sm')}
        disabled={!valid || !dirty || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isError ? (
        <small role="alert" className="text-xs text-red-700">
          Could not save
        </small>
      ) : null}
    </span>
  );
}

export function Inventory() {
  const { user } = useSession();
  const refs = useReferences();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [team, setTeam] = useState('');
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState<StatusView>('all');
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (category) params.set('category', category);
  if (team === ALL_TEAMS) params.set('allTeams', 'true');
  else if (team) params.set('owningTeamId', team);
  if (locationId) params.set('locationId', locationId);
  if (status !== 'all') params.set('status', status);
  const qs = params.toString();

  const query = useQuery({
    queryKey: ['inventory', qs],
    queryFn: ({ signal }) => api<InventoryResponse>(`/inventory${qs ? `?${qs}` : ''}`, { signal }),
    placeholderData: (previous) => previous,
  });
  const rows = query.data?.items ?? [];
  const summary = query.data?.summary;
  const defaultOwn = query.data?.defaultScope === 'own';

  useEffect(() => {
    if (!rows.length) return;
    setCategories((known) => {
      const next = new Set(known);
      for (const row of rows) next.add(row.category);
      return next.size === known.length ? known : [...next].sort();
    });
  }, [rows]);

  const filtered = Boolean(search || category || team || locationId || status !== 'all');

  return (
    <>
      <PageTitle
        eyebrow="INVENTORY & STORE"
        title="Inventory"
        description="Stock levels for each product type: how many are in store, ready, assigned or elsewhere."
      />
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(
          [
            {
              view: 'all',
              label: 'Product types',
              value: summary?.productTypes,
              tone: 'text-navy-900',
            },
            { view: 'low', label: 'Low stock', value: summary?.low, tone: 'text-yellow-800' },
            { view: 'out', label: 'Out of stock', value: summary?.out, tone: 'text-red-700' },
          ] as const
        ).map((chip) => (
          <button
            key={chip.view}
            type="button"
            aria-pressed={status === chip.view}
            onClick={() =>
              setStatus(status === chip.view && chip.view !== 'all' ? 'all' : chip.view)
            }
            className={cx(
              'flex flex-col rounded-xl border bg-white px-4 py-3 text-left transition-colors',
              status === chip.view
                ? 'border-navy-500 ring-1 ring-navy-500'
                : 'border-gray-200 hover:border-navy-300',
            )}
          >
            <span className="text-xs font-medium text-gray-500">{chip.label}</span>
            <strong
              className={cx(
                'mt-1 text-2xl font-semibold tabular-nums',
                chip.value ? chip.tone : 'text-navy-900',
              )}
            >
              {chip.value ?? '—'}
            </strong>
          </button>
        ))}
      </div>
      <Panel title="Stock by product type">
        <div className={filterBarClass}>
          <Field label="Search" htmlFor="inventory-q">
            <input
              id="inventory-q"
              className={inputClass}
              type="search"
              placeholder="Category or product type"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          </Field>
          <Select
            label="Category"
            htmlFor="inventory-category"
            value={category}
            onChange={setCategory}
            options={[
              { value: '', label: 'All categories' },
              ...categories.map((value) => ({ value, label: value })),
            ]}
          />
          <Select
            label="Team"
            htmlFor="inventory-team"
            value={team}
            onChange={setTeam}
            options={[
              { value: '', label: defaultOwn ? 'My teams' : 'All teams' },
              ...(defaultOwn ? [{ value: ALL_TEAMS, label: 'All teams' }] : []),
              ...(refs.data?.teams?.map((item) => ({
                value: item.id,
                label: `${item.name} (${item.code})`,
              })) ?? []),
            ]}
          />
          <Select
            label="Location"
            htmlFor="inventory-location"
            value={locationId}
            onChange={setLocationId}
            options={[
              { value: '', label: 'All locations' },
              ...(refs.data?.locations
                .filter((item) => item.active)
                .map((item) => ({ value: item.id, label: locationLabel(item) })) ?? []),
            ]}
          />
          <Select
            label="Stock"
            htmlFor="inventory-status"
            value={status}
            onChange={(value) => setStatus(value as StatusView)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'low', label: 'Low stock' },
              { value: 'out', label: 'Out of stock' },
            ]}
          />
        </div>
        {query.isPending ? (
          <Loading label="Loading inventory…" />
        ) : rows.length ? (
          <div className={tableWrapClass}>
            <table className={cx(tableClass, '[&_.num]:text-right [&_.num]:tabular-nums')}>
              <thead>
                <tr>
                  <th>Product type</th>
                  <th>Category</th>
                  <th>Team</th>
                  <th>Stock</th>
                  <th className="num">Total</th>
                  <th className="num">In store</th>
                  <th className="num">Ready</th>
                  <th className="num">Assigned</th>
                  <th className="num">Other</th>
                  <th>Min</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={`${item.category}-${item.asset_type}-${item.owning_team_id}`}>
                    <td>
                      <span className="font-medium text-gray-900">
                        {item.asset_type || 'Unspecified'}
                      </span>
                    </td>
                    <td>{item.category}</td>
                    <td>{item.team_code}</td>
                    <td>
                      <Badge value={item.stock_status} />
                    </td>
                    <td className="num">{item.total_count}</td>
                    <td className="num">{item.in_store_count}</td>
                    <td className="num">{item.ready_count}</td>
                    <td className="num">{item.assigned_count}</td>
                    <td className="num">{item.other_count}</td>
                    <td>
                      <MinCell item={item} canEdit={can(user, 'asset.edit', item.owning_team_id)} />
                    </td>
                    <td>
                      <Link
                        className={linkClass}
                        to={`/assets?category=${encodeURIComponent(item.category)}&assetType=${encodeURIComponent(item.asset_type ?? '')}&owningTeamId=${encodeURIComponent(item.owning_team_id)}`}
                      >
                        View assets
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <Empty title="No matching stock">Try clearing a filter or search term.</Empty>
        ) : (
          <Empty title="No assets yet">
            Stock appears here once assets are added to the catalog.
          </Empty>
        )}
      </Panel>
    </>
  );
}
