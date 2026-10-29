import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryString } from '../api';
import { hasRole, useSession } from '../session';
import { Badge, Empty, ErrorNotice, Field, Loading, Metric, PageTitle, Panel } from './ui';
interface Person {
  id: string;
  displayName: string;
  email: string;
  designation: string | null;
  employeeReference: string | null;
  state: string;
  department: string | null;
  equipmentCount: number;
  pendingAcknowledgements: number;
}
interface Equipment {
  id: string;
  assetCode: string;
  assetType: string;
  description: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  condition: string;
  status: string;
  locationSite: string | null;
  locationRoom: string | null;
  assignmentId: string;
  assignedAt: string;
  acknowledgement: string;
  purchaseCost?: string | null;
  financeState?: string | null;
  approvedCost?: string | null;
}
interface PersonEquipment {
  person: Person;
  summary: { total: number; pendingAcknowledgements: number; disputed: number };
  items: Equipment[];
  nextCursor: string | null;
}
export function EquipmentPeople() {
  const { user } = useSession(),
    [q, setQ] = useState(''),
    allowed = hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE');
  const query = useInfiniteQuery({
    queryKey: ['equipment-people', q],
    enabled: allowed,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<{ items: Person[]; nextCursor: string | null }>(
        '/equipment/people' + queryString({ q: q || undefined, after: pageParam || undefined }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (!allowed) return <Empty title="Equipment access required" />;
  const people = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageTitle
        title="People & equipment"
        description="One person, all their current equipment. Laptops, mice, keyboards and other items keep their own asset IDs and custody history."
      />
      <Panel>
        <Field label="Find a person" htmlFor="equipment-person-search">
          <input
            id="equipment-person-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={100}
            placeholder="Name, work email or employee reference"
          />
        </Field>
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        {query.error ? null : query.isPending ? (
          <Loading />
        ) : people.length ? (
          <div className="equipment-people-grid">
            {people.map((p) => (
              <article className="equipment-person-card" key={p.id}>
                <h2>{p.displayName}</h2>
                <p className="muted">
                  {[p.designation, p.department].filter(Boolean).join(' · ') ||
                    'Department not set'}
                </p>
                <p>{p.email}</p>
                <p>
                  <strong>{p.equipmentCount}</strong> assigned items · {p.pendingAcknowledgements}{' '}
                  awaiting acknowledgement
                </p>
                {p.state !== 'ACTIVE' ? <Badge value={p.state} /> : null}
                <Link className="button secondary" to={`/equipment/people/${p.id}`}>
                  View equipment for {p.displayName}
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="No matching people">
            Try another name or email. Employees with no equipment are included.
          </Empty>
        )}
        {query.hasNextPage ? (
          <button
            className="button secondary"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            Load more people
          </button>
        ) : null}
      </Panel>
    </>
  );
}
export function PersonEquipment() {
  const { id } = useParams(),
    { user } = useSession(),
    personId = id ?? user?.id,
    allowed =
      hasRole(user, 'ADMIN') ||
      hasRole(user, 'FINANCE') ||
      (hasRole(user, 'EMPLOYEE') && personId === user?.id);
  const query = useInfiniteQuery({
    queryKey: ['person-equipment', personId],
    enabled: allowed,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<PersonEquipment>(
        `/equipment/people/${personId}` + queryString({ after: pageParam || undefined }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (!allowed)
    return (
      <Empty title="Equipment access required">
        You can only see your own equipment unless you are an Admin.
      </Empty>
    );
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const data = query.data!.pages[0],
    p = data.person,
    items = query.data!.pages.flatMap((p) => p.items),
    admin = hasRole(user, 'ADMIN'),
    finance = hasRole(user, 'FINANCE');
  return (
    <>
      <PageTitle
        title={personId === user?.id ? 'My equipment' : `${p.displayName}'s equipment`}
        description={[p.email, p.designation, p.department].filter(Boolean).join(' · ')}
        action={
          admin || finance ? (
            <Link className="button secondary" to="/equipment/people">
              All people
            </Link>
          ) : undefined
        }
      />
      <div className="metric-grid">
        <Metric label="Current assigned items" value={data.summary.total} />
        <Metric label="Awaiting acknowledgement" value={data.summary.pendingAcknowledgements} />
        <Metric label="Reported discrepancies" value={data.summary.disputed} />
      </div>
      <p className="notice">
        These items are mapped to one person, not merged into one asset. Returning or transferring
        one item does not change the others. Closed assignments stay in each asset's history.
      </p>
      {admin ? (
        <p>
          <Link className="button" to={`/assignments/new?person=${personId}`}>
            Assign another item
          </Link>
        </p>
      ) : null}
      {items.length ? (
        <section className="equipment-item-grid" aria-label="Current equipment">
          {items.map((a) => (
            <article className="panel equipment-item-card" key={a.id}>
              <div>
                <span className="eyebrow">{a.assetType}</span>
                <h2>{a.assetCode}</h2>
                <p>{a.description}</p>
              </div>
              <dl className="finance-facts">
                <div>
                  <dt>Serial number</dt>
                  <dd>{a.serialNumber ?? 'Not recorded'}</dd>
                </div>
                <div>
                  <dt>Make / model</dt>
                  <dd>{[a.manufacturer, a.model].filter(Boolean).join(' ') || 'Not recorded'}</dd>
                </div>
                <div>
                  <dt>Condition</dt>
                  <dd>{a.condition}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>
                    {[a.locationSite, a.locationRoom].filter(Boolean).join(' / ') || 'Not set'}
                  </dd>
                </div>
                <div>
                  <dt>Assigned</dt>
                  <dd>{new Date(a.assignedAt).toLocaleDateString('en-IN')}</dd>
                </div>
                <div>
                  <dt>Receipt</dt>
                  <dd>
                    <Badge value={a.acknowledgement} />
                  </dd>
                </div>
              </dl>
              {finance ? (
                <>
                  <p>
                    Finance: {a.financeState ?? 'Not submitted'} · Last approved cost:{' '}
                    {a.approvedCost
                      ? new Intl.NumberFormat('en-IN', {
                          style: 'currency',
                          currency: 'INR',
                        }).format(Number(a.approvedCost))
                      : 'Not approved'}
                  </p>
                  <Link className="button secondary" to={`/finance/${a.id}`}>
                    Open financial review
                  </Link>
                </>
              ) : (
                <>
                  <Link className="button secondary" to={`/assets/${a.id}`}>
                    {admin ? 'Manage item / return' : 'View item / confirm receipt'}
                  </Link>
                  {!admin ? (
                    <Link className="button text" to={`/tickets/new?assetId=${a.id}`}>
                      Report an issue
                    </Link>
                  ) : null}
                </>
              )}
            </article>
          ))}
        </section>
      ) : (
        <Empty title="No equipment currently assigned">
          {admin
            ? 'Use Assign another item to map an available asset to this person.'
            : 'Your assigned equipment will appear together here.'}
        </Empty>
      )}
      {query.hasNextPage ? (
        <button
          className="button secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more equipment
        </button>
      ) : null}
    </>
  );
}
