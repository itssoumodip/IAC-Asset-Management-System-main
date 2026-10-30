import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { can, useSession } from '../session';
import { barPercent, formatInr } from '../admin-insights';
import {
  fillWeeks,
  formatHours,
  pieSlices,
  statusTotals,
  teamTotals,
  weekStarts,
  type TeamStatusRow,
  type TrendWeek,
} from '../executive';
import { ErrorNotice, Loading, Metric, Panel } from './ui';

export interface ExecutiveData {
  assetsByTeam: TeamStatusRow[];
  needsAttention: {
    pendingFinance: number;
    leftHoldersWithAssets: number;
    warrantyExpiring30: number;
    amcExpiring30: number;
    openHighTickets: number;
  };
  spendByProject: { projectId: string | null; label: string; spend: number; count: number }[];
  spendByFy: { fyStart: number; label: string; spend: number; count: number }[];
  ticketTrends: {
    weeks: TrendWeek[];
    teams: {
      teamId: string;
      teamName: string;
      opened: number;
      completed: number;
      medianResolutionHours: number | null;
    }[];
  };
}

export function useExecutive() {
  return useQuery({
    queryKey: ['dashboard', 'executive'],
    queryFn: ({ signal }) => api<ExecutiveData>('/dashboard/executive', { signal }),
  });
}

export interface TeamDashboardData {
  assetsByTeam: TeamStatusRow[];
  needsAttention: {
    pendingFinance: number;
    leftHoldersWithAssets: number;
    warrantyExpiring30: number;
    amcExpiring30: number;
  };
  openTickets: number;
  scopedTeamIds: string[] | 'ALL';
}

export function useTeamDashboard() {
  return useQuery({
    queryKey: ['dashboard', 'team'],
    queryFn: ({ signal }) => api<TeamDashboardData>('/dashboard/team', { signal }),
  });
}

const PALETTE = ['#1b6c80', '#2f70bb', '#a86f0c', '#5d5f60', '#8fb6c0', '#9db9dd', '#d9b877'];
const plain = (n: number) => new Intl.NumberFormat('en-IN').format(n);

function TextTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <details className="viz-table-details">
      <summary>View as table</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row[0]}-${index}`}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface BarRow {
  label: string;
  value: number;
  detail?: string;
  to?: string;
}

function HBars({
  rows,
  format,
  caption,
  headers,
}: {
  rows: BarRow[];
  format: (value: number) => string;
  caption: string;
  headers: [string, string];
}) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  if (!rows.length || max === 0) return <p className="muted admin-insights-empty">No data yet</p>;
  return (
    <>
      <div
        className="exec-bars"
        role="img"
        aria-label={`${caption}. ${rows.map((row) => `${row.label}: ${format(row.value)}`).join('; ')}`}
      >
        {rows.map((row) => {
          const body = (
            <>
              <span className="exec-bar-label" title={row.label}>
                {row.label}
              </span>
              <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                <rect x="0" y="0" width="100" height="8" className="exec-track" />
                <rect x="0" y="0" width={barPercent(row.value, max)} height="8" className="exec-fill" />
              </svg>
              <span className="exec-bar-value">{format(row.value)}</span>
            </>
          );
          return row.to ? (
            <Link className="exec-bar-row" to={row.to} key={row.label}>
              {body}
            </Link>
          ) : (
            <div className="exec-bar-row" key={row.label}>
              {body}
            </div>
          );
        })}
      </div>
      <TextTable headers={headers} rows={rows.map((row) => [row.label, format(row.value)])} />
    </>
  );
}

function Pie({ items, caption }: { items: { label: string; value: number }[]; caption: string }) {
  const slices = pieSlices(items);
  if (!slices.length) return <p className="muted admin-insights-empty">No data yet</p>;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <>
      <div className="exec-pie">
        <svg
          viewBox="-55 -55 110 110"
          role="img"
          aria-label={`${caption}. ${slices.map((s) => `${s.label}: ${plain(s.value)} (${Math.round(s.share * 100)}%)`).join('; ')}`}
        >
          {slices.map((slice, index) => (
            <path key={slice.label} d={slice.path} fill={PALETTE[index % PALETTE.length]} className="exec-slice" />
          ))}
        </svg>
        <ul className="exec-legend">
          {slices.map((slice, index) => (
            <li key={slice.label}>
              <span className="exec-swatch" style={{ background: PALETTE[index % PALETTE.length] }} />
              {slice.label} <strong>{plain(slice.value)}</strong>
              <small> {Math.round((slice.value / total) * 100)}%</small>
            </li>
          ))}
        </ul>
      </div>
      <TextTable
        headers={['Status', 'Assets']}
        rows={slices.map((slice) => [slice.label, plain(slice.value)])}
      />
    </>
  );
}

function TrendBars({
  weeks,
  starts,
  name,
}: {
  weeks: { weekStart: string; opened: number; completed: number }[];
  starts: string[];
  name: string;
}) {
  const max = Math.max(1, ...weeks.flatMap((week) => [week.opened, week.completed]));
  const step = 100 / starts.length;
  return (
    <svg
      className="exec-trend"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${name}: tickets opened and completed per week over the last ${starts.length} weeks. Opened ${weeks.reduce((s, w) => s + w.opened, 0)}, completed ${weeks.reduce((s, w) => s + w.completed, 0)}.`}
    >
      {weeks.map((week, index) => (
        <g key={week.weekStart}>
          <rect
            x={index * step + step * 0.1}
            width={step * 0.38}
            y={30 - (week.opened / max) * 28}
            height={(week.opened / max) * 28}
            className="exec-opened"
          >
            <title>{`Week of ${week.weekStart}: ${week.opened} opened`}</title>
          </rect>
          <rect
            x={index * step + step * 0.5}
            width={step * 0.38}
            y={30 - (week.completed / max) * 28}
            height={(week.completed / max) * 28}
            className="exec-completed"
          >
            <title>{`Week of ${week.weekStart}: ${week.completed} completed`}</title>
          </rect>
        </g>
      ))}
      <line x1="0" x2="100" y1="30.5" y2="30.5" className="exec-axis" />
    </svg>
  );
}

