import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorNotice, Panel, Field } from './ui';
type FieldName = 'purchaseCost' | 'purchaseDate' | 'invoiceNumber' | 'supplier';
interface Extraction {
  suggestions: Partial<Record<FieldName, { value: string; source: string }>>;
  warnings: string[];
}
interface Evidence {
  id: string;
  filename: string;
  sha256: string;
  bytes: number;
  extraction: Extraction;
}
const labels: Record<FieldName, string> = {
  purchaseCost: 'Invoice total (INR) - verify per-asset allocation',
  purchaseDate: 'Purchase date',
  invoiceNumber: 'Invoice number',
  supplier: 'Supplier',
};
export function InvoiceEvidence({
  assetId,
  version,
  canApply,
  onApply,
}: {
  assetId: string;
  version: number;
  canApply: boolean;
  onApply: (values: Partial<Record<FieldName, string>>, evidenceId: string) => void;
}) {
  const client = useQueryClient();
  const [evidenceId, setEvidenceId] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [extraction, setExtraction] = useState<Extraction>(),
    [selected, setSelected] = useState<FieldName[]>([]),
    [ack, setAck] = useState(false),
    [message, setMessage] = useState('');
  const list = useQuery({
    queryKey: ['invoice-evidence', assetId],
    queryFn: ({ signal }) =>
      api<{ items: Evidence[] }>(`/finance/assets/${assetId}/invoices`, { signal }),
  });
  async function upload(file: File) {
    setBusy(true);
    setError(undefined);
    setMessage('');
    setExtraction(undefined);
    setSelected([]);
    setAck(false);
    try {
      if (!/\.(pdf|xlsx)$/i.test(file.name) || file.size > 4 * 1024 * 1024 || !file.size)
        throw Error(
          'Choose a PDF or XLSX file up to 4 MiB. Legacy XLS and macro workbooks are unsupported.',
        );
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(Error('Could not read invoice'));
        reader.readAsDataURL(file);
      });
      const result = await api<Extraction & { id: string }>(`/finance/assets/${assetId}/invoices`, {
        method: 'POST',
        version,
        body: { filename: file.name, data },
      });
      setExtraction(result);
      setEvidenceId(result.id);
      await client.invalidateQueries({ queryKey: ['invoice-evidence', assetId] });
      setMessage('Evidence saved. Asset values and Finance approval are unchanged.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Invoice evidence & suggested values">
      <p>
        Upload a text PDF or plain XLSX, up to 4 MiB. Original evidence is retained privately for
        Admin and Finance. Scanned PDFs require manual entry. No external extraction service is
        used.
      </p>
      <Field label="Invoice file (PDF or XLSX)" htmlFor="invoice-file">
        <input
          id="invoice-file"
          type="file"
          accept=".pdf,.xlsx"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </Field>
      {busy ? <p role="status">Extracting within file and time limits...</p> : null}
      <ErrorNotice error={error} />
      <ErrorNotice error={list.error} />
      {message ? <p role="status">{message}</p> : null}
      {extraction ? (
        <div className="form-stack">
          <ul>
            {extraction.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          {(Object.keys(labels) as FieldName[]).map((field) => {
            const suggestion = extraction.suggestions[field];
            return (
              <div key={field}>
                {suggestion ? (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={selected.includes(field)}
                      disabled={!canApply}
                      onChange={(e) =>
                        setSelected((v) =>
                          e.target.checked ? [...v, field] : v.filter((x) => x !== field),
                        )
                      }
                    />
                    <span>
                      {labels[field]}: <strong>{suggestion.value}</strong>
                      <br />
                      <small>Source: {suggestion.source}</small>
                    </span>
                  </label>
                ) : (
                  <p>{labels[field]}: no reliable suggestion</p>
                )}
              </div>
            );
          })}
          {canApply ? (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
                checked the original, currency, line items, tax and per-asset allocation. Replace
                only the selected form fields.
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={!ack || !selected.length}
                onClick={() => {
                  onApply(
                    Object.fromEntries(selected.map((f) => [f, extraction.suggestions[f]!.value])),
                    evidenceId,
                  );
                  setMessage(
                    'Selected suggestions filled the review form only. Check them, add a review reason and separately record your decision.',
                  );
                }}
              >
                Apply selected suggestions to form
              </button>
            </>
          ) : (
            <p>
              Suggestions can be applied only by an eligible independent Finance reviewer on a
              current submitted record.
            </p>
          )}
        </div>
      ) : null}
      <p className="muted">
        Up to 50 distinct invoice files can be retained per asset. Downloads may contain active
        content: open only trusted files in an updated viewer.
      </p>
      <div className="form-stack">
        {list.data?.items.map((item) => (
          <article key={item.id}>
            <a href={`/api/v1/finance/assets/${assetId}/invoices/${item.id}`} download>
              {item.filename}
            </a>
            <p className="muted" style={{ overflowWrap: 'anywhere' }}>
              {item.bytes.toLocaleString()} bytes · SHA-256 {item.sha256}
            </p>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                setExtraction(item.extraction);
                setEvidenceId(item.id);
                setSelected([]);
                setAck(false);
                setMessage('Review the retained evidence before selecting suggested fields.');
              }}
            >
              Review extracted suggestions
            </button>
          </article>
        ))}
      </div>
    </Panel>
  );
}
