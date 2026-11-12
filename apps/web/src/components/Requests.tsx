import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import type { Asset } from '../types';
import { EmptyChart } from './charts';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  PersonChip,
  buttonClass,
  cx,
  displayDate,
  inputClass,
} from './ui';

interface CatalogItem {
  assetTypeCode: string;
  categoryCode: string;
  teamCode: string | null;
  inStock: number;
}
interface RequestLine {
  id: string;
  assetType: string;
  category: string;
  quantity: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FULFILLED' | 'CANCELLED';
  decisionNote: string | null;
  teamCode: string | null;
}
interface MyRequest {
  id: string;
  requestNumber: number;
  neededBy: string | null;
  remarks: string | null;
  createdAt: string;
  status: RequestLine['status'];
  items: RequestLine[];
}
interface QueueLine {
  id: string;
  assetTypeCode: string;
  quantity: number;
  status: string;
  teamCode: string | null;
  requestNumber: number;
  neededBy: string | null;
  remarks: string | null;
  createdAt: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  requesterHasPhoto: boolean;
  inStock: number;
}

const statusLabel: Record<string, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
  FULFILLED: 'Handed over',
  CANCELLED: 'Cancelled',
};
const statusTone: Record<string, string> = {
  PENDING: 'PENDING',
  APPROVED: 'OPEN',
  REJECTED: 'REJECTED',
  FULFILLED: 'COMPLETED',
  CANCELLED: 'Retired',
};
const initials = (s: string) =>
  s
    .split(/[\s/&-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-gray-300 bg-white">
      <button
        type="button"
        aria-label="Fewer"
        className="grid size-8 place-items-center text-gray-600 hover:text-navy-700 disabled:opacity-40"
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="w-7 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="More"
        className="grid size-8 place-items-center text-gray-600 hover:text-navy-700 disabled:opacity-40"
        disabled={value >= 50}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  );
}

