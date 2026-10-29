import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, queryString } from '../api';
import { useSession, hasRole } from '../session';
import { PageTitle, Panel, Field, ErrorNotice, Loading, Empty } from './ui';
interface Expiry {
  id: string;
  assetCode: string;
  description: string;
  status: string;
  warrantyExpiry: string | null;
  amcApplies: boolean;
  amcExpiry: string | null;
  department: string | null;
  site: string | null;
  room: string | null;
}
interface Recovery {
  id: string;
  displayName: string;
  email: string;
  state: string;
  department: string | null;
  outstanding: number;
  disputed: number;
}
export function LifecyclePage() {
  const { user } = useSession();
  const [window, setWindow] = useState('DUE30'),
    [q, setQ] = useState('');
  const allowed = hasRole(user, 'ADMIN');
  const expiry = useInfiniteQuery({
      queryKey: ['lifecycle-expiry', window],
      enabled: allowed,
      initialPageParam: '',
      queryFn: ({ pageParam, signal }) =>
        api<{
          items: Expiry[];
          nextCursor: string | null;
          total: number;
          today: string;
          definition: string;
        }>('/lifecycle/expiry' + queryString({ window, after: pageParam || undefined }), {
          signal,
        }),
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    }),
    recovery = useInfiniteQuery({
      queryKey: ['lifecycle-recovery', q],
      enabled: allowed,
      initialPageParam: '',
      queryFn: ({ pageParam, signal }) =>
        api<{ items: Recovery[]; nextCursor: string | null; definition: string }>(
          '/lifecycle/recovery' + queryString({ q: q || undefined, after: pageParam || undefined }),
          { signal },
        ),
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
  if (!allowed) return <Empty title="Admin access required" />;
  return (
    <>
      <PageTitle
        title="Lifecycle attention"
        description="Review recorded coverage dates and outstanding custody before separate operational decisions."
      />
      <Panel title="Warranty and AMC attention">
        <Field label="Coverage window" htmlFor="expiry-window">
          <select id="expiry-window" value={window} onChange={(e) => setWindow(e.target.value)}>
            <option value="DUE30">Due in 30 days</option>
            <option value="DUE90">Due in 90 days</option>
            <option value="EXPIRED">Expired dates</option>
            <option value="MISSING">Missing dates</option>
          </select>
        </Field>
        <ErrorNotice error={expiry.error} />
        {expiry.isPending ? <Loading /> : null}
        <p>
          {expiry.data?.pages[0]?.total ?? 0} matching assets · Organization date{' '}
          {expiry.data?.pages[0]?.today ?? 'loading'} · Asia/Kolkata
        </p>
        <p className="muted">{expiry.data?.pages[0]?.definition}</p>
        <div className="table-scroll finance-responsive-table">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Status</th>
                <th>Warranty</th>
                <th>AMC</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {expiry.data?.pages
                .flatMap((p) => p.items)
                .map((a) => (
                  <tr key={a.id}>
                    <td data-label="Asset">
                      <Link to={`/assets/${a.id}`}>{a.assetCode}</Link>
                      <p>{a.description}</p>
                    </td>
                    <td data-label="Status">{a.status}</td>
                    <td data-label="Warranty">{a.warrantyExpiry ?? 'Not recorded'}</td>
                    <td data-label="AMC">
                      {a.amcApplies ? (a.amcExpiry ?? 'Applies, date missing') : 'Not applicable'}
                    </td>
                    <td data-label="Location">
                      {[a.department, a.site, a.room].filter(Boolean).join(' · ') || 'Not set'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {expiry.data?.pages[0]?.total === 0 ? <p>No recorded assets match this window.</p> : null}
        {expiry.hasNextPage ? (
          <button
            className="button secondary"
            onClick={() => void expiry.fetchNextPage()}
            disabled={expiry.isFetchingNextPage}
          >
            Load more coverage items
          </button>
        ) : null}
      </Panel>
      <Panel title="Equipment recovery planning">
        <p>{recovery.data?.pages[0]?.definition}</p>
        <Field label="Find a person for recovery" htmlFor="recovery-person">
          <input
            id="recovery-person"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or email"
          />
        </Field>
        <ErrorNotice error={recovery.error} />
        {recovery.isPending ? <Loading /> : null}
        {recovery.data?.pages
          .flatMap((p) => p.items)
          .map((u) => (
            <article className="notification-card" key={u.id}>
              <h2>{u.displayName}</h2>
              <p>
                {u.email} · {u.state} · {u.department ?? 'No department'}
              </p>
              <p>
                {u.outstanding} outstanding items · {u.disputed} disputed
              </p>
              <Link className="button secondary small" to={`/equipment/people/${u.id}`}>
                Review this person's equipment
              </Link>
            </article>
          ))}
        {recovery.data?.pages[0]?.items.length === 0 ? (
          <p>No outstanding custody matches this search.</p>
        ) : null}
        {recovery.hasNextPage ? (
          <button
            className="button secondary"
            disabled={recovery.isFetchingNextPage}
            onClick={() => void recovery.fetchNextPage()}
          >
            Load more people with custody
          </button>
        ) : null}
      </Panel>
    </>
  );
}
