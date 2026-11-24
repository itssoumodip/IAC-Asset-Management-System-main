import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useReferences } from './References';
import {
  Checkbox,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  buttonClass,
  tableClass,
  tableWrapClass,
  cx,
} from './ui';

interface Method {
  code: string;
  label: string;
  active: boolean;
  version: number;
  calculationType: 'SLM' | 'WDV';
  ratePercent: number | null;
  teamId: string | null;
  teamName: string | null;
  categoryCode: string | null;
  categoryLabel: string | null;
}

const emptyForm = {
  label: '',
  calculationType: 'SLM' as 'SLM' | 'WDV',
  ratePercent: '15',
  reason: '',
  active: true,
  teamId: '',
  categoryCode: '',
};

export function DepreciationSettings() {
  const query = useQuery({
    queryKey: ['depreciation-methods'],
    queryFn: ({ signal }) => api<{ items: Method[] }>('/depreciation/methods', { signal }),
  });
  const action = useAction<Method>();
  const refs = useReferences();
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState('');
  const methods = query.data?.items ?? [];
  const editing = methods.find((method) => method.code === editingCode);

  function startEdit(method: Method) {
    setEditingCode(method.code);
    setForm({
      label: method.label,
      calculationType: method.calculationType,
      ratePercent: method.ratePercent == null ? '' : String(method.ratePercent),
      active: method.active,
      reason: '',
      teamId: method.teamId ?? '',
      categoryCode: method.categoryCode ?? '',
    });
    action.reset();
    setMessage('');
  }

  function startCreate() {
    setEditingCode(null);
    setForm(emptyForm);
    action.reset();
    setMessage('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.reason.trim() || action.isPending) return;
    const body = {
      ...(editing
        ? { label: form.label.trim(), active: form.active }
        : {
            label: form.label.trim(),
          }),
      calculationType: form.calculationType,
      ratePercent: form.calculationType === 'WDV' ? Number(form.ratePercent) : null,
      teamId: form.teamId || null,
      categoryCode: form.categoryCode || null,
      reason: form.reason.trim(),
      ...(editing ? { version: editing.version } : {}),
    };
    const result = await action
      .mutateAsync({
        path: editing
          ? `/depreciation/methods/${encodeURIComponent(editing.code)}`
          : '/depreciation/methods',
        method: editing ? 'PATCH' : 'POST',
        body,
        version: editing?.version,
      })
      .then(() => true)
      .catch(() => false);
    if (result) {
      setMessage(editing ? 'Depreciation method updated.' : 'Depreciation method created.');
      startCreate();
    }
  }

  async function deleteMethod(method: Method) {
    if (method.active || action.isPending) return;
    if (
      !window.confirm(
        `Permanently delete “${method.label}”? This is available only when no asset or schedule uses it.`,
      )
    )
      return;
    const result = await action
      .mutateAsync({
        path: `/depreciation/methods/${encodeURIComponent(method.code)}`,
        method: 'DELETE',
      })
      .then(() => true)
      .catch(() => false);
    if (result) setMessage(`${method.label} deleted.`);
  }

  const teams = refs.data?.teams?.filter((team) => team.active) ?? [];
  const categories =
    refs.data?.values.filter((value) => value.kind === 'CATEGORY' && value.active) ?? [];
  const codePreview =
    form.label
      .normalize('NFD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]+/g, '_')
      .replaceAll(/^_+|_+$/g, '')
      .slice(0, 75) || 'METHOD';

  return (
    <>
      <PageTitle
        eyebrow="FINANCE & REPORTS / SETTINGS"
        title="Depreciation methods"
        description="Finance and Super Admin can create reusable methods, set calculation rules and rates, and scope them to asset categories and teams."
      />
      <ErrorNotice error={action.error ?? query.error} retry={() => void query.refetch()} />
      {message ? (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <Panel title="Saved methods">
          {query.isPending ? (
            <Loading />
          ) : methods.length ? (
            <div className={tableWrapClass}>
              <table className={cx(tableClass, 'category-table')}>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Calculation</th>
                    <th>Rate</th>
                    <th>Asset category</th>
                    <th>Team</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {methods.map((method) => (
                    <tr key={method.code}>
                      <td>
                        <strong>{method.label}</strong>
                        <div className="muted small-text">{method.code}</div>
                      </td>
                      <td>
                        {method.calculationType === 'SLM' ? 'Straight Line' : 'Written Down Value'}
                      </td>
                      <td>
                        {method.calculationType === 'SLM'
                          ? 'Useful life per asset'
                          : `${method.ratePercent ?? 15}% yearly`}
                      </td>
                      <td>{method.categoryLabel ?? 'All categories'}</td>
                      <td>{method.teamName ?? 'All teams'}</td>
                      <td>{method.active ? 'Active' : 'Inactive'}</td>
                      <td className="flex gap-2">
                        <button
                          type="button"
                          className={buttonClass('secondary')}
                          onClick={() => startEdit(method)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={buttonClass('secondary')}
                          disabled={method.active}
                          title={
                            method.active
                              ? 'Deactivate the method before deleting it'
                              : 'Delete if no assets or schedules use this method'
                          }
                          onClick={() => void deleteMethod(method)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No methods yet. Add one using the form.</p>
          )}
        </Panel>
        <Panel title={editing ? `Edit ${editing.label}` : 'Create a method'}>
          <form className="form-stack" onSubmit={save}>
            <Field label="Method name" htmlFor="method-label">
              <input
                id="method-label"
                required
                maxLength={150}
                value={form.label}
                onChange={(event) => setForm({ ...form, label: event.target.value })}
                placeholder="e.g. Building — straight line"
              />
            </Field>
            <Field label="Calculation rule" htmlFor="method-calculation">
              <Select
                label=""
                htmlFor="method-calculation"
                value={form.calculationType}
                onChange={(value) => setForm({ ...form, calculationType: value as 'SLM' | 'WDV' })}
                options={[
                  { value: 'SLM', label: 'Straight Line (SLM)' },
                  { value: 'WDV', label: 'Written Down Value (WDV)' },
                ]}
              />
            </Field>
            {form.calculationType === 'WDV' ? (
              <Field label="Annual depreciation rate (%)" htmlFor="method-rate">
                <input
                  id="method-rate"
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  required
                  value={form.ratePercent}
                  onChange={(event) => setForm({ ...form, ratePercent: event.target.value })}
                />
              </Field>
            ) : (
              <p className="muted small-text">
                SLM uses the asset’s useful life and residual value to calculate the annual charge.
              </p>
            )}
            <Field label="Asset category" htmlFor="method-category">
              <Select
                label=""
                htmlFor="method-category"
                value={form.categoryCode}
                onChange={(value) => setForm({ ...form, categoryCode: value })}
                options={[
                  { value: '', label: 'All categories' },
                  ...categories.map((category) => ({
                    value: category.code,
                    label: category.label,
                  })),
                ]}
              />
            </Field>
            <Field label="Team" htmlFor="method-team">
              <Select
                label=""
                htmlFor="method-team"
                value={form.teamId}
                onChange={(value) => setForm({ ...form, teamId: value })}
                options={[
                  { value: '', label: 'All teams' },
                  ...teams.map((team) => ({ value: team.id, label: team.name })),
                ]}
              />
            </Field>
            {!editing ? (
              <p className="muted small-text">
                Generated method code: <code>{codePreview}</code> (a number is added if needed)
              </p>
            ) : null}
            {editing ? (
              <Checkbox
                label="Available for new asset assignments"
                checked={form.active}
                onChange={(checked) => setForm({ ...form, active: checked })}
              />
            ) : null}
            <Field label="Reason for change" htmlFor="method-reason">
              <textarea
                id="method-reason"
                required
                maxLength={1000}
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button className={buttonClass()} disabled={action.isPending || !form.reason.trim()}>
                {action.isPending ? 'Saving…' : editing ? 'Save method' : 'Create method'}
              </button>
              {editing ? (
                <button type="button" className={buttonClass('secondary')} onClick={startCreate}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </Panel>
      </div>
    </>
  );
}