function AskForItems({ onCreated }: { onCreated: () => void }) {
  const catalog = useQuery({
    queryKey: ['request-catalog'],
    queryFn: ({ signal }) => api<{ items: CatalogItem[] }>('/requests/catalog', { signal }),
  });
  const action = useAction<{ requestNumber: number }>();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [neededBy, setNeededBy] = useState('');
  const [remarks, setRemarks] = useState('');
  const [message, setMessage] = useState('');
  const items = catalog.data?.items ?? [];
  const categories = useMemo(() => [...new Set(items.map((i) => i.categoryCode))].sort(), [items]);
  const shown = items.filter(
    (i) =>
      (!category || i.categoryCode === category) &&
      (!search.trim() ||
        `${i.assetTypeCode} ${i.categoryCode}`.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const cartLines = Object.entries(cart);

  async function submit() {
    if (!cartLines.length || action.isPending) return;
    const result = await action
      .mutateAsync({
        path: '/requests',
        method: 'POST',
        body: {
          items: cartLines.map(([assetType, quantity]) => ({ assetType, quantity })),
          neededBy: neededBy || null,
          remarks: remarks.trim() || null,
        },
      })
      .catch(() => undefined);
    if (result) {
      setCart({});
      setNeededBy('');
      setRemarks('');
      setMessage(`Request #${result.requestNumber} sent. The team lead will review each item.`);
      onCreated();
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label="Search" htmlFor="req-search">
              <input
                id="req-search"
                type="search"
                className={inputClass}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Laptop, chair, therapy swing…"
              />
            </Field>
          </div>
          <div className="min-w-48">
            <Field label="Category" htmlFor="req-category">
              <select
                id="req-category"
                className={inputClass}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
        {catalog.isPending ? (
          <Loading label="Loading items…" />
        ) : shown.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((item) => {
              const inCart = cart[item.assetTypeCode];
              return (
                <li
                  key={item.assetTypeCode}
                  className={cx(
                    'flex flex-col rounded-xl border p-4',
                    inCart ? 'border-navy-300 bg-navy-50/40' : 'border-gray-200 bg-white',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="grid size-10 shrink-0 place-items-center rounded-lg bg-navy-50 text-sm font-semibold text-navy-700"
                      aria-hidden="true"
                    >
                      {initials(item.assetTypeCode)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {item.assetTypeCode}
                      </p>
                      <p className="truncate text-xs text-gray-500">{item.categoryCode}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    {/* Stock is deliberately not shown to requesters: anyone may ask for anything;
                        the handling team sees stock when deciding. */}
                    <span className="text-xs text-gray-500">
                      {item.teamCode ? `Handled by ${item.teamCode}` : ''}
                    </span>
                    {inCart ? (
                      <Stepper
                        value={inCart}
                        onChange={(n) => setCart({ ...cart, [item.assetTypeCode]: n })}
                      />
                    ) : (
                      <button
                        type="button"
                        className={buttonClass('secondary', 'sm')}
                        onClick={() => setCart({ ...cart, [item.assetTypeCode]: 1 })}
                      >
                        Add
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyChart>Nothing matches that search</EmptyChart>
        )}
      </Panel>

      <aside className="sticky top-20 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-navy-900">Your request</h2>
        {message ? (
          <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800" role="status">
            {message}
          </p>
        ) : null}
        <ErrorNotice error={action.error} />
        {cartLines.length ? (
          <ul className="mt-3 divide-y divide-gray-100">
            {cartLines.map(([type, qty]) => (
              <li key={type} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{type}</span>
                <Stepper value={qty} onChange={(n) => setCart({ ...cart, [type]: n })} />
                <button
                  type="button"
                  aria-label={`Remove ${type}`}
                  className="grid size-7 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-red-700"
                  onClick={() => {
                    const next = { ...cart };
                    delete next[type];
                    setCart(next);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">Add items from the list to start a request.</p>
        )}
        <div className="mt-4 flex flex-col gap-3">
          <Field label="Needed by (optional)" htmlFor="req-needed">
            <input
              id="req-needed"
              type="date"
              className={inputClass}
              value={neededBy}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </Field>
          <Field label="Remarks (optional)" htmlFor="req-remarks">
            <textarea
              id="req-remarks"
              rows={3}
              maxLength={1000}
              className={cx(inputClass, 'h-auto py-2')}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="What it is for, where it is needed"
            />
          </Field>
          <button
            type="button"
            className={cx(buttonClass(), 'w-full')}
            disabled={!cartLines.length || action.isPending}
            onClick={() => void submit()}
          >
            {action.isPending
              ? 'Sending…'
              : `Send request${cartLines.length ? ` (${cartLines.length})` : ''}`}
          </button>
        </div>
      </aside>
    </div>
  );
}

function MyRequests() {
  const mine = useQuery({
    queryKey: ['my-requests'],
    queryFn: ({ signal }) => api<{ items: MyRequest[] }>('/requests/mine', { signal }),
  });
  const cancel = useAction();
  if (mine.isPending) return <Loading label="Loading your requests…" />;
  if (!mine.data?.items.length)
    return (
      <Panel>
        <Empty title="No requests yet">Ask for items from the first tab.</Empty>
      </Panel>
    );
  return (
    <div className="flex flex-col gap-4">
      <ErrorNotice error={mine.error ?? cancel.error} />
      {mine.data.items.map((r) => (
        <section key={r.id} className="rounded-xl border border-gray-200 bg-white p-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-navy-900">Request #{r.requestNumber}</h2>
              <p className="text-xs text-gray-500">
                Sent {displayDate(r.createdAt)}
                {r.neededBy ? ` · needed by ${displayDate(r.neededBy)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge value={statusTone[r.status]} label={statusLabel[r.status]} />
              {r.status === 'PENDING' && r.items.every((i) => i.status === 'PENDING') ? (
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  disabled={cancel.isPending}
                  onClick={() => {
                    if (!window.confirm(`Cancel request #${r.requestNumber}?`)) return;
                    void cancel
                      .mutateAsync({ path: `/requests/${r.id}/cancel`, method: 'POST', body: {} })
                      .then(
                        () => mine.refetch(),
                        () => undefined,
                      );
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </header>
          {r.remarks ? <p className="mt-2 text-sm text-gray-600">{r.remarks}</p> : null}
          <ul className="mt-3 divide-y divide-gray-100">
            {r.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="w-10 text-gray-500 tabular-nums">{i.quantity} ×</span>
                <span className="min-w-0 flex-1 text-gray-900">
                  {i.assetType}
                  <span className="text-xs text-gray-400"> · {i.category}</span>
                </span>
                <Badge value={statusTone[i.status]} label={statusLabel[i.status]} />
                {i.decisionNote && i.status !== 'PENDING' ? (
                  <span className="basis-full pl-13 text-xs text-gray-500">“{i.decisionNote}”</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Hand over an approved request line in one go: pick in-store assets of the requested type,
 * assign each to the requester (they get the usual custody notice to confirm), then close the line.
 */
function HandOverDrawer({
  line,
  onClose,
  onDone,
}: {
  line: QueueLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const stock = useQuery({
    queryKey: ['handover-stock', line.assetTypeCode],
    queryFn: ({ signal }) =>
      api<{ items: Asset[] }>(
        `/assets?status=${encodeURIComponent('In Store')}&assetType=${encodeURIComponent(line.assetTypeCode)}&limit=50`,
        { signal },
      ),
  });
  const act = useAction();
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState('');
  const available = (stock.data?.items ?? []).filter((a) => !a.currentAssignment);
  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < line.quantity ? [...p, id] : p,
    );

  async function handOver() {
    const assets = available.filter((a) => picked.includes(a.id));
    const done: string[] = [];
    for (const asset of assets) {
      setProgress(`Assigning ${asset.assetCode}…`);
      const ok = await act
        .mutateAsync({
          path: `/assets/${asset.id}/assignments`,
          body: {
            userId: line.requesterId,
            note: note.trim() || `Request #${line.requestNumber}`,
          },
          version: asset.version,
          idempotent: true,
        })
        .then(
          () => true,
          () => false,
        );
      if (!ok) {
        setProgress(
          done.length
            ? `${done.length} assigned before the error. Fix the problem and try the rest again.`
            : '',
        );
        return;
      }
      done.push(asset.id);
    }
    setProgress('Closing the request…');
    const closed = await act
      .mutateAsync({
        path: `/requests/items/${line.id}/fulfil`,
        method: 'POST',
        body: { assetIds: done },
      })
      .then(
        () => true,
        () => false,
      );
    if (closed) onDone();
    else setProgress('Assets are assigned, but the request could not be closed. Try again.');
  }

  return (
    <Drawer
      open
      title={`Hand over ${line.quantity} × ${line.assetTypeCode}`}
      description={`Request #${line.requestNumber} for ${line.requesterName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass('secondary')} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonClass()}
            disabled={
              act.isPending ||
              picked.length !== Math.min(line.quantity, available.length) ||
              !picked.length
            }
            onClick={() => void handOver()}
          >
            {act.isPending ? 'Handing over…' : `Hand over ${picked.length || ''}`.trim()}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorNotice error={act.error} />
        {progress ? (
          <p className="rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900" role="status">
            {progress}
          </p>
        ) : null}
        <p className="text-sm text-gray-600">
          Choose {line.quantity === 1 ? 'the asset' : `up to ${line.quantity} assets`} to give. Each
          is assigned to {line.requesterName}, who confirms receipt on My assets.
        </p>
        {stock.isPending ? (
          <Loading label="Checking the store…" />
        ) : available.length ? (
          <ul className="flex flex-col gap-2">
            {available.map((a) => {
              const on = picked.includes(a.id);
              return (
                <li key={a.id}>
                  <label
                    className={cx(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5',
                      on ? 'border-navy-300 bg-navy-50' : 'border-gray-200 hover:bg-gray-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-navy-700"
                      checked={on}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-navy-700">{a.assetCode}</span>
                      <span className="block truncate text-xs text-gray-500">
                        {a.description}
                        {a.serialNumber ? ` · ${a.serialNumber}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-900">
            <p className="font-medium">None in store.</p>
            <p className="mt-0.5">
              This item has to be bought or received into the store first. It stays here as “To buy”
              until then.
            </p>
          </div>
        )}
        {available.length && available.length < line.quantity ? (
          <p className="text-xs text-yellow-800">
            Only {available.length} in store. Hand these over now; the line closes for what you
            give.
          </p>
        ) : null}
        <Field label="Handover note (optional)" htmlFor="handover-note">
          <input
            id="handover-note"
            className={inputClass}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Request #${line.requestNumber}`}
          />
        </Field>
        <button
          type="button"
          className="self-start text-xs text-gray-500 underline hover:text-navy-700"
          disabled={act.isPending}
          onClick={() => {
            if (
              !window.confirm(
                'Close this line without assigning an asset (for example a consumable)?',
              )
            )
              return;
            void act
              .mutateAsync({ path: `/requests/items/${line.id}/fulfil`, method: 'POST', body: {} })
              .then(onDone, () => undefined);
          }}
        >
          Close without assigning an asset
        </button>
      </div>
    </Drawer>
  );
}

function TeamRequests() {
  const queue = useQuery({
    queryKey: ['request-queue'],
    queryFn: ({ signal }) =>
      api<{ toDecide: QueueLine[]; toFulfil: QueueLine[] }>('/requests/queue', { signal }),
  });
  const act = useAction();
  const { user } = useSession();
  const [handing, setHanding] = useState<QueueLine | null>(null);
  const refresh = () => void queue.refetch();
  const decide = (line: QueueLine, decision: 'APPROVE' | 'REJECT') => {
    const reason = window.prompt(
      decision === 'APPROVE'
        ? `Approve ${line.quantity} × ${line.assetTypeCode}? Add a short note:`
        : `Why is ${line.quantity} × ${line.assetTypeCode} not approved?`,
      decision === 'APPROVE' ? 'Approved' : '',
    );
    if (!reason?.trim()) return;
    void act
      .mutateAsync({
        path: `/requests/items/${line.id}/decision`,
        method: 'POST',
        body: { decision, reason: reason.trim() },
      })
      .then(refresh, () => undefined);
  };
  const row = (line: QueueLine, actions: React.ReactNode) => (
    <li key={line.id} className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900">
          {line.quantity} × {line.assetTypeCode}
          <span className="ml-2 text-xs font-normal text-gray-500">
            Request #{line.requestNumber}
            {line.neededBy ? ` · needed by ${displayDate(line.neededBy)}` : ''}
          </span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <PersonChip
            userId={line.requesterId}
            name={line.requesterName}
            hasPhoto={line.requesterHasPhoto}
            email={line.requesterEmail}
            size={24}
          />
          {line.remarks ? <span className="text-xs text-gray-500">“{line.remarks}”</span> : null}
        </div>
      </div>
      {line.inStock > 0 ? (
        <Badge value="In Stock" label={`${line.inStock} in store`} />
      ) : line.status === 'APPROVED' ? (
        <Badge value="Out of stock" label="To buy" />
      ) : (
        <Badge value="Out of stock" label="Out of stock" />
      )}
      <div className="flex flex-nowrap gap-2">{actions}</div>
    </li>
  );
  if (queue.isPending) return <Loading label="Loading team requests…" />;
  const toDecide = queue.data?.toDecide ?? [];
  const toFulfil = queue.data?.toFulfil ?? [];
  return (
    <div className="flex flex-col gap-6">
      <ErrorNotice error={queue.error ?? act.error} />
      <Panel title={`Waiting for a decision${toDecide.length ? ` · ${toDecide.length}` : ''}`}>
        {toDecide.length ? (
          <ul className="divide-y divide-gray-100">
            {toDecide.map((line) =>
              row(
                line,
                line.requesterId === user?.id ? (
                  <span className="text-xs text-gray-400">Your own request</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className={buttonClass('primary', 'sm')}
                      disabled={act.isPending}
                      onClick={() => decide(line, 'APPROVE')}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={buttonClass('secondary', 'sm')}
                      disabled={act.isPending}
                      onClick={() => decide(line, 'REJECT')}
                    >
                      Reject
                    </button>
                  </>
                ),
              ),
            )}
          </ul>
        ) : (
          <EmptyChart>Nothing waiting for a decision</EmptyChart>
        )}
      </Panel>
      <Panel title={`Approved, to hand over${toFulfil.length ? ` · ${toFulfil.length}` : ''}`}>
        {toFulfil.length ? (
          <ul className="divide-y divide-gray-100">
            {toFulfil.map((line) =>
              row(
                line,
                <button
                  type="button"
                  className={buttonClass(line.inStock > 0 ? 'primary' : 'secondary', 'sm')}
                  onClick={() => setHanding(line)}
                >
                  Hand over
                </button>,
              ),
            )}
          </ul>
        ) : (
          <EmptyChart>Nothing approved is waiting to be handed over</EmptyChart>
        )}
        <p className="mt-3 text-xs text-gray-500">
          Hand over picks an asset from the store, assigns it to the requester and closes the line.
          Items marked To buy need to be purchased or received into the store first.
        </p>
      </Panel>
      {handing ? (
        <HandOverDrawer
          line={handing}
          onClose={() => setHanding(null)}
          onDone={() => {
            setHanding(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Requests: ask for items, follow your requests, and (for teams) decide and hand them over. */
export function Requests() {
  const { user } = useSession();
  const team = (user?.teams?.length ?? 0) > 0 || (user?.roles.includes('SUPER_ADMIN') ?? false);
  const [tab, setTab] = useState<'ask' | 'mine' | 'team'>('ask');
  const tabs = [
    { key: 'ask' as const, label: 'Ask for items' },
    { key: 'mine' as const, label: 'My requests' },
    ...(team ? [{ key: 'team' as const, label: 'Team requests' }] : []),
  ];
  return (
    <>
      <PageTitle
        eyebrow="My workspace"
        title="Requests"
        description="Ask for equipment you need. The team that looks after it approves and hands it over."
      />
      <div className="mb-5 flex flex-wrap gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={buttonClass(tab === t.key ? 'primary' : 'secondary', 'sm')}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'ask' ? <AskForItems onCreated={() => undefined} /> : null}
      {tab === 'mine' ? <MyRequests /> : null}
      {tab === 'team' ? <TeamRequests /> : null}
    </>
  );
}
