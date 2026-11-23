import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  Panel,
  displayDate,
  tableClass,
  tableWrapClass,
} from './ui';

interface WarrantyRow {
  id: string;
  assetCode: string;
  description: string;
  owningTeam: string;
  warrantyExpiry: string | null;
  amcApplies: boolean;
  amcExpiry: string | null;
  warrantyDaysRemaining: number | null;
  amcDaysRemaining: number | null;
}

interface TicketTimingRow {
  id: string;
  ticketNumber: number;
  subject: string;
  teamName: string;
  status: string;
  priority: string;
  createdAt: string;
  firstResponseAt: string | null;
  completedAt: string | null;
  responseTimeHours: number | null;
  resolutionTimeHours: number | null;
}

export function WarrantyExpiry() {
  const query = useQuery({
    queryKey: ['report-warranty'],
    queryFn: ({ signal }) => api<{ items: WarrantyRow[] }>('/reports/warranty-expiry', { signal }),
  });
  return (
    <>
      <PageTitle
        eyebrow="ASSET CARE"
        title="Warranty & AMC"
        description="Track warranty and annual maintenance contract dates, including missing expiry information. Open an asset to review or update its records."
      />
      <ErrorNotice error={query.error} />
      <Panel title="Warranty and AMC expiry register">
        {query.isPending ? (
          <Loading />
        ) : query.data?.items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Description</th>
                  <th>Team</th>
                  <th>Warranty expiry</th>
                  <th>Days</th>
                  <th>AMC expiry</th>
                  <th>Days</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/assets/${row.id}`} className="mono">
                        {row.assetCode}
                      </Link>
                    </td>
                    <td>{row.description}</td>
                    <td>{row.owningTeam || '—'}</td>
                    <td>{row.warrantyExpiry ? displayDate(row.warrantyExpiry) : 'Not recorded'}</td>
                    <td className="mono">{row.warrantyDaysRemaining ?? '—'}</td>
                    <td>
                      {row.amcApplies
                        ? row.amcExpiry
                          ? displayDate(row.amcExpiry)
                          : 'Expiry not recorded'
                        : 'No AMC'}
                    </td>
                    <td className="mono">{row.amcApplies ? (row.amcDaysRemaining ?? '—') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No warranty or AMC records" />
        )}
      </Panel>
    </>
  );
}

export function TicketResponseTimes() {
  const query = useQuery({
    queryKey: ['ticket-response-times'],
    queryFn: ({ signal }) =>
      api<{ items: TicketTimingRow[] }>('/reports/ticket-response-times', { signal }),
  });
  return (
    <>
      <PageTitle
        eyebrow="SUPPORT / REPORTS"
        title="Ticket response times"
        description="See each ticket’s first public staff response and total resolution time. Open a ticket to review its timeline."
      />
      <ErrorNotice error={query.error} />
      <Panel title="Ticket timing">
        {query.isPending ? (
          <Loading />
        ) : query.data?.items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Subject</th>
                  <th>Team</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Created</th>
                  <th>First response</th>
                  <th>First response hours</th>
                  <th>Resolution hours</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/tickets/${row.id}`} className="mono">
                        #{row.ticketNumber}
                      </Link>
                    </td>
                    <td>{row.subject}</td>
                    <td>{row.teamName}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td>{row.priority}</td>
                    <td>{displayDate(row.createdAt, true)}</td>
                    <td>
                      {row.firstResponseAt
                        ? displayDate(row.firstResponseAt, true)
                        : 'Awaiting response'}
                    </td>
                    <td className="mono">{row.responseTimeHours ?? '—'}</td>
                    <td className="mono">{row.resolutionTimeHours ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No tickets in this view" />
        )}
      </Panel>
    </>
  );
}
