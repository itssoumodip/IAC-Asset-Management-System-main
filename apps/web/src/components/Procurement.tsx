import { formatInr } from '../admin-insights';
import { BarList, Card, ColumnChart, StatTile } from './charts';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { can } from '../session';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  buttonClass,
  tableWrapClass,
  tableClass,
  cx,
} from './ui';

interface PurchaseRow {
  id: string;
  purchaseCode: string;
  supplier: string;
  purchaseDate: string;
  quantity: number;
  amount: number;
  currency: string;
  notes: string | null;
  createdByName: string;
  createdAt: string;
}

/** Numbers and charts over the purchase record: this financial year, month by month, suppliers. */
function ProcurementInsights({ data }: { data: PurchaseRow[] }) {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyStart = new Date(fyStartYear, 3, 1);
  const thisYear = data.filter((p) => new Date(p.purchaseDate) >= fyStart);
  const spent = thisYear.reduce((s, p) => s + p.amount, 0);
  const units = thisYear.reduce((s, p) => s + p.quantity, 0);
  const suppliers = new Map<string, { amount: number; count: number }>();
  for (const p of data) {
    const key = p.supplier.trim() || 'Unknown';
    const cur = suppliers.get(key) ?? { amount: 0, count: 0 };
    suppliers.set(key, { amount: cur.amount + p.amount, count: cur.count + 1 });
  }
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    return { y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleDateString('en-IN', { month: 'short' }), amount: 0, count: 0 };
  });
  for (const p of data) {
    const d = new Date(p.purchaseDate);
    const slot = months.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
    if (slot) {
      slot.amount += p.amount;
      slot.count += 1;
    }
  }
  const last = [...data].sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate))[0];
  return (
    <div className="mb-6 flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Purchases this year" value={thisYear.length.toLocaleString('en-IN')} detail={`Since 1 April ${fyStartYear}`} />
        <StatTile label="Spent this year" value={formatInr(spent)} detail="Recorded amount" />
        <StatTile label="Units bought" value={units.toLocaleString('en-IN')} detail="This financial year" />
        <StatTile
          label="Average purchase"
          value={thisYear.length ? formatInr(spent / thisYear.length) : '—'}
          detail="This financial year"
        />
        <StatTile label="Suppliers" value={suppliers.size.toLocaleString('en-IN')} detail="All time" />
        <StatTile label="Last purchase" value={last ? new Date(last.purchaseDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'} detail={last ? last.supplier : 'None recorded'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Spend by month, last 12 months">
          <ColumnChart
            valueLabel="Spend"
            labelHeader="Month"
            empty="No purchases in the last 12 months"
            format={formatInr}
            shortFormat={(v) => (v >= 1e5 ? `₹${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `₹${Math.round(v / 1e3)}k` : `₹${Math.round(v)}`)}
            items={months.map((m) => ({ label: m.label, value: m.amount, detail: `${m.label}: ${formatInr(m.amount)} · ${m.count} purchases` }))}
          />
        </Card>
        <Card title="Top suppliers by spend">
          <BarList
            valueLabel="Spend"
            format={formatInr}
            empty="No purchases recorded"
            items={[...suppliers.entries()].map(([label, s]) => ({ label, value: s.amount, note: `${s.count} purchase${s.count === 1 ? '' : 's'}` }))}
          />
        </Card>
      </div>
    </div>
  );
}

/** Procurement page: approved requests to buy, out-of-stock products, basic purchase record
 * (supplier, date, qty, amount). [OPEN full PO] */
export function Procurement() {
  const { user } = useSession();
  const allowed = can(user, 'procurement.view');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You need procurement view permission to view this page.</p>
      </Panel>
    );

  const query = useQuery({
    queryKey: ['procurement'],
    queryFn: ({ signal }) => api<{ items: PurchaseRow[] }>('/procurement', { signal }),
  });
  const action = useAction();

  const [purchaseCode, setPurchaseCode] = useState('');
  const [supplier, setSupplier] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const data = query.data?.items ?? [];
  const totalAmount = data.reduce((sum, p) => sum + p.amount, 0);
  const totalQty = data.reduce((sum, p) => sum + p.quantity, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !purchaseCode.trim() ||
      !supplier.trim() ||
      !purchaseDate ||
      !quantity.trim() ||
      !amount.trim() ||
      action.isPending
    )
      return;
    await action
      .mutateAsync({
        path: '/procurement',
        method: 'POST',
        body: {
          purchaseCode: purchaseCode.trim(),
          supplier: supplier.trim(),
          purchaseDate,
          quantity: parseInt(quantity, 10),
          amount: parseFloat(amount),
          currency: 'INR',
          notes: notes.trim() || null,
        },
      })
      .then(() => {
        setPurchaseCode('');
        setSupplier('');
        setPurchaseDate('');
        setQuantity('');
        setAmount('');
        setNotes('');
        void query.refetch();
      })
      .catch(() => undefined);
  }

  return (
    <>
      <PageTitle
        eyebrow="FINANCE & REPORTS"
        title="Procurement"
        description="Approved requests to buy, out-of-stock products, basic purchase record (supplier, date, qty, amount)."
      />
      <ErrorNotice error={action.error ?? query.error} />
      {query.data ? <ProcurementInsights data={data} /> : null}

      <Panel title="Record a purchase">
        <p className="muted">Record a purchase with its supplier, date, quantity and amount.</p>
        <div className="form-grid">
          <Field label="Purchase code" htmlFor="procurement-code">
            <input
              id="procurement-code"
              value={purchaseCode}
              onChange={(e) => setPurchaseCode(e.target.value)}
              maxLength={40}
              required
            />
          </Field>
          <Field label="Supplier" htmlFor="procurement-supplier">
            <input
              id="procurement-supplier"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              maxLength={200}
              required
            />
          </Field>
          <Field label="Purchase date" htmlFor="procurement-date">
            <input
              id="procurement-date"
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Quantity" htmlFor="procurement-quantity">
            <input
              id="procurement-quantity"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              min="1"
              required
            />
          </Field>
          <Field label="Amount (INR)" htmlFor="procurement-amount">
            <input
              id="procurement-amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              step="0.01"
              min="0"
              required
            />
          </Field>
          <Field label="Notes" htmlFor="procurement-notes">
            <input
              id="procurement-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
            />
          </Field>
          <div className="form-actions">
            <button
              className={buttonClass()}
              type="button"
              disabled={
                !purchaseCode.trim() ||
                !supplier.trim() ||
                !purchaseDate ||
                !quantity.trim() ||
                !amount.trim() ||
                action.isPending
              }
              onClick={submit}
            >
              {action.isPending ? 'Saving…' : 'Record purchase'}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="Purchase history">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Purchases" value={<>{data.length}</>} />
          <StatTile label="Total amount" value={<>{formatInr(totalAmount)}</>} />
          <StatTile label="Total quantity" value={<>{totalQty}</>} />
        </div>
        {query.isPending ? (
          <Loading />
        ) : data.length ? (
          <div className={tableWrapClass}>
            <table className={cx(tableClass, 'category-table')}>
              <thead>
                <tr>
                  <th>Purchase code</th>
                  <th>Supplier</th>
                  <th>Date</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>Created by</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.purchaseCode}</td>
                    <td>{p.supplier}</td>
                    <td>{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</td>
                    <td className="mono">{p.quantity}</td>
                    <td className="mono">{formatInr(p.amount)}</td>
                    <td>{p.createdByName}</td>
                    <td>{p.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No purchases recorded yet" />
        )}
      </Panel>
    </>
  );
}
