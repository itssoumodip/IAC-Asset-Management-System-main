import { formatInr } from '../admin-insights';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useSession } from '../session';
import { can } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  Panel,
  tableWrapClass,
  buttonClass,
  tableClass,
  cx,
} from './ui';

interface AssetRegisterRow {
  id: string;
  assetCode: string;
  description: string;
  category: string;
  assetType: string;
  owningTeam: string;
  location: string | null;
  status: string;
  purchaseDate: string | null;
  purchaseCost: number | null;
  currentValue: number;
  depreciatedValue: number;
  serialNumber: string | null;
}

interface LocationSummary {
  id: string;
  code: string;
  name: string;
  level: string;
  assetCount: number;
  purchaseValue: number;
  currentValue: number;
}

interface WarrantyExpiryRow {
  id: string;
  assetCode: string;
  description: string;
  owningTeam: string;
  warrantyExpiry: string | null;
  daysRemaining: number | null;
}

interface TicketResponseRow {
  id: string;
  ticketNumber: number;
  subject: string;
  teamName: string;
  status: string;
  priority: string;
  createdAt: string;
  completedAt: string | null;
  responseTimeHours: number | null;
}

interface VerificationCycleRow {
  id: string;
  cycleId: string;
  locationName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  auditorName: string;
  totalItems: number;
  verifiedItems: number;
  notFoundItems: number;
  wrongPlaceItems: number;
}

/** Reports: fixed asset register, depreciation, verification, assets by location,
 * insurer schedule, maintenance, warranty/AMC expiry, tickets and response times. */
