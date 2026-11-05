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

      <Panel title="Record a purchase">
        <p className="muted">
          Record a basic purchase: supplier, date, quantity, and amount. [OPEN full PO]
        </p>
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
              className="button"
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
        <div className="mini-stats">
          <div className="stat">
            <strong>{data.length}</strong>
            <span className="muted small-text">purchases</span>
          </div>
          <div className="stat">
            <strong>₹{totalAmount.toLocaleString('en-IN')}</strong>
            <span className="muted small-text">total amount</span>
          </div>
          <div className="stat">
            <strong>{totalQty}</strong>
            <span className="muted small-text">total quantity</span>
          </div>
        </div>
        {query.isPending ? (
          <Loading />
        ) : data.length ? (
          <div className="table-scroll">
            <table className="category-table">
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
                    <td className="mono">₹{p.amount.toLocaleString('en-IN')}</td>
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
