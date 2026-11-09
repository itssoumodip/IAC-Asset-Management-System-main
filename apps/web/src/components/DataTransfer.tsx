import { useLayoutEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { cellText, downloadTable, readTable } from '../transfer-files';
import type { TransferColumn, TransferFormat } from '../transfer-files';
import {
  ErrorNotice,
  Field,
  Loading,
  actionsClass,
  buttonClass,
  tableWrapClass,
  noticeClass,
  tableClass,
  fileInputClass,
} from './ui';

const MAX_BULK_IMPORT_ROWS = 500;

export interface TransferField {
  key: string;
  label?: string;
  type?: 'string' | 'boolean' | 'list';
  required?: boolean;
  options?: readonly string[];
}
function ActionButtons({
  busy,
  run,
  template = false,
}: {
  busy: boolean;
  run: (format: TransferFormat) => void;
  template?: boolean;
}) {
  return (
    <div className={actionsClass}>
      <button
        type="button"
        className={buttonClass('secondary', 'sm')}
        disabled={busy}
        onClick={() => run('xlsx')}
      >
        {template ? 'Template Excel' : 'Export Excel'}
      </button>
      <button
        type="button"
        className={buttonClass('secondary', 'sm')}
        disabled={busy}
        onClick={() => run('csv')}
      >
        {template ? 'Template CSV' : 'Export CSV'}
      </button>
    </div>
  );
}
export function FormTransfer({
  formId,
  fields,
  values,
  onImport,
  disabled = false,
  description,
}: {
  formId: string;
  fields: readonly TransferField[];
  values: Record<string, unknown>;
  onImport: (values: Record<string, unknown>) => void;
  disabled?: boolean;
  description?: string;
}) {
  const controlId = useId();
  const [preview, setPreview] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState('');
  const generation = useRef(0),
    active = useRef(false),
    inFlight = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  useLayoutEffect(() => {
    generation.current++;
    setPreview(undefined);
    setError(undefined);
    setMessage('');
    setBusy(false);
  }, [formId]);
  async function load(file: File | undefined) {
    const selected = ++generation.current;
    setPreview(undefined);
    setError(undefined);
    setMessage('');
    if (!file) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const table = await readTable(file);
      if (table.rows.length !== 1)
        throw new Error('This form accepts one row. Use bulk import for multiple records.');
      const row = table.rows[0];
      if (row.__form !== formId)
        throw new Error(
          'Use the template for this specific form. Its __form heading identifies the form.',
        );
      const known = new Map(fields.map((field) => [field.key, field]));
      const result: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(row)) {
        if (key === '__form') continue;
        const field = known.get(key);
        if (!field) throw new Error(`The field ${key} cannot be imported into this form.`);
        // Our own CSV drafts escape formula-leading text for spreadsheet safety.
        const value =
          /\.csv$/i.test(file.name) && /^'+[\s\u0000-\u001f]*[=+@-]/.test(raw) ? raw.slice(1) : raw;
        if (field.required && !value.trim()) throw new Error(`${field.label ?? key} is required.`);
        if (field.type === 'boolean') {
          if (!['true', 'false'].includes(value.trim().toLowerCase()))
            throw new Error(`${field.label ?? key} must be true or false.`);
          result[key] = value.trim().toLowerCase() === 'true';
        } else if (field.type === 'list') {
          const list = value
            .split(/[;\r\n]+/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (field.options && list.some((item) => !field.options!.includes(item)))
            throw new Error(`${field.label ?? key} has an unsupported choice.`);
          result[key] = list;
        } else {
          if (field.options && value && !field.options.includes(value))
            throw new Error(`${field.label ?? key} has an unsupported choice.`);
          result[key] = value;
        }
      }
      if (!Object.keys(result).length) throw new Error('The file has no editable fields.');
      if (active.current && selected === generation.current) setPreview(result);
    } catch (caught) {
      if (active.current && selected === generation.current) setError(caught);
    } finally {
      if (active.current && selected === generation.current) setBusy(false);
    }
  }
  async function save(format: TransferFormat, template = false) {
    if (inFlight.current || disabled || busy) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const row = Object.fromEntries(
        fields.map((field) => [
          field.key,
          template
            ? field.type === 'boolean'
              ? false
              : ''
            : (values[field.key] ?? (field.type === 'boolean' ? false : '')),
        ]),
      );
      await downloadTable(
        `${formId}${template ? '-template' : '-draft'}`,
        ['__form', ...fields.map((field) => field.key)],
        [{ __form: formId, ...row }],
        format,
      );
    } catch (caught) {
      if (active.current) setError(caught);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <details className="group m-0 space-y-4 rounded-xl border border-gray-200 bg-white px-4 py-3 open:pb-4">
      <summary className="m-0 flex min-h-0 cursor-pointer list-none items-center justify-between gap-3 p-0 text-sm font-medium text-navy-900 select-none [&::-webkit-details-marker]:hidden">
        <span>Import / export form</span>
        <svg
          viewBox="0 0 16 16"
          className="size-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </summary>
      <p className="text-xs text-gray-500">
        {description ??
          'Load one Excel or CSV row for review. Loading does not save or submit the form.'}
      </p>
      <ActionButtons
        busy={disabled || busy}
        run={(format) => {
          void save(format);
        }}
      />
      <ActionButtons
        busy={disabled || busy}
        template
        run={(format) => {
          void save(format, true);
        }}
      />
      <Field
        label="Import form file"
        htmlFor={controlId}
        hint="CSV or one-sheet XLSX, up to 2 MiB. Use this form’s template."
      >
        <input
          id={controlId}
          type="file"
          className={fileInputClass}
          accept=".csv,.xlsx"
          disabled={disabled || busy}
          onChange={(event) => {
            void load(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </Field>
      {busy ? <Loading label="Preparing form file..." /> : null}
      <ErrorNotice error={error} />
      {preview ? (
        <div className="transfer-preview">
          <h3>Review imported fields</h3>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(preview).map(([key, value]) => (
                  <tr key={key}>
                    <td>{fields.find((field) => field.key === key)?.label ?? key}</td>
                    <td className="preserve">{cellText(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={buttonClass('secondary')}
            disabled={disabled || busy}
            onClick={() => {
              try {
                onImport(preview);
                setPreview(undefined);
                setMessage('Fields loaded. Review the form, then use its normal save action.');
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            Load into form
          </button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className={noticeClass('success')}>
          {message}
        </p>
      ) : null}
    </details>
  );
}

interface ExportJob {
  id: string;
  state: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
  rowCount: number | null;
}
/** Large lists are built by the worker; the browser only starts the job and downloads the file. */
function BackgroundExport({ filters }: { filters: Record<string, unknown> }) {
  const [jobId, setJobId] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [starting, setStarting] = useState(false);
  const job = useQuery({
    queryKey: ['export-job', jobId],
    enabled: !!jobId,
    queryFn: ({ signal }) => api<ExportJob>(`/exports/${jobId}`, { signal }),
    refetchInterval: (query) =>
      query.state.data && ['READY', 'FAILED'].includes(query.state.data.state) ? false : 2000,
  });
  async function start() {
    setStarting(true);
    setError(undefined);
    try {
      const created = await api<{ id: string }>('/exports', {
        method: 'POST',
        body: { kind: 'assets', filters, format: 'csv' },
      });
      setJobId(created.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setStarting(false);
    }
  }
  const state = job.data?.state;
  const working = starting || (!!jobId && state !== 'READY' && state !== 'FAILED');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={buttonClass('secondary', 'sm')}
        disabled={working}
        onClick={() => void start()}
      >
        Export all (background)
      </button>
      {working ? (
        <span role="status" className="text-xs text-gray-500">
          {state === 'RUNNING' ? 'Building the file...' : 'Export queued...'}
        </span>
      ) : null}
      {state === 'READY' ? (
        <span role="status" className="text-xs text-gray-500">
          Ready ({job.data?.rowCount ?? 0} rows).{' '}
          <a href={`/api/v1/exports/${jobId}/file`} download>
            Download CSV
          </a>{' '}
          (kept for 7 days)
        </span>
      ) : null}
      {state === 'FAILED' ? (
        <span role="alert" className="text-xs text-gray-500">
          The export failed. Try again.
        </span>
      ) : null}
      <ErrorNotice error={error ?? job.error} />
    </div>
  );
}

export function ExportRecords({
  name,
  columns,
  load,
  disabled = false,
  backgroundFilters,
}: {
  name: string;
  columns: TransferColumn[];
  load: () => Promise<Record<string, unknown>[]>;
  disabled?: boolean;
  /** Filters applied to the list, sent with the background export request. */
  backgroundFilters?: Record<string, unknown>;
}) {
  const background = name === 'assets'; // the only kind the server can export in the background
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const lock = useRef(false);
  async function run(format: TransferFormat) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await downloadTable(name, columns, await load(), format);
    } catch (caught) {
      setError(caught);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={`Export ${name}`}>
      <ActionButtons
        busy={disabled || busy}
        run={(format) => {
          void run(format);
        }}
      />
      {busy ? (
        <span role="status" className="text-xs text-gray-500">
          Preparing all matching records...
        </span>
      ) : null}
      {background ? <BackgroundExport filters={backgroundFilters ?? {}} /> : null}
      <ErrorNotice error={error} />
    </div>
  );
}

interface Definition {
  module: string;
  label: string;
  columns: string[];
  example: Record<string, string>;
  description: string;
}
interface Preview {
  id: string;
  module: string;
  rowCount: number;
  valid: boolean;
  rows: { rowNumber: number; valid: boolean; errors: string[]; summary: string }[];
  warnings: string[];
}
export function BulkTransfer({ module, disabled = false }: { module: string; disabled?: boolean }) {
  const query = useQuery({
    queryKey: ['transfer-definitions'],
    queryFn: ({ signal }) => api<{ items: Definition[] }>('/transfers/definitions', { signal }),
  });
  const definition = query.data?.items.find((item) => item.module === module);
  const id = useId(),
    client = useQueryClient();
  const [file, setFile] = useState<Awaited<ReturnType<typeof readTable>>>(),
    [reason, setReason] = useState('');
  const [sendEmails, setSendEmails] = useState(false);
  const [preview, setPreview] = useState<Preview>(),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState('');
  const lock = useRef(false),
    generation = useRef(0),
    active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  useLayoutEffect(() => {
    generation.current++;
    setFile(undefined);
    setPreview(undefined);
    setConfirmed(false);
    setSendEmails(false);
    setError(undefined);
    setMessage('');
    setBusy(false);
  }, [module]);
  async function choose(input: File | undefined) {
    const selected = ++generation.current;
    setFile(undefined);
    setPreview(undefined);
    setConfirmed(false);
    setError(undefined);
    setMessage('');
    if (!input) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const result = await readTable(input);
      if (result.rows.length > MAX_BULK_IMPORT_ROWS)
        throw new Error(
          `Bulk imports accept at most ${MAX_BULK_IMPORT_ROWS} records per batch. Split larger files into smaller batches.`,
        );
      if (
        definition &&
        result.rows.some((row) => Object.keys(row).some((key) => !definition.columns.includes(key)))
      )
        throw new Error('The file has unsupported columns. Download the template for this import.');
      if (active.current && selected === generation.current) setFile(result);
    } catch (caught) {
      if (active.current && selected === generation.current) setError(caught);
    } finally {
      if (active.current && selected === generation.current) setBusy(false);
    }
  }
  async function validate() {
    if (!file || !reason.trim() || busy || lock.current || disabled) return;
    const selected = ++generation.current;
    lock.current = true;
    setBusy(true);
    setPreview(undefined);
    setConfirmed(false);
    setError(undefined);
    setMessage('');
    try {
      const body = {
        module,
        filename: file.filename,
        sha256: file.sha256,
        reason: reason.trim(),
        sendEmails,
        rows: file.rows,
      };
      if (new TextEncoder().encode(JSON.stringify(body)).length > 6 * 1024 * 1024)
        throw new Error(
          'This batch exceeds 6 MiB. Reduce the file size or split it into smaller batches.',
        );
      const result = await api<Preview>('/transfers/preview', { method: 'POST', body });
      if (active.current && selected === generation.current) setPreview(result);
    } catch (caught) {
      if (active.current && selected === generation.current) setError(caught);
    } finally {
      lock.current = false;
      if (active.current && selected === generation.current) setBusy(false);
    }
  }
  async function commit() {
    if (
      !preview ||
      !preview.rows.some((row) => row.valid) ||
      !confirmed ||
      busy ||
      lock.current ||
      disabled
    )
      return;
    const selected = ++generation.current;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ rowCount: number; skippedCount: number; state: string }>(
        `/transfers/${preview.id}/commit`,
        { method: 'POST', body: { confirmed: true } },
      );
      await client.invalidateQueries();
      if (active.current && selected === generation.current) {
        setMessage(
          `${result.rowCount} records imported. ${result.skippedCount} invalid rows skipped. Changes saved with an audit trail.`,
        );
        setPreview(undefined);
        setFile(undefined);
        setConfirmed(false);
      }
    } catch (caught) {
      if (active.current && selected === generation.current) setError(caught);
    } finally {
      lock.current = false;
      if (active.current && selected === generation.current) setBusy(false);
    }
  }
  async function template(format: TransferFormat) {
    if (!definition || busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await downloadTable(
        `${module}-import-template`,
        definition.columns,
        [definition.example],
        format,
      );
    } catch (caught) {
      if (active.current) setError(caught);
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  if (query.isPending) return <Loading label="Loading import options..." />;
  if (query.error)
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  if (!definition) return null;
  const validRowCount = preview?.rows.filter((row) => row.valid).length ?? 0;
  const skippedRowCount = (preview?.rowCount ?? 0) - validRowCount;
  return (
    <details className="group m-0 space-y-4 rounded-xl border border-gray-200 bg-white px-4 py-3 open:pb-4">
      <summary className="m-0 flex min-h-0 cursor-pointer list-none items-center justify-between gap-3 p-0 text-sm font-medium text-navy-900 select-none [&::-webkit-details-marker]:hidden">
        <span>Bulk import {definition.label}</span>
        <svg
          viewBox="0 0 16 16"
          className="size-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </summary>
      <p className="text-xs text-gray-500">
        {definition.description} Use at most {MAX_BULK_IMPORT_ROWS} records per batch. Nothing is
        applied until you confirm the valid rows. Rows needing correction can be fixed and imported
        later.
      </p>
      <ActionButtons
        busy={disabled || busy}
        template
        run={(format) => {
          void template(format);
        }}
      />
      <Field label="Bulk import file" htmlFor={id}>
        <input
          id={id}
          type="file"
          className={fileInputClass}
          accept=".xlsx,.csv"
          disabled={disabled || busy}
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </Field>
      {file ? (
        <p className="text-xs text-gray-600">
          {file.filename} · {file.rows.length} rows ready for validation
        </p>
      ) : null}
      <Field label="Import reason" htmlFor={`${id}-reason`}>
        <textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={1000}
          disabled={disabled || busy}
          onChange={(event) => {
            generation.current++;
            setReason(event.target.value);
            setPreview(undefined);
            setConfirmed(false);
            setMessage('');
          }}
        />
      </Field>
      {module === 'people' || module === 'assignments' ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={sendEmails}
            disabled={disabled || busy}
            onChange={(event) => {
              generation.current++;
              setSendEmails(event.target.checked);
              setPreview(undefined);
              setConfirmed(false);
              setMessage('');
            }}
          />
          Send invitation and asset assignment emails after import
        </label>
      ) : null}
      <button
        type="button"
        className={buttonClass('secondary')}
        disabled={disabled || busy || !file || !reason.trim()}
        onClick={() => {
          void validate();
        }}
      >
        Validate import
      </button>
      {busy ? <Loading label="Processing import..." /> : null}
      <ErrorNotice error={error} />
      {preview ? (
        <div className="transfer-preview">
          <h3>Import preview · {preview.rowCount} rows</h3>
          {preview.warnings?.map((warning, index) => (
            <p key={index} className={noticeClass('warning')}>
              {warning}
            </p>
          ))}
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.valid ? 'Valid' : 'Needs correction'}</td>
                    <td>{row.errors.length ? row.errors.join('; ') : row.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {validRowCount > 0 ? (
            <>
              {skippedRowCount > 0 ? (
                <p className={noticeClass('warning')}>
                  {validRowCount} valid rows can be imported now. {skippedRowCount} rows needing
                  correction will be skipped and can be uploaded later in a separate batch.
                </p>
              ) : null}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={disabled || busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed these changes and authorize importing {validRowCount} valid rows.
                {skippedRowCount > 0
                  ? ` ${skippedRowCount} invalid rows will be skipped.`
                  : ''}{' '}
                {sendEmails
                  ? 'Invitation and assignment emails may be sent.'
                  : 'Email is off for this batch.'}
              </label>
              <button
                type="button"
                className={buttonClass()}
                disabled={disabled || busy || !confirmed}
                onClick={() => {
                  void commit();
                }}
              >
                Apply {validRowCount} valid rows
              </button>
            </>
          ) : (
            <p className={noticeClass('warning')}>
              There are no valid rows to import. Correct the file and validate it again.
            </p>
          )}
        </div>
      ) : null}
      {message ? (
        <p role="status" className={noticeClass('success')}>
          {message}
        </p>
      ) : null}
    </details>
  );
}
