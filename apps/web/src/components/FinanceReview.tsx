import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAction, usePages } from '../hooks';
import { can, useSession } from '../session';
import type { Asset, FinanceQueueItem, InvoiceMeta, ProposedField } from '../types';
import { useReferences } from './References';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  displayDate,
} from './ui';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/jpeg,image/png';

export function financeBadge(asset: Pick<Asset, 'financeStatus' | 'financeRejectionReason'>) {
  if (asset.financeStatus === 'REJECTED')
    return <Badge value="REJECTED" label={`Rejected: ${asset.financeRejectionReason ?? ''}`} />;
  if (asset.financeStatus === 'PENDING') return <Badge value="PENDING" label="Pending Finance" />;
  if (asset.financeStatus === 'APPROVED') return <Badge value="ACTIVE" label="Finance approved" />;
  return null;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

const useInvoices = (assetId: string) =>
  useQuery({
    queryKey: ['asset-invoices', assetId],
    queryFn: ({ signal }) =>
      api<{ items: InvoiceMeta[] }>(`/assets/${assetId}/invoices`, { signal }),
    // Keep checking while the worker is still reading the newest invoice.
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => i.extractionState === 'PENDING') ? 3000 : false,
  });

export function InvoicePreview({ invoice }: { invoice: InvoiceMeta }) {
  const src = `/api/v1/invoices/${invoice.id}/file`;
  return (
    <div className="invoice-preview">
      {invoice.mime === 'application/pdf' ? (
        <iframe title={`Invoice ${invoice.originalName}`} src={src} />
      ) : (
        <img src={src} alt={`Invoice ${invoice.originalName}`} />
      )}
      <a className="button secondary small" href={src} target="_blank" rel="noreferrer">
        Open / download
      </a>
    </div>
  );
}

function ExtractionNote({ invoice }: { invoice: InvoiceMeta }) {
  if (invoice.extractionState === 'PENDING')
    return (
      <div className="notice" role="status">
        Reading invoice…
      </div>
    );
  if (invoice.extractionState === 'FAILED')
    return (
      <div className="notice warning" role="status">
        {invoice.extractionError ?? 'The invoice could not be read'} Enter the values by hand.
      </div>
    );
  return null;
}