export function ExecutiveDashboard() {
  const { user } = useSession();
  const query = useExecutive();
  const data = query.data;
  if (query.isPending)
    return (
      <div className="admin-insights-skeleton">
        <Loading label="Loading executive overview…" />
      </div>
    );
  if (!data) {
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const attention = data.needsAttention;
  const teams = teamTotals(data.assetsByTeam);
  const statuses = statusTotals(data.assetsByTeam);
  const starts = weekStarts(new Date());
  return (
    <div className="exec">
      <Panel title="Needs attention">
        <div className="metric-grid five">
          <Metric
            label="Pending Finance"
            value={attention.pendingFinance}
            detail="Assets awaiting finance review"
            to="/finance"
          />
          <Metric
            label="Holders who left"
            value={attention.leftHoldersWithAssets}
            detail="Assets to recover"
            to={can(user, 'system.admin') ? '/admin/directory' : undefined}
          />
          <Metric
            label="Warranty ending"
            value={attention.warrantyExpiring30}
            detail="Within 30 days"
            to="/assets"
          />
          <Metric
            label="AMC ending"
            value={attention.amcExpiring30}
            detail="Within 30 days"
            to="/assets"
          />
          <Metric
            label="High-priority tickets"
            value={attention.openHighTickets}
            detail="Open right now"
            to="/tickets?priority=HIGH"
          />
        </div>
      </Panel>

      <div className="dashboard-columns">
        <Panel title="Assets by team">
          <HBars
            caption="Assets by owning team"
            headers={['Team', 'Assets']}
            format={plain}
            rows={teams.map((team) => ({
              label: team.label,
              value: team.count,
              to: `/assets?owningTeamId=${team.teamId}`,
            }))}
          />
          <p className="muted small-text">
            Purchase value:{' '}
            {teams.map((team) => `${team.label} ${formatInr(team.value)}`).join(' · ') || '—'}
          </p>
        </Panel>
        <Panel title="Assets by status">
          <Pie
            caption="Assets by status"
            items={statuses.map((status) => ({ label: status.label, value: status.count }))}
          />
          <div className="exec-chips">
            {statuses.map((status) => (
              <Link key={status.label} to={`/assets?status=${encodeURIComponent(status.label)}`}>
                {status.label}
              </Link>
            ))}
          </div>
        </Panel>
      </div>

      <div className="dashboard-columns">
        <Panel title="Spend by project">
          <HBars
            caption="Purchase spend by project"
            headers={['Project', 'Spend']}
            format={formatInr}
            rows={data.spendByProject.map((project) => ({
              label: project.label,
              value: project.spend,
              to: project.projectId ? `/assets?projectId=${project.projectId}` : undefined,
            }))}
          />
        </Panel>
        <Panel title="Spend by financial year (April to March)">
          <HBars
            caption="Purchase spend by financial year"
            headers={['Financial year', 'Spend']}
            format={formatInr}
            rows={[...data.spendByFy].reverse().map((year) => ({
              label: year.label,
              value: year.spend,
            }))}
          />
        </Panel>
      </div>

      <Panel title="Ticket trends, last 12 weeks">
        <div className="exec-trend-grid">
          {data.ticketTrends.teams.map((team) => (
            <Link
              className="exec-trend-card"
              key={team.teamId}
              to={`/tickets?teamId=${team.teamId}`}
            >
              <strong>{team.teamName}</strong>
              <TrendBars
                name={team.teamName}
                starts={starts}
                weeks={fillWeeks(data.ticketTrends.weeks, team.teamId, starts)}
              />
              <small>
                {team.opened} opened · {team.completed} completed · median{' '}
                {formatHours(team.medianResolutionHours)}
              </small>
            </Link>
          ))}
        </div>
        <p className="exec-key">
          <span className="exec-swatch opened" /> Opened <span className="exec-swatch completed" />{' '}
          Completed
        </p>
        <TextTable
          headers={['Team', 'Opened', 'Completed', 'Median resolution']}
          rows={data.ticketTrends.teams.map((team) => [
            team.teamName,
            String(team.opened),
            String(team.completed),
            formatHours(team.medianResolutionHours),
          ])}
        />
      </Panel>
    </div>
  );
}

export function TeamDashboard() {
  const { user } = useSession();
  const query = useTeamDashboard();
  const data = query.data;
  if (query.isPending)
    return (
      <div className="admin-insights-skeleton">
        <Loading label="Loading team dashboard…" />
      </div>
    );
  if (!data) {
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const attention = data.needsAttention;
  const teams = teamTotals(data.assetsByTeam);
  const statuses = statusTotals(data.assetsByTeam);
  return (
    <div className="exec">
      <Panel title="Needs attention">
        <div className="metric-grid five">
          <Metric
            label="Pending Finance"
            value={attention.pendingFinance}
            detail="Assets awaiting finance review"
            to="/finance"
          />
          <Metric
            label="Holders who left"
            value={attention.leftHoldersWithAssets}
            detail="Assets to recover"
          />
          <Metric
            label="Warranty ending"
            value={attention.warrantyExpiring30}
            detail="Within 30 days"
            to="/assets"
          />
          <Metric
            label="AMC ending"
            value={attention.amcExpiring30}
            detail="Within 30 days"
            to="/assets"
          />
          <Metric
            label="Open tickets"
            value={data.openTickets}
            detail="Open right now"
            to="/tickets?status=OPEN"
          />
        </div>
      </Panel>
      <div className="dashboard-columns">
        <Panel title="Assets by team">
          <HBars
            caption="Assets by owning team"
            headers={['Team', 'Assets']}
            format={plain}
            rows={teams.map((team) => ({
              label: team.label,
              value: team.count,
              to: `/assets?owningTeamId=${team.teamId}`,
            }))}
          />
          <p className="muted small-text">
            Purchase value:{' '}
            {teams.map((team) => `${team.label} ${formatInr(team.value)}`).join(' · ') || '—'}
          </p>
        </Panel>
        <Panel title="Assets by status">
          <Pie
            caption="Assets by status"
            items={statuses.map((status) => ({ label: status.label, value: status.count }))}
          />
          <div className="exec-chips">
            {statuses.map((status) => (
              <Link key={status.label} to={`/assets?status=${encodeURIComponent(status.label)}`}>
                {status.label}
              </Link>
            ))}
          </div>
        </Panel>
      </div>
      <p className="muted small-text">
        Scoped to:{' '}
        {data.scopedTeamIds === 'ALL'
          ? 'all teams'
          : data.scopedTeamIds.map((id) => {
              const team = (user?.teams ?? []).find((t) => t.teamId === id);
              return team ? team.teamCode : id;
            }).join(', ')}
      </p>
    </div>
  );
}
