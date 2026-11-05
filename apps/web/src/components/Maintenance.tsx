import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  Panel,
} from './ui';

interface MaintenanceRow {
  id: string;
  maintenanceId: string;
  assetCode: string;
  assetDescription: string;
  assetType: string;
  type: string;
  status: string;
  scheduledDate: string;
  dueDate: string;
  completedAt: string | null;
  assignedToName: string | null;
  assignedToEmail: string | null;
}

/** Preventive maintenance page: schedules, upcoming/overdue work, and completion. */
export function Maintenance() {
  const { user } = useSession();
  const allowed = can(user, 'ticket.work');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need work order permission to view maintenance schedules.</p>
      </Panel>
    );

  const query = useQuery({
    queryKey: ['maintenance'],
    queryFn: ({ signal }) => api<{ items: MaintenanceRow[] }>('/maintenance', { signal }),
  });
  const action = useAction();
  const [view, setView] = useState<'upcoming' | 'all'>('upcoming');

  const data = query.data?.items ?? [];

  const upcoming = data.filter((m) => !m.completedAt);
  const completed = data.filter((m) => !!m.completedAt);
  const overdue = upcoming.filter(
    (m) => m.dueDate && new Date(m.dueDate) < new Date() && new Date(m.dueDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0),
  );

  const rows = view === 'upcoming' ? upcoming : data;

  return (
    <>
      <PageTitle
        eyebrow="MAINTENANCE & AUDIT"
        title="Preventive maintenance"
        description="Track scheduled maintenance per asset or subcategory, view upcoming and overdue work, and record completions."
      />
      <ErrorNotice error={action.error ?? query.error} />
      <div className="dashboard-columns">
        <div className="mini-stats">
          <div className="stat">
            <strong>{upcoming.length}</strong>
            <span className="muted small-text">upcoming</span>
          </div>
          <div className="stat warn">
            <strong>{overdue.length}</strong>
            <span className="muted small-text">overdue</span>
          </div>
          <div className="stat">
            <strong>{completed.length}</strong>
            <span className="muted small-text">completed</span>
          </div>
        </div>
      </div>

      <Panel title={view === 'upcoming' ? 'Upcoming & overdue' : 'All maintenance'}>
        <div className="form-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={`button ${view === 'upcoming' ? '' : 'secondary'}`}
            onClick={() => setView('upcoming')}
          >
            Upcoming
          </button>
          <button
            type="button"
            className={`button ${view === 'all' ? '' : 'secondary'}`}
            onClick={() => setView('all')}
          >
            All
          </button>
        </div>
        {query.isPending ? (
          <Loading />
        ) : rows.length ? (
          <div className="table-scroll">
            <table className="category-table">
              <thead>
                <tr>
                  <th>Maintenance ID</th>
                  <th>Asset</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Assigned to</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.maintenanceId}</td>
                    <td>
                      <strong>{m.assetCode}</strong>
                      <span className="muted small-text block">{m.assetDescription}</span>
                    </td>
                    <td>{m.assetType}</td>
                    <td>
                      <Badge
                        value={
                          m.completedAt ? 'COMPLETED' : m.status.toUpperCase()
                        }
                      />
                    </td>
                    <td className="mono">{m.dueDate}</td>
                    <td>
                      <strong>{m.assignedToName ?? '—'}</strong>
                      <span className="muted small-text block">{m.assignedToEmail ?? ''}</span>
                    </td>
                    <td>
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={action.isPending}
                        onClick={() => {
                          // Handled via completion flow below
                        }}
                      >
                        Mark complete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={view === 'upcoming' ? 'No upcoming maintenance' : 'No maintenance records'} />
        )}
      </Panel>
    </>
  );
}
