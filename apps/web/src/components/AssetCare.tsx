import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { usePages } from '../hooks';
import { can, useSession } from '../session';
import { fetchAllPages } from '../transfer-files';
import type { User } from '../types';
import { Card, ColumnChart, EmptyChart } from './charts';
import {
  Empty,
  ErrorNotice,
  LoadMore,
  Loading,
  PageTitle,
  Panel,
  PersonChip,
  buttonClass,
  cx,
  displayDate,
  inputClass,
  Select,
  tableClass,
  tableWrapClass,
} from './ui';

/*
 * Warranty, AMC and insurance registers. Built for large registers: the server counts (summary)
 * and sends one page of rows at a time, so a 50,000-asset register stays quick.
 */

/* ------------------------------------------------------------------ data */

export interface CareRow {
  id: string;
  assetCode: string;
  description: string;
  category: string;
  assetType: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber?: string | null;
  status: string;
  owningTeam?: string | null;
  teamCode?: string | null;
  location?: string | null;
  warrantyExpiry?: string | null;
  warrantyDaysRemaining?: number | null;
  amcApplies?: boolean;
  amcExpiry?: string | null;
  amcDaysRemaining?: number | null;
  insurancePolicyNumber?: string | null;
  insuranceExpiry?: string | null;
  insuranceDaysRemaining?: number | null;
  purchaseDate?: string | null;
  purchaseCost?: number | null;
  supplier?: string | null;
  repairCount: number;
  custodian: {
    userId: string;
    name: string;
    hasPhoto: boolean;
    designation: string | null;
    department: string | null;
    left: boolean;
  } | null;
}

export type CoverState = 'expired' | 'due30' | 'due90' | 'active' | 'missing' | 'none';
type Cover = 'warranty' | 'amc' | 'insurance';
type StateCounts = Record<CoverState, number>;

export interface CareSummary {
  total: number;
  warranty: StateCounts | null;
  amc: StateCounts | null;
  insurance: StateCounts | null;
  months: { month: string; warranty: number; amc: number; insurance: number }[];
  soonest: { id: string; assetCode: string; cover: Cover; date: string; days: number }[];
  gaps: { purchaseCost: number | null; purchaseDate: number | null; location: number | null };
  value: { total: number; insured: number; atRisk: number } | null;
  biggestGaps: { id: string; assetCode: string; name: string; cost: number }[];
  repairedAssets: number;
  ages: number[] | null;
  teams: { id: string; name: string; assets: number }[];
}

/** Warranty & AMC: anyone with reporting access, plus every team lead and member (own team). */
export function canSeeWarranty(user: User | undefined) {
  return can(user, 'report.view') || (user?.teams?.length ?? 0) > 0;
}
/** Insurance: the insurer, Finance, leadership/auditors, plus team leads and members (own team). */
export function canSeeInsurance(user: User | undefined) {
  return (
    can(user, 'insurer.view') ||
    can(user, 'asset.finance_edit') ||
    can(user, 'report.view') ||
    (user?.teams?.length ?? 0) > 0
  );
}

const SUMMARY_PATH = { warranty: '/reports/warranty-expiry/summary', insurance: '/insurance/summary' } as const;
const LIST_PATH = { warranty: '/reports/warranty-expiry', insurance: '/insurance' } as const;

/** Counts for one register (cached for the session's usual 20 seconds and shared by every panel). */
export function useCareSummary(page: 'warranty' | 'insurance', enabled = true) {
  return useQuery({
    queryKey: ['asset-care', 'summary', page],
    queryFn: ({ signal }) => api<CareSummary>(SUMMARY_PATH[page], { signal }),
    enabled,
    retry: false,
  });
}

/* ---------------------------------------------------------------- states */

export const STATE_WORDS: Record<CoverState, string> = {
  expired: 'Expired',
  due30: 'Ends within 30 days',
  due90: 'Ends in 31–90 days',
  active: 'Covered',
  missing: 'Not recorded',
  none: 'Not applicable',
};
const pillTone: Record<CoverState, string> = {
  expired: 'bg-red-50 text-red-700 ring-red-100',
  due30: 'bg-yellow-50 text-yellow-800 ring-yellow-200',
  due90: 'bg-navy-50 text-navy-700 ring-navy-100',
  active: 'bg-sky-50 text-sky-800 ring-sky-100',
  missing: 'bg-gray-100 text-gray-600 ring-gray-200',
  none: 'bg-white text-gray-400 ring-gray-200',
};
export const dotTone: Record<CoverState, string> = {
  expired: 'bg-red-600',
  due30: 'bg-yellow-500',
  due90: 'bg-navy-500',
  active: 'bg-sky-500',
  missing: 'bg-gray-400',
  none: 'bg-gray-300',
};

