import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAction, usePages } from '../hooks';
import type { Asset } from '../types';
import { ReferenceSelect, useReferences } from './References';
import {
  Checkbox,
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
import { LAYOUTS, layoutPages, scanUrl } from '../labels/layouts';
import type { LayoutId } from '../labels/layouts';
import '../labels/labels.css';

const MAX_LABELS = 500;
const layoutOptions: { value: LayoutId; label: string }[] = [
  { value: 'A4_40', label: 'A4 sheet, 40 small labels (4 x 10)' },
  { value: 'A4_24', label: 'A4 sheet, 24 labels (3 x 8)' },
  { value: 'A4_14', label: 'A4 sheet, 14 labels (2 x 7)' },
  { value: 'THERMAL_50x25', label: 'Thermal roll, 50 x 25 mm' },
];
const printedAt = (asset: Asset) => asset.lastLabelPrintedAt as string | null | undefined;

export function LabelPrintPage() {
  const [params, setParams] = useSearchParams();
  const refs = useReferences();
  const filters = {
    q: params.get('q') || undefined,
    status: params.get('status') || undefined,
    category: params.get('category') || undefined,
    departmentId: params.get('departmentId') || undefined,
    labelPrinted: params.get('labelPrinted') === 'no' ? 'no' : undefined,
  };
  const query = usePages<Asset>('/assets', filters);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const [search, setSearch] = useState(filters.q ?? '');
  const [selected, setSelected] = useState<Map<string, Asset>>(new Map());
  const [layoutId, setLayoutId] = useState<LayoutId>('A4_40');
  const [startAt, setStartAt] = useState(1);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const record = useAction<{ recorded: number; printedAt: string }>();
  const layout = LAYOUTS[layoutId];
  const perPage = layout.cols * layout.rows;
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
  function toggle(asset: Asset) {
    setSelected((current) => {
      const next = new Map(current);
      if (!next.delete(asset.id)) next.set(asset.id, asset);
      return next;
    });
  }
  async function selectAll() {
    setLoadingAll(true);
    setLoadError(undefined);
    try {
      let all = items;
      let more = query.hasNextPage;
      while (all.length < MAX_LABELS && more) {
        const fetched = await query.fetchNextPage();
        if (fetched.isError) throw fetched.error;
        all = fetched.data?.pages.flatMap((page) => page.items) ?? all;
        more = fetched.hasNextPage;
      }
      setSelected((current) => {
        const next = new Map(current);
        for (const asset of all.slice(0, MAX_LABELS)) next.set(asset.id, asset);
        return next;
      });
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoadingAll(false);
    }
  }
  function print() {
    window.print();
    setConfirming(true);
  }
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
  return (
    <>
      <div className="no-print">
        <Link to="/assets" className={backLinkClass}>
          ← Asset catalog
        </Link>
        <PageTitle
          eyebrow="INVENTORY / LABELS"
          title="Print asset labels"
          description="Select assets, choose your label stock, then print QR stickers that open the report-a-problem page."
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
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search asset ID, description or serial"
                maxLength={100}
              />
              <button className={buttonClass('secondary')} type="submit">
                Search
              </button>
            </form>
            <Field label="Category" htmlFor="label-category">
              <ReferenceSelect
                refs={refs.data}
                kind="category"
                id="label-category"
                value={filters.category ?? ''}
                onChange={(value) => update('category', value)}
                required={false}
                allowEmpty
                includeInactive
              />
            </Field>
            <Select
              label="Department"
              htmlFor="label-department"
              value={filters.departmentId ?? ''}
              onChange={(value) => update('departmentId', value)}
              options={[
                { value: '', label: 'All departments' },
                ...(refs.data?.departments.map((item) => ({
                  value: item.id,
                  label: `${item.name}${!item.active ? ' (inactive)' : ''}`,
                })) || []),
              ]}
            />
            <Checkbox
              label="Not printed yet"
              className="filter-checkbox"
              checked={filters.labelPrinted === 'no'}
              onChange={(checked) => update('labelPrinted', checked ? 'no' : '')}
            />
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
            <>
              <div className={actionsClass}>
                <button
                  type="button"
                  className={buttonClass('secondary')}
                  disabled={loadingAll}
                  onClick={() => {
                    void selectAll();
                  }}
                >
                  {loadingAll ? 'Loading...' : 'Select all matching'}
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  disabled={!selected.size}
                  onClick={() => setSelected(new Map())}
                >
                  Clear selection
                </button>
                <span className="muted">
                  {selected.size} selected
                  {selected.size > MAX_LABELS ? ` (first ${MAX_LABELS} will print)` : ''}
                </span>
              </div>
              <div className={tableWrapClass}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className="label-table-check">
                        <input
                          type="checkbox"
                          aria-label="Select all loaded assets"
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
                      <th>Asset / description</th>
                      <th>Type</th>
                      <th>Last label printed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((asset) => (
                      <tr key={asset.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${asset.assetCode}`}
                            checked={selected.has(asset.id)}
                            onChange={() => toggle(asset)}
                          />
                        </td>
                        <td>
                          <span className="asset-code">{asset.assetCode}</span>
                          <span className="cell-description">{asset.description}</span>
                        </td>
                        <td>{asset.assetType || asset.category}</td>
                        <td>
                          {printedAt(asset) ? (
                            displayDate(printedAt(asset), true)
                          ) : (
                            <span className="muted">Never</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : !query.error ? (
            <p className="muted">No assets match these filters.</p>
          ) : null}
          <LoadMore
            available={query.hasNextPage && !query.isPlaceholderData}
            loading={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          />
        </Panel>
        <Panel>
          <div className={filterBarClass}>
            <Select
              label="Label layout"
              htmlFor="label-layout"
              value={layoutId}
              onChange={(value) => setLayoutId(value as LayoutId)}
              options={layoutOptions}
            />
            {perPage > 1 ? (
              <Field
                label="Start at label #"
                htmlFor="label-start"
                hint={`1 to ${perPage}; skip labels already used on a partial sheet`}
              >
                <input
                  id="label-start"
                  type="number"
                  min={1}
                  max={perPage}
                  value={startAt}
                  onChange={(event) =>
                    setStartAt(
                      Math.min(Math.max(Math.trunc(Number(event.target.value)) || 1, 1), perPage),
                    )
                  }
                />
              </Field>
            ) : null}
          </div>
          <p className="muted">Print at 100% scale (no fit-to-page)</p>
          <div className={actionsClass}>
            <button
              type="button"
              className={buttonClass()}
              disabled={!chosen.length}
              onClick={print}
            >
              Print {chosen.length} label{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
          {confirming ? (
            <div className="label-print-confirm" role="group" aria-label="Confirm print">
              <strong>Did the labels print correctly?</strong>
              <button
                type="button"
                className={buttonClass()}
                disabled={record.isPending}
                onClick={confirmPrinted}
              >
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
        {pages.length ? <h2>Preview</h2> : null}
      </div>
      {pages.map((cells, pageIndex) => (
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
                style={{
                  left: `${layout.marginLeftMm + (index % layout.cols) * (layout.labelWidthMm + layout.gapXMm)}mm`,
                  top: `${layout.marginTopMm + Math.floor(index / layout.cols) * (layout.labelHeightMm + layout.gapYMm)}mm`,
                  width: `${layout.labelWidthMm}mm`,
                  height: `${layout.labelHeightMm}mm`,
                }}
              >
                <div
                  className="label-qr"
                  style={{ width: `${layout.qrMm}mm`, height: `${layout.qrMm}mm` }}
                >
                  <div
                    className="label-qr-code"
                    dangerouslySetInnerHTML={{ __html: qrs[asset.assetCode] ?? '' }}
                  />
                  <img className="label-qr-logo" src="/image.png" alt="" />
                </div>
                <div className="label-text">
                  <span className="label-brand">IAC Assets</span>
                  <strong>{asset.assetCode}</strong>
                  <span className="label-type">{asset.assetType || asset.category}</span>
                  <span className="label-hint">Scan for help ›</span>
                </div>
              </div>
            ) : null,
          )}
        </div>
      ))}
    </>
  );
}
