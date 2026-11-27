import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { catalogHref } from '../catalog-return';
import QRCode from 'qrcode';
import { api, queryString } from '../api';
import { useAction, usePages } from '../hooks';
import type { Asset, Page } from '../types';
import { useBrands, useHolders } from './Insights';
import {
  ColumnFilter,
  ColumnsMenu,
  FilterChips,
  FiltersButton,
  SortMenu,
  fromList,
  toList,
  type FilterGroup,
} from './ColumnFilter';
import { locationLabel, useReferences } from './References';
import {
  Badge,
  Checkbox,
  Empty,
  PersonChip,
  cx,
  inputClass,
  ErrorNotice,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  Select,
  displayDate,
  backLinkClass,
  filterBarClass,
  searchFormClass,
  buttonClass,
  actionsClass,
  tableWrapClass,
  tableClass,
} from './ui';
import { LAYOUTS, layoutPages, maxQrMm, scanUrl } from '../labels/layouts';
import type { LabelText, LayoutId } from '../labels/layouts';
import '../labels/labels.css';

/** Most labels one print run takes (25 A4 sheets of 40). */
const MAX_LABELS = 1000;
const layoutOptions: { value: LayoutId; label: string }[] = [
  { value: 'A4_40', label: 'A4 sheet, 40 labels, 45.7 x 25.4 mm (4 x 10)' },
  { value: 'A4_24', label: 'A4 sheet, 24 labels, 63.5 x 33.9 mm (3 x 8)' },
  { value: 'A4_14', label: 'A4 sheet, 14 labels, 99.1 x 38.1 mm (2 x 7)' },
  { value: 'THERMAL_50x25', label: 'Thermal roll, 50 x 25 mm' },
  { value: 'A4_SQ_38', label: 'A4 sheet, 35 square labels, 38 x 38 mm (5 x 7)' },
  { value: 'A4_SQ_50', label: 'A4 sheet, 20 square labels, 50 x 50 mm (4 x 5)' },
  { value: 'THERMAL_40x40', label: 'Thermal roll, 40 x 40 mm square' },
  { value: 'THERMAL_50x50', label: 'Thermal roll, 50 x 50 mm square' },
];
/** QR sizes on offer (mm); only those smaller than the largest that fits are listed. */
const QR_SIZES = [12, 15, 18, 20, 22, 25, 28, 30, 33, 36, 40];
const printedAt = (asset: Asset) => asset.lastLabelPrintedAt as string | null | undefined;

/** Columns the label list can show; the asset column is always on. */
const labelColumns = [
  { key: 'assetType', label: 'Subcategory' },
  { key: 'category', label: 'Category' },
  { key: 'manufacturer', label: 'Brand' },
  { key: 'model', label: 'Model' },
  { key: 'serialNumber', label: 'Serial' },
  { key: 'departmentId', label: 'Department' },
  { key: 'holderId', label: 'Held by' },
  { key: 'owningTeamId', label: 'Team' },
  { key: 'locationId', label: 'Location' },
  { key: 'status', label: 'Status' },
  { key: 'printed', label: 'Last label printed' },
] as const;
type LabelColumn = (typeof labelColumns)[number]['key'];
const defaultLabelColumns: LabelColumn[] = ['assetType', 'manufacturer', 'departmentId', 'holderId', 'locationId', 'status', 'printed'];
const FILTER_KEYS = ['q', 'status', 'category', 'assetType', 'departmentId', 'manufacturer', 'holderId', 'owningTeamId', 'locationId', 'labelPrinted', 'sort'] as const;