function stateOf(days: number | null | undefined, date: string | null | undefined, applies = true): CoverState {
  if (!applies) return 'none';
  if (!date || days == null) return 'missing';
  if (days < 0) return 'expired';
  if (days <= 30) return 'due30';
  if (days <= 90) return 'due90';
  return 'active';
}
const warrantyState = (r: CareRow) => stateOf(r.warrantyDaysRemaining, r.warrantyExpiry);
const amcState = (r: CareRow) => stateOf(r.amcDaysRemaining, r.amcExpiry, !!r.amcApplies);
const insuranceState = (r: CareRow) => stateOf(r.insuranceDaysRemaining, r.insuranceExpiry);

const plain = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN');
function plural(n: number, word: string) {
  return `${plain(n)} ${word}${n === 1 ? '' : 's'}`;
}
function spanText(days: number) {
  const d = Math.abs(days);
  if (d >= 365) return plural(Math.floor(d / 365), 'year');
  if (d >= 60) return plural(Math.floor(d / 30), 'month');
  return plural(d, 'day');
}
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Date plus a short coloured status, e.g. "12 Mar 2026 · Ends in 9 days". */
function CoverCell({
  state,
  date,
  days,
  missingLabel = 'Not recorded',
  noneLabel = 'No AMC',
}: {
  state: CoverState;
  date?: string | null;
  days?: number | null;
  missingLabel?: string;
  noneLabel?: string;
}) {
  const label =
    state === 'none'
      ? noneLabel
      : state === 'missing'
        ? missingLabel
        : state === 'expired'
          ? `Ended ${spanText(days ?? 0)} ago`
          : days === 0
            ? 'Ends today'
            : `Ends in ${spanText(days ?? 0)}`;
  return (
    <div className="flex min-w-36 flex-col items-start gap-1">
      {date && state !== 'none' ? (
        <span className="text-sm whitespace-nowrap text-gray-800">{displayDate(date)}</span>
      ) : null}
      <span
        className={cx(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
          pillTone[state],
        )}
      >
        <span className={cx('size-1.5 rounded-full', dotTone[state])} aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- shared bits */

/** One clickable number in the snapshot row; pressing it filters the table below. */
function SnapTile({
  label,
  value,
  detail,
  state,
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  state: CoverState | 'all';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex min-w-0 flex-col rounded-xl border bg-white px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-navy-500',
        active ? 'border-navy-500 ring-2 ring-navy-100' : 'border-gray-200 hover:border-navy-200',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
        {state !== 'all' ? <span className={cx('size-2 rounded-full', dotTone[state])} aria-hidden="true" /> : null}
        {label}
      </span>
      <strong data-count className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-navy-900 tabular-nums">
        {value}
      </strong>
      {detail ? <span className="mt-0.5 text-xs text-gray-500">{detail}</span> : null}
    </button>
  );
}

function Custodian({ row }: { row: CareRow }) {
  if (!row.custodian)
    return <span className="text-sm text-gray-400">{row.status === 'In Store' ? 'In store' : 'Not assigned'}</span>;
  const c = row.custodian;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <PersonChip
        userId={c.userId}
        name={c.name}
        hasPhoto={c.hasPhoto}
        detail={c.designation ?? c.department ?? undefined}
        designation={c.designation}
        department={c.department}
        holdingsHref={`/assets?holderId=${c.userId}`}
      />
      {c.left ? <span className="pl-1 text-xs font-medium text-red-700">Has left</span> : null}
    </div>
  );
}

function AssetCell({ row }: { row: CareRow }) {
  const name = [row.manufacturer, row.model].filter(Boolean).join(' ') || row.description;
  return (
    <div className="flex min-w-44 flex-col">
      <Link to={`/assets/${row.id}`} className="font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
        {row.assetCode}
      </Link>
      <span className="truncate text-sm text-gray-900">{name}</span>
      <span className="text-xs text-gray-500">{row.assetType || row.category}</span>
    </div>
  );
}

/** Downloads rows as a CSV file (opens in Excel). */
function downloadCsv(name: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** URL-backed filters plus a debounced search box. */
function useRegisterFilters() {
  const [params, setParams] = useSearchParams();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const [search, setSearch] = useState(params.get('q') ?? '');
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((params.get('q') ?? '') !== search.trim()) set('q', search.trim());
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  return { params, set, search, setSearch };
}

function FilterRow({
  search,
  setSearch,
  placeholder,
  teams,
  team,
  setTeam,
  onClear,
  showClear,
}: {
  search: string;
  setSearch: (v: string) => void;
  placeholder: string;
  teams: CareSummary['teams'];
  team: string;
  setTeam: (v: string) => void;
  onClear: () => void;
  showClear: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-3">
      <input
        type="search"
        className={cx(inputClass, 'min-w-56 flex-[2]')}
        placeholder={placeholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search assets"
      />
      {teams.length > 1 ? (
        <div className="min-w-40 flex-1">
          <Select
            label=""
            htmlFor="asset-care-team"
            value={team}
            onChange={setTeam}
            className="h-10"
            options={[
              { value: '', label: 'All teams' },
              ...teams.map((t) => ({ value: t.id, label: `${t.name} (${plain(t.assets)})` })),
            ]}
          />
        </div>
      ) : null}
      {showClear ? (
        <button type="button" className={buttonClass('ghost')} onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- warranty page */

export function WarrantyExpiry() {
  const { user } = useSession();
  const canEdit = can(user, 'asset.edit');
  const summary = useCareSummary('warranty');
  const { params, set, search, setSearch } = useRegisterFilters();
  const kind: 'warranty' | 'amc' = params.get('cover') === 'amc' ? 'amc' : 'warranty';
  const show = (params.get('show') ?? '') as CoverState | '';
  const team = params.get('team') ?? '';
  const filters = {
    cover: kind,
    show: show || undefined,
    teamId: team || undefined,
    q: params.get('q') || undefined,
  };
  const list = usePages<CareRow>(LIST_PATH.warranty, filters);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const s = summary.data;
  const counts = (kind === 'amc' ? s?.amc : s?.warranty) ?? null;
  const other = (kind === 'amc' ? s?.warranty : s?.amc) ?? null;
  const word = kind === 'amc' ? 'AMC' : 'Warranty';
  const needs = (counts?.expired ?? 0) + (counts?.due30 ?? 0);
  const otherNeeds = (other?.expired ?? 0) + (other?.due30 ?? 0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  async function exportRows() {
    setExporting(true);
    setExportError(null);
    try {
      const all = await fetchAllPages<CareRow>(LIST_PATH.warranty, filters);
      downloadCsv(
        kind === 'amc' ? 'amc-register' : 'warranty-register',
        ['Asset', 'Name', 'Type', 'Team', 'Held by', 'Location', 'Warranty ends', 'Warranty status', 'AMC ends', 'AMC status'],
        all.map((r) => [
          r.assetCode,
          [r.manufacturer, r.model].filter(Boolean).join(' ') || r.description,
          r.assetType,
          r.owningTeam,
          r.custodian?.name ?? '',
          r.location,
          r.warrantyExpiry?.slice(0, 10),
          STATE_WORDS[warrantyState(r)],
          r.amcApplies ? r.amcExpiry?.slice(0, 10) : '',
          STATE_WORDS[amcState(r)],
        ]),
      );
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  }

  const tile = (state: CoverState | 'all', label: string, value: number | undefined, detail: string) => (
    <SnapTile
      label={label}
      value={plain(value)}
      detail={detail}
      state={state}
      active={state === 'all' ? !show : show === state}
      onClick={() => set('show', state === 'all' || show === state ? '' : state)}
    />
  );

  return (
    <>
      <PageTitle
        eyebrow="ASSET CARE"
        title="Warranty & AMC"
        description="A warranty is the maker's free repair promise; an AMC (annual maintenance contract) is a paid service contract. See what has ended, what ends soon and what is missing, then open an asset to update it."
        action={
          <button type="button" className={buttonClass('secondary')} onClick={() => void exportRows()} disabled={exporting || !rows.length}>
            {exporting ? 'Preparing…' : 'Export CSV'}
          </button>
        }
      />
      <ErrorNotice error={summary.error ?? list.error ?? exportError} retry={() => void summary.refetch()} />
      {summary.isPending ? (
        <Loading label="Loading warranty and AMC…" />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Cover type" className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
              {(['warranty', 'amc'] as const).map((k) => (
                <button
                  key={k}
                  role="tab"
                  type="button"
                  aria-selected={kind === k}
                  onClick={() => set('cover', k === 'warranty' ? '' : k)}
                  className={cx(
                    'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                    kind === k ? 'bg-navy-700 text-white' : 'text-gray-600 hover:text-navy-700',
                  )}
                >
                  {k === 'amc' ? 'AMC' : 'Warranty'}
                </button>
              ))}
            </div>
            <p className="text-sm text-gray-500">
              {needs
                ? `${plural(needs, 'asset')} need${needs === 1 ? 's' : ''} attention: ${plain(counts?.expired)} ended, ${plain(counts?.due30)} ending within 30 days.`
                : `No ${word.toLowerCase()} ends in the next 30 days.`}{' '}
              {otherNeeds ? `${kind === 'amc' ? 'Warranty' : 'AMC'}: ${plain(otherNeeds)} need attention.` : ''}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {tile('all', 'All assets', s?.total, 'In your view')}
            {tile('expired', 'Expired', counts?.expired, `${word} has ended`)}
            {tile('due30', 'Within 30 days', counts?.due30, 'Renew or plan now')}
            {tile('due90', 'In 31–90 days', counts?.due90, 'Coming up')}
            {tile('active', 'Covered', counts?.active, 'More than 90 days left')}
            {kind === 'amc'
              ? tile('none', 'No AMC', counts?.none, `${plain(counts?.missing)} have AMC but no date`)
              : tile('missing', 'Not recorded', counts?.missing, 'Add the end date')}
          </div>

          <Card title={`${word} ending in the next 12 months`}>
            <ColumnChart
              items={(s?.months ?? []).map((m) => ({
                label: new Date(m.month).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
                value: kind === 'amc' ? m.amc : m.warranty,
              }))}
              format={(v) => plural(v, 'asset')}
              shortFormat={(v) => String(v)}
              valueLabel="Assets"
              labelHeader="Month"
              empty={`No ${word.toLowerCase()} ends in the next 12 months`}
            />
          </Card>

          <Panel
            title={`${word} register`}
            action={
              <span className="text-sm text-gray-500">
                {show ? `${STATE_WORDS[show]} · ` : ''}most urgent first
              </span>
            }
          >
            <FilterRow
              search={search}
              setSearch={setSearch}
              placeholder="Search code, model, serial or person"
              teams={s?.teams ?? []}
              team={team}
              setTeam={(v) => set('team', v)}
              showClear={!!(show || team || search)}
              onClear={() => {
                setSearch('');
                set('show', '');
                set('team', '');
              }}
            />
            {list.isPending ? (
              <Loading />
            ) : rows.length ? (
              <>
                <div className={tableWrapClass}>
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Held by</th>
                        <th>Warranty</th>
                        <th>AMC</th>
                        <th>Team</th>
                        <th>Location</th>
                        {canEdit ? <th aria-label="Actions" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <AssetCell row={r} />
                          </td>
                          <td>
                            <Custodian row={r} />
                          </td>
                          <td>
                            <CoverCell state={warrantyState(r)} date={r.warrantyExpiry} days={r.warrantyDaysRemaining} />
                          </td>
                          <td>
                            <CoverCell state={amcState(r)} date={r.amcExpiry} days={r.amcDaysRemaining} />
                          </td>
                          <td>{r.owningTeam ?? '—'}</td>
                          <td className="max-w-56 text-sm text-gray-600">{r.location ?? '—'}</td>
                          {canEdit ? (
                            <td>
                              <Link
                                to={`/assets/${r.id}/edit`}
                                className={buttonClass('secondary', 'sm')}
                                aria-label={`Update warranty and AMC for ${r.assetCode}`}
                              >
                                Update
                              </Link>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <LoadMore available={list.hasNextPage} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} />
              </>
            ) : (
              <Empty title="Nothing matches">Try another filter or clear the search.</Empty>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------- insurance page */

export function Insurance() {
  const { user } = useSession();
  const summary = useCareSummary('insurance');
  const { params, set, search, setSearch } = useRegisterFilters();
  const show = (params.get('show') ?? '') as CoverState | '';
  const team = params.get('team') ?? '';
  const filters = { show: show || undefined, teamId: team || undefined, q: params.get('q') || undefined };
  const list = usePages<CareRow>(LIST_PATH.insurance, filters);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const s = summary.data;
  const c = s?.insurance ?? null;
  const covered = (c?.active ?? 0) + (c?.due30 ?? 0) + (c?.due90 ?? 0);
  const uncovered = (c?.missing ?? 0) + (c?.expired ?? 0);
  const hasCost = !!s?.value;
  const canEdit = can(user, 'asset.finance_edit') || can(user, 'asset.edit');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  async function exportRows() {
    setExporting(true);
    setExportError(null);
    try {
      const all = await fetchAllPages<CareRow>(LIST_PATH.insurance, filters);
      downloadCsv(
        'insurance-register',
        ['Asset', 'Name', 'Type', 'Team', 'Held by', 'Location', 'Purchase date', 'Purchase cost', 'Policy number', 'Cover ends', 'Status', 'Repairs'],
        all.map((r) => [
          r.assetCode,
          [r.manufacturer, r.model].filter(Boolean).join(' ') || r.description,
          r.assetType,
          r.owningTeam,
          r.custodian?.name ?? '',
          r.location,
          r.purchaseDate?.slice(0, 10),
          r.purchaseCost,
          r.insurancePolicyNumber,
          r.insuranceExpiry?.slice(0, 10),
          insuranceState(r) === 'missing' ? 'Not insured' : STATE_WORDS[insuranceState(r)],
          r.repairCount,
        ]),
      );
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  }

  const tile = (state: CoverState | 'all', label: string, value: number | undefined, detail: string) => (
    <SnapTile
      label={label}
      value={plain(value)}
      detail={detail}
      state={state}
      active={state === 'all' ? !show : show === state}
      onClick={() => set('show', state === 'all' || show === state ? '' : state)}
    />
  );

  return (
    <>
      <PageTitle
        eyebrow="ASSET CARE"
        title="Insurance"
        description="Insurance pays to repair or replace an asset if it is stolen, damaged or lost. Each asset should carry its policy number and the date its cover ends, so cover can be renewed before it lapses."
        action={
          <button type="button" className={buttonClass('secondary')} onClick={() => void exportRows()} disabled={exporting || !rows.length}>
            {exporting ? 'Preparing…' : 'Export CSV'}
          </button>
        }
      />
      <ErrorNotice error={summary.error ?? list.error ?? exportError} retry={() => void summary.refetch()} />
      {summary.isPending ? (
        <Loading label="Loading insurance…" />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {tile('all', 'All assets', s?.total, 'In your view')}
            {tile('active', 'Insured', c?.active, 'More than 90 days of cover')}
            {tile('due30', 'Renew within 30 days', c?.due30, 'Cover ends soon')}
            {tile('due90', 'Renew in 31–90 days', c?.due90, 'Plan the renewal')}
            {tile('expired', 'Cover expired', c?.expired, 'Not protected now')}
            {tile('missing', 'Not insured', c?.missing, 'No cover end date recorded')}
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card title="Cover at a glance" className="lg:col-span-2">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
                <div>
                  <dt className="text-xs text-gray-500">Assets with cover</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-navy-900 tabular-nums">
                    {s?.total ? Math.round((covered / s.total) * 100) : 0}%
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Without cover</dt>
                  <dd className="mt-0.5 text-lg font-semibold text-red-700 tabular-nums">{plain(uncovered)}</dd>
                </div>
                {s?.value ? (
                  <>
                    <div>
                      <dt className="text-xs text-gray-500">Value insured</dt>
                      <dd className="mt-0.5 text-lg font-semibold text-navy-900 tabular-nums">{inr(s.value.insured)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Value at risk (no cover)</dt>
                      <dd className="mt-0.5 text-lg font-semibold text-red-700 tabular-nums">{inr(s.value.atRisk)}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              <div className="mt-5 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-600">
                <strong className="block font-semibold text-gray-800">Who looks after this</strong>
                Finance records the policy number and cover end date on each asset (Edit asset → Insurance). Team
                leads can see their own team’s cover here and on their dashboard, and raise a renewal with Finance
                before it ends.
              </div>
            </Card>
            <Card title="Most valuable assets without cover" className="lg:col-span-3">
              {!hasCost ? (
                <EmptyChart>Purchase values are not shown for your role</EmptyChart>
              ) : s?.biggestGaps.length ? (
                <ul className="divide-y divide-gray-100">
                  {s.biggestGaps.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <Link to={`/assets/${r.id}`} className="font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                        {r.assetCode}
                      </Link>
                      <span className="min-w-0 flex-1 truncate text-gray-700">{r.name}</span>
                      <span className="font-medium text-gray-900 tabular-nums">{inr(r.cost)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Every valued asset has cover</EmptyChart>
              )}
            </Card>
          </div>

          <Panel
            title="Insurance register"
            action={<span className="text-sm text-gray-500">{show ? `${STATE_WORDS[show]} · ` : ''}most urgent and valuable first</span>}
          >
            <FilterRow
              search={search}
              setSearch={setSearch}
              placeholder="Search code, model, policy or person"
              teams={s?.teams ?? []}
              team={team}
              setTeam={(v) => set('team', v)}
              showClear={!!(show || team || search)}
              onClear={() => {
                setSearch('');
                set('show', '');
                set('team', '');
              }}
            />
            {list.isPending ? (
              <Loading />
            ) : rows.length ? (
              <>
                <div className={tableWrapClass}>
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Held by</th>
                        <th>Cover</th>
                        <th>Policy number</th>
                        {hasCost ? <th className="text-right">Purchase cost</th> : null}
                        <th>Location</th>
                        <th className="text-right">Repairs</th>
                        {canEdit ? <th aria-label="Actions" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <AssetCell row={r} />
                          </td>
                          <td>
                            <Custodian row={r} />
                          </td>
                          <td>
                            <CoverCell
                              state={insuranceState(r)}
                              date={r.insuranceExpiry}
                              days={r.insuranceDaysRemaining}
                              missingLabel={r.insurancePolicyNumber ? 'End date missing' : 'Not insured'}
                            />
                          </td>
                          <td className="font-mono text-xs">{r.insurancePolicyNumber || '—'}</td>
                          {hasCost ? (
                            <td className="text-right tabular-nums">{r.purchaseCost != null ? inr(r.purchaseCost) : '—'}</td>
                          ) : null}
                          <td className="max-w-56 text-sm text-gray-600">{r.location ?? '—'}</td>
                          <td className="text-right tabular-nums">{r.repairCount}</td>
                          {canEdit ? (
                            <td>
                              <Link to={`/assets/${r.id}/edit`} className={buttonClass('secondary', 'sm')}>
                                Update
                              </Link>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <LoadMore available={list.hasNextPage} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} />
              </>
            ) : (
              <Empty title="Nothing matches">Try another filter or clear the search.</Empty>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------- dashboard panel */

function CareRowLink({ to, state, label, count }: { to: string; state: CoverState; label: string; count: number | undefined }) {
  return (
    <li>
      <Link
        to={to}
        className={cx('flex items-center gap-3 rounded-md px-1 py-2 no-underline hover:bg-gray-50', !count && 'opacity-60')}
      >
        <span className={cx('size-2 shrink-0 rounded-full', dotTone[state])} aria-hidden="true" />
        <span className="flex-1 truncate text-sm text-gray-800">{label}</span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums">{plain(count)}</span>
      </Link>
    </li>
  );
}

const coverWord: Record<Cover, string> = { warranty: 'Warranty', amc: 'AMC', insurance: 'Insurance' };

/**
 * Dashboard card: warranty, AMC and insurance numbers that need attention, each opening the
 * matching filtered register. Shown to everyone who can open those pages (admins, leadership,
 * Finance, auditors, the insurer, and team leads and members for their own team).
 */
export function AssetCareCard() {
  const { user } = useSession();
  const seeWarranty = canSeeWarranty(user);
  const seeInsurance = canSeeInsurance(user);
  const warranty = useCareSummary('warranty', seeWarranty);
  const insurance = useCareSummary('insurance', seeInsurance);
  if (!seeWarranty && !seeInsurance) return null;
  const w = warranty.data?.warranty;
  const a = warranty.data?.amc;
  const i = insurance.data?.insurance;
  const next = [...(warranty.data?.soonest ?? []), ...(insurance.data?.soonest.filter((x) => x.cover === 'insurance') ?? [])]
    .filter((x, idx, list) => list.findIndex((y) => y.id === x.id && y.cover === x.cover) === idx)
    .sort((x, y) => x.days - y.days)
    .slice(0, 5);
  const loading = (seeWarranty && warranty.isPending) || (seeInsurance && insurance.isPending);
  const viewLink = (to: string) => (
    <Link to={to} className="text-xs font-medium text-navy-700 no-underline hover:underline">
      Open
    </Link>
  );

  return (
    <>
      <ErrorNotice error={warranty.error ?? insurance.error} />
      <div className="grid gap-6 lg:grid-cols-3">
        {seeWarranty ? (
          <Card title="Warranty & AMC" action={viewLink('/warranty-expiry')}>
            {loading ? (
              <Loading />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">Warranty</h3>
                  <ul>
                    <CareRowLink to="/warranty-expiry?show=expired" state="expired" label="Expired" count={w?.expired} />
                    <CareRowLink to="/warranty-expiry?show=due30" state="due30" label="Within 30 days" count={w?.due30} />
                    <CareRowLink to="/warranty-expiry?show=due90" state="due90" label="In 31–90 days" count={w?.due90} />
                    <CareRowLink to="/warranty-expiry?show=missing" state="missing" label="Not recorded" count={w?.missing} />
                  </ul>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">AMC</h3>
                  <ul>
                    <CareRowLink to="/warranty-expiry?cover=amc&show=expired" state="expired" label="Expired" count={a?.expired} />
                    <CareRowLink to="/warranty-expiry?cover=amc&show=due30" state="due30" label="Within 30 days" count={a?.due30} />
                    <CareRowLink to="/warranty-expiry?cover=amc&show=due90" state="due90" label="In 31–90 days" count={a?.due90} />
                    <CareRowLink to="/warranty-expiry?cover=amc&show=missing" state="missing" label="No end date" count={a?.missing} />
                  </ul>
                </div>
              </div>
            )}
          </Card>
        ) : null}
        {seeInsurance ? (
          <Card title="Insurance" action={viewLink('/insurance')}>
            {loading ? (
              <Loading />
            ) : (
              <ul>
                <CareRowLink to="/insurance?show=expired" state="expired" label="Cover expired" count={i?.expired} />
                <CareRowLink to="/insurance?show=due30" state="due30" label="Renew within 30 days" count={i?.due30} />
                <CareRowLink to="/insurance?show=due90" state="due90" label="Renew in 31–90 days" count={i?.due90} />
                <CareRowLink to="/insurance?show=missing" state="missing" label="Not insured" count={i?.missing} />
                <CareRowLink to="/insurance?show=active" state="active" label="Insured" count={i?.active} />
              </ul>
            )}
          </Card>
        ) : null}
        <Card title="Ending in the next 90 days" className={seeWarranty && seeInsurance ? '' : 'lg:col-span-2'}>
          {loading ? (
            <Loading />
          ) : next.length ? (
            <ul className="divide-y divide-gray-100">
              {next.map((x) => (
                <li key={`${x.id}-${x.cover}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className={cx('size-2 shrink-0 rounded-full', dotTone[x.days <= 30 ? 'due30' : 'due90'])} aria-hidden="true" />
                  <Link to={`/assets/${x.id}`} className="font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                    {x.assetCode}
                  </Link>
                  <span className="flex-1 truncate text-gray-700">{coverWord[x.cover]}</span>
                  <span className="text-xs whitespace-nowrap text-gray-500">
                    {x.days === 0 ? 'Today' : `${x.days}d · ${displayDate(x.date)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyChart>Nothing ends in the next 90 days</EmptyChart>
          )}
        </Card>
      </div>
    </>
  );
}
