import { formatInr } from '../admin-insights';
import { StatTile } from './charts';
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

interface InsurerAsset {
  id: string;
  assetCode: string;
  description: string;
  category: string;
  assetType: string;
  purchaseDate: string | null;
  purchaseCost: number | null;
  location: string | null;
  status: string;
  repairCount: number;
}

interface LocationTotal {
  id: string;
  code: string;
  name: string;
  assetCount: number;
  totalPurchasePrice: number;
}

/** Insurance view: insurer-only list — asset name, photo, purchase price, purchase date,
 * repair history; totals by location; export. */
export function Insurance() {
  const { user } = useSession();
  const allowed = can(user, 'insurer.view');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need insurance view permission to view this page.</p>
      </Panel>
    );

  const [tab, setTab] = useState<'assets' | 'locations'>('assets');

  const assets = useQuery({
    queryKey: ['insurance-assets'],
    queryFn: ({ signal }) => api<{ items: InsurerAsset[] }>('/insurance', { signal }),
  });
  const locations = useQuery({
    queryKey: ['insurance-locations'],
    queryFn: ({ signal }) => api<{ items: LocationTotal[] }>('/insurance/locations', { signal }),
  });

  const totalPurchasePrice = (assets.data?.items ?? []).reduce(
    (sum, a) => sum + (a.purchaseCost ?? 0),
    0,
  );

  return (
    <>
      <PageTitle
        eyebrow="FINANCE & REPORTS"
        title="Insurance view"
        description="Insurer-only list: asset name, photo, purchase price, purchase date, repair history; totals by location."
      />
      <ErrorNotice error={assets.error ?? locations.error} />

      <div className="form-actions" style={{ marginBottom: 20, gap: 12 }}>
        <button
          type="button"
          className={buttonClass(tab === 'assets' ? 'primary' : 'secondary')}
          onClick={() => setTab('assets')}
        >
          Insured assets
        </button>
        <button
          type="button"
          className={buttonClass(tab === 'locations' ? 'primary' : 'secondary')}
          onClick={() => setTab('locations')}
        >
          Totals by location
        </button>
      </div>

      {tab === 'assets' && (
        <Panel title="Insured assets">
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Insured assets" value={<>{assets.data?.items.length ?? 0}</>} />
            <StatTile label="Total purchase price" value={<>{formatInr(totalPurchasePrice)}</>} />
          </div>
          {assets.isPending ? (
            <Loading />
          ) : assets.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Asset ID</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Type</th>
                    <th>Purchase date</th>
                    <th>Purchase price</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Repairs</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.data.items.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.assetCode}</td>
                      <td>{a.description}</td>
                      <td>{a.category}</td>
                      <td>{a.assetType}</td>
                      <td>{a.purchaseDate ?? '—'}</td>
                      <td className="mono">
                        {a.purchaseCost != null
                          ? `₹${a.purchaseCost.toLocaleString('en-IN')}`
                          : '—'}
                      </td>
                      <td>{a.location ?? '—'}</td>
                      <td>
                        <Badge value={a.status} />
                      </td>
                      <td className="mono">{a.repairCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No insured assets" />
          )}
        </Panel>
      )}

      {tab === 'locations' && (
        <Panel title="Totals by location">
          {locations.isPending ? (
            <Loading />
          ) : locations.data?.items.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Assets</th>
                    <th>Total purchase price</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.data.items.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.name || l.code}</strong>
                        <span className="muted small-text block">· {l.code}</span>
                      </td>
                      <td>{l.assetCount}</td>
                      <td className="mono">{formatInr(l.totalPurchasePrice)}</td>
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
    </>
  );
}
