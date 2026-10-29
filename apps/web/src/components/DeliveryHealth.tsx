import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, queryString } from '../api';
import { hasRole, useSession } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Metric,
  PageTitle,
  Panel,
  displayDate,
} from './ui';
type Delivery = {
  id: string;
  recipient: string;
  state: string;
  attempts: number;
  template: string;
  created_at: string;
  next_attempt_at: string;
  accepted_at: string | null;
  expires_at: string | null;
  last_error_code: string | null;
  provider_message_id: string | null;
  attempt_history: { attempt_number: number; result_code: string; occurred_at: string }[] | null;
};
type Health = {
  summary: {
    pending: number;
    leased: number;
    accepted: number;
    dead: number;
    overdue: number;
    expired_leases: number;
  };
  items: Delivery[];
  nextCursor: string | null;
};
export function DeliveryHealth() {
  const { user } = useSession(),
    [state, setState] = useState('ALL');
  const query = useInfiniteQuery({
    queryKey: ['delivery-health', state],
    enabled: hasRole(user, 'ADMIN'),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<Health>('/admin/deliveries' + queryString({ state, before: pageParam || undefined }), {
        signal,
      }),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (!hasRole(user, 'ADMIN')) return <Empty title="Admin access required" />;
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const summary = query.data!.pages[0].summary,
    items = query.data!.pages.flatMap((p) => p.items);
  return (
    <>
      <PageTitle
        title="Email delivery health"
        description="Durable delivery states and safe error codes. Message bodies, tokens and encrypted payloads are never shown."
        action={
          <button className="button secondary" onClick={() => void query.refetch()}>
            Refresh status
          </button>
        }
      />
      <div className="metric-grid four">
        <Metric label="Pending retries" value={summary.pending} />
        <Metric label="In progress" value={summary.leased} />
        <Metric label="SMTP accepted" value={summary.accepted} />
        <Metric label="Dead letters" value={summary.dead} />
      </div>
      <p className="notice">
        SMTP accepted means the mail server accepted the message, not that it arrived in the
        recipient's inbox. This view does not track opens or bounces. Pending attempts over five
        minutes late: {summary.overdue}. Expired worker leases: {summary.expired_leases}.
      </p>
      <Panel>
        <Field label="Delivery state" htmlFor="delivery-state">
          <select id="delivery-state" value={state} onChange={(e) => setState(e.target.value)}>
            {['ALL', 'PENDING', 'LEASED', 'ACCEPTED', 'DEAD'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <p className="muted">
          Read-only operations view. No resend button: expired authentication links must be replaced
          through the normal invitation or reset flow; dead operational messages need investigation
          before retry.
        </p>
        {items.length ? (
          <div className="equipment-item-grid">
            {items.map((d) => (
              <article className="panel" key={d.id}>
                <h2>{d.template}</h2>
                <p>{d.recipient}</p>
                <Badge value={d.state} />
                <dl className="finance-facts">
                  <div>
                    <dt>Created</dt>
                    <dd>{displayDate(d.created_at, true)}</dd>
                  </div>
                  <div>
                    <dt>Attempts</dt>
                    <dd>{d.attempts} / 6</dd>
                  </div>
                  <div>
                    <dt>Next attempt</dt>
                    <dd>
                      {d.state === 'PENDING'
                        ? displayDate(d.next_attempt_at, true)
                        : 'Not scheduled'}
                    </dd>
                  </div>
                  <div>
                    <dt>Server accepted</dt>
                    <dd>{d.accepted_at ? displayDate(d.accepted_at, true) : 'Not accepted'}</dd>
                  </div>
                  <div>
                    <dt>Last error code</dt>
                    <dd>{d.last_error_code ?? 'None'}</dd>
                  </div>
                </dl>
                {d.attempt_history?.length ? (
                  <details>
                    <summary>Attempt history</summary>
                    <ol>
                      {d.attempt_history.map((a) => (
                        <li key={a.attempt_number}>
                          Attempt {a.attempt_number}: {a.result_code} ·{' '}
                          {displayDate(a.occurred_at, true)}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <Empty title="No deliveries in this state" />
        )}
        {query.hasNextPage ? (
          <button
            className="button secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more deliveries
          </button>
        ) : null}
      </Panel>
    </>
  );
}
