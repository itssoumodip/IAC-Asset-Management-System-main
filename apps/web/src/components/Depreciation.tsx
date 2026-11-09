import { formatInr } from '../admin-insights';
import { StatTile } from './charts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import {
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  Panel,
  Select,
  buttonClass,
  tableWrapClass,
  tableClass,
  cx,
} from './ui';

interface DepreciationRow {
  id: string;
  assetCode: string;
  description: string;
  assetType: string;
  category: string;
  owningTeamId: string;
  teamName: string;
  status: string;
  purchaseDate: string | null;
  purchaseCost: number | null;
  residualValue: number | null;
  depreciationMethod: string | null;
  usefulLifeYears: number | null;
  capitalisationDate: string | null;
  currentValue: number;
  depreciatedValue: number;
}

/** Depreciation page: per-asset purchase date, capitalisation date, method, rate,
 * current value, depreciated value. Run by period; Companies Act and Income Tax views. */
export function Depreciation() {
  const { user } = useSession();
  const allowed = can(user, 'asset.finance_edit');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need finance edit permission to view depreciation.</p>
      </Panel>
    );

  const [fyStart, setFyStart] = useState<number>(new Date().getFullYear());
  const [method, setMethod] = useState<'SLM' | 'WDV'>('SLM');

  const query = useQuery({
    queryKey: ['depreciation'],
    queryFn: ({ signal }) => api<{ items: DepreciationRow[] }>('/depreciation', { signal }),
  });
  const action = useAction();

  const data = query.data?.items ?? [];

  // Summary stats
  const totalPurchaseCost = data.reduce((sum, a) => sum + (a.purchaseCost ?? 0), 0);
  const totalCurrentValue = data.reduce((sum, a) => sum + a.currentValue, 0);
  const uncappeditalised = data.filter((a) => !a.capitalisationDate).length;

  async function runDepreciation() {
    if (action.isPending) return;
    await action
      .mutateAsync({
        path: '/depreciation/run',
        method: 'POST',
        body: { financialYearStart: fyStart, method },
      })
      .then(() => {
        void query.refetch();
      })
      .catch(() => undefined);
  }

  return (
    <>
      <PageTitle
        eyebrow="FINANCE & REPORTS"
        title="Depreciation"
        description="Per-asset purchase date, capitalisation date, method, rate, current value and depreciated value. Run by period."
      />
      <ErrorNotice error={action.error ?? query.error} />

      <div className="flex flex-col gap-6">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Assets with cost" value={<>{data.length}</>} />
          <StatTile label="Purchase cost" value={<>{formatInr(totalPurchaseCost)}</>} />
          <StatTile label="Current value" value={<>{formatInr(totalCurrentValue)}</>} />
          <StatTile label="Not capitalised" value={<>{uncappeditalised}</>} />
        </div>
      </div>

      <Panel title="Depreciation register">
        <div className="form-actions" style={{ marginBottom: 12, gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted small-text">Financial year:</span>
            <input
              type="number"
              value={fyStart}
              onChange={(e) => setFyStart(parseInt(e.target.value, 10) || new Date().getFullYear())}
              min="2000"
              max="2100"
              style={{ width: 90 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted small-text">Method:</span>
            <Select
              label=""
              htmlFor="dep-method"
              value={method}
              onChange={(v) => setMethod(v as 'SLM' | 'WDV')}
              options={[
                { value: 'SLM', label: 'Straight Line' },
                { value: 'WDV', label: 'Written Down Value' },
              ]}
            />
          </div>
          <button
            className={buttonClass()}
            type="button"
            disabled={action.isPending}
            onClick={runDepreciation}
          >
            {action.isPending ? 'Running…' : 'Run depreciation'}
          </button>
        </div>
        <p className="muted small-text">
          Companies Act view: SLM depreciation over useful life. Income Tax view: WDV at prescribed
          rate. Capitalisation date is set automatically at first assignment.
        </p>
        {query.isPending ? (
          <Loading />
        ) : data.length ? (
          <div className={tableWrapClass}>
            <table className={cx(tableClass, 'category-table')}>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Team</th>
                  <th>Purchase date</th>
                  <th>Purchase cost</th>
                  <th>Capitalisation date</th>
                  <th>Method</th>
                  <th>Current value</th>
                  <th>Depreciated value</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.assetCode}</td>
                    <td>{a.description}</td>
                    <td>{a.category}</td>
                    <td>{a.teamName}</td>
                    <td>{a.purchaseDate ?? '—'}</td>
                    <td className="mono">
                      {a.purchaseCost != null ? `₹${a.purchaseCost.toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td>{a.capitalisationDate ?? '—'}</td>
                    <td>{a.depreciationMethod ?? '—'}</td>
                    <td className="mono">{formatInr(a.currentValue)}</td>
                    <td className="mono">{formatInr(a.depreciatedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No depreciable assets" />
        )}
      </Panel>

      <Panel title="Depreciation schedules by period">
        <p className="muted">
          Run depreciation for a financial year to generate per-asset schedules. Use the buttons
          above to run for the selected year and method.
        </p>
        <div className="muted small-text">
          Companies Act (SLM): Depreciation = (Purchase cost − Residual value) ÷ Useful life years,
          charged each year until residual value is reached. Income Tax (WDV): Depreciation = Rate%
          × Opening written-down value, reducing balance each year.
        </div>
      </Panel>
    </>
  );
}
