import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { ErrorNotice, Field, Loading, PageTitle, Panel } from './ui';

type Permission = { roleCode: string; fieldName: string; canView: boolean; canEdit: boolean };
type PermissionData = { roles: string[]; fields: string[]; permissions: Permission[] };

const labels: Record<string, string> = {
  description: 'Asset description',
  purchase_cost: 'Purchase price',
  purchase_date: 'Purchase date',
  serial_number: 'Serial number',
  location_id: 'Location',
  status: 'Status',
  condition: 'Condition',
};

function label(field: string) {
  return labels[field] ?? field.replaceAll('_', ' ');
}
function databaseField(field: string) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function FieldPermissions() {
  const query = useQuery({
    queryKey: ['field-permissions'],
    queryFn: () => api<PermissionData>('/field-permissions'),
  });
  const action = useAction();
  const [role, setRole] = useState('INSURER');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<Record<string, { view: boolean; edit: boolean }>>({});
  const data = query.data;
  const current = useMemo(() => {
    if (!data) return {};
    const next: Record<string, { view: boolean; edit: boolean }> = {};
    for (const field of data.fields) next[field] = { view: false, edit: false };
    for (const permission of data.permissions.filter((item) => item.roleCode === role))
      next[databaseField(permission.fieldName)] = { view: permission.canView, edit: permission.canEdit };
    return next;
  }, [data, role]);
  const values = Object.keys(draft).length ? draft : current;
  if (query.isPending) return <Loading />;
  if (query.error || !data)
    return <ErrorNotice error={query.error ?? new Error('Field permissions unavailable')} retry={() => void query.refetch()} />;
  async function save() {
    await action.mutateAsync({
      path: `/field-permissions/${role}`,
      method: 'PUT',
      body: {
        fields: Object.entries(values)
          .filter(([, permission]) => permission.view)
          .map(([name, permission]) => ({ name, view: permission.view, edit: permission.edit })),
        reason: reason.trim(),
      },
    });
    setDraft({});
    setReason('');
    await query.refetch();
  }
  return (
    <>
      <PageTitle
        title="Field permissions"
        description="Choose which asset fields each specialist role can view or edit."
      />
      <ErrorNotice error={action.error} />
      <Panel title="Role visibility">
        <div className="form-grid">
          <Field label="Role" htmlFor="permission-role">
            <select id="permission-role" value={role} onChange={(event) => { setRole(event.target.value); setDraft({}); }}>
              {data.roles.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </Field>
          <Field label="Reason for this change" htmlFor="permission-reason">
            <input id="permission-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} />
          </Field>
        </div>
        <div className="permission-list">
          {data.fields.map((field) => {
            const permission = values[field] ?? { view: false, edit: false };
            return (
              <div className="permission-row" key={field}>
                <strong>{label(field)}</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={permission.view}
                    onChange={(event) => setDraft({ ...values, [field]: { view: event.target.checked, edit: event.target.checked && permission.edit } })}
                  />
                  View
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={permission.edit}
                    disabled={!permission.view}
                    onChange={(event) => setDraft({ ...values, [field]: { ...permission, edit: event.target.checked } })}
                  />
                  Edit
                </label>
              </div>
            );
          })}
        </div>
        <button className="button" type="button" disabled={!reason.trim() || action.isPending} onClick={() => void save()}>
          {action.isPending ? 'Saving...' : 'Save permissions'}
        </button>
      </Panel>
    </>
  );
}
