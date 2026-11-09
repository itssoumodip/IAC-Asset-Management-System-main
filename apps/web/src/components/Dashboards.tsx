import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePages, useAction } from '../hooks';
import { can, useSession } from '../session';
import type { Asset, Ticket } from '../types';
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  Metric,
  PageTitle,
  Panel,
  buttonClass,
  noticeClass,
  metaLabelClass,
  actionsClass,
  linkClass,
} from './ui';
import { useReferences, ReferenceBadge } from './References';
import { OverviewDashboard } from './OverviewDashboard';
import { summaryLine } from '../executive';

/** The greeting and date live in the top bar; dashboards only add their summary line. */
function Greeting({ line }: { line?: string }) {
  return line ? <p className="mb-4 text-sm text-gray-500">{line}</p> : null;
}
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
function DashboardListSkeleton({
  kind,
  horizontal = false,
}: {
  kind: 'equipment' | 'requests';
  horizontal?: boolean;
}) {
  return (
    <div className={`dashboard-data-loading ${kind}${horizontal ? ' horizontal' : ''}`}>
      <Loading label={kind === 'equipment' ? 'Loading equipment…' : 'Loading requests…'} />
    </div>
  );
}
export function UserDashboard() {
  const { user } = useSession();
  if (can(user, 'report.view')) return <AdminDashboard />;
  if (can(user, 'ticket.work')) return <ITDashboard />;
  return <EmployeeDashboard />;
}
function EmployeeDashboard() {
  const refs = useReferences();
  const summary = useDashboard();
  const assets = usePages<Asset>('/assets');
  const tickets = usePages<Ticket>('/tickets', { status: 'OPEN' });
  const items = assets.data?.pages.flatMap((page) => page.items) ?? [];
  const requests = tickets.data?.pages.flatMap((page) => page.items) ?? [];
  const employeeLine = summary.data
    ? summaryLine([
        { label: 'to confirm', count: summary.data.assets?.pendingAcknowledgements ?? 0 },
        {
          label: 'open requests',
          count: (summary.data.tickets?.open ?? 0) + (summary.data.tickets?.inProgress ?? 0),
        },
      ])
    : undefined;
  return (
    <>
      <Greeting line={employeeLine} />
      <PageTitle
        title="Overview"
        description="Your equipment, confirmations and open support requests."
        action={
          <Link className={buttonClass()} to="/tickets/new">
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
        <div className={noticeClass('warning')}>
          <strong>A quick check makes a difference.</strong>
          <p>
            Some assigned assets need your confirmation. Review the details and tell us if anything
            needs correcting.
          </p>
        </div>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-2">
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
                    <span className={metaLabelClass}>{asset.assetCode}</span>
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
                  <span className={metaLabelClass}>Ticket #{ticket.ticketNumber}</span>
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
  return <OverviewDashboard />;
}
export function ITDashboard() {
  const summary = useDashboard();
  const data = summary.data;
  const itLine = data?.tickets
    ? summaryLine([
        { label: 'open tickets', count: data.tickets.open },
        { label: 'unassigned', count: data.tickets.unassigned },
      ])
    : undefined;
  return (
    <>
      <Greeting line={itLine} />
      <PageTitle
        title="Support overview"
        description="Your queue, ownership and next actions in one place."
        action={
          <Link className={buttonClass()} to="/tickets">
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
              <span className={metaLabelClass}>Ticket #{ticket.ticketNumber}</span>
              <Link to={`/tickets/${ticket.id}`}>
                <h3>{ticket.subject}</h3>
              </Link>
              <div className={actionsClass}>
                <ReferenceBadge refs={refs.data} kind="TICKET_PRIORITY" value={ticket.priority} />
                <ReferenceBadge refs={refs.data} kind="TICKET_STATUS" value={ticket.status} />
              </div>
              <p className="muted small-text">{ticket.ownerId ? 'Assigned' : 'No owner yet'}</p>
              {!ticket.ownerId ? (
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
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
                <Link className={linkClass} to={`/tickets/${ticket.id}`}>
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
