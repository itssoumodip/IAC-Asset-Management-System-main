import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAction, usePages } from '../hooks';
import { can, useSession } from '../session';
import type { Asset, AssignablePerson, InvoiceMeta } from '../types';
import { fetchAllPages } from '../transfer-files';
import { catalogHref, rememberCatalogSearch } from '../catalog-return';
import { fyOptions } from '../admin-insights';
import { AssetPhoto } from './AssetPhoto';
import { AssetTags } from './AssetTags';
import { PersonPicker } from './PersonPicker';
import { useBrands, useHolders } from './Insights';
import {
  ColumnFilter,
  ColumnsMenu,
  FilterChips,
  FiltersButton,
  SortMenu,
  TextColumnFilter,
  fromList,
  toList,
  type FilterGroup,
} from './ColumnFilter';
import { StoreReceiving } from './StoreReceiving';
import { AssetDetailTabs } from './AssetDetailTabs';
import { BulkTransfer, ExportRecords, FormTransfer, IMPORT_TOOLS_ENABLED } from './DataTransfer';
import {
  FinanceStatusPanel,
  INVOICE_ACCEPT,
  INVOICE_MAX_BYTES,
  readDataUrl,
} from './FinanceReview';
import {
  useReferences,
  ReferenceSelect,
  ReferenceBadge,
  referenceLabel,
  locationLabel,
  referenceOptions,
} from './References';
import {
  Checkbox,
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  Timeline,
  displayDate,
  Select,
  backLinkClass,
  actionsClass,
  buttonClass,
  filterBarClass,
  searchFormClass,
  tableWrapClass,
  inputClass,
  cx,
  linkClass,
  noticeClass,
  tableClass,
  formStackClass,
  PersonChip,
  fileInputClass,
} from './ui';
const assetExportColumns = [
  'assetCode',
  'description',
  'category',
  'assetType',
  'manufacturer',
  'model',
  'serialNumber',
  'barcode',
  'configuration',
  'graphics',
  'ownershipType',
  'status',
  'condition',
  'riskLevel',
  'departmentId',
  'locationId',
  'warrantyExpiry',
  'amcApplies',
  'amcExpiry',
  'purchaseDate',
  'insuranceExpiry',
  'lastAuditDate',
  'nextAuditDate',
  'disposalDate',
  'disposalMethod',
  'dataWipeRequired',
];
const assetAdminExportColumns = [
  'purchaseCost',
  'residualValue',
  'depreciationMethod',
  'usefulLifeYears',
  'capitalisationDate',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'disposalReference',
  'remarks',
  'commentType',
  'financePending',
];
function assetExportRow(asset: Record<string, unknown>, manage: boolean) {
  const columns = [...assetExportColumns, ...(manage ? assetAdminExportColumns : [])];
  return Object.fromEntries(columns.map((key) => [key, asset[key] ?? '']));
}

const terminalAssetStatuses = new Set(['Retired', 'Disposed', 'Sold', 'Scrapped']);
const catalogColumns = [
  { key: 'asset', label: 'Asset' },
  { key: 'manufacturer', label: 'Brand' },
  { key: 'category', label: 'Category' },
  { key: 'assetType', label: 'Subcategory' },
  { key: 'departmentId', label: 'Department' },
  { key: 'holderId', label: 'Held by' },
  { key: 'status', label: 'Status' },
  { key: 'owningTeamId', label: 'Owning team' },
  { key: 'ownershipType', label: 'Ownership' },
  { key: 'model', label: 'Model' },
  { key: 'serialNumber', label: 'Serial number' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'locationId', label: 'Location' },
  { key: 'condition', label: 'Condition' },
  { key: 'riskLevel', label: 'Risk' },
  { key: 'warrantyExpiry', label: 'Warranty expiry' },
  { key: 'purchaseDate', label: 'Purchase date' },
  { key: 'purchaseCost', label: 'Purchase cost' },
] as const;
const defaultCatalogColumns = ['asset', 'manufacturer', 'category', 'assetType', 'departmentId', 'holderId', 'status', 'model', 'serialNumber', 'locationId'];
function canAssign(asset: Asset) {
  return ['In Store', 'Ready to Assign'].includes(asset.status) && !asset.currentAssignment;
}
function canTransfer(asset: Asset) {
  return !!asset.currentAssignment && !terminalAssetStatuses.has(asset.status);
}
// Row thumbnail: fetches the stored photo only for assets that have one; others show a box icon.
function AssetThumb({ asset }: { asset: Asset }) {
  const photo = useQuery({
    queryKey: ['asset-photo', asset.id],
    queryFn: ({ signal }) =>
      api<{ dataUrl: string | null }>(`/assets/${asset.id}/photo`, { signal }),
    enabled: !!asset.hasPhoto,
    staleTime: 10 * 60 * 1000,
  });
  const src = photo.data?.dataUrl;
  return (
    <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-gray-100 text-gray-400">
      {src ? (
        <img src={src} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z M3 7.5 12 12l9-4.5 M12 12v9" />
        </svg>
      )}
    </div>
  );
}
/** What each `?attention=` value on the catalog means (the dashboard "Needs attention" rows). */
const attentionLabels: Record<string, string> = {
  unconfirmed: 'Custody not yet confirmed by the holder',
  no_cost: 'Assets missing purchase cost',
  no_date: 'Assets missing purchase date',
  no_warranty: 'Assets with no warranty end date',
  left_holder: 'Assets held by people who have left',
  finance_pending: 'Waiting for Finance review',
};

/** Small row of live numbers above the catalog; each one opens the matching list. */
function CatalogSnapshot({ active }: { active?: string }) {
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) =>
      api<{
        assets?: { total: number; assigned: number; inStore?: number; pendingAcknowledgements: number; warrantyExpiring: number };
        unknownCounts?: { warrantyExpiry: number };
      }>('/dashboard', { signal }),
  });
  const a = summary.data?.assets;
  if (!a) return null;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-IN');
  const tile = (label: string, value: string, detail: string, to: string, on = false, warn = false) => (
    <Link
      key={label}
      to={to}
      className={cx(
        'flex min-w-0 flex-col rounded-xl border bg-white px-4 py-3 no-underline transition-colors',
        on ? 'border-navy-500 ring-2 ring-navy-100' : 'border-gray-200 hover:border-navy-200',
      )}
    >
      <span className="text-xs font-medium text-gray-500">{label}</span>
      <strong className={cx('mt-0.5 text-xl font-semibold tabular-nums', warn ? 'text-red-700' : 'text-navy-900')}>{value}</strong>
      <span className="truncate text-xs text-gray-500">{detail}</span>
    </Link>
  );
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {tile('All assets', n(a.total), 'In the register', '/assets', !active)}
      {tile('In use', n(a.assigned), a.total ? `${Math.round((a.assigned / a.total) * 100)}% of assets` : 'Assigned', '/assets?status=In%20Use,Assigned')}
      {tile('In store', n(a.inStore), 'Ready to issue', '/assets?status=In%20Store')}
      {tile('Not confirmed', n(a.pendingAcknowledgements), 'Holder has not confirmed', '/assets?attention=unconfirmed', active === 'unconfirmed', a.pendingAcknowledgements > 0)}
      {tile('Warranty ≤ 30 days', n(a.warrantyExpiring), 'Ending soon', '/warranty-expiry?show=due30', false, a.warrantyExpiring > 0)}
      {tile('No warranty date', n(summary.data?.unknownCounts?.warrantyExpiry), 'Add the end date', '/assets?attention=no_warranty', active === 'no_warranty')}
    </div>
  );
}