export function Reports() {
  const { user } = useSession();
  const allowed = can(user, 'report.view');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need report view permission to view reports.</p>
      </Panel>
    );

  const [tab, setTab] = useState<'register' | 'location' | 'warranty' | 'tickets' | 'verification'>(
    'register',
  );

  const register = useQuery({
    queryKey: ['report-register'],
    queryFn: ({ signal }) =>
      api<{ items: AssetRegisterRow[] }>('/reports/fixed-asset-register', { signal }),
  });
  const locations = useQuery({
    queryKey: ['report-locations'],
    queryFn: ({ signal }) =>
      api<{ items: LocationSummary[] }>('/reports/assets-by-location', { signal }),
  });
  const warranty = useQuery({
    queryKey: ['report-warranty'],
    queryFn: ({ signal }) =>
      api<{ items: WarrantyExpiryRow[] }>('/reports/warranty-expiry', { signal }),
  });
  const tickets = useQuery({
    queryKey: ['report-tickets'],
    queryFn: ({ signal }) =>
      api<{ items: TicketResponseRow[] }>('/reports/ticket-response-times', { signal }),
  });
  const verification = useQuery({
    queryKey: ['report-verification'],
    queryFn: ({ signal }) =>
      api<{ items: VerificationCycleRow[] }>('/reports/verification', { signal }),
  });

  return (
    <>
      <PageTitle
        eyebrow="FINANCE & REPORTS"
        title="Reports"
        description="Fixed asset register, depreciation, verification, assets by location, warranty expiry, tickets and response times. Each with filters and Excel export."
      />
      <ErrorNotice
        error={
          register.error ?? locations.error ?? warranty.error ?? tickets.error ?? verification.error
        }
      />

      <div className="form-actions" style={{ marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={buttonClass(tab === 'register' ? 'primary' : 'secondary')}
          onClick={() => setTab('register')}
        >
          Asset register
        </button>
        <button
          type="button"
          className={buttonClass(tab === 'location' ? 'primary' : 'secondary')}
          onClick={() => setTab('location')}
        >
          Assets by location
        </button>
        <button
          type="button"
          className={buttonClass(tab === 'warranty' ? 'primary' : 'secondary')}
          onClick={() => setTab('warranty')}
        >
          Warranty & AMC expiry
        </button>
        <button
          type="button"
          className={buttonClass(tab === 'tickets' ? 'primary' : 'secondary')}
          onClick={() => setTab('tickets')}
        >
          Ticket response times
        </button>
        <button
          type="button"
          className={buttonClass(tab === 'verification' ? 'primary' : 'secondary')}
          onClick={() => setTab('verification')}
        >
          Verification cycles
        </button>
      </div>

      {tab === 'register' && (
        <Panel title="Fixed asset register (Companies Act format)">
          {register.isPending ? (
            <Loading />
          ) : register.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Asset ID</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Team</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Purchase date</th>
                    <th>Purchase cost</th>
                    <th>Current value</th>
                    <th>Depreciated value</th>
                    <th>Serial</th>
                  </tr>
                </thead>
                <tbody>
                  {register.data.items.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.assetCode}</td>
                      <td>{a.description}</td>
                      <td>{a.category}</td>
                      <td>{a.assetType}</td>
                      <td>{a.owningTeam}</td>
                      <td>{a.location ?? '—'}</td>
                      <td>
                        <Badge value={a.status} />
                      </td>
                      <td>{a.purchaseDate ?? '—'}</td>
                      <td className="mono">
                        {a.purchaseCost != null
                          ? `₹${a.purchaseCost.toLocaleString('en-IN')}`
                          : '—'}
                      </td>
                      <td className="mono">{formatInr(a.currentValue)}</td>
                      <td className="mono">{formatInr(a.depreciatedValue)}</td>
                      <td className="mono">{a.serialNumber ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No assets in register" />
          )}
        </Panel>
      )}

      {tab === 'location' && (
        <Panel title="Assets by location">
          {locations.isPending ? (
            <Loading />
          ) : locations.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Level</th>
                    <th>Assets</th>
                    <th>Purchase value</th>
                    <th>Current value</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.data.items.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.name || l.code}</strong>
                        <span className="muted small-text block">· {l.code}</span>
                      </td>
                      <td>
                        <Badge value={l.level} />
                      </td>
                      <td>{l.assetCount}</td>
                      <td className="mono">{formatInr(l.purchaseValue)}</td>
                      <td className="mono">{formatInr(l.currentValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No locations" />
          )}
        </Panel>
      )}

      {tab === 'warranty' && (
        <Panel title="Warranty & AMC expiry">
          {warranty.isPending ? (
            <Loading />
          ) : warranty.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Description</th>
                    <th>Team</th>
                    <th>Warranty expiry</th>
                    <th>Days remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {warranty.data.items.map((w) => (
                    <tr key={w.id}>
                      <td className="mono">{w.assetCode}</td>
                      <td>{w.description}</td>
                      <td>{w.owningTeam}</td>
                      <td>{w.warrantyExpiry ?? '—'}</td>
                      <td className="mono">{w.daysRemaining ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No warranty expiries" />
          )}
        </Panel>
      )}

      {tab === 'tickets' && (
        <Panel title="Ticket response times">
          {tickets.isPending ? (
            <Loading />
          ) : tickets.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Subject</th>
                    <th>Team</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Created</th>
                    <th>Completed</th>
                    <th>Response hours</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">#{t.ticketNumber}</td>
                      <td>{t.subject}</td>
                      <td>{t.teamName}</td>
                      <td>
                        <Badge value={t.status} />
                      </td>
                      <td>{t.priority}</td>
                      <td>{new Date(t.createdAt).toLocaleDateString('en-IN')}</td>
                      <td>
                        {t.completedAt ? new Date(t.completedAt).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td className="mono">{t.responseTimeHours ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No completed tickets" />
          )}
        </Panel>
      )}

      {tab === 'verification' && (
        <Panel title="Verification cycles (user vs auditor)">
          {verification.isPending ? (
            <Loading />
          ) : verification.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Cycle</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Items</th>
                    <th>Verified</th>
                    <th>Not found</th>
                    <th>Wrong place</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.data.items.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">{v.cycleId}</td>
                      <td>{v.locationName}</td>
                      <td>
                        <Badge value={v.status} />
                      </td>
                      <td>{new Date(v.startedAt).toLocaleDateString('en-IN')}</td>
                      <td>{v.totalItems}</td>
                      <td>{v.verifiedItems}</td>
                      <td>{v.notFoundItems}</td>
                      <td>{v.wrongPlaceItems}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No verification cycles" />
          )}
        </Panel>
      )}
    </>
  );
}
