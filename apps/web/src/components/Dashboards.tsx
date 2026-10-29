import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePages, useAction } from '../hooks';
import { hasRole, isStaff, useSession } from '../session';
import type { Asset, Ticket } from '../types';
import { Badge, Empty, ErrorNotice, Loading, Metric, PageTitle, Panel } from './ui';
import { useReferences, ReferenceBadge } from './References';
import { ExecutiveDashboard, FinanceQueue } from './Finance';
import { AdminInsights } from './AdminInsights';
interface Summary {
  role?: string;
  assets?: {
    total: number;
    assigned: number;
    pendingAcknowledgements: number;
    warrantyExpiring: number;
  };
  tickets?: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    unassigned: number;
  };
  unknownCounts?: { warrantyExpiry: number; amcExpiry: number; financePending: number };
  imports?: { quarantined: number };
}
function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api<Summary>('/dashboard', { signal }),
  });
}
function DashboardListSkeleton({ kind, horizontal = false }: { kind: 'equipment' | 'requests'; horizontal?: boolean }) {
  return (
    <div
      className={`dashboard-data-loading ${kind}${horizontal ? ' horizontal' : ''}`}
    >
      <Loading label={kind === 'equipment' ? 'Loading equipment…' : 'Loading requests…'} />
    </div>
  );
}
export function UserDashboard() {
  const { user } = useSession();
  if (hasRole(user, 'ADMIN')) return <AdminDashboard />;
  if (hasRole(user, 'FINANCE')) return <FinanceQueue />;
  if (hasRole(user, 'EXECUTIVE')) return <ExecutiveDashboard />;
  if (isStaff(user)) return <ITDashboard />;
  return <EmployeeDashboard />;
}
function EmployeeDashboard() {
  const refs = useReferences();
  const summary = useDashboard();
  const assets = usePages<Asset>('/assets');
  const tickets = usePages<Ticket>('/tickets', { status: 'OPEN' });
  const items = assets.data?.pages.flatMap((page) => page.items) ?? [];
  const requests = tickets.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageTitle
        title="Overview"
        description="Your equipment, confirmations and open support requests."
        action={
          <Link className="button" to="/tickets/new">
            Raise a ticket
          </Link>
        }
      />
      <ErrorNotice
        error={summary.error}
        retry={() => {
          void summary.refetch();
        }}
      />
      <div className="metric-grid">
        <Metric
          label="Assigned to you"
          value={summary.data?.assets?.assigned}
          detail="Equipment in your custody"
          to="/assets"
        />
        <Metric
          label="Needs your review"
          value={summary.data?.assets?.pendingAcknowledgements}
          detail="Check details and confirm receipt"
          to="/assets"
        />
        <Metric
          label="Open support requests"
          value={
            summary.data?.tickets
              ? summary.data.tickets.open + summary.data.tickets.inProgress
              : undefined
          }
          detail="Your requests in progress"
          to="/tickets"
        />
      </div>
      {(summary.data?.assets?.pendingAcknowledgements ?? 0) > 0 ? (
        <div className="notice warning">
          <strong>A quick check makes a difference.</strong>
          <p>
            Some assigned assets need your confirmation. Review the details and tell us if anything
            needs correcting.
          </p>
        </div>
      ) : null}
      <div className="dashboard-columns">
        <Panel title="Your equipment" action={<Link to="/assets">View all →</Link>}>
          <ErrorNotice
            error={assets.error}
            retry={() => {
              void assets.refetch();
            }}
          />
          {assets.isPending ? (
            <DashboardListSkeleton kind="equipment" />
          ) : items.length ? (
            <div className="asset-card-list">
              {items.slice(0, 4).map((asset) => (
                <Link to={`/assets/${asset.id}`} className="asset-card" key={asset.id}>
                  <div>
                    <span className="meta-label">{asset.assetCode}</span>
                    <h3>{asset.description}</h3>
                    <p className="muted">
                      {asset.serialNumber
                        ? `Serial ${asset.serialNumber}`
                        : 'Serial number unknown'}
                    </p>
                    {asset.currentAssignment ? (
                      <Badge value={asset.currentAssignment.acknowledgement} />
                    ) : (
                      <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
                    )}
                  </div>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          ) : !assets.error ? (
            <Empty title="No equipment assigned">
              Assets appear here once your administrator records a handover.
            </Empty>
          ) : null}
        </Panel>
        <Panel title="Support at a glance" action={<Link to="/tickets">View all →</Link>}>
          <ErrorNotice
            error={tickets.error}
            retry={() => {
              void tickets.refetch();
            }}
          />
          {tickets.isPending ? (
            <DashboardListSkeleton kind="requests" />
          ) : requests.length ? (
            <div className="queue-list">
              {requests.slice(0, 4).map((ticket) => (
                <Link className="queue-item" key={ticket.id} to={`/tickets/${ticket.id}`}>
                  <span className="meta-label">Ticket #{ticket.ticketNumber}</span>
                  <h3>{ticket.subject}</h3>
                  <ReferenceBadge refs={refs.data} kind="TICKET_STATUS" value={ticket.status} />
                </Link>
              ))}
            </div>
          ) : !tickets.error ? (
            <Empty title="You're all caught up">
              Need a hand? Your support team is a ticket away.
            </Empty>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
export function AdminDashboard() {
  const summary = useDashboard();
  const data = summary.data;
  return (
    <>
      <PageTitle
        title="Overview"
        description="Custody, exceptions and support across the foundation."
        action={
          <Link className="button" to="/assets/new">
            Create asset
          </Link>
        }
      />
      <ErrorNotice
        error={summary.error}
        retry={() => {
          void summary.refetch();
        }}
      />
      <AdminInsights />
      <div className="dashboard-columns">
        <Panel title="What needs attention">
          <div className="attention-row">
            <span>
              <strong>Custody confirmations</strong>
              <small>Help employees verify the equipment received.</small>
            </span>
            <Link className="count-link" to="/assets">
              {data?.assets?.pendingAcknowledgements ?? '—'} →
            </Link>
          </div>
          <div className="attention-row">
            <span>
              <strong>Quarantined import rows</strong>
              <small>Review exceptions before promotion to the catalog.</small>
            </span>
            <Link className="count-link" to="/admin/imports">
              {data?.imports?.quarantined ?? '—'} →
            </Link>
          </div>
          <div className="attention-row">
            <span>
              <strong>Warranty alerts</strong>
              <small>Known coverage expiring within the alert window.</small>
            </span>
            <span className="count-link">{data?.assets?.warrantyExpiring ?? '—'}</span>
          </div>
          <div className="notice">
            <strong>Unknown is not zero</strong>
            <p>
              {data?.unknownCounts?.warrantyExpiry ?? '—'} assets have unknown warranty dates.{' '}
              {data?.unknownCounts?.financePending ?? '—'} have pending financial metadata.
            </p>
          </div>
        </Panel>
        <Panel title="Workspace actions">
          <div className="quick-actions">
            <Link to="/assets/new">
              <strong>Add an asset</strong>
              <small>Record identity, condition, and coverage</small>
            </Link>
            <Link to="/admin/users">
              <strong>Manage people</strong>
              <small>Approve emails, invite staff, and manage access</small>
            </Link>
            <Link to="/tickets">
              <strong>Open support desk</strong>
              <small>Review requests and update your team</small>
            </Link>
            <Link to="/admin/audit">
              <strong>Review activity</strong>
              <small>Trace timestamped changes and decisions</small>
            </Link>
          </div>
        </Panel>
      </div>
      <StaffQueue />
    </>
  );
}
export function ITDashboard() {
  const summary = useDashboard();
  const data = summary.data;
  return (
    <>
      <PageTitle
        title="Support overview"
        description="Your queue, ownership and next actions in one place."
        action={
          <Link className="button" to="/tickets">
            Open support desk
          </Link>
        }
      />
      <ErrorNotice error={summary.error} />
      <div className="metric-grid">
        <Metric
          label="Open tickets"
          value={data?.tickets?.open}
          detail="New requests needing attention"
          to="/tickets?status=OPEN"
        />
        <Metric
          label="In progress"
          value={data?.tickets?.inProgress}
          detail="Work already underway"
          to="/tickets?status=IN_PROGRESS"
        />
        <Metric
          label="Unassigned"
          value={data?.tickets?.unassigned}
          detail="Take ownership and get started"
          to="/tickets"
        />
      </div>
      <StaffQueue />
    </>
  );
}
function StaffQueue() {
  const refs = useReferences();
  const { user } = useSession();
  const query = usePages<Ticket>('/tickets', { status: 'OPEN' });
  const action = useAction();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel
      title="Requests needing attention"
      action={<Link to="/tickets">View support desk →</Link>}
    >
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <DashboardListSkeleton kind="requests" horizontal />
      ) : items.length ? (
        <div className="queue-list horizontal">
          {items.slice(0, 4).map((ticket) => (
            <article key={ticket.id} className="queue-item">
              <span className="meta-label">Ticket #{ticket.ticketNumber}</span>
              <Link to={`/tickets/${ticket.id}`}>
                <h3>{ticket.subject}</h3>
              </Link>
              <div className="actions">
                <ReferenceBadge refs={refs.data} kind="TICKET_PRIORITY" value={ticket.priority} />
                <ReferenceBadge refs={refs.data} kind="TICKET_STATUS" value={ticket.status} />
              </div>
              <p className="muted small-text">{ticket.ownerId ? 'Assigned' : 'No owner yet'}</p>
              {!ticket.ownerId ? (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/tickets/${ticket.id}/owner`,
                      method: 'PATCH',
                      body: { ownerId: user?.id },
                      version: ticket.version,
                    })
                  }
                >
                  Take ownership
                </button>
              ) : (
                <Link className="table-link" to={`/tickets/${ticket.id}`}>
                  Open conversation →
                </Link>
              )}
            </article>
          ))}
        </div>
      ) : !query.error ? (
        <Empty title="Nothing waiting here">New support requests appear in this queue.</Empty>
      ) : null}
    </Panel>
  );
}