export function AssetList({ assignmentMode = false }: { assignmentMode?: boolean }) {
  const { user } = useSession();
  const manage = can(user, 'asset.view_all');
  const [params, setParams] = useSearchParams();
  const refs = useReferences();
  // Remember this search and filters so coming back from an asset reopens the same list.
  const searchKey = params.toString();
  useEffect(() => {
    if (!assignmentMode) rememberCatalogSearch(searchKey);
  }, [assignmentMode, searchKey]);
  const filters = {
    q: params.get('q') || undefined,
    asset: params.get('asset') || undefined,
    model: params.get('model') || undefined,
    serialNumber: params.get('serialNumber') || undefined,
    barcode: params.get('barcode') || undefined,
    warrantyExpiry: params.get('warrantyExpiry') || undefined,
    purchaseDate: params.get('purchaseDate') || undefined,
    purchaseCost: params.get('purchaseCost') || undefined,
    status: assignmentMode ? 'In Store' : params.get('status') || undefined,
    category: params.get('category') || undefined,
    assetType: params.get('assetType') || undefined,
    manufacturer: params.get('manufacturer') || undefined,
    condition: params.get('condition') || undefined,
    riskLevel: params.get('riskLevel') || undefined,
    ownershipType: params.get('ownershipType') || undefined,
    departmentId: params.get('departmentId') || undefined,
    holderId: params.get('holderId') || undefined,
    locationId: params.get('locationId') || undefined,
    owningTeamId: params.get('owningTeamId') || undefined,
    sort: params.get('sort') || undefined,
    removed: params.get('removed') === 'only' ? 'only' : undefined,
    attention: params.get('attention') || undefined,
    // Financial years bought (2022 = FY 2022-23), e.g. from the dashboard's Spend charts.
    fy: params.get('fy') || undefined,
  };
  const showAssign = !assignmentMode && can(user, 'asset.custody');
  const showCreate = can(user, 'asset.create');
  const query = usePages<Asset>('/assets', filters);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('asset-catalog-columns-v2');
      const parsed: unknown = saved ? JSON.parse(saved) : null;
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === 'string' && catalogColumns.some((column) => column.key === key))
        : defaultCatalogColumns;
    } catch {
      return defaultCatalogColumns;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('asset-catalog-columns-v2', JSON.stringify(visibleColumns));
    } catch {
      // The selected columns still work for this page view if storage is unavailable.
    }
  }, [visibleColumns]);
  const holders = useHolders();
  const brands = useBrands();
  // Column checkbox filters: every value is a comma-separated list in the URL.
  const refOptions = (kind: string, selected: string[]) =>
    (refs.data?.values ?? [])
      .filter((v) => v.kind === kind && (v.active || selected.includes(v.code)))
      .map((v) => ({ value: v.code, label: v.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const sel = (key: string) => toList(params.get(key));
  const filterGroups: FilterGroup[] = [
    ...(!assignmentMode
      ? [
          {
            key: 'status',
            title: 'Status',
            options: refOptions('STATUS', sel('status')),
            selected: sel('status'),
          },
        ]
      : []),
    {
      key: 'category',
      title: 'Category',
      options: refOptions('CATEGORY', sel('category')),
      selected: sel('category'),
    },
    {
      key: 'condition',
      title: 'Condition',
      options: refOptions('CONDITION', sel('condition')),
      selected: sel('condition'),
    },
    {
      key: 'riskLevel',
      title: 'Risk',
      options: refOptions('RISK', sel('riskLevel')),
      selected: sel('riskLevel'),
    },
    {
      key: 'ownershipType',
      title: 'Ownership',
      options: refOptions('OWNERSHIP', sel('ownershipType')),
      selected: sel('ownershipType'),
    },
    {
      key: 'assetType',
      title: 'Subcategory',
      options: refOptions('ASSET_TYPE', sel('assetType')),
      selected: sel('assetType'),
    },
    {
      key: 'manufacturer',
      title: 'Brand',
      options: [
        { value: 'none', label: 'No brand' },
        ...(brands.data?.items ?? []).map((b) => ({
          value: b.name,
          label: `${b.name} (${b.count})`,
        })),
      ],
      selected: sel('manufacturer'),
    },
    {
      key: 'departmentId',
      title: 'Department',
      // "No department" first, then the departments ("none" is understood by the API).
      options: [
        { value: 'none', label: 'No department' },
        ...(refs.data?.departments ?? [])
          .filter((d) => d.active || sel('departmentId').includes(d.id))
          .map((d) => ({ value: d.id, label: d.name })),
      ],
      selected: sel('departmentId'),
    },
    ...(!assignmentMode
      ? [
          {
            key: 'holderId',
            title: 'Held by',
            // Only people who hold something, with how many items each holds.
            options: [
              { value: 'none', label: 'Not held by anyone' },
              ...(holders.data?.items ?? [])
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((h) => ({ value: h.userId, label: `${h.name} (${h.count})` })),
            ],
            selected: sel('holderId'),
          },
        ]
      : []),
    {
      key: 'locationId',
      title: 'Location',
      options: [
        { value: 'none', label: 'No location' },
        ...(refs.data?.locations ?? [])
          .filter((l) => l.active || sel('locationId').includes(l.id))
          .map((l) => ({ value: l.id, label: locationLabel(l) })),
      ],
      selected: sel('locationId'),
    },
    {
      // Not a table column: shows as a chip (and in the phone Filters panel) when set.
      key: 'fy',
      title: 'Financial year',
      options: [
        ...fyOptions(),
        ...sel('fy')
          .filter((y) => !fyOptions().some((o) => o.value === y))
          .map((y) => ({ value: y, label: `FY ${y}-${String(Number(y) + 1).slice(-2)}` })),
      ],
      selected: sel('fy'),
    },
    ...(manage
      ? [
          {
            key: 'owningTeamId',
            title: 'Team',
            options: (refs.data?.teams ?? []).map((t) => ({
              value: t.id,
              label: `${t.name} (${t.code})`,
            })),
            selected: sel('owningTeamId'),
          },
        ]
      : []),
  ];
  const groupFor = (key: string) => filterGroups.find((g) => g.key === key);
  function setFilter(key: string, values: string[]) {
    const next = new URLSearchParams(params);
    if (values.length) next.set(key, fromList(values));
    else next.delete(key);
    setParams(next);
  }
  function applyFilters(all: Record<string, string[]>) {
    const next = new URLSearchParams(params);
    for (const [key, values] of Object.entries(all)) {
      if (values.length) next.set(key, fromList(values));
      else next.delete(key);
    }
    setParams(next);
  }
  const loadedItems = query.data?.pages.flatMap((page) => page.items) ?? [];
  const matchingCount = query.data?.pages[0]?.totalCount;
  const items = assignmentMode ? loadedItems.filter(canAssign) : loadedItems;
  const allowedCatalogColumns = catalogColumns.filter(
    (column) =>
      (column.key !== 'purchaseCost' || can(user, 'asset.view_private')) &&
      (column.key !== 'owningTeamId' || manage),
  );
  const [search, setSearch] = useState(filters.q ?? '');
  function update(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  }
  function searchSubmit(event: FormEvent) {
    event.preventDefault();
    update('q', search.trim());
  }
  function renderColumnFilter(column: (typeof catalogColumns)[number]) {
    const group = groupFor(column.key);
    if (group)
      return (
        <ColumnFilter
          title={column.label}
          options={group.options}
          selected={group.selected}
          onApply={(values) => setFilter(column.key, values)}
        />
      );
    return (
      <TextColumnFilter
        title={column.label}
        value={params.get(column.key) ?? ''}
        placeholder={
          column.key === 'purchaseDate' || column.key === 'warrantyExpiry'
            ? 'YYYY-MM-DD'
            : column.key === 'purchaseCost'
              ? 'Exact amount'
              : 'Contains…'
        }
        // Asset ID and description are always filled in; every other text column can be blank.
        blankLabel={
          column.key === 'asset'
            ? null
            : column.key === 'warrantyExpiry'
              ? 'Only assets with no warranty date'
              : column.key === 'purchaseDate'
                ? 'Only assets with no purchase date'
                : column.key === 'purchaseCost'
                  ? 'Only assets with no purchase cost'
                  : `Only assets with no ${column.label.toLowerCase()}`
        }
        onApply={(value) => update(column.key, value)}
      />
    );
  }
  function renderColumnValue(asset: Asset, key: (typeof catalogColumns)[number]['key']) {
    const location = refs.data?.locations.find((item) => item.id === asset.locationId);
    switch (key) {
      case 'asset':
        return (
          <Link
            to={assignmentMode ? `/assets/${asset.id}/assign` : `/assets/${asset.id}`}
            className="asset-list-link flex items-center gap-3"
          >
            <AssetThumb asset={asset} />
            <span className="min-w-0">
              <span className="block font-medium text-navy-700">{asset.assetCode}</span>
              <span className="line-clamp-1 block max-w-72 text-xs text-gray-500">{asset.description}</span>
            </span>
          </Link>
        );
      case 'manufacturer': return asset.manufacturer || '—';
      case 'category': return referenceLabel(refs.data, 'CATEGORY', asset.category);
      case 'assetType': return referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType);
      case 'departmentId': return refs.data?.departments.find((item) => item.id === asset.departmentId)?.name ?? '—';
      case 'holderId':
        return asset.currentAssignment?.employeeName ? (
          <PersonChip
            userId={asset.currentAssignment.userId ?? ''}
            name={asset.currentAssignment.employeeName}
            hasPhoto={asset.currentAssignment.employeeHasPhoto}
            designation={asset.currentAssignment.employeeDesignation}
            department={asset.currentAssignment.employeeDepartment}
            email={asset.currentAssignment.employeeEmail}
            holdingsHref={asset.currentAssignment.userId ? `/assets?holderId=${asset.currentAssignment.userId}` : undefined}
          />
        ) : refs.data?.teams?.find((item) => item.id === asset.owningTeamId)?.name ?? '—';
      case 'status': return <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />;
      case 'owningTeamId': return refs.data?.teams?.find((item) => item.id === asset.owningTeamId)?.name ?? '—';
      case 'ownershipType': return referenceLabel(refs.data, 'OWNERSHIP', asset.ownershipType);
      case 'model': return asset.model || '—';
      case 'serialNumber': return asset.serialNumber || '—';
      case 'barcode': return asset.barcode || '—';
      case 'locationId': return asset.locationId ? location ? locationLabel(location) : 'Location unavailable' : 'Not recorded';
      case 'condition': return referenceLabel(refs.data, 'CONDITION', asset.condition);
      case 'riskLevel': return referenceLabel(refs.data, 'RISK', asset.riskLevel);
      case 'warrantyExpiry': return asset.warrantyExpiry ? displayDate(asset.warrantyExpiry) : '—';
      case 'purchaseDate': return asset.purchaseDate ? displayDate(asset.purchaseDate) : '—';
      case 'purchaseCost': return asset.purchaseCost == null ? '—' : `₹${Number(asset.purchaseCost).toLocaleString('en-IN')}`;
    }
  }
  return (
    <>
      {assignmentMode ? (
        <Link to={catalogHref()} className={backLinkClass}>
          ← Asset catalog
        </Link>
      ) : null}
      <PageTitle
        eyebrow={manage ? 'INVENTORY / ASSETS' : 'MY WORKSPACE / ASSETS'}
        title={assignmentMode ? 'Assign an asset' : manage ? 'Asset catalog' : 'Your assets'}
        description={
          assignmentMode
            ? 'Pick an In Store asset, then choose who receives it.'
            : manage
              ? 'Every asset in the register, with who holds it and its status.'
              : 'Equipment assigned to you.'
        }
        action={
          manage && (showAssign || showCreate) ? (
            <div className={actionsClass}>
              {showAssign ? (
                <Link className={buttonClass('secondary')} to="/assignments/new">
                  Assign asset
                </Link>
              ) : null}
              {showCreate ? (
                <Link className={buttonClass()} to="/assets/new">
                  Add asset
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ExportRecords
            name="assets"
            // The background export applies the same list filters as this page.
            backgroundFilters={Object.fromEntries(
              Object.entries({
                q: filters.q,
                asset: filters.asset,
                model: filters.model,
                serialNumber: filters.serialNumber,
                barcode: filters.barcode,
                warrantyExpiry: filters.warrantyExpiry,
                purchaseDate: filters.purchaseDate,
                purchaseCost: filters.purchaseCost,
                status: filters.status,
                category: filters.category,
                assetType: filters.assetType,
                manufacturer: filters.manufacturer,
                condition: filters.condition,
                riskLevel: filters.riskLevel,
                ownershipType: filters.ownershipType,
                departmentId: filters.departmentId,
                holderId: filters.holderId,
                locationId: filters.locationId,
                owningTeamId: filters.owningTeamId,
              }).filter(([, value]) => value),
            )}
            columns={[...assetExportColumns, ...(manage ? assetAdminExportColumns : [])]}
            load={async () =>
              (await fetchAllPages('/assets', filters)).map((item) => assetExportRow(item, manage))
            }
          />
          {user?.roles.includes('SUPER_ADMIN') && !assignmentMode ? (
            <button
              type="button"
              className={cx(buttonClass(filters.removed ? 'primary' : 'ghost', 'sm'))}
              aria-pressed={!!filters.removed}
              onClick={() => update('removed', filters.removed ? '' : 'only')}
            >
              {filters.removed ? 'Viewing removed assets only · Return to active assets' : 'Show removed assets'}
            </button>
          ) : null}
          {IMPORT_TOOLS_ENABLED && can(user, 'system.admin') && !assignmentMode ? (
            <p className="text-xs text-gray-500">
              Importing an original register with permanent Asset IDs?{' '}
              <Link to="/admin/imports" className={linkClass}>
                Use Import review
              </Link>
            </p>
          ) : null}
        </div>
        {IMPORT_TOOLS_ENABLED && can(user, 'asset.import') && !assignmentMode ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <BulkTransfer module="assets" />
            <BulkTransfer module="assignments" />
          </div>
        ) : null}
      </div>
      {manage && !assignmentMode ? <CatalogSnapshot active={filters.attention} /> : null}
      <Panel>
        {filters.attention && attentionLabels[filters.attention] ? (
          <div className={cx(noticeClass('info'), 'mb-4 flex flex-wrap items-center justify-between gap-3')} role="status">
            <span>
              Showing only: <span className="font-semibold">{attentionLabels[filters.attention]}</span>
            </span>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => update('attention', '')}>
              Show all assets
            </button>
          </div>
        ) : null}
        {filters.removed ? (
          <div className={cx(noticeClass('warning'), 'mb-4 flex flex-wrap items-center justify-between gap-3')} role="status">
            <span>Active assets are hidden in this view. You are viewing removed asset records only.</span>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => update('removed', '')}>
              Return to active assets
            </button>
          </div>
        ) : null}
        <div className={filterBarClass}>
          <form className={searchFormClass} onSubmit={searchSubmit}>
            <label htmlFor="asset-search" className="sr-only">
              Search assets
            </label>
            <input
              id="asset-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search asset ID, description, model, brand, serial, barcode or holder name"
              className={inputClass}
              maxLength={100}
            />
            <button className={buttonClass('secondary')} type="submit">
              Search
            </button>
            {/* Inside the search row so it keeps its natural size (the filter bar stretches its children). */}
            <SortMenu
              value={filters.sort ?? 'code'}
              onChange={(value) => update('sort', value === 'code' ? '' : value)}
              options={[
                { value: 'code', label: 'Asset ID (A–Z)' },
                { value: 'code_desc', label: 'Newest Asset ID first' },
                { value: 'added', label: 'Recently added' },
                { value: 'updated', label: 'Recently updated' },
              ]}
            />
          </form>
          {!assignmentMode ? (
            <div className="ml-auto !min-w-0 !flex-none">
              <ColumnsMenu
                columns={allowedCatalogColumns}
                visible={visibleColumns}
                onChange={setVisibleColumns}
                defaults={defaultCatalogColumns.filter((key) => allowedCatalogColumns.some((column) => column.key === key))}
              />
            </div>
          ) : null}
          {/* Phones hide the table headers, so their filters live behind this button. */}
          <div className="flex-none md:hidden">
            <FiltersButton groups={filterGroups} onApply={applyFilters} />
          </div>
        </div>
        <FilterChips
          groups={filterGroups}
          onRemove={(key, value) =>
            setFilter(
              key,
              toList(params.get(key)).filter((v) => v !== value),
            )
          }
        onClearAll={() => {
          const next = new URLSearchParams(params);
          [
            'q', 'asset', 'model', 'serialNumber', 'barcode', 'warrantyExpiry',
            'purchaseDate', 'purchaseCost', 'status', 'category', 'assetType',
            'manufacturer', 'condition', 'riskLevel', 'ownershipType', 'departmentId',
            'holderId', 'locationId', 'owningTeamId', 'fy',
          ].forEach((key) => next.delete(key));
          setParams(next);
        }}
        />
        {!assignmentMode && !query.isPending && !query.error ? (
          <p className="mb-3 text-sm text-gray-500" aria-live="polite">
            Total matching assets: {matchingCount?.toLocaleString('en-IN') ?? 'unavailable'}
            {' · '}Currently loaded: {loadedItems.length.toLocaleString('en-IN')}
          </p>
        ) : null}
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {query.isPending ? (
          <Loading label="Loading assets..." />
        ) : items.length ? (
          <div className={cx(tableWrapClass, 'asset-catalog-table')}>
            <table className={tableClass}>
              <thead>
                <tr>
                  {allowedCatalogColumns
                    .filter((column) => visibleColumns.includes(column.key))
                    .map((column) => (
                      <th key={column.key}>
                        {column.label}
                        {renderColumnFilter(column)}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {items.map((asset) => (
                  <tr key={asset.id} className="asset-list-row">
                    {allowedCatalogColumns
                      .filter((column) => visibleColumns.includes(column.key))
                      .map((column) => (
                        <td key={column.key} data-label={column.label}>
                          {renderColumnValue(asset, column.key)}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !query.error ? (
          <Empty
            title={
              assignmentMode
                ? 'No assets ready for assignment'
                : manage
                  ? 'Your register starts here'
                  : 'No assets to display'
            }
            action={
              assignmentMode ? (
                <div className={actionsClass}>
                  {showCreate ? (
                    <Link className={buttonClass()} to="/assets/new">
                      Create asset
                    </Link>
                  ) : null}
                  {IMPORT_TOOLS_ENABLED && can(user, 'system.admin') ? (
                    <Link className={buttonClass('secondary')} to="/admin/imports">
                      Import review
                    </Link>
                  ) : null}
                </div>
              ) : showCreate ? (
                <Link className={buttonClass()} to="/assets/new">
                  Create your first asset
                </Link>
              ) : undefined
            }
          >
            {assignmentMode
              ? 'Only In Store assets without current custody can be assigned. Adjust the search filters or create an asset first.'
              : manage
                ? 'Add an asset or stage a reviewed import to begin.'
                : 'Assigned equipment will appear here. Adjust your filters if needed.'}
          </Empty>
        ) : null}
        <LoadMore
          available={query.hasNextPage && !query.isPlaceholderData}
          loading={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        />
      </Panel>
    </>
  );
}
function KitPanel({ asset }: { asset: Asset }) {
  const action = useAction();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [detachReason, setDetachReason] = useState('');
  const parts = asset.kitParts ?? [];
  async function attach(event: FormEvent) {
    event.preventDefault();
    setLookupError('');
    const wanted = code.trim().toUpperCase();
    const found = await api<{ items: Asset[] }>(
      `/assets?q=${encodeURIComponent(wanted)}&limit=20`,
    ).catch(() => undefined);
    const part = found?.items.find((item) => item.assetCode.toUpperCase() === wanted);
    if (!part) {
      setLookupError('No asset with that code was found.');
      return;
    }
    await action
      .mutateAsync({
        path: `/assets/${asset.id}/kit`,
        body: { partAssetId: part.id, reason: reason.trim() },
        idempotent: true,
      })
      .then(() => {
        setCode('');
        setReason('');
      })
      .catch(() => undefined);
  }
  async function detach(part: { id: string }) {
    if (!detachReason.trim()) return;
    await action
      .mutateAsync({
        path: `/assets/${asset.id}/kit/${part.id}`,
        method: 'DELETE',
        body: { reason: detachReason.trim() },
        idempotent: true,
      })
      .then(() => setDetachReason(''))
      .catch(() => undefined);
  }
  return (
    <Panel title="Kit">
      <p className="muted">
        Parts in a kit are assigned, transferred and returned together with this asset.
      </p>
      {parts.length ? (
        <Field label="Detach reason" htmlFor="kit-detach-reason">
          <input
            id="kit-detach-reason"
            value={detachReason}
            onChange={(event) => setDetachReason(event.target.value)}
            maxLength={5000}
            placeholder="Required to detach a part"
          />
        </Field>
      ) : null}
      {parts.length ? (
        <ul className="plain-list">
          {parts.map((part) => (
            <li key={part.id}>
              <Link to={`/assets/${part.id}`}>{part.assetCode}</Link> {part.description}
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={action.isPending || !detachReason.trim()}
                onClick={() => void detach(part)}
              >
                Detach
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No parts attached.</p>
      )}
      <form className="form-stack subsection" onSubmit={attach}>
        <Field label="Part asset code" htmlFor="kit-part-code">
          <input
            id="kit-part-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="IAC-IT-000123"
            required
          />
        </Field>
        <Field label="Reason" htmlFor="kit-reason">
          <input
            id="kit-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={5000}
            required
          />
        </Field>
        {lookupError ? <p role="alert">{lookupError}</p> : null}
        <button
          className={buttonClass()}
          disabled={action.isPending || !code.trim() || !reason.trim()}
        >
          Attach part
        </button>
      </form>
    </Panel>
  );
}
export function AssetDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const manage = can(user, 'asset.view_all');
  const refs = useReferences();
  const query = useQuery({
    queryKey: ['asset', id],
    queryFn: ({ signal }) => api<Asset>(`/assets/${id}`, { signal }),
    enabled: !!id,
  });
  const action = useAction();
  const [custodySnapshot, setCustodySnapshot] = useState<{ id: string; version: number }>();
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [returning, setReturning] = useState(false);
  const [condition, setCondition] = useState('');
  const [location, setLocation] = useState('');
  if (query.isPending) return <Loading label="Loading asset details..." />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <Empty title="Asset not found">
          <p>This asset does not exist or belongs to another team.</p>
        </Empty>
      );
    }
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const asset = query.data;
  if (!asset) return <Empty title="Asset not found" />;
  const assetTeam = asset.owningTeamId ?? undefined;
  const mayEdit = can(user, 'asset.edit', assetTeam) || can(user, 'asset.finance_edit');
  const mayLabel = can(user, 'asset.label', assetTeam);
  const mayCustody =
    can(user, 'asset.custody', assetTeam) &&
    !asset.kitParent &&
    (canTransfer(asset) || canAssign(asset));
  const assignment = asset.currentAssignment;
  const own = assignment?.userId === user?.id;
  const department = refs.data?.departments.find((value) => value.id === asset.departmentId)?.name;
  const loc = refs.data?.locations.find((value) => value.id === asset.locationId);
  async function acknowledge(event: FormEvent) {
    event.preventDefault();
    if (!custodySnapshot) return;
    await action
      .mutateAsync({
        path: `/assignments/${custodySnapshot.id}/acknowledgement`,
        body: { decision, ...(decision === 'DISPUTED' ? { reason: reason.trim() } : {}) },
        version: custodySnapshot.version,
        idempotent: true,
      })
      .then(() => {
        setDecision('');
        setReason('');
      })
      .catch(() => undefined);
  }
  async function returnAsset(event: FormEvent) {
    event.preventDefault();
    if (!custodySnapshot) return;
    await action
      .mutateAsync({
        path: `/assignments/${custodySnapshot.id}/return`,
        body: { condition, locationId: location, reason: reason.trim() },
        version: custodySnapshot.version,
        idempotent: true,
      })
      .then(() => {
        setReturning(false);
        setReason('');
      })
      .catch(() => undefined);
  }
  return (
    <>
      <Link to={catalogHref()} className={backLinkClass}>
        ← Asset catalog
      </Link>
      <PageTitle
        eyebrow={asset.assetCode}
        title={asset.description}
        description={`${referenceLabel(refs.data, 'CATEGORY', asset.category)} · ${referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType)}`}
        action={
          manage && (mayEdit || mayLabel || mayCustody) ? (
            <div className={actionsClass}>
              {mayEdit ? (
                <Link className={buttonClass('secondary')} to={`/assets/${id}/edit`}>
                  Edit asset
                </Link>
              ) : null}
              {mayLabel ? (
                <Link className={buttonClass('secondary')} to={`/assets/labels?ids=${asset.id}`}>
                  Print label
                </Link>
              ) : null}
              {!mayCustody ? null : canTransfer(asset) ? (
                <Link className={buttonClass()} to={`/assets/${id}/assign?transfer=1`}>
                  Transfer custody
                </Link>
              ) : canAssign(asset) ? (
                <Link className={buttonClass()} to={`/assets/${id}/assign`}>
                  Assign asset
                </Link>
              ) : null}
            </div>
          ) : own ? (
            <Link className={buttonClass()} to={`/tickets/new?assetId=${asset.id}`}>
              Raise a ticket
            </Link>
          ) : undefined
        }
      />
      <ExportRecords
        name={`asset-${asset.assetCode}`}
        columns={[...assetExportColumns, ...(manage ? assetAdminExportColumns : [])]}
        load={async () => [assetExportRow(await api<Asset>(`/assets/${asset.id}`), manage)]}
      />
      <ErrorNotice
        error={action.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {manage || mayEdit ? <FinanceStatusPanel asset={asset} /> : null}
      {!manage ? (
        <div className={noticeClass()}>
          Asset details are read-only. Contact Admin or raise a support ticket to request a
          correction.
        </div>
      ) : null}
      {own && assignment?.acknowledgement === 'PENDING' ? (
        <div className={noticeClass('warning')}>
          <strong>This asset needs your confirmation</strong>
          <p>
            Check the serial number, description, and condition against the item received. A
            discrepancy records your feedback without changing custody.
          </p>
          <div className={actionsClass}>
            <button
              type="button"
              className={buttonClass()}
              onClick={() => {
                setDecision('ACCEPTED');
                setReason('');
                setCustodySnapshot(
                  assignment ? { id: assignment.id, version: assignment.version } : undefined,
                );
              }}
            >
              Details are correct
            </button>
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setDecision('DISPUTED');
                setReason('');
                setCustodySnapshot(
                  assignment ? { id: assignment.id, version: assignment.version } : undefined,
                );
              }}
            >
              Report discrepancy
            </button>
          </div>
          {decision ? (
            <form className="inline-form" onSubmit={acknowledge}>
              {decision === 'DISPUTED' ? (
                <FormTransfer
                  formId="asset-discrepancy"
                  fields={[{ key: 'reason', label: 'Discrepancy reason', required: true }]}
                  values={{ reason }}
                  disabled={action.isPending}
                  onImport={(data) => {
                    if (typeof data.reason === 'string') setReason(data.reason);
                  }}
                  description="Load a discrepancy description for review. Submission remains a separate action."
                />
              ) : null}
              {decision === 'DISPUTED' ? (
                <Field label="What needs correcting?" htmlFor="dispute-reason">
                  <textarea
                    id="dispute-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    maxLength={5000}
                  />
                </Field>
              ) : (
                <p>Confirm that these asset details match the equipment you received.</p>
              )}
              <button
                className={buttonClass()}
                disabled={action.isPending || (decision === 'DISPUTED' && !reason.trim())}
              >
                {action.isPending
                  ? 'Saving...'
                  : decision === 'DISPUTED'
                    ? 'Submit discrepancy'
                    : 'Confirm acceptance'}
              </button>
              <button
                type="button"
                className={buttonClass('ghost')}
                onClick={() => setDecision('')}
              >
                Cancel
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <AssetDetailTabs
        summary={
          <div className="stack">
            <Panel title="Asset summary">
              <p className="asset-code">{asset.assetCode}</p>
              <p>{asset.description}</p>
              <Badge value={asset.status} />
              <p className="muted">
                {assignment?.employeeName
                  ? `Assigned to ${assignment.employeeName}`
                  : loc
                    ? `Located at ${locationLabel(loc)}`
                    : 'No current custodian or location'}
              </p>
            </Panel>
            <AssetPhoto key={`summary-${asset.id}`} asset={asset} manage={manage} />
          </div>
        }
        details={
          <div className="detail-grid">
            <Panel title="Asset overview">
              <dl className="details">
                <dt>Asset ID</dt>
                <dd className="mono">{asset.assetCode}</dd>
                <dt>Status</dt>
                <dd>
                  <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
                </dd>
                <dt>Manufacturer / model</dt>
                <dd>
                  {[asset.manufacturer, asset.model].filter(Boolean).join(' / ') || 'Unknown'}
                </dd>
                <dt>Serial number</dt>
                <dd>{asset.serialNumber || 'Unknown'}</dd>
                <dt>Condition</dt>
                <dd>{referenceLabel(refs.data, 'CONDITION', asset.condition)}</dd>
                <dt>Risk level</dt>
                <dd>{referenceLabel(refs.data, 'RISK', asset.riskLevel)}</dd>
                {manage ? (
                  <>
                    <dt>Owning team</dt>
                    <dd>
                      {refs.data?.teams?.find((item) => item.id === asset.owningTeamId)?.name ??
                        'Unknown'}
                    </dd>
                  </>
                ) : null}
                <dt>Department</dt>
                <dd>{department || 'Unknown'}</dd>
                <dt>Location</dt>
                <dd>{loc ? locationLabel(loc) : 'Unknown'}</dd>
                <dt>Ownership</dt>
                <dd>{referenceLabel(refs.data, 'OWNERSHIP', asset.ownershipType)}</dd>
              </dl>
              {asset.configuration ? (
                <div className="subsection">
                  <h3>Configuration</h3>
                  <p className="preserve">{asset.configuration}</p>
                </div>
              ) : null}
            </Panel>
            <div className="stack">
              <AssetPhoto key={asset.id} asset={asset} manage={manage} />
              <Panel title="Current custody">
                {assignment ? (
                  <>
                    <Badge value={assignment.acknowledgement} />
                    <p className="muted">
                      {assignment.assignedAt
                        ? `Assigned ${displayDate(assignment.assignedAt)}`
                        : 'Current assignment recorded'}
                    </p>
                    {manage ? (
                      <div className="custody-person">
                        <strong>{assignment.employeeName || 'Employee name not recorded'}</strong>
                        {assignment.employeeDesignation ? (
                          <span>{assignment.employeeDesignation}</span>
                        ) : null}
                        {assignment.employeeDepartment ? (
                          <span className="muted">{assignment.employeeDepartment}</span>
                        ) : null}
                      </div>
                    ) : null}
                    {assignment.acknowledgedAt ? (
                      <p>Confirmed {displayDate(assignment.acknowledgedAt, true)}</p>
                    ) : null}
                    {manage && !asset.kitParent ? (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setReturning(!returning);
                          setCustodySnapshot(
                            assignment
                              ? { id: assignment.id, version: assignment.version }
                              : undefined,
                          );
                          setCondition(asset.condition ?? '');
                          setLocation(asset.locationId ?? '');
                          setReason('');
                        }}
                      >
                        Record return
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">No current assignment.</p>
                )}
                {returning && assignment ? (
                  <form className="form-stack subsection" onSubmit={returnAsset}>
                    <FormTransfer
                      formId="asset-return"
                      fields={[
                        {
                          key: 'condition',
                          required: true,
                          options: referenceOptions(refs.data, 'CONDITION').map(
                            (item) => item.code,
                          ),
                        },
                        {
                          key: 'locationId',
                          required: true,
                          options:
                            refs.data?.locations
                              .filter((item) => item.active)
                              .map((item) => item.id) ?? [],
                        },
                        { key: 'reason', required: true },
                      ]}
                      values={{ condition, locationId: location, reason }}
                      disabled={action.isPending || refs.isPending || !!refs.error}
                      onImport={(data) => {
                        if (typeof data.condition === 'string') setCondition(data.condition);
                        if (typeof data.locationId === 'string') setLocation(data.locationId);
                        if (typeof data.reason === 'string') setReason(data.reason);
                      }}
                    />
                    <Field label="Returned condition" htmlFor="return-condition">
                      <ReferenceSelect
                        id="return-condition"
                        kind="condition"
                        refs={refs.data}
                        value={condition}
                        onChange={setCondition}
                      />
                    </Field>
                    <Select
                      label="Return location"
                      htmlFor="return-location"
                      value={location}
                      onChange={setLocation}
                      required={true}
                      options={[
                        { value: '', label: 'Select location' },
                        ...(refs.data?.locations
                          .filter((item) => item.active || item.id === location)
                          .map((item) => ({
                            value: item.id,
                            label: `${locationLabel(item)}${!item.active ? ' (inactive)' : ''}`,
                            disabled: !item.active,
                          })) || []),
                      ]}
                    />
                    <Field label="Return reason" htmlFor="return-reason">
                      <textarea
                        id="return-reason"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={5000}
                        required
                      />
                    </Field>
                    <button className="button" disabled={action.isPending || !reason.trim()}>
                      Confirm return
                    </button>
                  </form>
                ) : null}
              </Panel>
              <Panel title="Coverage & dates">
                <dl className="details">
                  <dt>Warranty expires</dt>
                  <dd>{displayDate(asset.warrantyExpiry)}</dd>
                  <dt>AMC</dt>
                  <dd>
                    {asset.amcApplies
                      ? displayDate(asset.amcExpiry)
                      : asset.amcApplies === false
                        ? 'Not applicable'
                        : 'Unknown'}
                  </dd>
                  <dt>Next audit</dt>
                  <dd>{displayDate(asset.nextAuditDate)}</dd>
                </dl>
              </Panel>
            </div>
            {manage ? (
              <Panel title="Finance metadata">
                <p className="muted">
                  Operational records only. Valuations require Finance policy approval.
                </p>
                <dl className="details">
                  <dt>Purchase cost</dt>
                  <dd>{asset.purchaseCost == null ? 'Pending' : `INR ${asset.purchaseCost}`}</dd>
                  <dt>Residual value</dt>
                  <dd>
                    {asset.residualValue == null
                      ? 'Pending Finance input'
                      : `INR ${asset.residualValue}`}
                  </dd>
                  <dt>Purchase date</dt>
                  <dd>{displayDate(asset.purchaseDate)}</dd>
                </dl>
              </Panel>
            ) : null}
            {asset.kitParent ? (
              <Panel title="Kit">
                <p>
                  Part of kit{' '}
                  <Link to={`/assets/${asset.kitParent.id}`}>{asset.kitParent.assetCode}</Link>.
                  Custody changes are made on the kit; detach this item first to move it on its own.
                </p>
              </Panel>
            ) : null}
            <AssetTags asset={asset} canEdit={mayEdit} />
            {mayCustody && !asset.currentAssignment && !asset.kitParent ? (
              <Panel title="Store receiving">
                <p className="muted">Record where an unassigned asset was received.</p>
                <StoreReceiving asset={asset} refs={refs.data} />
              </Panel>
            ) : null}
            {can(user, 'asset.custody', assetTeam) && !asset.kitParent ? (
              <KitPanel asset={asset} />
            ) : null}
            <Panel title="Asset history">
              <Timeline items={asset.timeline ?? []} />
            </Panel>
          </div>
        }
        tickets={
          <Panel title="Tickets">
            <p className="muted">Support requests linked to this asset.</p>
            <Link
              className="button secondary"
              to={`/tickets?assetId=${encodeURIComponent(asset.id)}`}
            >
              View asset tickets
            </Link>
          </Panel>
        }
        users={
          <Panel title="Users">
            {assignment ? (
              <div className="custody-person">
                <strong>{assignment.employeeName || 'Current user not recorded'}</strong>
                {assignment.employeeDesignation ? (
                  <span>{assignment.employeeDesignation}</span>
                ) : null}
                {assignment.employeeDepartment ? (
                  <span className="muted">{assignment.employeeDepartment}</span>
                ) : null}
              </div>
            ) : (
              <p className="muted">No user currently holds this asset.</p>
            )}
          </Panel>
        }
        history={
          <Panel title="History">
            <Timeline items={asset.timeline ?? []} />
          </Panel>
        }
      />
    </>
  );
}
const textFields = [
  ['description', 'Description'],
  ['manufacturer', 'Manufacturer'],
  ['model', 'Model'],
  ['serialNumber', 'Serial number'],
  ['barcode', 'Barcode / QR value'],
] as const;
const dateFields = [
  ['purchaseDate', 'Purchase date'],
  ['capitalisationDate', 'Capitalisation date'],
  ['warrantyExpiry', 'Warranty expiry'],
  ['insuranceExpiry', 'Insurance expiry'],
  ['lastAuditDate', 'Last audit date'],
  ['nextAuditDate', 'Next audit date'],
  ['disposalDate', 'Disposal date'],
] as const;
const assetEditableFields = [
  ...textFields.map(([key]) => key),
  ...dateFields.map(([key]) => key),
  'category',
  'assetType',
  'ownershipType',
  'status',
  'condition',
  'riskLevel',
  'departmentId',
  'locationId',
  'configuration',
  'graphics',
  'amcExpiry',
  'purchaseCost',
  'residualValue',
  'usefulLifeYears',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'disposalMethod',
  'depreciationMethod',
  'commentType',
  'dataWipeRequired',
  'disposalReference',
  'remarks',
];
const assetReferenceKinds: Record<string, string> = {
  category: 'CATEGORY',
  assetType: 'ASSET_TYPE',
  ownershipType: 'OWNERSHIP',
  status: 'STATUS',
  condition: 'CONDITION',
  riskLevel: 'RISK',
  disposalMethod: 'DISPOSAL_METHOD',
  depreciationMethod: 'DEPRECIATION_METHOD',
  commentType: 'COMMENT_TYPE',
  dataWipeRequired: 'DATA_WIPE',
};
export function AssetEditor() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['asset', id],
    queryFn: () => api<Asset>(`/assets/${id}`),
    enabled: !!id,
  });
  if (id && query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return <AssetEditForm asset={query.data} key={id ?? 'new'} />;
}
const financeKeys = new Set([
  'purchaseDate',
  'capitalisationDate',
  'purchaseCost',
  'currency',
  'residualValue',
  'depreciationMethod',
  'usefulLifeYears',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'insuranceExpiry',
  'financePending',
]);
function AssetEditForm({ asset }: { asset?: Asset }) {
  const [baseline] = useState(asset);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useReferences();
  const { user } = useSession();
  const action = useAction<Asset>();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const data: Record<string, string> = {
      status: 'In Store',
      category: '',
      ownershipType: '',
      condition: '',
      riskLevel: '',
      assetType: '',
      description: '',
      reason: '',
    };
    if (asset)
      Object.entries(asset).forEach(([name, value]) => {
        if (typeof value === 'string' || typeof value === 'number') data[name] = String(value);
      });
    return data;
  });
  const [amc, setAmc] = useState(asset?.amcApplies ?? false);
  const [validation, setValidation] = useState('');
  // Invoice chosen on the Create form: read now to fill the finance values, attached after saving.
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoiceReading, setInvoiceReading] = useState(false);
  const [invoiceNote, setInvoiceNote] = useState<{ tone: 'info' | 'warning'; text: string } | null>(
    null,
  );
  const [savedWithoutInvoice, setSavedWithoutInvoice] = useState<Asset | null>(null);
  const [savedWithoutAssignment, setSavedWithoutAssignment] = useState<{
    asset: Asset;
    personName: string;
    transfer: boolean;
    message: string;
  } | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState(asset?.currentAssignment?.employeeName ?? '');
  const [assigneeQuery, setAssigneeQuery] = useState(asset?.currentAssignment?.employeeName ?? '');
  const [pickedAssignee, setPickedAssignee] = useState<AssignablePerson>();
  // An invoice billed in another currency: the register is kept in INR, so the amount is
  // converted with a rate the person enters rather than copied across as if it were rupees.
  const [foreignTotal, setForeignTotal] = useState<{ currency: string; amount: string } | null>(
    null,
  );
  const [exchangeRate, setExchangeRate] = useState('');
  const set = (name: string, value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  const teams = refs.data?.teams ?? [];
  const createTeams = teams.filter((item) => item.active && can(user, 'asset.create', item.id));
  // A single permitted team is preselected for a new asset.
  const teamId =
    values.owningTeamId || (!baseline && createTeams.length === 1 ? createTeams[0].id : '');
  const selectedTeam = teams.find((item) => item.id === teamId);
  const allowedCategories = (refs.data?.categoryPolicies ?? []).filter(
    (policy) =>
      (!!selectedTeam && policy.teamIds.includes(teamId)) ||
      (selectedTeam?.code === 'PRJ' &&
        policy.teamIds.includes(teams.find((t) => t.code === 'ADM')?.id ?? '')),
  );
  // Finance fields: Finance, or a member of this asset's team (approval stays with Finance).
  const canFinance = can(user, 'asset.edit_finance', teamId || undefined);
  const canAssignCustody = can(user, 'asset.custody', teamId || undefined);
  const assignmentStatus = ['Assigned', 'In Use'].includes(values.status ?? '');
  const canChangeTeam = !!baseline && can(user, 'asset.change_team');
  // Finance without asset.edit for this team may change only the finance fields.
  const financeOnly =
    !!baseline && canFinance && !can(user, 'asset.edit', baseline.owningTeamId ?? undefined);
  const depreciationMethods = useQuery({
    queryKey: ['depreciation-methods'],
    queryFn: ({ signal }) => api<{ items: Array<{
      code: string; label: string; active: boolean; teamId: string | null; categoryCode: string | null;
      teamName: string | null; categoryLabel: string | null;
    }> }>('/depreciation/methods', { signal }),
    enabled: canFinance,
  });
  const vendors = useQuery({
    queryKey: ['vendor-names'],
    queryFn: ({ signal }) => api<{ items: { id: string; name: string }[] }>('/vendors/names', { signal }),
    enabled: canFinance,
    staleTime: 300_000,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => setAssigneeQuery(assigneeSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [assigneeSearch]);
  const assignablePeople = useQuery({
    queryKey: ['asset-editor-assignable-people', baseline?.id, assigneeQuery],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(
        `${baseline ? `/assets/${baseline.id}/assignable-people` : '/assignable-people'}?limit=25${assigneeQuery ? `&q=${encodeURIComponent(assigneeQuery)}` : ''}`,
        { signal },
      ),
    enabled: assignmentStatus && canAssignCustody,
  });
  const selectedAssignee =
    pickedAssignee ??
    assignablePeople.data?.items.find((person) => person.id === baseline?.currentAssignment?.userId);
  const supplierNames = (vendors.data?.items ?? []).map((vendor) => vendor.name);
  const supplierOptions = [
    { value: '', label: 'Select supplier' },
    ...(values.supplier && !supplierNames.includes(values.supplier)
      ? [{ value: values.supplier, label: values.supplier }]
      : []),
    ...supplierNames.map((name) => ({ value: name, label: name })),
  ];
  const applicableDepreciationMethods = (depreciationMethods.data?.items ?? [])
    .filter((method) => method.active && (!method.teamId || method.teamId === teamId) &&
      (!method.categoryCode || method.categoryCode === values.category))
    .sort((a, b) => {
      const aSpecificity = Number(!!a.teamId) + 2 * Number(!!a.categoryCode);
      const bSpecificity = Number(!!b.teamId) + 2 * Number(!!b.categoryCode);
      return bSpecificity - aSpecificity || a.label.localeCompare(b.label);
    });
  const suggestedDepreciationMethod = applicableDepreciationMethods[0]?.code;
  useEffect(() => {
    if (!suggestedDepreciationMethod) return;
    setValues((current) => current.depreciationMethod
      ? current
      : { ...current, depreciationMethod: suggestedDepreciationMethod });
  }, [teamId, values.category, suggestedDepreciationMethod]);
  const lockedStyle = { display: 'contents' } as const;
  const roomHeld =
    refs.data?.assetTypePolicies?.find((item) => item.assetTypeCode === values.assetType)
      ?.requiresCustodian === false;
  const blocked = !financeOnly && ((!baseline && !teamId) || (roomHeld && !values.locationId));
  const editableFields = assetEditableFields.filter((key) => canFinance || !financeKeys.has(key));
  const lockFinance = (name: string) => !canFinance && financeKeys.has(name);
  const mayAttachInvoice =
    !baseline && (canFinance || (!!teamId && can(user, 'asset.edit', teamId)));
  async function chooseInvoice(file: File | undefined) {
    setInvoiceNote(null);
    setInvoiceFile(null);
    setForeignTotal(null);
    setExchangeRate('');
    if (!file) return;
    if (file.size > INVOICE_MAX_BYTES) {
      setInvoiceNote({ tone: 'warning', text: 'Choose a file up to 10 MB.' });
      return;
    }
    setInvoiceFile(file);
    if (!canFinance) {
      setInvoiceNote({
        tone: 'info',
        text: 'The invoice will be attached when you create the asset. Finance fills in the values from it.',
      });
      return;
    }
    setInvoiceReading(true);
    try {
      const { fields } = await api<{ fields: InvoiceMeta['fields'] }>('/invoices/preview', {
        method: 'POST',
        body: { dataUrl: await readDataUrl(file), fileName: file.name },
      });
      const currency = fields.currency?.value;
      const foreign = !!currency && currency !== 'INR' && !!fields.totalAmount;
      if (foreign) setForeignTotal({ currency, amount: fields.totalAmount!.value });
      const proposals: [string, string, string | undefined][] = [
        ['purchaseCost', 'purchase cost', foreign ? undefined : fields.totalAmount?.value],
        ['invoiceNumber', 'invoice number', fields.invoiceNumber?.value],
        ['supplier', 'supplier', fields.supplier?.value],
        ['purchaseDate', 'purchase date', fields.invoiceDate?.value],
      ];
      // Never overwrite something the person already typed.
      const fill = proposals.filter(([name, , value]) => value && !values[name]?.trim());
      setValues((current) => ({
        ...current,
        ...Object.fromEntries(fill.map(([name, , value]) => [name, value as string])),
      }));
      setInvoiceNote(
        fill.length || foreign
          ? fill.length
            ? {
                tone: 'info',
                text: `Filled from the invoice: ${fill.map(([, label]) => label).join(', ')}. Check each value before saving.`,
              }
            : null
          : {
              tone: 'warning',
              text: 'No new values could be read from this invoice. Enter them by hand; the file will still be attached.',
            },
      );
    } catch (error) {
      setInvoiceNote({
        tone: 'warning',
        text: `${error instanceof Error ? error.message : 'The invoice could not be read'}. Enter the values by hand; the file will still be attached.`,
      });
    } finally {
      setInvoiceReading(false);
    }
  }
  function fillDemo() {
    const firstCode = (kind: string) => referenceOptions(refs.data, kind)[0]?.code ?? '';
    const demo: Record<string, string> = {
      description: 'Demo laptop — Dell Latitude 5540 (sample record)',
      manufacturer: 'Dell',
      model: 'Latitude 5540',
      serialNumber: 'DL5540-DEMO-001',
      barcode: 'IAC-DEMO-0001',
      category: firstCode('CATEGORY'),
      assetType: firstCode('ASSET_TYPE'),
      ownershipType: firstCode('OWNERSHIP'),
      status: 'In Store',
      condition: firstCode('CONDITION'),
      riskLevel: firstCode('RISK'),
      departmentId: refs.data?.departments.find((item) => item.active)?.id ?? '',
      locationId: refs.data?.locations.find((item) => item.active)?.id ?? '',
      configuration: 'Intel Core i7-1355U · 16 GB RAM · 512 GB NVMe SSD · Windows 11 Pro',
      purchaseDate: '2024-04-15',
      capitalisationDate: '2024-05-01',
      warrantyExpiry: '2027-04-15',
      insuranceExpiry: '2027-03-31',
      lastAuditDate: '2025-06-15',
      nextAuditDate: '2026-12-15',
      disposalDate: '2026-01-10',
      disposalMethod: firstCode('DISPOSAL_METHOD'),
      dataWipeRequired: firstCode('DATA_WIPE'),
      disposalReference: 'DEMO-DISPOSAL-REF-001',
      amcExpiry: '2027-04-15',
      purchaseCost: '45999.00',
      residualValue: '12000',
      invoiceNumber: 'INV-DEMO-2024-0415',
      supplier: 'Demo Technologies Pvt Ltd',
      insurancePolicyNumber: 'POL-DEMO-88421',
      depreciationMethod: 'SLM',
      usefulLifeYears: '5',
      commentType: firstCode('COMMENT_TYPE'),
      remarks: 'Sample record created with Fill demo values. Safe to edit or discard.',
    };
    // Only Finance may fill finance fields, so leave them out for everyone else.
    const allowed = Object.fromEntries(Object.entries(demo).filter(([key]) => !lockFinance(key)));
    setValues((current) => ({ ...current, ...allowed }));
    setAmc(true);
    setValidation('');
    action.reset();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation('');
    if ((!financeOnly && !values.description.trim()) || (baseline && !values.reason?.trim())) {
      setValidation('Description and change reason must contain text.');
      return;
    }
    if (assignmentStatus && !baseline?.currentAssignment?.userId && !selectedAssignee) {
      setValidation(
        canAssignCustody
          ? 'Choose an assignee before saving an asset as Assigned.'
          : 'You need asset custody permission to assign this asset.',
      );
      return;
    }
    if (
      assignmentStatus &&
      baseline?.currentAssignment?.userId &&
      selectedAssignee &&
      selectedAssignee.id !== baseline.currentAssignment.userId &&
      !canAssignCustody
    ) {
      setValidation('You need asset custody permission to change this assignee.');
      return;
    }
    const body: Record<string, unknown> = {};
    const allowed = [
      'category',
      'assetType',
      'description',
      'manufacturer',
      'model',
      'serialNumber',
      'barcode',
      'configuration',
      'graphics',
      'ownershipType',
      'departmentId',
      'locationId',
      'status',
      'condition',
      'riskLevel',
      'warrantyExpiry',
      'amcExpiry',
      'purchaseDate',
      'capitalisationDate',
      'purchaseCost',
      'residualValue',
      'usefulLifeYears',
      'invoiceNumber',
      'supplier',
      'insurancePolicyNumber',
      'insuranceExpiry',
      'lastAuditDate',
      'nextAuditDate',
      'disposalDate',
      'disposalMethod',
      'depreciationMethod',
      'commentType',
      'dataWipeRequired',
      'disposalReference',
      'remarks',
    ];
    if (blocked) {
      setValidation(
        roomHeld && !values.locationId
          ? 'This asset type is kept in a room. Choose a location.'
          : 'Choose the owning team.',
      );
      return;
    }
    if (financeOnly && baseline) {
      for (const name of allowed) {
        if (!financeKeys.has(name)) continue;
        const next = (values[name] ?? '').trim();
        const raw = baseline[name];
        const before =
          raw == null
            ? ''
            : String(raw).slice(
                0,
                name.endsWith('Date') || name.endsWith('Expiry') ? 10 : undefined,
              );
        if (next !== before)
          body[name] = name === 'usefulLifeYears' ? (next ? Number(next) : null) : next || null;
      }
      body.reason = values.reason.trim();
      const sent = await action
        .mutateAsync({
          path: `/assets/${baseline.id}`,
          method: 'PATCH',
          body,
          version: baseline.version,
        })
        .catch(() => undefined);
      if (sent) navigate(`/assets/${sent.id}`);
      return;
    }
    if (!baseline) body.owningTeamId = teamId;
    else if (canChangeTeam && teamId !== baseline.owningTeamId) body.owningTeamId = teamId;
    for (const name of allowed) {
      if (lockFinance(name)) continue;
      const value = values[name];
      if (value?.trim()) body[name] = name === 'usefulLifeYears' ? Number(value) : value.trim();
      else if (
        baseline &&
        baseline[name] != null &&
        ![
          'category',
          'assetType',
          'description',
          'ownershipType',
          'status',
          'condition',
          'riskLevel',
        ].includes(name)
      )
        body[name] = null;
    }
    const needsAssignment =
      assignmentStatus && !!selectedAssignee &&
      selectedAssignee.id !== baseline?.currentAssignment?.userId;
    // Custody is recorded by the assignment endpoint, which changes status to In Use.
    if (needsAssignment && !baseline?.currentAssignment?.userId) body.status = 'In Store';
    body.amcApplies = amc;
    if (!amc) body.amcExpiry = null;
    if (baseline) body.reason = values.reason.trim();
    const result = await action
      .mutateAsync({
        path: baseline ? `/assets/${baseline.id}` : '/assets',
        method: baseline ? 'PATCH' : 'POST',
        body,
        version: baseline?.version,
        idempotent: !baseline,
      })
      .catch(() => undefined);
    if (!result) return;
    if (!baseline && invoiceFile) {
      try {
        await api(`/assets/${result.id}/invoices`, {
          method: 'POST',
          body: { dataUrl: await readDataUrl(invoiceFile), fileName: invoiceFile.name },
        });
      } catch {
        // The asset exists now; do not let a second save create a duplicate.
        setSavedWithoutInvoice(result);
        return;
      }
    }
    if (needsAssignment && selectedAssignee) {
      const transfer = !!baseline?.currentAssignment?.userId;
      try {
        await api(`/assets/${result.id}/${transfer ? 'reassign' : 'assignments'}`, {
          method: 'POST',
          version: result.version,
          idempotencyKey: crypto.randomUUID(),
          body: transfer
            ? { userId: selectedAssignee.id, reason: values.reason.trim() }
            : { userId: selectedAssignee.id, note: baseline ? values.reason.trim() : 'Assigned during asset setup' },
        });
      } catch (error) {
        setSavedWithoutAssignment({
          asset: result,
          personName: selectedAssignee.displayName,
          transfer,
          message: error instanceof Error ? error.message : 'The assignment could not be completed.',
        });
        return;
      }
    }
    // The assignment above changed the asset after the save, so drop any copy loaded in between
    // (otherwise the asset page would show the old status and no holder until refreshed).
    await queryClient.invalidateQueries({ queryKey: ['asset', result.id] });
    void queryClient.invalidateQueries({ queryKey: ['/assets'] });
    navigate(`/assets/${result.id}`);
  }
  if (savedWithoutInvoice)
    return (
      <Panel title="Asset created">
        <div className={noticeClass('warning')} role="alert">
          {savedWithoutInvoice.assetCode} was created, but the invoice could not be attached. Open
          the asset and upload the invoice again from its Finance &amp; invoices section.
        </div>
        <p className="mt-4">
          <Link className={buttonClass()} to={`/assets/${savedWithoutInvoice.id}`}>
            Open {savedWithoutInvoice.assetCode}
          </Link>
        </p>
      </Panel>
    );
  if (savedWithoutAssignment)
    return (
      <Panel title="Asset saved">
        <div className={noticeClass('warning')} role="alert">
          {savedWithoutAssignment.asset.assetCode} was saved, but assignment to {savedWithoutAssignment.personName} did not finish: {savedWithoutAssignment.message}
        </div>
        <div className={actionsClass}>
          <Link className={buttonClass()} to={`/assets/${savedWithoutAssignment.asset.id}/assign${savedWithoutAssignment.transfer ? '?transfer=1' : ''}`}>
            Continue assignment
          </Link>
          <Link className={buttonClass('secondary')} to={`/assets/${savedWithoutAssignment.asset.id}`}>
            Open asset
          </Link>
        </div>
      </Panel>
    );
  return (
    <>
      <Link className={backLinkClass} to={baseline ? `/assets/${baseline.id}` : '/assets'}>
        ← Back to asset
      </Link>
      <PageTitle
        title={baseline ? 'Edit asset' : 'Create an asset'}
        description={
          baseline
            ? `${baseline.assetCode} · The Asset ID is permanent.`
            : 'Add an item to the register. Its permanent Asset ID is assigned automatically.'
        }
        action={
          // Sample data is a development aid only; never shown in the live app.
          !baseline && import.meta.env.DEV ? (
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={fillDemo}
              disabled={refs.isPending || !!refs.error}
              title="Fill every field with sample data"
            >
              Fill demo values
            </button>
          ) : undefined
        }
      />
      <FormTransfer
        formId={baseline ? 'asset-edit' : 'asset-create'}
        fields={[
          ...editableFields.map((key) => {
            const kind = assetReferenceKinds[key];
            let options = kind
              ? referenceOptions(refs.data, kind).map((item) => item.code)
              : undefined;
            if (key === 'departmentId')
              options =
                refs.data?.departments.filter((item) => item.active).map((item) => item.id) ?? [];
            if (key === 'locationId')
              options =
                refs.data?.locations.filter((item) => item.active).map((item) => item.id) ?? [];
            if (options && typeof baseline?.[key] === 'string' && !options.includes(baseline[key]))
              options = [...options, baseline[key]];
            return {
              key,
              required: [
                'description',
                'category',
                'assetType',
                'ownershipType',
                'status',
                'condition',
                'riskLevel',
              ].includes(key),
              ...(options ? { options } : {}),
            };
          }),
          { key: 'amcApplies', label: 'AMC applies', type: 'boolean' },
          ...(baseline ? [{ key: 'reason', label: 'Change reason', required: true }] : []),
        ]}
        values={{ ...values, amcApplies: amc }}
        disabled={action.isPending || refs.isPending || !!refs.error}
        description="Load editable fields for review, then use the normal Save action. The selected asset and its permanent Asset ID are unchanged."
        onImport={(data) => {
          const editable = [...editableFields, ...(baseline ? ['reason'] : [])];
          setValues((previous) => ({
            ...previous,
            ...Object.fromEntries(
              editable
                .filter((key) => typeof data[key] === 'string')
                .map((key) => [key, data[key] as string]),
            ),
          }));
          if (typeof data.amcApplies === 'boolean') setAmc(data.amcApplies);
          setValidation('');
          action.reset();
        }}
      />
      <form onSubmit={submit} className={formStackClass}>
        <ErrorNotice error={action.error} retry={() => window.location.reload()} />
        <ErrorNotice
          error={refs.error}
          retry={() => {
            void refs.refetch();
          }}
        />
        {validation ? (
          <div className={noticeClass('danger')} role="alert">
            {validation}
          </div>
        ) : null}
        <fieldset
          disabled={financeOnly}
          style={lockedStyle}
          className="m-0 grid min-w-0 gap-6 border-0 p-0"
        >
          <Panel title="Identity & configuration" className="col-span-full">
            {roomHeld ? (
              <p className={noticeClass()} role="note">
                A location is required because this asset type is held in a room.
              </p>
            ) : null}
            <div className="form-grid">
              <Select
                label="Owning team"
                htmlFor="owningTeamId"
                value={teamId}
                onChange={(value) => {
                  setValues((current) => ({
                    ...current,
                    owningTeamId: value,
                    category: '',
                    assetType: '',
                    depreciationMethod: '',
                  }));
                }}
                disabled={!!baseline && !canChangeTeam}
                required
                hint={
                  !baseline && selectedTeam
                    ? `IAC-${selectedTeam.assetCodePrefix}-…`
                    : baseline
                      ? `Asset code ${baseline.assetCode} stays the same if the team changes.`
                      : undefined
                }
                options={[
                  { value: '', label: 'Select team' },
                  ...(baseline
                    ? teams.filter((t) => t.active || t.id === teamId)
                    : createTeams
                  ).map((item) => ({ value: item.id, label: `${item.name} (${item.code})` })),
                ]}
              />
              {textFields.map(([name, label]) => (
                <Field key={name} label={label} htmlFor={name}>
                  <input
                    id={name}
                    value={values[name] ?? ''}
                    onChange={(event) => set(name, event.target.value)}
                    required={name === 'description'}
                    maxLength={name === 'description' ? 2000 : 200}
                  />
                </Field>
              ))}
              {['ownershipType', 'status', 'condition', 'riskLevel'].map((name) => (
                <Field
                  key={name}
                  label={
                    {
                      category: 'Category',
                      ownershipType: 'Ownership type',
                      status: 'Status',
                      condition: 'Condition',
                      riskLevel: 'Risk level',
                    }[name] ?? name
                  }
                  htmlFor={name}
                >
                  <ReferenceSelect
                    refs={refs.data}
                    kind={name}
                    id={name}
                    value={values[name] ?? ''}
                    onChange={(value) => set(name, value)}
                    preserveCurrent={!!baseline}
                  />
                </Field>
              ))}
              <Field label="Category" htmlFor="category">
                <Select
                  label=""
                  htmlFor="category"
                  value={values.category ?? ''}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, category: value, assetType: '', depreciationMethod: '' }))
                  }
                  required
                  options={[
                    { value: '', label: 'Select category' },
                    ...allowedCategories
                      .filter((policy) =>
                        refs.data?.values.some(
                          (v) =>
                            v.kind === 'CATEGORY' && v.code === policy.categoryCode && v.active,
                        ),
                      )
                      .map((policy) => ({
                        value: policy.categoryCode,
                        label:
                          refs.data?.values.find(
                            (v) => v.kind === 'CATEGORY' && v.code === policy.categoryCode,
                          )?.label ?? policy.categoryCode,
                      })),
                    ...(baseline &&
                    values.category &&
                    !allowedCategories.some((p) => p.categoryCode === values.category)
                      ? [
                          {
                            value: values.category,
                            label:
                              refs.data?.values.find(
                                (v) => v.kind === 'CATEGORY' && v.code === values.category,
                              )?.label ?? values.category,
                          },
                        ]
                      : []),
                  ]}
                />
              </Field>
              {/* Asset type is filtered by the chosen owning team's type→team mapping. */}
              <Field key="assetType" label="Asset type" htmlFor="assetType">
                <Select
                  label=""
                  htmlFor="assetType"
                  value={values.assetType ?? ''}
                  onChange={(value) => set('assetType', value)}
                  required
                  options={[
                    { value: '', label: 'Select asset type' },
                    ...(refs.data?.assetTypePolicies ?? [])
                      .filter((policy) => {
                        if (policy.categoryCode !== values.category) return false;
                        if (!selectedTeam) return false;
                        if (policy.owningTeamId === selectedTeam.id) return true;
                        // Projects may use Admin's facility types for grant purchases.
                        if (
                          selectedTeam.code === 'PRJ' &&
                          policy.owningTeamId === teams.find((t) => t.code === 'ADM')?.id
                        )
                          return true;
                        return false;
                      })
                      .filter((policy) => {
                        const ref = refs.data?.values.find(
                          (v) => v.kind === 'ASSET_TYPE' && v.code === policy.assetTypeCode,
                        );
                        return ref?.active ?? false;
                      })
                      .map((policy) => {
                        const ref = refs.data?.values.find(
                          (v) => v.kind === 'ASSET_TYPE' && v.code === policy.assetTypeCode,
                        );
                        return {
                          value: policy.assetTypeCode,
                          label: ref?.label ?? policy.assetTypeCode,
                        };
                      }),
                    // When editing, keep the current type selectable even if the mapping changed.
                    ...(baseline && baseline.assetType
                      ? [
                          {
                            value: baseline.assetType,
                            label:
                              refs.data?.values.find(
                                (v) => v.kind === 'ASSET_TYPE' && v.code === baseline.assetType,
                              )?.label ?? baseline.assetType,
                          },
                        ]
                      : []),
                  ]}
                />
              </Field>
              <Select
                label="Department"
                htmlFor="departmentId"
                value={values.departmentId ?? ''}
                onChange={(value) => set('departmentId', value)}
                options={[
                  { value: '', label: 'Not set' },
                  ...(refs.data?.departments
                    .filter((item) => item.active || item.id === values.departmentId)
                    .map((item) => ({
                      value: item.id,
                      label: `${item.name}${!item.active ? ' (inactive)' : ''}`,
                      disabled: !item.active,
                    })) || []),
                ]}
              />
              <Select
                label="Location"
                htmlFor="locationId"
                value={values.locationId ?? ''}
                onChange={(value) => set('locationId', value)}
                options={[
                  { value: '', label: 'Not set' },
                  ...(refs.data?.locations
                    .filter((item) => item.active || item.id === values.locationId)
                    .map((item) => ({
                      value: item.id,
                      label: `${locationLabel(item)}${!item.active ? ' (inactive)' : ''}`,
                      disabled: !item.active,
                    })) || []),
                ]}
              />
            </div>
            {assignmentStatus ? (
              <div className="mt-5">
                {canAssignCustody ? (
                  <>
                    <PersonPicker
                      label="Assignee"
                      people={assignablePeople.data?.items ?? []}
                      loading={assignablePeople.isFetching}
                      search={assigneeSearch}
                      onSearch={setAssigneeSearch}
                      selected={selectedAssignee}
                      onSelect={(person) => {
                        setPickedAssignee(person);
                        if (!person) setAssigneeSearch('');
                      }}
                      disabled={action.isPending || !!assignablePeople.error}
                    />
                    {assignablePeople.error ? (
                      <p className="mt-1 text-sm text-red-700">Could not load eligible assignees. Refresh and retry.</p>
                    ) : null}
                  </>
                ) : (
                  <p className={noticeClass('warning')} role="note">
                    Asset custody permission is required to choose an assignee.
                  </p>
                )}
              </div>
            ) : null}
            <Field label="Configuration" htmlFor="configuration">
              <textarea
                id="configuration"
                value={values.configuration ?? ''}
                onChange={(event) => set('configuration', event.target.value)}
                maxLength={5000}
              />
            </Field>
          </Panel>
        </fieldset>
        <Panel title="Dates & coverage">
          <div className="form-grid">
            {dateFields.map(([name, label]) => (
              <Field key={name} label={label} htmlFor={name}>
                <input
                  type="date"
                  id={name}
                  value={values[name]?.slice(0, 10) ?? ''}
                  onChange={(event) => set(name, event.target.value)}
                  readOnly={lockFinance(name)}
                  disabled={financeOnly && !financeKeys.has(name)}
                />
              </Field>
            ))}
            <fieldset
              disabled={financeOnly}
              style={lockedStyle}
              className="m-0 grid min-w-0 gap-6 border-0 p-0"
            >
              <Field label="Disposal method" htmlFor="disposalMethod">
                <ReferenceSelect
                  refs={refs.data}
                  kind="DISPOSAL_METHOD"
                  id="disposalMethod"
                  value={values.disposalMethod ?? ''}
                  onChange={(value) => set('disposalMethod', value)}
                  required={false}
                  preserveCurrent={!!baseline}
                />
              </Field>
              <Field label="Data wipe required" htmlFor="dataWipeRequired">
                <ReferenceSelect
                  refs={refs.data}
                  kind="DATA_WIPE"
                  id="dataWipeRequired"
                  value={values.dataWipeRequired ?? ''}
                  onChange={(value) => set('dataWipeRequired', value)}
                  required={false}
                  preserveCurrent={!!baseline}
                />
              </Field>
              <Field
                label="Disposal evidence / reference"
                htmlFor="disposalReference"
                hint="Required with disposal date for terminal status changes."
              >
                <input
                  id="disposalReference"
                  value={values.disposalReference ?? ''}
                  onChange={(event) => set('disposalReference', event.target.value)}
                />
              </Field>
              <Checkbox label="AMC applies to this asset" checked={amc} onChange={setAmc} />
              {amc ? (
                <Field
                  label="AMC expiry"
                  htmlFor="amcExpiry"
                  hint="Independent of the warranty expiry."
                >
                  <input
                    type="date"
                    id="amcExpiry"
                    value={values.amcExpiry?.slice(0, 10) ?? ''}
                    onChange={(event) => set('amcExpiry', event.target.value)}
                    required
                  />
                </Field>
              ) : null}
            </fieldset>
          </div>
        </Panel>
        <Panel title="Financial metadata">
          <p className="muted">
            {canFinance
              ? 'Leave unknown values blank. Upload the invoice to fill what it can.'
              : 'Finance fills in these values. They are shown read-only.'}
          </p>
          {mayAttachInvoice ? (
            <div className="mb-4 grid gap-2">
              <Field
                label="Invoice (PDF, JPEG or PNG, up to 10 MB)"
                htmlFor="create-invoice"
                hint={
                  canFinance
                    ? 'Cost, invoice number, supplier and purchase date are read from the file. Only empty fields are filled.'
                    : undefined
                }
              >
                <input
                  id="create-invoice"
                  type="file"
                  accept={INVOICE_ACCEPT}
                  className={fileInputClass}
                  disabled={invoiceReading || action.isPending}
                  onChange={(event) => void chooseInvoice(event.target.files?.[0])}
                />
              </Field>
              {invoiceReading ? (
                <div className={noticeClass()} role="status">
                  Reading invoice…
                </div>
              ) : invoiceNote ? (
                <div className={noticeClass(invoiceNote.tone)} role="status">
                  {invoiceNote.text}
                </div>
              ) : null}
              {foreignTotal && !invoiceReading ? (
                <div className={noticeClass('warning')} role="status">
                  <p>
                    This invoice is in {foreignTotal.currency}: the total is{' '}
                    <strong>
                      {foreignTotal.currency} {foreignTotal.amount}
                    </strong>
                    . The register is kept in INR, so the amount was not copied into Purchase cost.
                    Enter the exchange rate that was paid and the INR cost is worked out for you.
                  </p>
                  <div className="mt-3 max-w-xs">
                    <Field
                      label={`Exchange rate (INR for 1 ${foreignTotal.currency})`}
                      htmlFor="invoice-exchange-rate"
                    >
                      <input
                        id="invoice-exchange-rate"
                        inputMode="decimal"
                        value={exchangeRate}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setExchangeRate(raw);
                          const rate = Number(raw);
                          if (raw.trim() && Number.isFinite(rate) && rate > 0)
                            set('purchaseCost', (Number(foreignTotal.amount) * rate).toFixed(2));
                        }}
                      />
                    </Field>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <fieldset disabled={!canFinance} className="form-grid" data-testid="finance-fields">
            <Field label="Depreciation method" htmlFor="depreciationMethod">
              <Select
                label=""
                htmlFor="depreciationMethod"
                value={values.depreciationMethod ?? ''}
                onChange={(value) => set('depreciationMethod', value)}
                disabled={depreciationMethods.isPending}
                options={[
                  { value: '', label: 'Not set' },
                  ...(values.depreciationMethod && !applicableDepreciationMethods.some((method) => method.code === values.depreciationMethod)
                    ? [{ value: values.depreciationMethod, label: `${values.depreciationMethod} (current)` }]
                    : []),
                  ...applicableDepreciationMethods.map((method) => ({
                    value: method.code,
                    label: `${method.label}${method.categoryLabel ? ` · ${method.categoryLabel}` : ''}${method.teamName ? ` · ${method.teamName}` : ''}`,
                  })),
                ]}
              />
              {depreciationMethods.error ? <p className="text-sm text-red-700">Could not load methods. Refresh and retry.</p> : null}
              {can(user, 'depreciation.manage_methods') ? (
                <Link className="muted small-text" to="/depreciation/settings">Manage depreciation methods</Link>
              ) : null}
            </Field>
            <Field label="Useful life (years)" htmlFor="usefulLifeYears">
              <input
                id="usefulLifeYears"
                type="number"
                min="1"
                max="100"
                step="1"
                value={values.usefulLifeYears ?? ''}
                onChange={(event) => set('usefulLifeYears', event.target.value)}
              />
            </Field>
            {[
              ['purchaseCost', 'Purchase cost incl. GST (INR)'],
              ['residualValue', 'Residual value (INR)'],
              ['invoiceNumber', 'Invoice number'],
            ].map(([name, label]) => (
              <Field
                key={name}
                label={label}
                htmlFor={name}
                hint={
                  name === 'purchaseCost'
                    ? 'The invoice total including GST, as in the finance fixed asset register (IAC cannot claim GST back).'
                    : undefined
                }
              >
                <input
                  id={name}
                  value={values[name] ?? ''}
                  onChange={(event) => set(name, event.target.value)}
                  inputMode={name === 'purchaseCost' || name === 'residualValue' ? 'decimal' : 'text'}
                  pattern={
                    name === 'purchaseCost' || name === 'residualValue'
                      ? '[0-9]+([.][0-9]{1,2})?'
                      : undefined
                  }
                />
              </Field>
            ))}
            <Field label="Supplier" htmlFor="supplier">
              <Select
                label=""
                htmlFor="supplier"
                value={values.supplier ?? ''}
                onChange={(value) => set('supplier', value)}
                disabled={!canFinance || vendors.isPending}
                options={supplierOptions}
              />
            </Field>
            <Field label="Insurance policy number" htmlFor="insurancePolicyNumber">
              <input
                id="insurancePolicyNumber"
                value={values.insurancePolicyNumber ?? ''}
                onChange={(event) => set('insurancePolicyNumber', event.target.value)}
              />
            </Field>
          </fieldset>
        </Panel>
        <Panel title="Notes & accountability">
          <fieldset
            disabled={financeOnly}
            style={lockedStyle}
            className="m-0 grid min-w-0 gap-6 border-0 p-0"
          >
            <Field label="Comment type" htmlFor="commentType">
              <ReferenceSelect
                refs={refs.data}
                kind="COMMENT_TYPE"
                id="commentType"
                value={values.commentType ?? ''}
                onChange={(value) => set('commentType', value)}
                required={false}
                preserveCurrent={!!baseline}
              />
            </Field>
            <Field label="Remarks" htmlFor="remarks">
              <textarea
                id="remarks"
                value={values.remarks ?? ''}
                onChange={(event) => set('remarks', event.target.value)}
                maxLength={5000}
              />
            </Field>
          </fieldset>
          {baseline ? (
            <Field label="Reason for this change" htmlFor="reason">
              <textarea
                id="reason"
                value={values.reason ?? ''}
                onChange={(event) => set('reason', event.target.value)}
                required
                maxLength={5000}
              />
            </Field>
          ) : null}
        </Panel>
        <div className="form-actions">
          <Link
            className={buttonClass('secondary')}
            to={baseline ? `/assets/${baseline.id}` : '/assets'}
          >
            Cancel
          </Link>
          <button
            className={buttonClass()}
            disabled={action.isPending || refs.isPending || !!refs.error || blocked}
          >
            {action.isPending ? 'Saving...' : baseline ? 'Save changes' : 'Create asset'}
          </button>
        </div>
      </form>
    </>
  );
}
export function AssignmentForm() {
  const refs = useReferences();
  const { id } = useParams();
  const [params] = useSearchParams();
  const transfer = params.get('transfer') === '1';
  const navigate = useNavigate();
  const asset = useQuery({ queryKey: ['asset', id], queryFn: () => api<Asset>(`/assets/${id}`) });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  // Server-side eligible people (active employees and Zoho directory people), searchable.
  const employees = usePages<AssignablePerson>(
    `/assets/${id}/assignable-people`,
    { q: query || undefined },
    !!id,
  );
  const [picked, setPicked] = useState<AssignablePerson>();
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const listed =
    employees.data?.pages
      .flatMap((page) => page.items)
      .filter((person) => person.id !== asset.data?.currentAssignment?.userId) ?? [];
  // Keep the chosen person selectable while the search results change underneath.
  const items = picked && !listed.some((p) => p.id === picked.id) ? [picked, ...listed] : listed;
  const [baseline, setBaseline] = useState<{ id: string; transfer: boolean; version: number }>();
  const selectedEmployee = items.find((employee) => employee.id === userId);
  const custodyAvailable =
    !!asset.data && (transfer ? canTransfer(asset.data) : canAssign(asset.data));
  const ready =
    custodyAvailable &&
    !!selectedEmployee &&
    baseline?.id === id &&
    baseline?.transfer === transfer &&
    !employees.isPending &&
    !employees.error;
  // Capture the version when the user deliberately chooses the recipient; background refetches cannot upgrade it.
  function choose(value: string) {
    const employee = items.find((item) => item.id === value);
    setUserId(employee?.id ?? '');
    setPicked(employee);
    setBaseline(
      employee && asset.data
        ? { id: asset.data.id, transfer, version: asset.data.version }
        : undefined,
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !baseline || action.isPending || (transfer && !note.trim())) return;
    const result = await action
      .mutateAsync({
        path: transfer ? `/assets/${id}/reassign` : `/assets/${id}/assignments`,
        body: transfer
          ? { userId, reason: note.trim() }
          : { userId, ...(note.trim() ? { note: note.trim() } : {}) },
        version: baseline.version,
        idempotent: true,
      })
      .then(() => true)
      .catch(() => false);
    if (result) navigate(`/assets/${id}`);
  }
  return (
    <>
      <Link className={backLinkClass} to={`/assets/${id}`}>
        ← Asset details
      </Link>
      <PageTitle
        title={transfer ? 'Transfer custody' : 'Assign an asset'}
        description="Record a clear handover. The employee receives a notification and verifies the asset separately."
      />
      <ErrorNotice error={asset.error} />
      <ErrorNotice
        error={employees.error}
        retry={() => {
          void employees.refetch();
        }}
      />
      <ErrorNotice error={action.error} retry={() => window.location.reload()} />
      {asset.isPending ? (
        <Loading />
      ) : asset.data ? (
        <div className="narrow">
          <Panel title={`${asset.data.assetCode} · ${asset.data.description}`}>
            <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.data.status} />
            {!custodyAvailable ? (
              <div className={noticeClass('warning')}>
                {transfer
                  ? 'This asset has no transferable current custody. Review its details before continuing.'
                  : 'This asset must be In Store without current custody before it can be assigned.'}{' '}
                <Link to="/assignments/new">Choose another asset</Link>.
              </div>
            ) : null}
            <FormTransfer
              formId={transfer ? 'asset-transfer' : 'asset-assignment'}
              fields={[
                {
                  key: 'userId',
                  label: 'Approved employee ID',
                  required: true,
                  options: items.map((item) => item.id),
                },
                {
                  key: 'note',
                  label: transfer ? 'Transfer reason' : 'Handover note',
                  required: transfer,
                },
              ]}
              values={{ userId, note }}
              disabled={
                action.isPending || employees.isPending || !!employees.error || !custodyAvailable
              }
              description="Choose from loaded eligible employees. Load more employees below if the intended recipient is not listed. Review before confirming custody."
              onImport={(data) => {
                if (
                  typeof data.userId === 'string' &&
                  items.some((item) => item.id === data.userId)
                )
                  choose(data.userId);
                if (typeof data.note === 'string') setNote(data.note);
                action.reset();
              }}
            />
            <form className="form-stack subsection" onSubmit={submit}>
              <Field label="Search people" htmlFor="assignment-search">
                <input
                  id="assignment-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, email or employee code"
                  maxLength={100}
                  autoComplete="off"
                />
              </Field>
              <Select
                label="Approved employee"
                htmlFor="assignment-user"
                value={selectedEmployee ? userId : ''}
                onChange={choose}
                disabled={
                  action.isPending || employees.isPending || !!employees.error || !custodyAvailable
                }
                ariaDescribedBy="assignment-eligibility"
                required
                options={[
                  { value: '', label: 'Choose an employee' },
                  ...items.map((user) => ({
                    value: user.id,
                    label: `${user.displayName}${user.employeeCode ? ` (${user.employeeCode})` : ''} · ${user.email}${user.state === 'DIRECTORY' ? ' · No login' : ''}`,
                  })),
                ]}
              />
              {selectedEmployee?.state === 'DIRECTORY' ? (
                <p className="muted">
                  <Badge value="DIRECTORY" label="No login" /> This person has no portal login, so
                  no assignment email is sent. Record the handover in person.
                </p>
              ) : null}
              <p id="assignment-eligibility" className="muted">
                Recipients are active employees with portal access, or people synced from the staff
                directory who have not left. Search above, or load more if the intended recipient is
                not listed.
              </p>
              <LoadMore
                available={employees.hasNextPage}
                loading={employees.isFetchingNextPage}
                onClick={() => {
                  void employees.fetchNextPage();
                }}
              />
              {!employees.isPending && !items.length ? (
                <p className="muted">
                  No eligible employees are loaded. Complete invitation acceptance, email
                  verification and portal access, then refresh this page. Current custodians cannot
                  be selected for a transfer to themselves.
                </p>
              ) : null}
              <Field
                label={transfer ? 'Reason for transfer' : 'Handover note'}
                htmlFor="assignment-note"
              >
                <textarea
                  id="assignment-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required={transfer}
                  maxLength={5000}
                />
              </Field>
              <div className={noticeClass()}>
                Effective immediately.{' '}
                {transfer
                  ? 'Previous custody is closed and the new employee must confirm receipt.'
                  : 'A new pending verification is created.'}
              </div>
              <div className={actionsClass}>
                <button
                  className={buttonClass()}
                  disabled={action.isPending || !ready || (transfer && !note.trim())}
                >
                  {action.isPending
                    ? 'Saving...'
                    : transfer
                      ? 'Confirm transfer'
                      : 'Confirm assignment'}
                </button>
                <Link className={buttonClass('secondary')} to={`/assets/${id}`}>
                  Cancel
                </Link>
              </div>
            </form>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
