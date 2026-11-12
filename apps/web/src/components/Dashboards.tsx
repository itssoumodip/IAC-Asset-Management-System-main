import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { Asset, Ticket } from '../types';
import { summaryLine } from '../executive';
import { BarList, Card, EmptyChart, StatTile } from './charts';
import { OverviewDashboard } from './OverviewDashboard';
import {
  AuditorDashboard,
  FinanceDashboard,
  InsurerDashboard,
  ProcurementDashboard,
  StoreDashboard,
} from './RoleDashboards';
import { Badge, ErrorNotice, Loading, buttonClass, cx, displayDate } from './ui';

interface Summary {
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
}
interface TeamData {
  assetsByTeam: {
    teamId: string;
    teamName: string;
    status: string;
    count: number;
    value: number;
  }[];
  needsAttention: {
    pendingFinance: number;
    leftHoldersWithAssets: number;
    warrantyExpiring30: number;
    amcExpiring30: number;
  };
  openTickets: number;
}
interface MaintenanceSummary {
  items: {
    id: string;
    title: string;
    assetCode: string;
    assetId: string;
    nextDue: string;
    daysUntilDue: number;
  }[];
  summary: { overdue: number; dueThisWeek: number; active: number; doneThisMonth: number };
}

const plain = (n: number) => n.toLocaleString('en-IN');
const priorityTone: Record<string, string> = { HIGH: 'HIGH', MEDIUM: 'IN_PROGRESS', LOW: 'OPEN' };

function useSummary() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api<Summary>('/dashboard', { signal }),
  });
}

