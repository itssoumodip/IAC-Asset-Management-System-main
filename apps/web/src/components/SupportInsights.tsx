import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { BarList, Card, EmptyChart, PairedColumnChart, StatTile } from './charts';
import { Badge, ErrorNotice, Loading, cx, displayDate } from './ui';

type Days = '30' | '90' | '365' | 'all';
interface SupportInsightsData {
  scope: 'all' | 'team' | 'mine';
  days: Days;
  teams: string[];
  totals: {
    raised: number;
    fixed: number;
    open: number;
    inProgress: number;
    unowned: number;
    highOpen: number;
    medianFirstResponseHours: number | null;
    medianFixHours: number | null;
    averageFixHours: number | null;
    fixedWithinTwoDays: number;
  };
  byTeam: { teamId: string; team: string; raised: number; fixed: number; open: number; medianFixHours: number | null }[];
  byCategory: { label: string; value: number }[];
  byPriority: { priority: string; raised: number; open: number; medianFixHours: number | null }[];
  weeks: { weekStart: string; opened: number; completed: number }[];
  oldestOpen: {
    id: string;
    ticketNumber: number;
    subject: string;
    priority: string;
    status: string;
    owned: boolean;
    team: string;
    ageDays: number;
  }[];
}

/** 5.2 h under a day, 2.4 days after. */
export function duration(hours: number | null | undefined) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

const periods: { value: Days; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'all', label: 'All time' },
];

/**
 * Snapshot and charts at the top of the Support desk. What it covers follows the role: admins
 * and leadership see every team, team leads and members their own teams, everyone else the
 * tickets they raised.
 */
export function SupportInsights() {
  const [days, setDays] = useState<Days>('90');
  const query = useQuery({
    queryKey: ['support-insights', days],
    queryFn: ({ signal }) => api<SupportInsightsData>(`/support/insights?days=${days}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const d = query.data;
  const t = d?.totals;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-IN');
  const periodWord = days === 'all' ? 'all time' : days === '365' ? 'the last year' : `the last ${days} days`;
  const scopeLine =
    d?.scope === 'all'
      ? 'All teams'
      : d?.scope === 'team'
        ? `${d.teams.join(', ')} team${d.teams.length > 1 ? 's' : ''}`
        : 'Tickets you raised';

  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (!d) return <Loading label="Loading support numbers…" />;

  return (
    <section className={cx('mb-6 flex flex-col gap-6 transition-opacity', query.isFetching && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          <span className="font-semibold text-navy-900">{scopeLine}</span> · raised and fixed in {periodWord}; open
          counts are as of now.
        </p>
        <div role="tablist" aria-label="Period" className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {periods.map((p) => (
            <button
              key={p.value}
              role="tab"
              type="button"
              aria-selected={days === p.value}
              onClick={() => setDays(p.value)}
              className={cx(
                'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                days === p.value ? 'bg-navy-700 text-white' : 'text-gray-600 hover:text-navy-700',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Raised" value={n(t?.raised)} detail={`In ${periodWord}`} />
        <StatTile
          label="Fixed"
          value={n(t?.fixed)}
          detail={t?.fixed ? `${Math.round((t.fixedWithinTwoDays / t.fixed) * 100)}% within 2 days` : 'Completed'}
          to="/tickets?status=COMPLETED"
        />
        <StatTile
          label="Open now"
          value={n((t?.open ?? 0) + (t?.inProgress ?? 0))}
          detail={`${n(t?.inProgress)} in progress`}
          to="/tickets?status=OPEN"
        />
        <StatTile label="Without an owner" value={n(t?.unowned)} detail="Nobody has taken it" to="/tickets?unowned=1" />
        <StatTile label="First reply" value={duration(t?.medianFirstResponseHours)} detail="Typical (median) wait" />
        <StatTile
          label="Time to fix"
          value={duration(t?.medianFixHours)}
          detail={t?.averageFixHours != null ? `Average ${duration(t.averageFixHours)}` : 'Typical (median)'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Raised and fixed, last 12 weeks" className="lg:col-span-2">
          <PairedColumnChart
            series={['Raised', 'Fixed']}
            empty="No tickets in the last 12 weeks"
            xLabel={(key) => `Week of ${displayDate(key)}`}
            points={d.weeks.map((w) => ({
              key: w.weekStart,
              label: displayDate(w.weekStart).replace(/,?\s*\d{4}$/, ''),
              a: w.opened,
              b: w.completed,
            }))}
          />
        </Card>
        <Card title="What people ask for">
          <BarList
            valueLabel="Tickets"
            empty={`No tickets in ${periodWord}`}
            items={d.byCategory.map((c) => ({ label: c.label.replaceAll('_', ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()), value: c.value }))}
          />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {d.scope !== 'mine' ? (
          <Card title={d.byTeam.length > 1 ? 'By team' : 'Your team'}>
            <BarList
              valueLabel="Raised"
              empty={`No tickets in ${periodWord}`}
              items={d.byTeam.map((r) => ({
                label: r.team,
                value: r.raised,
                note: `${r.fixed} fixed · ${r.open} open · fix ${duration(r.medianFixHours)}`,
                to: `/tickets?teamId=${r.teamId}`,
              }))}
            />
          </Card>
        ) : null}
        <Card title="By priority">
          <ul className="divide-y divide-gray-100">
            {d.byPriority.map((p) => (
              <li key={p.priority} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="w-20">
                  <Badge value={p.priority === 'HIGH' ? 'HIGH' : p.priority === 'MEDIUM' ? 'IN_PROGRESS' : 'OPEN'} label={p.priority.toLowerCase()} />
                </span>
                <Link
                  to={`/tickets?priority=${p.priority}`}
                  className="flex-1 text-gray-700 no-underline hover:text-navy-700"
                >
                  {p.raised} raised · <span className={p.open && p.priority === 'HIGH' ? 'font-semibold text-red-700' : ''}>{p.open} open</span>
                </Link>
                <span className="text-xs text-gray-500">fix {duration(p.medianFixHours)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Waiting longest" className={d.scope === 'mine' ? 'lg:col-span-2' : ''}>
          {d.oldestOpen.length ? (
            <ul className="divide-y divide-gray-100">
              {d.oldestOpen.map((o) => (
                <li key={o.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <Link to={`/tickets/${o.id}`} className="min-w-0 flex-1 no-underline">
                    <span className="block truncate font-medium text-gray-900 hover:text-navy-700">{o.subject}</span>
                    <span className="text-xs text-gray-500">
                      #{o.ticketNumber} · {o.team} · {o.owned ? 'owned' : 'no owner'}
                    </span>
                  </Link>
                  <span className={cx('text-xs whitespace-nowrap', o.ageDays >= 7 ? 'font-semibold text-red-700' : 'text-gray-500')}>
                    {o.ageDays === 0 ? 'today' : `${o.ageDays}d`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyChart>No open tickets</EmptyChart>
          )}
        </Card>
      </div>
    </section>
  );
}
