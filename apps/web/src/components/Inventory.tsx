import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Empty, ErrorNotice, Loading, PageTitle, Panel } from './ui';

interface InventoryRow {
  category: string;
  asset_type: string;
  total_count: number;
  in_store_count: number;
  ready_count: number;
  assigned_count: number;
  other_count: number;
  stock_status: string;
}

export function Inventory() {
  const query = useQuery({
    queryKey: ['inventory'],
    queryFn: ({ signal }) => api<{ items: InventoryRow[] }>('/inventory', { signal }),
  });
  const rows = query.data?.items ?? [];

  return (
    <>
      <PageTitle
        eyebrow="INVENTORY & STORE"
        title="Inventory"
        description="Stock levels for each product type: how many are in store, ready, assigned or elsewhere."
      />
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      <Panel title="Stock by product type">
        {query.isPending ? (
          <Loading label="Loading inventory…" />
        ) : rows.length ? (
          <div className="table-scroll">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Product type</th>
                  <th>Category</th>
                  <th>Stock</th>
                  <th className="num">Total</th>
                  <th className="num">In store</th>
                  <th className="num">Ready</th>
                  <th className="num">Assigned</th>
                  <th className="num">Other</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={`${item.category}-${item.asset_type}`}>
                    <td>
                      <strong>{item.asset_type || 'Unspecified'}</strong>
                    </td>
                    <td>{item.category}</td>
                    <td>
                      <Badge value={item.stock_status} />
                    </td>
                    <td className="num">{item.total_count}</td>
                    <td className="num">{item.in_store_count}</td>
                    <td className="num">{item.ready_count}</td>
                    <td className="num">{item.assigned_count}</td>
                    <td className="num">{item.other_count}</td>
                    <td>
                      <Link
                        className="button secondary small"
                        to={`/assets?category=${encodeURIComponent(item.category)}&assetType=${encodeURIComponent(item.asset_type ?? '')}`}
                      >
                        View assets
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No assets yet">
            Stock appears here once assets are added to the catalog.
          </Empty>
        )}
      </Panel>
    </>
  );
}