function Header({ title, line, actions }: { title: string; line?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-navy-900">{title}</h1>
        {line ? <p className="mt-1 text-sm text-gray-500">{line}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = 'danger' | 'warning' | 'neutral';
const toneDot: Record<Tone, string> = {
  danger: 'bg-red-600',
  warning: 'bg-yellow-500',
  neutral: 'bg-navy-500',
};
function AttentionRows({
  items,
}: {
  items: { label: string; count?: number; to?: string; tone: Tone }[];
}) {
  const open = items.filter((i) => (i.count ?? 0) > 0);
  if (!open.length)
    return (
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
        Everything is in order for your team.
      </p>
    );
  return (
    <ul className="divide-y divide-gray-100">
      {open.map((item) => {
        const body = (
          <>
            <span
              className={cx('size-2 shrink-0 rounded-full', toneDot[item.tone])}
              aria-hidden="true"
            />
            <span className="flex-1 truncate text-sm text-gray-800">{item.label}</span>
            <span className="text-sm font-semibold text-gray-900 tabular-nums">{item.count}</span>
          </>
        );
        return (
          <li key={item.label}>
            {item.to ? (
              <Link
                to={item.to}
                className="flex items-center gap-3 rounded-md px-1 py-2.5 no-underline hover:bg-gray-50"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-1 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function UserDashboard() {
  const { user } = useSession();
  // Development only: preview another role's dashboard with ?as=<role> (team, finance, store…).
  if (import.meta.env.DEV) {
    const as = new URLSearchParams(window.location.search).get('as');
    if (as === 'team') return <TeamDashboard />;
    if (as === 'employee') return <EmployeeDashboard />;
    if (as === 'finance') return <FinanceDashboard />;
    if (as === 'store') return <StoreDashboard />;
    if (as === 'auditor') return <AuditorDashboard />;
    if (as === 'insurer') return <InsurerDashboard />;
    if (as === 'procurement') return <ProcurementDashboard />;
  }
  const roles = user?.roles ?? [];
  // Most specific first. Someone with several roles gets the one closest to their daily work.
  if (can(user, 'report.view')) return <OverviewDashboard />;
  if (roles.includes('FINANCE')) return <FinanceDashboard />;
  if (can(user, 'ticket.work')) return <TeamDashboard />;
  if (roles.includes('STORE')) return <StoreDashboard />;
  if (roles.includes('PROCUREMENT')) return <ProcurementDashboard />;
  if (roles.includes('AUDITOR')) return <AuditorDashboard />;
  if (roles.includes('INSURER')) return <InsurerDashboard />;
  return <EmployeeDashboard />;
}

/** Team members and leads (IT, Admin…): their queue, their team's assets and what needs action. */
function TeamDashboard() {
  const { user } = useSession();
  const summary = useSummary();
  const team = useQuery({
    queryKey: ['dashboard', 'team'],
    queryFn: ({ signal }) => api<TeamData>('/dashboard/team', { signal }),
  });
  const tickets = useQuery({
    queryKey: ['dashboard', 'team-tickets'],
    queryFn: ({ signal }) => api<{ items: Ticket[] }>('/tickets?limit=50', { signal }),
  });
  const maintenance = useQuery({
    queryKey: ['maintenance', 'upcoming'],
    queryFn: ({ signal }) => api<MaintenanceSummary>('/maintenance?view=upcoming', { signal }),
  });
  const requests = useQuery({
    queryKey: ['request-queue'],
    queryFn: ({ signal }) =>
      api<{ toDecide: unknown[]; toFulfil: unknown[] }>('/requests/queue', { signal }),
  });
  const take = useAction();
  const open = (tickets.data?.items ?? []).filter((t) => t.status !== 'COMPLETED');
  const mine = open.filter((t) => t.ownerId === user?.id);
  const unowned = open.filter((t) => !t.ownerId);
  const queue = [...unowned, ...open.filter((t) => t.ownerId)].slice(0, 8);
  const att = team.data?.needsAttention;
  const statusTotals = new Map<string, number>();
  for (const row of team.data?.assetsByTeam ?? [])
    statusTotals.set(row.status, (statusTotals.get(row.status) ?? 0) + row.count);
  const teamAssets = [...statusTotals.values()].reduce((s, n) => s + n, 0);
  const mnt = maintenance.data?.summary;
  const teamNames = (user?.teams ?? []).map((t) => t.teamCode).join(', ');

  return (
    <div className="flex flex-col gap-6">
      <Header
        title={teamNames ? `${teamNames} team` : 'Your team'}
        line={summaryLine([
          { label: 'tickets without an owner', count: unowned.length },
          { label: 'assigned to you', count: mine.length },
          { label: 'maintenance overdue', count: mnt?.overdue ?? 0 },
        ])}
        actions={
          <>
            <Link to="/tickets" className={buttonClass('secondary')}>
              Support desk
            </Link>
            {can(user, 'asset.create') ? (
              <Link to="/assets/new" className={buttonClass()}>
                Add asset
              </Link>
            ) : null}
          </>
        }
      />
      <ErrorNotice
        error={summary.error ?? team.error ?? tickets.error}
        retry={() => void team.refetch()}
      />
      {team.isPending || tickets.isPending ? (
        <Loading label="Loading your team…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Team assets"
              value={plain(teamAssets)}
              detail="Owned by your team"
              to="/assets"
            />
            <StatTile
              label="Open tickets"
              value={plain(open.length)}
              detail={`${unowned.length} without an owner`}
              to="/tickets"
            />
            <StatTile
              label="Assigned to you"
              value={plain(mine.length)}
              detail="Tickets you own"
              to="/tickets"
            />
            <StatTile
              label="Maintenance due"
              value={plain((mnt?.overdue ?? 0) + (mnt?.dueThisWeek ?? 0))}
              detail={mnt?.overdue ? `${mnt.overdue} overdue` : 'This week'}
              to="/maintenance"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card
              title="Support queue"
              className="lg:col-span-3"
              action={
                <Link
                  to="/tickets"
                  className="text-xs font-medium text-navy-700 no-underline hover:underline"
                >
                  View all
                </Link>
              }
            >
              <ErrorNotice error={take.error} />
              {queue.length ? (
                <ul className="divide-y divide-gray-100">
                  {queue.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/tickets/${t.id}`}
                          className="block truncate text-sm font-medium text-gray-900 no-underline hover:text-navy-700"
                        >
                          {t.subject}
                        </Link>
                        <span className="text-xs text-gray-500">
                          #{t.ticketNumber} · {t.createdAt ? displayDate(t.createdAt) : ''}
                        </span>
                      </div>
                      <Badge
                        value={priorityTone[t.priority] ?? t.priority}
                        label={t.priority.toLowerCase()}
                      />
                      {t.ownerId ? (
                        <span className="w-24 text-right text-xs text-gray-500">
                          {t.ownerId === user?.id ? 'You' : 'Owned'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={cx(buttonClass('secondary', 'sm'), 'w-24')}
                          disabled={take.isPending}
                          onClick={() =>
                            void take
                              .mutateAsync({
                                path: `/tickets/${t.id}/owner`,
                                method: 'PATCH',
                                body: { ownerId: user?.id },
                                version: t.version,
                              })
                              .then(
                                () => tickets.refetch(),
                                () => undefined,
                              )
                          }
                        >
                          Take it
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>No open tickets for your team</EmptyChart>
              )}
            </Card>
            <Card title="Needs attention" className="lg:col-span-2">
              <AttentionRows
                items={[
                  {
                    label: 'Requests waiting for your decision',
                    count: requests.data?.toDecide.length,
                    to: '/requests',
                    tone: 'warning',
                  },
                  {
                    label: 'Approved requests to hand over',
                    count: requests.data?.toFulfil.length,
                    to: '/requests',
                    tone: 'warning',
                  },
                  {
                    label: 'Tickets without an owner',
                    count: unowned.length,
                    to: '/tickets',
                    tone: 'warning',
                  },
                  {
                    label: 'Maintenance overdue',
                    count: mnt?.overdue,
                    to: '/maintenance',
                    tone: 'danger',
                  },
                  {
                    label: 'Assets with people who have left',
                    count: att?.leftHoldersWithAssets,
                    tone: 'danger',
                  },
                  {
                    label: 'Waiting for Finance review',
                    count: att?.pendingFinance,
                    to: '/assets',
                    tone: 'neutral',
                  },
                  {
                    label: 'Warranty ending in 30 days',
                    count: att?.warrantyExpiring30,
                    to: '/assets',
                    tone: 'warning',
                  },
                  {
                    label: 'AMC ending in 30 days',
                    count: att?.amcExpiring30,
                    to: '/assets',
                    tone: 'warning',
                  },
                  {
                    label: 'Custody not yet confirmed',
                    count: summary.data?.assets?.pendingAcknowledgements,
                    to: '/assets',
                    tone: 'neutral',
                  },
                ]}
              />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Team assets by status">
              <BarList
                valueLabel="Assets"
                empty="Your team has no assets yet"
                items={[...statusTotals.entries()].map(([status, count]) => ({
                  label: status,
                  value: count,
                  note: teamAssets ? `${Math.round((count / teamAssets) * 100)}%` : undefined,
                  to: `/assets?status=${encodeURIComponent(status)}`,
                }))}
              />
            </Card>
            <Card
              title="Maintenance in the next 30 days"
              action={
                <Link
                  to="/maintenance"
                  className="text-xs font-medium text-navy-700 no-underline hover:underline"
                >
                  Open
                </Link>
              }
            >
              {maintenance.data?.items.length ? (
                <ul className="divide-y divide-gray-100">
                  {maintenance.data.items.slice(0, 6).map((m) => (
                    <li key={m.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <Link
                        to={`/assets/${m.assetId}`}
                        className="font-medium text-navy-700 no-underline hover:underline"
                      >
                        {m.assetCode}
                      </Link>
                      <span className="flex-1 truncate text-gray-700">{m.title}</span>
                      <span
                        className={cx(
                          'text-xs',
                          m.daysUntilDue < 0 ? 'font-medium text-red-700' : 'text-gray-500',
                        )}
                      >
                        {m.daysUntilDue < 0
                          ? `${-m.daysUntilDue}d overdue`
                          : displayDate(m.nextDue)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyChart>Nothing due in the next 30 days</EmptyChart>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** Everyone else: their equipment, anything to confirm, and their own support requests. */
function EmployeeDashboard() {
  const { user } = useSession();
  const summary = useSummary();
  const assets = useQuery({
    queryKey: ['my-assets'],
    queryFn: ({ signal }) => api<{ items: Asset[] }>('/assets?limit=100', { signal }),
  });
  const tickets = useQuery({
    queryKey: ['dashboard', 'my-tickets'],
    queryFn: ({ signal }) => api<{ items: Ticket[] }>('/tickets?limit=25', { signal }),
  });
  const mine = (assets.data?.items ?? []).filter((a) => a.currentAssignment?.userId === user?.id);
  const toConfirm = mine.filter((a) => a.currentAssignment?.acknowledgement === 'PENDING');
  const requests = tickets.data?.items ?? [];
  const openRequests = requests.filter((t) => t.status !== 'COMPLETED');

  return (
    <div className="flex flex-col gap-6">
      <Header
        title="Your workspace"
        line={summaryLine([
          { label: 'to confirm', count: toConfirm.length },
          { label: 'open requests', count: openRequests.length },
        ])}
        actions={
          <Link to="/tickets/new" className={buttonClass()}>
            Report a problem
          </Link>
        }
      />
      <ErrorNotice
        error={summary.error ?? assets.error ?? tickets.error}
        retry={() => void assets.refetch()}
      />

      {toConfirm.length ? (
        <section className="rounded-xl border border-yellow-200 bg-yellow-50 p-5">
          <h2 className="text-sm font-semibold text-yellow-900">
            {toConfirm.length === 1
              ? 'One item is waiting for you to confirm'
              : `${toConfirm.length} items are waiting for you to confirm`}
          </h2>
          <p className="mt-0.5 text-sm text-yellow-900">
            Check that you received them and that the details are right.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {toConfirm.slice(0, 4).map((a) => (
              <li
                key={a.id}
                className="rounded-lg bg-white px-3 py-1.5 text-sm text-gray-800 ring-1 ring-yellow-200"
              >
                <span className="font-medium">{a.assetCode}</span> · {a.description}
              </li>
            ))}
          </ul>
          <Link to="/my-assets" className={cx(buttonClass('primary', 'sm'), 'mt-4')}>
            Confirm now
          </Link>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="With you"
          value={plain(mine.length)}
          detail="Items in your care"
          to="/my-assets"
        />
        <StatTile
          label="To confirm"
          value={plain(toConfirm.length)}
          detail="Waiting for you"
          to="/my-assets"
        />
        <StatTile
          label="Open requests"
          value={plain(openRequests.length)}
          detail="Support you asked for"
          to="/tickets"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Your equipment"
          action={
            <Link
              to="/my-assets"
              className="text-xs font-medium text-navy-700 no-underline hover:underline"
            >
              View all
            </Link>
          }
        >
          {assets.isPending ? (
            <Loading />
          ) : mine.length ? (
            <ul className="divide-y divide-gray-100">
              {mine.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/assets/${a.id}`}
                      className="text-sm font-medium text-navy-700 no-underline hover:underline"
                    >
                      {a.assetCode}
                    </Link>
                    <span className="block truncate text-xs text-gray-500">{a.description}</span>
                  </div>
                  {a.currentAssignment?.acknowledgement === 'PENDING' ? (
                    <Badge value="PENDING" label="To confirm" />
                  ) : a.currentAssignment?.acknowledgement === 'DISPUTED' ? (
                    <Badge value="DISPUTED" label="Reported" />
                  ) : (
                    <Badge value="ACCEPTED" label="Confirmed" />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyChart>No equipment is assigned to you yet</EmptyChart>
          )}
        </Card>
        <Card
          title="Your support requests"
          action={
            <Link
              to="/tickets"
              className="text-xs font-medium text-navy-700 no-underline hover:underline"
            >
              View all
            </Link>
          }
        >
          {tickets.isPending ? (
            <Loading />
          ) : requests.length ? (
            <ul className="divide-y divide-gray-100">
              {requests.slice(0, 6).map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/tickets/${t.id}`}
                      className="block truncate text-sm font-medium text-gray-900 no-underline hover:text-navy-700"
                    >
                      {t.subject}
                    </Link>
                    <span className="text-xs text-gray-500">
                      #{t.ticketNumber}
                      {t.updatedAt ? ` · updated ${displayDate(t.updatedAt)}` : ''}
                    </span>
                  </div>
                  <Badge value={t.status} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-gray-500">You have not raised any requests.</p>
              <Link to="/tickets/new" className={buttonClass('secondary', 'sm')}>
                Report a problem
              </Link>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