export function LabelPrintPage() {
  const [params, setParams] = useSearchParams();
  const refs = useReferences();
  const holders = useHolders();
  const brands = useBrands();
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || undefined])) as Record<
    (typeof FILTER_KEYS)[number],
    string | undefined
  >;
  const query = usePages<Asset>('/assets', filters);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const matching = query.data?.pages[0]?.totalCount;
  const [search, setSearch] = useState(filters.q ?? '');
  const [selected, setSelected] = useState<Map<string, Asset>>(new Map());
  const [layoutId, setLayoutId] = useState<LayoutId>('A4_40');
  const [startAt, setStartAt] = useState(1);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [selecting, setSelecting] = useState<{ done: number; total?: number } | null>(null);
  const [loadError, setLoadError] = useState<unknown>();
  const [columns, setColumns] = useState<LabelColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('label-columns-v1') ?? 'null');
      return Array.isArray(saved)
        ? (saved.filter((k) => labelColumns.some((c) => c.key === k)) as LabelColumn[])
        : defaultLabelColumns;
    } catch {
      return defaultLabelColumns;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('label-columns-v1', JSON.stringify(columns));
    } catch {
      // Column choice still applies for this visit if storage is unavailable.
    }
  }, [columns]);
  const record = useAction<{ recorded: number; printedAt: string }>();
  const layout = LAYOUTS[layoutId];
  const perPage = layout.cols * layout.rows;
  const [textMode, setTextMode] = useState<LabelText>('full');
  const [qrChoice, setQrChoice] = useState('auto');
  const [edgeBar, setEdgeBar] = useState(true);
  const qrMax = maxQrMm(layout, textMode);
  // A chosen size larger than this stock allows falls back to the largest that fits.
  const qrMm = qrChoice === 'auto' ? qrMax : Math.min(Number(qrChoice), qrMax);
  const preselect = (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 50);
  const preselected = useQuery({
    queryKey: ['label-preselect', preselect.join(',')],
    enabled: preselect.length > 0,
    queryFn: () => Promise.all(preselect.map((id) => api<Asset>(`/assets/${id}`))),
  });
  useEffect(() => {
    if (!preselected.data) return;
    setSelected((current) => {
      const next = new Map(current);
      for (const asset of preselected.data) next.set(asset.id, asset);
      return next;
    });
  }, [preselected.data]);

  const chosen = useMemo(() => [...selected.values()].slice(0, MAX_LABELS), [selected]);
  const pages = useMemo(
    () => layoutPages(chosen, layout, perPage > 1 ? startAt : 1),
    [chosen, layout, perPage, startAt],
  );
  useEffect(() => {
    let live = true;
    const missing = chosen.filter((asset) => !qrs[asset.assetCode]);
    if (!missing.length) return;
    void Promise.all(
      missing.map(
        async (asset) =>
          [
            asset.assetCode,
            await QRCode.toString(scanUrl(window.location.origin, asset.assetCode), {
              type: 'svg',
              // H tolerates the logo covering the centre modules.
              errorCorrectionLevel: 'H',
              margin: 1,
            }),
          ] as const,
      ),
    ).then((entries) => {
      if (live) setQrs((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      live = false;
    };
  }, [chosen, qrs]);

  function update(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }
  function setFilter(key: string, values: string[]) {
    update(key, fromList(values));
  }
  function applyFilters(all: Record<string, string[]>) {
    const next = new URLSearchParams(params);
    for (const [key, values] of Object.entries(all)) {
      if (values.length) next.set(key, fromList(values));
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }
  function toggle(asset: Asset) {
    setSelected((current) => {
      const next = new Map(current);
      if (!next.delete(asset.id)) next.set(asset.id, asset);
      return next;
    });
  }
  /**
   * Adds every asset matching the current filters, fetched straight from the server 100 at a
   * time (the list on screen does not need to be loaded), up to the print limit.
   */
  async function selectAllMatching() {
    setSelecting({ done: 0, total: matching });
    setLoadError(undefined);
    try {
      const found: Asset[] = [];
      let cursor: string | undefined;
      do {
        const page = await api<Page<Asset>>(
          '/assets' + queryString({ ...filters, limit: '100', cursor }),
        );
        found.push(...page.items);
        setSelecting({ done: found.length, total: page.totalCount ?? matching });
        cursor = page.nextCursor ?? undefined;
      } while (cursor && found.length < MAX_LABELS);
      setSelected((current) => {
        const next = new Map(current);
        for (const asset of found.slice(0, MAX_LABELS)) next.set(asset.id, asset);
        return next;
      });
    } catch (error) {
      setLoadError(error);
    } finally {
      setSelecting(null);
    }
  }
  // Printing copies the sheets into a print-only root on <body> (nothing else prints) and sets
  // the paper size and zero margins for the chosen stock, then opens the print dialog.
  const [printing, setPrinting] = useState(false);
  function print() {
    setPrinting(true);
  }
  useEffect(() => {
    if (!printing) return;
    let pageRule: CSSStyleSheet | null = null;
    try {
      pageRule = new CSSStyleSheet();
      pageRule.replaceSync(`@page { size: ${layout.pageWidthMm}mm ${layout.pageHeightMm}mm; margin: 0; }`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageRule];
    } catch {
      pageRule = null; // Older browsers: the print dialog's own paper settings apply.
    }
    const done = () => {
      setPrinting(false);
      setConfirming(true);
    };
    window.addEventListener('afterprint', done, { once: true });
    // Two frames so the print-only copy is in the page before the dialog opens.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', done);
      if (pageRule) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== pageRule);
    };
  }, [printing, layout.pageWidthMm, layout.pageHeightMm]);
  function confirmPrinted() {
    record.mutate(
      {
        path: '/asset-labels/prints',
        body: { assetIds: chosen.map((asset) => asset.id), layout: layoutId },
        idempotent: true,
      },
      {
        onSuccess: () => {
          setConfirming(false);
          setSelected(new Map());
        },
      },
    );
  }
  const allChecked = items.length > 0 && items.every((asset) => selected.has(asset.id));
  const sel = (key: string) => toList(params.get(key));
  const refOptions = (kind: string, chosenValues: string[]) =>
    (refs.data?.values ?? [])
      .filter((v) => v.kind === kind && (v.active || chosenValues.includes(v.code)))
      .map((v) => ({ value: v.code, label: v.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const groups: FilterGroup[] = [
    { key: 'category', title: 'Category', options: refOptions('CATEGORY', sel('category')), selected: sel('category') },
    { key: 'assetType', title: 'Subcategory', options: refOptions('ASSET_TYPE', sel('assetType')), selected: sel('assetType') },
    {
      key: 'manufacturer',
      title: 'Brand',
      options: (brands.data?.items ?? []).map((b) => ({ value: b.name, label: `${b.name} (${b.count})` })),
      selected: sel('manufacturer'),
    },
    {
      key: 'departmentId',
      title: 'Department',
      options: (refs.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name })),
      selected: sel('departmentId'),
    },
    {
      key: 'holderId',
      title: 'Held by',
      options: (holders.data?.items ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((h) => ({ value: h.userId, label: `${h.name} (${h.count})` })),
      selected: sel('holderId'),
    },
    {
      key: 'owningTeamId',
      title: 'Team',
      options: (refs.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name })),
      selected: sel('owningTeamId'),
    },
    {
      key: 'locationId',
      title: 'Location',
      // Picking a place includes everything inside it (a building covers its floors and rooms).
      options: (refs.data?.locations ?? [])
        .filter((l) => l.active || sel('locationId').includes(l.id))
        .map((l) => ({ value: l.id, label: l.path ?? locationLabel(l) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      selected: sel('locationId'),
    },
    { key: 'status', title: 'Status', options: refOptions('STATUS', sel('status')), selected: sel('status') },
  ];
  const groupFor = (key: string) => groups.find((g) => g.key === key);
  const headerCell = (key: LabelColumn, label: string) => {
    const group = groupFor(key);
    return (
      <th key={key}>
        <span className="inline-flex items-center gap-1">
          {label}
          {group ? (
            <ColumnFilter title={label} options={group.options} selected={group.selected} onApply={(values) => setFilter(key, values)} />
          ) : null}
        </span>
      </th>
    );
  };
  const cell = (asset: Asset, key: LabelColumn) => {
    switch (key) {
      case 'assetType':
        return asset.assetType || '—';
      case 'category':
        return asset.category;
      case 'manufacturer':
        return asset.manufacturer || '—';
      case 'model':
        return asset.model || '—';
      case 'serialNumber':
        return <span className="font-mono text-xs">{asset.serialNumber || '—'}</span>;
      case 'departmentId':
        return refs.data?.departments.find((d) => d.id === asset.departmentId)?.name ?? '—';
      case 'holderId':
        return asset.currentAssignment?.employeeName ? (
          <PersonChip
            userId={asset.currentAssignment.userId ?? ''}
            name={asset.currentAssignment.employeeName}
            hasPhoto={asset.currentAssignment.employeeHasPhoto}
            designation={asset.currentAssignment.employeeDesignation}
            department={asset.currentAssignment.employeeDepartment}
          />
        ) : (
          <span className="text-gray-400">Not assigned</span>
        );
      case 'owningTeamId':
        return refs.data?.teams?.find((t) => t.id === asset.owningTeamId)?.name ?? '—';
      case 'locationId': {
        const place = refs.data?.locations.find((l) => l.id === asset.locationId);
        return place ? <span className="text-sm text-gray-700">{place.path ?? locationLabel(place)}</span> : <span className="text-gray-400">No location</span>;
      }
      case 'status':
        return <Badge value={asset.status} />;
      case 'printed':
        return printedAt(asset) ? displayDate(printedAt(asset), true) : <span className="text-gray-400">Never</span>;
    }
  };
  const shown = labelColumns.filter((c) => columns.includes(c.key));
  const capped = (matching ?? 0) > MAX_LABELS;

  const sheets = pages.map((cells, pageIndex) => (
        <div
          className="label-sheet"
          key={pageIndex}
          data-layout={layoutId}
          style={{ width: `${layout.pageWidthMm}mm`, height: `${layout.pageHeightMm}mm` }}
        >
          {cells.map((asset, index) =>
            asset ? (
              <div
                className="label-cell"
                key={index}
                data-shape={layout.shape}
                data-text={textMode}
                data-bar={edgeBar ? 'on' : 'off'}
                style={{
                  left: `${layout.marginLeftMm + (index % layout.cols) * (layout.labelWidthMm + layout.gapXMm)}mm`,
                  top: `${layout.marginTopMm + Math.floor(index / layout.cols) * (layout.labelHeightMm + layout.gapYMm)}mm`,
                  width: `${layout.labelWidthMm}mm`,
                  height: `${layout.labelHeightMm}mm`,
                }}
              >
                <div className="label-qr" style={{ width: `${qrMm}mm`, height: `${qrMm}mm` }}>
                  <div className="label-qr-code" dangerouslySetInnerHTML={{ __html: qrs[asset.assetCode] ?? '' }} />
                  <img className="label-qr-logo" src="/image.png" alt="" />
                </div>
                {textMode !== 'none' ? (
                  <div className="label-text">
                    {textMode === 'full' ? <span className="label-brand">IAC Assets</span> : null}
                    <strong>{asset.assetCode}</strong>
                    {textMode === 'full' ? (
                      <>
                        <span className="label-type">{asset.assetType || asset.category}</span>
                        <span className="label-hint">Scan for help ›</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null,
          )}
        </div>
      ));

  return (
    <>
      <div className="no-print">
        <Link to={catalogHref()} className={backLinkClass}>
          ← Asset catalog
        </Link>
        <PageTitle
          eyebrow="INVENTORY / LABELS"
          title="Print asset labels"
          description="Filter to the assets you need (for example one category or one person), select them all at once, choose your label stock, then print QR stickers that open the report-a-problem page."
        />
        <Panel>
          <div className={filterBarClass}>
            <form
              className={searchFormClass}
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                update('q', search.trim());
              }}
            >
              <label htmlFor="label-search" className="sr-only">
                Search assets
              </label>
              <input
                id="label-search"
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search asset ID, description, model, serial or holder name"
                maxLength={100}
              />
              <button className={buttonClass('secondary')} type="submit">
                Search
              </button>
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
            <div className="!min-w-0 !flex-none">
              <Checkbox
                label="Not printed yet"
                checked={filters.labelPrinted === 'no'}
                onChange={(checked) => update('labelPrinted', checked ? 'no' : '')}
              />
            </div>
            <div className="!min-w-0 !flex-none">
              <ColumnsMenu columns={labelColumns} visible={columns} onChange={setColumns} defaults={defaultLabelColumns} extra={1} />
            </div>
            {/* Phones hide the table headers, so their filters live behind this button. */}
            <div className="!min-w-0 !flex-none md:hidden">
              <FiltersButton groups={groups} onApply={applyFilters} />
            </div>
          </div>
          <FilterChips
            groups={groups}
            onRemove={(key, value) => setFilter(key, sel(key).filter((v) => v !== value))}
            onClearAll={() => {
              const next = new URLSearchParams(params);
              FILTER_KEYS.forEach((key) => key !== 'sort' && next.delete(key));
              setSearch('');
              setParams(next, { replace: true });
            }}
          />

          {/* Selection bar: how many match, how many are picked, one click to pick them all, print. */}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-navy-100 bg-navy-50/60 px-4 py-3">
            <div className="min-w-0 flex-1 text-sm text-gray-700">
              <span className="font-semibold text-navy-900">{(matching ?? items.length).toLocaleString('en-IN')}</span>{' '}
              assets match ·{' '}
              <span className="font-semibold text-navy-900">{selected.size.toLocaleString('en-IN')}</span> selected
              {selected.size > MAX_LABELS ? ` (the first ${MAX_LABELS} will print)` : ''}
              {selecting ? (
                <span className="ml-2 text-gray-500">
                  Selecting {selecting.done.toLocaleString('en-IN')}
                  {selecting.total ? ` of ${Math.min(selecting.total, MAX_LABELS).toLocaleString('en-IN')}` : ''}…
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              disabled={!!selecting || !items.length}
              onClick={() => void selectAllMatching()}
            >
              {selecting
                ? 'Selecting…'
                : `Select all ${capped ? `first ${MAX_LABELS}` : (matching ?? items.length).toLocaleString('en-IN')} matching`}
            </button>
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              disabled={!selected.size}
              onClick={() => setSelected(new Map())}
            >
              Clear selection
            </button>
            <button type="button" className={buttonClass('primary', 'sm')} disabled={!chosen.length} onClick={print}>
              Print {chosen.length.toLocaleString('en-IN')} label{chosen.length === 1 ? '' : 's'}
            </button>
          </div>

          <ErrorNotice
            error={query.error ?? loadError ?? preselected.error}
            retry={() => {
              void query.refetch();
            }}
          />
          {query.isPending ? (
            <Loading label="Loading assets..." />
          ) : items.length ? (
            <div className={tableWrapClass}>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className="w-10">
                      <Checkbox
                        ariaLabel="Select the assets shown"
                        checked={allChecked}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Map(current);
                            for (const asset of items) {
                              if (allChecked) next.delete(asset.id);
                              else next.set(asset.id, asset);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    <th>Asset</th>
                    {shown.map((c) => headerCell(c.key, c.label))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((asset) => (
                    <tr
                      key={asset.id}
                      className={cx('cursor-pointer', selected.has(asset.id) && 'bg-navy-50/50')}
                      onClick={(event) => {
                        // Clicking the row toggles it, except on links and buttons inside it.
                        if ((event.target as HTMLElement).closest('a,button,input')) return;
                        toggle(asset);
                      }}
                    >
                      <td>
                        <Checkbox
                          ariaLabel={`Select ${asset.assetCode}`}
                          checked={selected.has(asset.id)}
                          onChange={() => toggle(asset)}
                        />
                      </td>
                      <td>
                        <span className="block font-mono text-xs font-medium text-navy-700">{asset.assetCode}</span>
                        <span className="block max-w-72 truncate text-sm text-gray-700">{asset.description}</span>
                      </td>
                      {shown.map((c) => (
                        <td key={c.key}>{cell(asset, c.key)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !query.error ? (
            <Empty title="No assets match">Try clearing a filter or the search.</Empty>
          ) : null}
          <LoadMore
            available={query.hasNextPage && !query.isPlaceholderData}
            loading={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          />
        </Panel>
        <Panel title="Label stock and design">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-gray-700">Shape</span>
              <div role="tablist" aria-label="Label shape" className="inline-flex max-w-full flex-wrap rounded-lg border border-gray-200 bg-white p-1">
                {(['rect', 'square'] as const).map((s) => (
                  <button
                    key={s}
                    role="tab"
                    type="button"
                    aria-selected={layout.shape === s}
                    onClick={() => {
                      if (layout.shape === s) return;
                      setLayoutId(s === 'square' ? 'A4_SQ_38' : 'A4_40');
                      setStartAt(1);
                    }}
                    className={cx(
                      'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                      layout.shape === s ? 'bg-navy-700 text-white' : 'text-gray-600 hover:text-navy-700',
                    )}
                  >
                    {s === 'square' ? 'Square (QR on top)' : 'Rectangle (QR beside text)'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Select
                label="Label stock"
                htmlFor="label-layout"
                value={layoutId}
                onChange={(value) => {
                  setLayoutId(value as LayoutId);
                  setStartAt(1);
                }}
                options={layoutOptions.filter((o) => LAYOUTS[o.value].shape === layout.shape)}
              />
              <Select
                label="QR code size"
                htmlFor="label-qr-size"
                value={qrChoice}
                onChange={setQrChoice}
                options={[
                  { value: 'auto', label: `Largest that fits (${qrMax} mm)` },
                  ...QR_SIZES.filter((mm) => mm < qrMax).map((mm) => ({ value: String(mm), label: `${mm} mm` })),
                ]}
              />
              <Select
                label="Text on label"
                htmlFor="label-text"
                value={textMode}
                onChange={(value) => setTextMode(value as LabelText)}
                options={[
                  { value: 'full', label: 'Asset ID, type and “Scan for help”' },
                  { value: 'code', label: 'Asset ID only' },
                  { value: 'none', label: 'QR code only' },
                ]}
              />
              {perPage > 1 ? (
                <Field
                  label="Start at label #"
                  htmlFor="label-start"
                  hint={`1 to ${perPage}; skip labels already used on a partial sheet`}
                >
                  <input
                    id="label-start"
                    className={inputClass}
                    type="number"
                    min={1}
                    max={perPage}
                    value={startAt}
                    onChange={(event) =>
                      setStartAt(Math.min(Math.max(Math.trunc(Number(event.target.value)) || 1, 1), perPage))
                    }
                  />
                </Field>
              ) : null}
            </div>
            <Checkbox label="Blue edge bar on the left of each label" checked={edgeBar} onChange={setEdgeBar} />
            <p className="text-xs text-gray-500">
              Each label is {layout.labelWidthMm} × {layout.labelHeightMm} mm with a {qrMm} mm QR code
              {perPage > 1 ? `, ${perPage} per sheet` : ''}. QR codes smaller than 15 mm can be hard to scan from a
              distance. Print at 100% scale (no fit-to-page).
            </p>
            <div className={actionsClass}>
              <button type="button" className={buttonClass()} disabled={!chosen.length} onClick={print}>
                Print {chosen.length.toLocaleString('en-IN')} label{chosen.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
          {confirming ? (
            <div className="label-print-confirm" role="group" aria-label="Confirm print">
              <strong>Did the labels print correctly?</strong>
              <button type="button" className={buttonClass()} disabled={record.isPending} onClick={confirmPrinted}>
                Yes, record print
              </button>
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={record.isPending}
                onClick={() => setConfirming(false)}
              >
                No
              </button>
              <ErrorNotice error={record.error} />
            </div>
          ) : null}
          {record.isSuccess && !confirming ? (
            <p role="status">Recorded {record.data?.recorded} label print(s).</p>
          ) : null}
        </Panel>
        {pages.length ? <h2 className="mt-6 mb-3 text-base font-semibold text-navy-900">Preview</h2> : null}
      </div>
      {sheets}
      {printing ? createPortal(<div className="label-print-root">{sheets}</div>, document.body) : null}
    </>
  );
}
