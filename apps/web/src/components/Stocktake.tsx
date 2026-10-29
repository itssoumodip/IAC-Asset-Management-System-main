import { useState, useRef, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryString } from '../api';
import { useAction } from '../hooks';
import { hasRole, useSession } from '../session';
import { PageTitle, Panel, Field, ErrorNotice, Loading, Empty, Metric } from './ui';
import { useReferences, locationLabel } from './References';
interface Run {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  closedAt: string | null;
  scope: { departmentId: string | null; locationId: string | null };
}
interface Item {
  id: string;
  assetCode: string;
  snapshot: { description: string; status: string; custodianName: string | null } | null;
  expectedVersion: number | null;
  currentVersion: number;
  observedVersion: number | null;
  outcome: string | null;
  note: string | null;
  extra: boolean;
}
interface Detail {
  run: Run;
  summary: {
    expected: number;
    seen: number;
    notFound: number;
    mismatch: number;
    extra: number;
    unobserved: number;
  };
  items: Item[];
  nextCursor: string | null;
  definition: string;
}
export function StocktakePage() {
  const { user } = useSession(),
    { id } = useParams();
  if (!hasRole(user, 'ADMIN')) return <Empty title="Administrator access required" />;
  return id ? <StocktakeRun key={id} id={id} /> : <StocktakeList />;
}
function StocktakeList() {
  const query = useQuery({
      queryKey: ['stocktake'],
      queryFn: ({ signal }) => api<{ items: Run[] }>('/stocktake', { signal }),
    }),
    action = useAction<Run>();
  const refs = useReferences();
  const [name, setName] = useState(''),
    [departmentId, setDepartmentId] = useState(''),
    [locationId, setLocationId] = useState('');
  async function create(e: FormEvent) {
    e.preventDefault();
    await action
      .mutateAsync({
        path: '/stocktake',
        body: {
          name,
          departmentId: departmentId || undefined,
          locationId: locationId || undefined,
        },
      })
      .then(() => setName(''))
      .catch(() => {});
  }
  return (
    <>
      <PageTitle
        title="Physical stocktake"
        description="Freeze expected inventory, record observations and review discrepancies without changing custody or Finance values."
      />
      <Panel title="Start a frozen count">
        <p>
          The expected list includes all registered asset statuses and custody at creation. Leave
          scope blank for the whole organization, or limit by department and/or location. Selecting
          both uses their intersection. Run creation does not claim anything was physically seen.
        </p>
        <form onSubmit={create} className="form-stack">
          <Field label="Count name" htmlFor="count-name">
            <input
              id="count-name"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Count department scope" htmlFor="count-department">
            <select
              id="count-department"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">All departments</option>
              {refs.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Count location scope" htmlFor="count-location">
            <select
              id="count-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">All locations</option>
              {refs.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locationLabel(l)}
                  {l.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          <ErrorNotice error={refs.error} />
          <button className="button" disabled={action.isPending}>
            {action.isPending ? 'Creating snapshot...' : 'Create frozen stocktake'}
          </button>
        </form>
        <ErrorNotice error={action.error} />
      </Panel>
      <Panel title="Recent counts">
        <ErrorNotice error={query.error} />
        {query.isPending ? <Loading /> : null}
        {query.data?.items.map((r) => (
          <article className="notification-card" key={r.id}>
            <h2>
              <Link to={`/admin/stocktake/${r.id}`}>{r.name}</Link>
            </h2>
            <p>
              {r.closedAt ? 'Closed' : 'Open'} · Started {new Date(r.createdAt).toLocaleString()}
            </p>
          </article>
        ))}
        {query.data?.items.length === 0 ? <p>No counts yet.</p> : null}
        <p className="muted">Latest 50 counts shown.</p>
      </Panel>
    </>
  );
}
function StocktakeRun({ id }: { id: string }) {
  const refs = useReferences();
  const query = useInfiniteQuery({
      queryKey: ['stocktake', id],
      initialPageParam: '',
      queryFn: ({ pageParam, signal }) =>
        api<Detail>(`/stocktake/${id}` + queryString({ after: pageParam || undefined }), {
          signal,
        }),
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    }),
    action = useAction();
  const pending = useRef<{ signature: string; key: string } | undefined>(undefined);
  const [code, setCode] = useState(''),
    [outcome, setOutcome] = useState('SEEN'),
    [note, setNote] = useState(''),
    [reason, setReason] = useState(''),
    [saved, setSaved] = useState('');
  const d = query.data?.pages[0];
  async function observe(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    setSaved('');
    const signature = JSON.stringify([code.trim(), outcome, note, d.run.version]);
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    await action
      .mutateAsync({
        path: `/stocktake/${id}/observations`,
        version: d.run.version,
        body: { assetCode: code.trim(), outcome, note, requestKey: pending.current.key },
      })
      .then(() => {
        setSaved('Observation saved. Asset, custody and Finance values are unchanged.');
        pending.current = undefined;
        setCode('');
        setNote('');
      })
      .catch(() => {});
  }
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!d) return null;
  const s = d.summary;
  return (
    <>
      <PageTitle
        title={d.run.name}
        description={`Stocktake ${d.run.closedAt ? 'closed' : 'open'} · Expected list frozen ${new Date(d.run.createdAt).toLocaleString()}`}
        action={
          <Link className="button secondary" to="/admin/stocktake">
            All counts
          </Link>
        }
      />
      <p>
        Frozen scope:{' '}
        {d.run.scope.departmentId
          ? (refs.data?.departments.find((x) => x.id === d.run.scope.departmentId)?.name ??
            d.run.scope.departmentId)
          : 'All departments'}{' '}
        ·{' '}
        {d.run.scope.locationId
          ? refs.data?.locations.find((x) => x.id === d.run.scope.locationId)
            ? locationLabel(refs.data.locations.find((x) => x.id === d.run.scope.locationId)!)
            : d.run.scope.locationId
          : 'All locations'}
        .
      </p>
      <p>{d.definition}</p>
      <div className="metric-grid four">
        <Metric label="Expected" value={s.expected} />
        <Metric label="Seen" value={s.seen} />
        <Metric label="Not found" value={s.notFound} />
        <Metric label="Unobserved" value={s.unobserved} />
        <Metric label="Mismatch" value={s.mismatch} />
        <Metric label="Extra registered items" value={s.extra} />
      </div>
      {!d.run.closedAt ? (
        <Panel title="Record an observation">
          <p>
            Use the asset ID on its label. SEEN means you observed the item, not that its custodian
            or value is correct. Record the difference as MISMATCH. NOT_FOUND is an explicit
            observation; unobserved items are not automatically declared missing. Corrections create
            a new observation and preserve earlier evidence.
          </p>
          <form onSubmit={observe} className="form-stack">
            <Field label="Observed asset ID" htmlFor="observed-code">
              <input
                id="observed-code"
                value={code}
                required
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Field label="Observation" htmlFor="observed-outcome">
              <select
                id="observed-outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="SEEN">Seen</option>
                <option value="NOT_FOUND">Not found</option>
                <option value="MISMATCH">Mismatch</option>
              </select>
            </Field>
            <Field label="Observation evidence or difference" htmlFor="observed-note">
              <textarea
                id="observed-note"
                required
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <button className="button" disabled={action.isPending}>
              Save observation only
            </button>
          </form>
          {saved ? <p role="status">{saved}</p> : null}
          <ErrorNotice error={action.error} />
        </Panel>
      ) : null}
      <Panel title="Expected list and latest observations">
        <div className="table-scroll finance-responsive-table">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Frozen expectation</th>
                <th>Latest observation</th>
                <th>Version check</th>
              </tr>
            </thead>
            <tbody>
              {query
                .data!.pages.flatMap((p) => p.items)
                .map((a) => (
                  <tr key={a.id}>
                    <td data-label="Asset">
                      <Link to={`/assets/${a.id}`}>{a.assetCode}</Link>
                      {a.extra ? <p>Extra to frozen scope</p> : null}
                    </td>
                    <td data-label="Frozen expectation">
                      {a.snapshot ? (
                        <>
                          {a.snapshot.description}
                          <br />
                          {a.snapshot.status} · {a.snapshot.custodianName ?? 'No custodian'}
                        </>
                      ) : (
                        'Not in the frozen scope'
                      )}
                    </td>
                    <td data-label="Latest observation">
                      {a.outcome ?? 'Unobserved'}
                      <ObservationHistory run={id} asset={a.id} />
                      {a.note ? <p>{a.note}</p> : null}
                    </td>
                    <td data-label="Version check">
                      Frozen {a.expectedVersion ?? 'N/A'} · Current {a.currentVersion} · Observed{' '}
                      {a.observedVersion ?? 'N/A'}
                      {a.expectedVersion !== null && a.expectedVersion !== a.currentVersion ? (
                        <p>Asset changed since snapshot. Review before corrections.</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {query.hasNextPage ? (
          <button
            className="button secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more expected items
          </button>
        ) : null}
      </Panel>
      {!d.run.closedAt ? (
        <Panel title="Close count without correcting inventory">
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate({
                path: `/stocktake/${id}/close`,
                version: d.run.version,
                body: { reason },
              });
            }}
          >
            <p>
              Closing freezes further observations. Unobserved and discrepancies remain in the
              report. No asset, custody, loss/disposal or Finance decision is made.
            </p>
            <Field label="Closing reason" htmlFor="close-reason">
              <textarea
                id="close-reason"
                required
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <button className="button secondary" disabled={action.isPending}>
              Close count
            </button>
          </form>
          <ErrorNotice error={action.error} />
        </Panel>
      ) : (
        <Panel title="Count closed">
          <p>
            No further observations can be added. Use the report as evidence for separately
            authorized corrections.
          </p>
        </Panel>
      )}
    </>
  );
}

function ObservationHistory({ run, asset }: { run: string; asset: string }) {
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ['stocktake-history', run, asset],
    enabled: open,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<{
        items: {
          id: string;
          outcome: string;
          note: string;
          actor: string;
          observedAt: string;
          assetVersion: number;
        }[];
        nextCursor: string | null;
      }>(
        `/stocktake/${run}/assets/${asset}/history` +
          queryString({ after: pageParam || undefined }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  return (
    <div>
      <button type="button" className="button text small" onClick={() => setOpen(!open)}>
        {open ? 'Hide observations' : 'Observation history'}
      </button>
      {open ? (
        <>
          <ErrorNotice error={query.error} />
          {query.isPending ? <Loading /> : null}
          <ol>
            {query.data?.pages
              .flatMap((p) => p.items)
              .map((o) => (
                <li key={o.id}>
                  {o.outcome} · {o.actor} · {new Date(o.observedAt).toLocaleString()} · Asset
                  version {o.assetVersion}
                  <p>{o.note}</p>
                </li>
              ))}
          </ol>
          {query.hasNextPage ? (
            <button
              className="button secondary small"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Older observations
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
