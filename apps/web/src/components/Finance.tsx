import { InvoiceEvidence } from './InvoiceEvidence';
import { useState, type FormEvent } from 'react';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryString } from '../api';
import type { References } from '../types';
import { useAction } from '../hooks';
import { hasRole, useSession } from '../session';
import { Empty, ErrorNotice, Field, Loading, Metric, PageTitle, Panel } from './ui';

interface FinanceAsset {
  id: string;
  assetCode: string;
  description: string;
  assetType: string;
  departmentId?: string | null;
  department?: string | null;
  assetVersion: number;
  financeVersion: number | null;
  state: string | null;
  purchaseCost: string | null;
  purchaseDate: string | null;
  invoiceNumber: string | null;
  supplier: string | null;
  residualValue: string | null;
  depreciationMethod: string | null;
  usefulLifeYears: number | null;
  insurancePolicyNumber: string | null;
  insuranceExpiry: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  submittedByName: string | null;
  submissionReason: string | null;
  reviewReason: string | null;
  reviewedByName: string | null;
  submittedAssetVersion: number | null;
  approvedCost: string | null;
  approvedAt: string | null;
  history: {
    id: string;
    action: string;
    reason: string;
    actor: string;
    occurredAt: string;
    details?: { invoiceEvidence?: { id: string; sha256: string } };
  }[];
}
const money = (value: string | number | null) =>
  value == null
    ? 'Not set'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2,
      }).format(Number(value));
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-IN') : 'Not recorded';
export function FinanceQueue() {
  const { user } = useSession();
  const [state, setState] = useState('SUBMITTED'),
    [q, setQ] = useState(''),
    [departmentId, setDepartmentId] = useState(''),
    [assetType, setAssetType] = useState('');
  const allowed = hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE');
  const references = useQuery({
    queryKey: ['finance-references'],
    enabled: allowed,
    queryFn: ({ signal }) => api<References>('/finance/filter-options', { signal }),
  });
  const query = useInfiniteQuery({
    queryKey: ['finance-queue', state, q, departmentId, assetType],
    enabled: hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE'),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<{ items: FinanceAsset[]; nextCursor: string | null }>(
        '/finance/queue' +
          queryString({
            state,
            q: q || undefined,
            departmentId: departmentId || undefined,
            assetType: assetType || undefined,
            after: pageParam || undefined,
          }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (!hasRole(user, 'ADMIN') && !hasRole(user, 'FINANCE'))
    return (
      <Empty title="Finance access required">
        Only registrars and Finance reviewers can open this queue.
      </Empty>
    );
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageTitle
        title="Finance review"
        description="Registrars submit asset records. A separate Finance reviewer checks and approves the entered financial details."
        action={
          <Link className="button secondary" to="/executive">
            Executive overview
          </Link>
        }
      />
      <section className="panel">
        <div className="finance-filters">
          <Field label="Review state" htmlFor="finance-state">
            <select id="finance-state" value={state} onChange={(e) => setState(e.target.value)}>
              {['SUBMITTED', 'RETURNED', 'APPROVED', 'UNSUBMITTED', 'ALL'].map((v) => (
                <option key={v} value={v}>
                  {v === 'UNSUBMITTED'
                    ? 'Not submitted'
                    : v === 'ALL'
                      ? 'All records'
                      : v.charAt(0) + v.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Asset code or description" htmlFor="finance-search">
            <input
              id="finance-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search asset records"
              maxLength={100}
            />
          </Field>
          <Field label="Department" htmlFor="finance-department">
            <select
              id="finance-department"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={references.isPending}
            >
              <option value="">All departments</option>
              {references.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Asset type" htmlFor="finance-asset-type">
            <select
              id="finance-asset-type"
              value={assetType}
              onChange={(e) => setAssetType(e.target.value)}
              disabled={references.isPending}
            >
              <option value="">All asset types</option>
              {references.data?.values
                .filter((v) => v.kind === 'ASSET_TYPE')
                .map((v) => (
                  <option key={v.code} value={v.code}>
                    {v.label}
                    {v.active ? '' : ' (inactive)'}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <ErrorNotice error={references.error} retry={() => void references.refetch()} />
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        {query.error ? null : query.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className="table-scroll finance-responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Review state</th>
                  <th>Entered cost</th>
                  <th>Last approved cost</th>
                  <th>Submitted by</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Asset">
                      <strong>{a.assetCode}</strong>
                      <p>{a.description}</p>
                      <small>
                        {a.department ?? 'No department'} · {a.assetType}
                      </small>
                    </td>
                    <td data-label="Review state">
                      <span className={`finance-status ${a.state?.toLowerCase() ?? 'new'}`}>
                        {a.state ?? 'NOT SUBMITTED'}
                      </span>
                    </td>
                    <td data-label="Entered cost">{money(a.purchaseCost)}</td>
                    <td data-label="Last approved cost">{money(a.approvedCost)}</td>
                    <td data-label="Submitted by">{a.submittedByName ?? 'Not submitted'}</td>
                    <td data-label="Open record">
                      <Link className="button secondary small" to={`/finance/${a.id}`}>
                        Review {a.assetCode}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No matching records">
            Choose another state, department, asset type or search. No records have been hidden by a
            row limit.
          </Empty>
        )}
        {query.hasNextPage ? (
          <button
            className="button secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more records'}
          </button>
        ) : null}
      </section>
    </>
  );
}
export function FinanceDetail() {
  const { id } = useParams(),
    { user } = useSession();
  const query = useQuery({
    queryKey: ['finance-asset', id],
    enabled: hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE'),
    queryFn: ({ signal }) => api<FinanceAsset>(`/finance/assets/${id}`, { signal }),
  });
  if (!hasRole(user, 'ADMIN') && !hasRole(user, 'FINANCE'))
    return <Empty title="Finance access required" />;
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  return query.data ? (
    <FinanceRecord
      key={`${id}-${query.data.assetVersion}-${query.data.financeVersion}`}
      asset={query.data}
    />
  ) : null;
}
function FinanceRecord({ asset: a }: { asset: FinanceAsset }) {
  const { user } = useSession(),
    action = useAction(),
    client = useQueryClient();
  const [invoiceEvidenceId, setInvoiceEvidenceId] = useState<string>();
  const [metadata, setMetadata] = useState<Record<string, string>>({
    residualValue: a.residualValue ?? '',
    depreciationMethod: a.depreciationMethod ?? '',
    usefulLifeYears: a.usefulLifeYears == null ? '' : String(a.usefulLifeYears),
    insurancePolicyNumber: a.insurancePolicyNumber ?? '',
    insuranceExpiry: a.insuranceExpiry?.slice(0, 10) ?? '',
  });
  const refs = useQuery({
    queryKey: ['finance-references'],
    queryFn: ({ signal }) => api<References>('/finance/filter-options', { signal }),
  });

  const [cost, setCost] = useState(a.purchaseCost ?? ''),
    [purchaseDate, setPurchaseDate] = useState(a.purchaseDate?.slice(0, 10) ?? ''),
    [invoice, setInvoice] = useState(a.invoiceNumber ?? ''),
    [supplier, setSupplier] = useState(a.supplier ?? ''),
    [reason, setReason] = useState(''),
    [decision, setDecision] = useState('APPROVE'),
    [saved, setSaved] = useState('');
  const history = useInfiniteQuery({
    queryKey: ['finance-history', a.id],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<{ items: FinanceAsset['history']; nextCursor: string | null }>(
        `/finance/assets/${a.id}/history` + queryString({ before: pageParam || undefined }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const canReview =
    hasRole(user, 'FINANCE') && a.state === 'SUBMITTED' && a.submittedBy !== user?.id;
  const stale = a.state === 'SUBMITTED' && a.submittedAssetVersion !== a.assetVersion;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved('');
    try {
      await action.mutateAsync({
        path: `/finance/assets/${a.id}/submit`,
        body: { reason },
        version: a.assetVersion,
      });
      setSaved('Current asset version submitted for Finance review.');
      setReason('');
    } catch {
      /* shared error notice */
    }
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    setSaved('');
    try {
      await action.mutateAsync({
        path: `/finance/assets/${a.id}/review`,
        body: {
          decision,
          reason,
          ...(decision === 'APPROVE'
            ? {
                ...Object.fromEntries(
                  Object.entries(metadata).map(([key, value]) => [
                    key,
                    value.trim()
                      ? key === 'usefulLifeYears'
                        ? Number(value)
                        : value.trim()
                      : null,
                  ]),
                ),
                purchaseCost: cost,
                purchaseDate,
                invoiceNumber: invoice,
                supplier,
                ...(invoiceEvidenceId ? { invoiceEvidenceId } : {}),
              }
            : {}),
        },
        version: a.financeVersion ?? undefined,
      });
      setSaved(
        decision === 'APPROVE'
          ? 'Finance approval recorded.'
          : 'Returned to registrar with your reason.',
      );
    } catch {
      /* shared error notice */
    }
  }
  return (
    <>
      <PageTitle
        title={`Finance · ${a.assetCode}`}
        description={a.description}
        action={
          <Link className="button secondary" to="/finance">
            Back to queue
          </Link>
        }
      />
      <ErrorNotice
        error={action.error}
        retry={() => void client.invalidateQueries({ queryKey: ['finance-asset', a.id] })}
      />
      {saved ? (
        <p role="status" className="notice success">
          {saved}
        </p>
      ) : null}
      {stale ? (
        <p className="notice warning" role="alert">
          The asset changed after submission. The registrar must resubmit this version before
          Finance can review it.
        </p>
      ) : null}
      <InvoiceEvidence
        assetId={a.id}
        version={a.assetVersion}
        canApply={canReview && !stale && decision === 'APPROVE'}
        onApply={(v, evidenceId) => {
          setInvoiceEvidenceId(evidenceId);
          if (v.purchaseCost !== undefined) setCost(v.purchaseCost);
          if (v.purchaseDate !== undefined) setPurchaseDate(v.purchaseDate);
          if (v.invoiceNumber !== undefined) setInvoice(v.invoiceNumber);
          if (v.supplier !== undefined) setSupplier(v.supplier);
        }}
      />
      <div className="finance-layout">
        <Panel title="Review record">
          <dl className="finance-facts">
            <div>
              <dt>State</dt>
              <dd>{a.state ?? 'NOT SUBMITTED'}</dd>
            </div>
            <div>
              <dt>Submitted by</dt>
              <dd>{a.submittedByName ?? 'Not submitted'}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>{date(a.submittedAt)}</dd>
            </div>
            <div>
              <dt>Submission reason</dt>
              <dd>{a.submissionReason ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Latest review note</dt>
              <dd>{a.reviewReason ?? 'No review yet'}</dd>
            </div>
            <div>
              <dt>Last approved cost</dt>
              <dd>{money(a.approvedCost)}</dd>
            </div>
            <div>
              <dt>Last approved</dt>
              <dd>{date(a.approvedAt)}</dd>
            </div>
          </dl>
          <dl className="finance-facts">
            {[
              ['Purchase cost', money(a.purchaseCost)],
              ['Purchase date', a.purchaseDate?.slice(0, 10)],
              ['Invoice number', a.invoiceNumber],
              ['Supplier', a.supplier],
              ['Residual value', money(a.residualValue)],
              ['Depreciation method', a.depreciationMethod],
              ['Useful life (years)', a.usefulLifeYears],
              ['Insurance policy number', a.insurancePolicyNumber],
              ['Insurance expiry', a.insuranceExpiry?.slice(0, 10)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? 'Not set'}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            A pending amendment keeps the last approved cost in executive totals until Finance
            approves the replacement.
          </p>
        </Panel>
        <Panel title={canReview ? 'Review financial details' : 'Registrar submission'}>
          {canReview ? (
            <form className="form-stack" onSubmit={(e) => void review(e)}>
              <Field label="Decision" htmlFor="decision">
                <select
                  id="decision"
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                >
                  <option value="APPROVE">Approve financial details</option>
                  <option value="RETURN">Return for correction</option>
                </select>
              </Field>
              {decision === 'APPROVE' ? (
                <>
                  <Field label="Purchase cost (INR)" htmlFor="cost">
                    <input
                      id="cost"
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      value={cost}
                      onChange={(e) => setCost(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Purchase date" htmlFor="purchase-date">
                    <input
                      id="purchase-date"
                      type="date"
                      value={purchaseDate}
                      onChange={(e) => setPurchaseDate(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Invoice number" htmlFor="invoice">
                    <input
                      id="invoice"
                      value={invoice}
                      onChange={(e) => setInvoice(e.target.value)}
                      required
                      maxLength={160}
                    />
                  </Field>
                  <Field label="Supplier" htmlFor="supplier">
                    <input
                      id="supplier"
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      required
                      maxLength={160}
                    />
                  </Field>
                  {[
                    ['residualValue', 'Residual value (INR)', 'text'],
                    ['usefulLifeYears', 'Useful life (years)', 'number'],
                    ['insurancePolicyNumber', 'Insurance policy number', 'text'],
                    ['insuranceExpiry', 'Insurance expiry', 'date'],
                  ].map(([key, label, type]) => (
                    <Field key={key} label={label} htmlFor={key}>
                      <input
                        id={key}
                        type={type}
                        min={key === 'usefulLifeYears' ? 1 : undefined}
                        max={key === 'usefulLifeYears' ? 100 : undefined}
                        value={metadata[key]}
                        onChange={(e) => setMetadata((v) => ({ ...v, [key]: e.target.value }))}
                      />
                    </Field>
                  ))}
                  <Field label="Depreciation method" htmlFor="depreciationMethod">
                    <select
                      id="depreciationMethod"
                      value={metadata.depreciationMethod}
                      onChange={(e) =>
                        setMetadata((v) => ({ ...v, depreciationMethod: e.target.value }))
                      }
                    >
                      <option value="">Not set</option>
                      {refs.data?.values
                        .filter(
                          (v) =>
                            v.kind === 'DEPRECIATION_METHOD' &&
                            (v.active || v.code === metadata.depreciationMethod),
                        )
                        .map((v) => (
                          <option key={v.code} value={v.code}>
                            {v.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <p className="muted">
                    Optional financial metadata may be left blank. Depreciation is not calculated.
                    All approved values are recorded in the Finance history.
                  </p>
                </>
              ) : null}
              {invoiceEvidenceId ? (
                <p className="muted">
                  Selected source evidence will be linked to this approval. Review final values
                  against the original.
                </p>
              ) : null}
              <Field label="Review reason" htmlFor="review-reason">
                <textarea
                  id="review-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </Field>
              <button className="button" disabled={action.isPending || stale}>
                {action.isPending
                  ? 'Recording…'
                  : decision === 'APPROVE'
                    ? 'Record Finance approval'
                    : 'Return to registrar'}
              </button>
            </form>
          ) : hasRole(user, 'ADMIN') ? (
            <form className="form-stack" onSubmit={(e) => void submit(e)}>
              <p>
                Submit the entered financial draft and current asset version for independent Finance
                review. Approved records may be submitted again for an amendment.
              </p>
              <Field label="Submission reason" htmlFor="submission-reason">
                <textarea
                  id="submission-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  minLength={3}
                  maxLength={2000}
                />
              </Field>
              <button
                className="button"
                disabled={action.isPending || (a.state === 'SUBMITTED' && !stale)}
              >
                {action.isPending
                  ? 'Submitting…'
                  : a.approvedAt
                    ? 'Submit amendment'
                    : 'Submit to Finance'}
              </button>
            </form>
          ) : (
            <p className="muted">
              {a.state === 'SUBMITTED'
                ? 'A separate reviewer must review a record you submitted.'
                : a.state === 'APPROVED'
                  ? 'Approval recorded. A registrar can submit an amendment when these details change.'
                  : 'The registrar must submit this record before Finance can review it.'}
            </p>
          )}
        </Panel>
      </div>
      <Panel title="Finance history">
        <p className="muted">
          Finance events, newest first. Load earlier events without losing the current record.
        </p>
        {history.isPending ? (
          <Loading />
        ) : history.error ? (
          <ErrorNotice error={history.error} retry={() => void history.refetch()} />
        ) : history.data?.pages.some((p) => p.items.length) ? (
          <ol className="finance-history">
            {history.data.pages
              .flatMap((p) => p.items)
              .map((e) => (
                <li key={e.id}>
                  <strong>{e.action}</strong>
                  <span>
                    {e.actor} · {date(e.occurredAt)}
                  </span>
                  <p>{e.reason}</p>
                  {e.details?.invoiceEvidence ? (
                    <p style={{ overflowWrap: 'anywhere' }}>
                      <a
                        href={`/api/v1/finance/assets/${a.id}/invoices/${e.details.invoiceEvidence.id}`}
                        download
                      >
                        Original invoice used for this approval
                      </a>
                      <br />
                      SHA-256 {e.details.invoiceEvidence.sha256}
                    </p>
                  ) : null}
                </li>
              ))}
          </ol>
        ) : (
          <p>No Finance events yet.</p>
        )}
        {history.hasNextPage ? (
          <button
            className="button secondary"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Load earlier Finance events'}
          </button>
        ) : null}
      </Panel>
    </>
  );
}
interface ExecutiveSummary {
  asOf: string;
  totalAssets: number;
  assignedAssets: number;
  pendingReviews: number;
  returnedReviews: number;
  unsubmittedAssets: number;
  approvedAssets: number;
  approvedAcquisitionCost: string;
  missingAssets: number;
  warrantyExpiring: number;
  openTickets: number;
  highPriorityOpen: number;
  departments: {
    department: string;
    assetCount: number;
    approvedCount: number;
    approvedCost: string;
  }[];
  activity: {
    weekStart: string;
    approvalEvents: number;
    ticketsCreated: number;
    ticketsCompleted: number;
    partialWeek: boolean;
  }[];
  definitions: {
    approvedAcquisitionCost: string;
    approvedAssets: string;
    scope: string;
    activity: string;
  };
}
export function ExecutiveDashboard() {
  const { user } = useSession(),
    allowed = hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE') || hasRole(user, 'EXECUTIVE');
  const query = useQuery({
    queryKey: ['executive-summary'],
    queryFn: ({ signal }) => api<ExecutiveSummary>('/finance/executive-summary', { signal }),
    enabled: allowed,
  });
  if (!allowed) return <Empty title="Executive access required" />;
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const d = query.data!;
  return (
    <>
      <PageTitle
        title="Executive overview"
        description="A read-only view of asset coverage, Finance approvals and operational risk."
        action={
          <button
            className="button secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh summary'}
          </button>
        }
      />
      <p className="muted">Updated {date(d.asOf)} · Organization-wide · INR</p>
      <div className="metric-grid four">
        <Metric label="Registered assets" value={d.totalAssets} />
        <Metric label="Finance-approved assets" value={d.approvedAssets} />
        <Metric label="Approved acquisition cost" value={money(d.approvedAcquisitionCost)} />
        <Metric label="Awaiting Finance review" value={d.pendingReviews} />
      </div>
      <div className="finance-layout">
        <Panel title="Review coverage">
          <dl className="finance-facts">
            <div>
              <dt>Not submitted</dt>
              <dd>{d.unsubmittedAssets}</dd>
            </div>
            <div>
              <dt>Returned for correction</dt>
              <dd>{d.returnedReviews}</dd>
            </div>
            <div>
              <dt>Currently assigned</dt>
              <dd>{d.assignedAssets}</dd>
            </div>
          </dl>
          {hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE') ? (
            <Link className="button secondary" to="/finance">
              Open Finance queue
            </Link>
          ) : (
            <p className="muted">Your executive role has read-only summary access.</p>
          )}
        </Panel>
        <Panel title="Operational attention">
          <dl className="finance-facts">
            <div>
              <dt>Lost or stolen assets</dt>
              <dd>{d.missingAssets}</dd>
            </div>
            <div>
              <dt>Warranties expiring in 30 days</dt>
              <dd>{d.warrantyExpiring}</dd>
            </div>
            <div>
              <dt>Open support tickets</dt>
              <dd>{d.openTickets}</dd>
            </div>
            <div>
              <dt>High-priority open tickets</dt>
              <dd>{d.highPriorityOpen}</dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Panel title="Recorded activity by week">
        <p className="muted">
          Monday-start weeks · Asia/Kolkata · current week is partial. Counts are events, not
          spending or historical backlog.
        </p>
        <div className="executive-activity-chart" aria-label="Weekly recorded activity">
          {(d.activity ?? []).map((w) => {
            const max = Math.max(
              1,
              ...d.activity.flatMap((v) => [
                v.approvalEvents,
                v.ticketsCreated,
                v.ticketsCompleted,
              ]),
            );
            return (
              <div className="executive-activity-week" key={w.weekStart}>
                <span>
                  {new Date(w.weekStart + 'T00:00:00+05:30').toLocaleDateString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    day: 'numeric',
                    month: 'short',
                  })}
                  {w.partialWeek ? ' *' : ''}
                </span>
                <div>
                  {[
                    ['Finance approvals', w.approvalEvents, 'approval'],
                    ['Tickets created', w.ticketsCreated, 'created'],
                    ['Tickets completed', w.ticketsCompleted, 'completed'],
                  ].map(([label, value, style]) => (
                    <div className="executive-activity-series" key={label}>
                      <span
                        className={`executive-activity-bar ${style}`}
                        style={{ width: `${(Number(value) / max) * 100}%` }}
                      />
                      <span>
                        {label}: {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <details>
          <summary>Exact weekly counts and definitions</summary>
          <p>{d.definitions.activity}</p>
          <div className="table-scroll finance-responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Week starting</th>
                  <th>Approval events</th>
                  <th>Tickets created</th>
                  <th>Tickets completed</th>
                </tr>
              </thead>
              <tbody>
                {(d.activity ?? []).map((w) => (
                  <tr key={w.weekStart}>
                    <td data-label="Week starting">
                      {w.weekStart}
                      {w.partialWeek ? ' (partial)' : ''}
                    </td>
                    <td data-label="Approval events">{w.approvalEvents}</td>
                    <td data-label="Tickets created">{w.ticketsCreated}</td>
                    <td data-label="Tickets completed">{w.ticketsCompleted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Panel>
      <Panel title="Department overview">
        <div className="table-scroll finance-responsive-table">
          <table>
            <thead>
              <tr>
                <th>Department</th>
                <th>Assets</th>
                <th>Finance-approved</th>
                <th>Approved cost (INR)</th>
              </tr>
            </thead>
            <tbody>
              {d.departments.map((v) => (
                <tr key={v.department}>
                  <td data-label="Department">{v.department}</td>
                  <td data-label="Assets">{v.assetCount}</td>
                  <td data-label="Finance-approved">{v.approvedCount}</td>
                  <td data-label="Approved cost (INR)">{money(v.approvedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="How to read these numbers">
        <p>{d.definitions.approvedAcquisitionCost}</p>
        <p>{d.definitions.approvedAssets}</p>
        <p>{d.definitions.scope}</p>
      </Panel>
    </>
  );
}