/** Status badge, invoice upload and resubmit control shown on the asset detail page. */
export function FinanceStatusPanel({ asset }: { asset: Asset }) {
  const { user } = useSession();
  const team = asset.owningTeamId ?? undefined;
  const mayUpload = can(user, 'asset.edit', team) || can(user, 'asset.finance_edit');
  const invoices = useInvoices(asset.id);
  const queryClient = useQueryClient();
  const action = useAction();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!asset.financeStatus || !can(user, 'asset.view_private')) return null;
  const refresh = () => void queryClient.invalidateQueries();
  async function upload(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    if (file.size > MAX_BYTES) return setError(new Error('Choose a file up to 10 MB'));
    setBusy(true);
    try {
      await api(`/assets/${asset.id}/invoices`, {
        method: 'POST',
        body: { dataUrl: await readDataUrl(file), fileName: file.name },
      });
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <Panel title="Finance & invoices" className="finance-status-panel">
      <p>{financeBadge(asset)}</p>
      {asset.financeStatus === 'REJECTED' ? (
        <div className="notice danger" role="status">
          <strong>Finance sent this back</strong>
          <p>{asset.financeRejectionReason}</p>
          {mayUpload ? (
            <button
              type="button"
              className="button small"
              disabled={action.isPending}
              onClick={() =>
                void action
                  .mutateAsync({ path: `/finance/assets/${asset.id}/resubmit` })
                  .then(refresh, () => undefined)
              }
            >
              Resubmit for review
            </button>
          ) : null}
        </div>
      ) : null}
      <ErrorNotice error={error ?? action.error} />
      {invoices.data?.items.length ? (
        <ul className="invoice-list">
          {invoices.data.items.map((invoice) => (
            <li key={invoice.id}>
              <a href={`/api/v1/invoices/${invoice.id}/file`} target="_blank" rel="noreferrer">
                {invoice.originalName}
              </a>{' '}
              <span className="muted">
                {displayDate(invoice.uploadedAt)} ·{' '}
                {invoice.extractionState === 'PENDING'
                  ? 'Reading invoice…'
                  : invoice.extractionState === 'DONE'
                    ? 'Fields read'
                    : 'Needs manual entry'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No invoice uploaded yet.</p>
      )}
      {mayUpload ? (
        <div className="actions">
          <input
            ref={input}
            id={`invoice-file-${asset.id}`}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? 'Uploading…' : 'Upload invoice'}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

type FormValues = Record<'supplier' | 'invoiceNumber' | 'purchaseDate' | 'purchaseCost', string>;
const FIELD_SOURCE: Record<keyof FormValues, 'supplier' | 'invoiceNumber' | 'invoiceDate' | 'totalAmount'> =
  {
    supplier: 'supplier',
    invoiceNumber: 'invoiceNumber',
    purchaseDate: 'invoiceDate',
    purchaseCost: 'totalAmount',
  };
const LABELS: Record<keyof FormValues, string> = {
  supplier: 'Supplier',
  invoiceNumber: 'Invoice number',
  purchaseDate: 'Purchase date (invoice date)',
  purchaseCost: 'Purchase cost (INR, total)',
};

function ReviewForm({
  asset,
  invoice,
  onDone,
}: {
  asset: Asset;
  invoice: InvoiceMeta | undefined;
  onDone: () => void;
}) {
  const proposals = invoice?.extractionState === 'DONE' ? invoice.fields : {};
  const initial = (name: keyof FormValues) => {
    const proposed = proposals[FIELD_SOURCE[name]];
    if (proposed) return proposed.value;
    const current = String((asset as Record<string, unknown>)[name] ?? '');
    return name === 'purchaseDate' ? current.slice(0, 10) : current;
  };
  const [values, setValues] = useState<FormValues>(() => ({
    supplier: initial('supplier'),
    invoiceNumber: initial('invoiceNumber'),
    purchaseDate: initial('purchaseDate'),
    purchaseCost: initial('purchaseCost'),
  }));
  const [reason, setReason] = useState('Verified against the invoice');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const action = useAction();
  const proposalFor = (name: keyof FormValues): ProposedField | undefined =>
    proposals[FIELD_SOURCE[name]];
  async function approve(event: FormEvent) {
    event.preventDefault();
    const fields = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]),
    );
    await action
      .mutateAsync({
        path: `/finance/assets/${asset.id}/approve`,
        body: { fields, reason: reason.trim() },
        version: asset.version,
      })
      .then(onDone, () => undefined);
  }
  async function reject(event: FormEvent) {
    event.preventDefault();
    await action
      .mutateAsync({
        path: `/finance/assets/${asset.id}/reject`,
        body: { reason: rejectReason.trim() },
      })
      .then(onDone, () => undefined);
  }
  const gstin = proposals.gstin;
  return (
    <form onSubmit={rejecting ? reject : approve} className="form-stack">
      {invoice ? <ExtractionNote invoice={invoice} /> : null}
      <ErrorNotice error={action.error} />
      <div className="form-grid">
        {(Object.keys(values) as (keyof FormValues)[]).map((name) => {
          const proposal = proposalFor(name);
          const proposed = proposal && proposal.value === values[name];
          return (
            <Field
              key={name}
              label={LABELS[name]}
              htmlFor={`fin-${name}`}
              hint={
                proposed
                  ? `Proposed from invoice (${Math.round(proposal.confidence * 100)}% sure). Check it.`
                  : undefined
              }
            >
              <input
                id={`fin-${name}`}
                className={proposed ? 'proposed' : undefined}
                value={values[name]}
                inputMode={name === 'purchaseCost' ? 'decimal' : 'text'}
                placeholder={name === 'purchaseDate' ? 'YYYY-MM-DD' : undefined}
                onChange={(event) => setValues({ ...values, [name]: event.target.value })}
              />
            </Field>
          );
        })}
      </div>
      {gstin ? (
        <p className="muted">
          GSTIN on invoice: <strong>{gstin.value}</strong> ({Math.round(gstin.confidence * 100)}%)
        </p>
      ) : null}
      {rejecting ? (
        <>
          <Field label="Reason for rejection" htmlFor="fin-reject-reason">
            <textarea
              id="fin-reject-reason"
              required
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </Field>
          <div className="actions">
            <button className="button danger" disabled={action.isPending || !rejectReason.trim()}>
              Send back to team
            </button>
            <button type="button" className="button secondary" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <Field label="Approval note" htmlFor="fin-reason">
            <input
              id="fin-reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="actions">
            <button className="button" disabled={action.isPending || !reason.trim()}>
              Approve
            </button>
            <button type="button" className="button secondary" onClick={() => setRejecting(true)}>
              Reject…
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function ReviewPane({ item, onDone }: { item: FinanceQueueItem; onDone: () => void }) {
  const asset = useQuery({
    queryKey: ['asset', item.id],
    queryFn: ({ signal }) => api<Asset>(`/assets/${item.id}`, { signal }),
  });
  const invoices = useInvoices(item.id);
  if (asset.isPending || invoices.isPending) return <Loading />;
  if (asset.error || invoices.error)
    return <ErrorNotice error={asset.error ?? invoices.error} />;
  const invoice = invoices.data.items[0];
  return (
    <div className="finance-review-grid">
      <Panel title={invoice ? invoice.originalName : 'No invoice'}>
        {invoice ? (
          <InvoicePreview invoice={invoice} />
        ) : (
          <Empty title="No invoice uploaded">
            Ask the owning team to upload the invoice, or enter the values by hand.
          </Empty>
        )}
      </Panel>
      <Panel title={`${asset.data.assetCode} · ${asset.data.description}`}>
        {asset.data.financeStatus === 'REJECTED' ? (
          <div className="notice warning">Rejected: {asset.data.financeRejectionReason}</div>
        ) : null}
        <ReviewForm
          key={`${item.id}:${invoice?.id}:${invoice?.extractionState}`}
          asset={asset.data}
          invoice={invoice}
          onDone={onDone}
        />
      </Panel>
    </div>
  );
}

export function FinanceReview() {
  const refs = useReferences();
  const [status, setStatus] = useState('PENDING');
  const [teamId, setTeamId] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<FinanceQueueItem>();
  const queryClient = useQueryClient();
  const queue = usePages<FinanceQueueItem>('/finance/queue', {
    status,
    teamId: teamId || undefined,
    q: q.trim() || undefined,
  });
  const items = queue.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageTitle
        eyebrow="FINANCE"
        title="Finance review"
        description="Check each asset against its invoice, correct the proposed values, then approve or send it back."
      />
      <div className="filters">
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setSelected(undefined);
          }}
        >
          <option value="PENDING">Pending Finance</option>
          <option value="REJECTED">Rejected</option>
          <option value="APPROVED">Approved</option>
        </select>
        <select aria-label="Team" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
          <option value="">All teams</option>
          {(refs.data?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} · {t.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Search assets"
          placeholder="Search asset code or description"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      <ErrorNotice error={queue.error} retry={() => void queue.refetch()} />
      <div className="finance-layout">
        <Panel title={`Queue${items.length ? ` (${items.length}${queue.hasNextPage ? '+' : ''})` : ''}`}>
          {queue.isPending ? (
            <Loading />
          ) : items.length ? (
            <ul className="finance-queue">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={selected?.id === item.id ? 'is-selected' : undefined}
                    onClick={() => setSelected(item)}
                  >
                    <strong>{item.assetCode}</strong> <span>{item.description}</span>
                    <small>
                      {item.teamCode} ·{' '}
                      {item.invoiceState === null
                        ? 'No invoice'
                        : item.invoiceState === 'PENDING'
                          ? 'Reading invoice…'
                          : item.invoiceState === 'DONE'
                            ? 'Fields proposed'
                            : 'Manual entry'}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing to review">No assets match this filter.</Empty>
          )}
          <LoadMore
            available={queue.hasNextPage}
            loading={queue.isFetchingNextPage}
            onClick={() => void queue.fetchNextPage()}
          />
        </Panel>
        <div>
          {selected ? (
            <ReviewPane
              item={selected}
              onDone={() => {
                setSelected(undefined);
                void queryClient.invalidateQueries();
              }}
            />
          ) : (
            <Empty title="Select an asset">Choose an asset from the queue to review it.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
