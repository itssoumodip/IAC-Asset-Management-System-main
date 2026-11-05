import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { RoleFieldResponse } from '../types';
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel } from './ui';

const ALL_ROLES: string[] = [
  'SUPER_ADMIN',
  'EXECUTIVE',
  'FINANCE',
  'TEAM_LEAD',
  'TEAM_MEMBER',
  'STORE',
  'TECHNICIAN',
  'AUDITOR',
  'INSURER',
  'PROCUREMENT',
  'EMPLOYEE',
];

const FIELD_GROUPS: Record<string, string[]> = {
  Identity: ['assetCode', 'category', 'assetType', 'description', 'manufacturer', 'model', 'serialNumber', 'barcode'],
  Location: ['departmentId', 'locationId', 'owningTeamId', 'status'],
  Condition: ['condition', 'riskLevel', 'dataWipeRequired', 'remarks', 'commentType'],
  'Warranty & AMC': ['warrantyExpiry', 'amcApplies', 'amcExpiry', 'lastLabelPrintedAt'],
  Purchase: ['purchaseDate', 'purchaseCost', 'currency', 'residualValue', 'depreciationMethod', 'usefulLifeYears', 'invoiceNumber', 'supplier'],
  Insurance: ['insurancePolicyNumber', 'insuranceExpiry'],
  Audit: ['lastAuditDate', 'nextAuditDate', 'assetOwner', 'financePending'],
  Finance: ['financeStatus', 'financeRejectionReason'],
};

function fieldLabel(name: string): string {
  const labels: Record<string, string> = {
    assetCode: 'Asset ID',
    category: 'Category',
    assetType: 'Asset type',
    description: 'Description',
    manufacturer: 'Manufacturer',
    model: 'Model',
    serialNumber: 'Serial number',
    barcode: 'Barcode / QR',
    departmentId: 'Department',
    locationId: 'Location',
    owningTeamId: 'Owning team',
    status: 'Status',
    condition: 'Condition',
    riskLevel: 'Risk level',
    dataWipeRequired: 'Data wipe required',
    remarks: 'Remarks',
    commentType: 'Comment type',
    warrantyExpiry: 'Warranty expiry',
    amcApplies: 'AMC applies',
    amcExpiry: 'AMC expiry',
    lastLabelPrintedAt: 'Last label printed',
    purchaseDate: 'Purchase date',
    purchaseCost: 'Purchase cost',
    currency: 'Currency',
    residualValue: 'Residual value',
    depreciationMethod: 'Depreciation method',
    usefulLifeYears: 'Useful life (years)',
    invoiceNumber: 'Invoice number',
    supplier: 'Supplier',
    insurancePolicyNumber: 'Insurance policy',
    insuranceExpiry: 'Insurance expiry',
    lastAuditDate: 'Last audit date',
    nextAuditDate: 'Next audit date',
    assetOwner: 'Asset owner',
    financePending: 'Finance pending',
    financeStatus: 'Finance status',
    financeRejectionReason: 'Finance rejection reason',
  };
  return labels[name] ?? name.replaceAll('_', ' ');
}

function roleLabel(role: string): string {
  return role.replaceAll('_', ' ');
}

export function RoleFieldPermissions() {
  const query = useQuery({
    queryKey: ['role-field-permissions'],
    queryFn: ({ signal }) => api<RoleFieldResponse>('/admin/roles/fields', { signal }),
  });
  const action = useAction<{ updated: number }>();
  const [selectedRole, setSelectedRole] = useState<string>('SUPER_ADMIN');
  const [reason, setReason] = useState('');
  const [edits, setEdits] = useState<Record<string, { canView: boolean; canEdit: boolean }>>({});

  const data = query.data;
  const group = data?.permissions.find((g) => g.roleCode === selectedRole);
  const fieldsByName = new Map(
    group?.fields.map((f) => [f.fieldName, f]) ?? [],
  );

  function toggle(fieldName: string, key: 'canView' | 'canEdit') {
    const currentView = isViewChecked(fieldName);
    const currentEdit = isEditChecked(fieldName);
    if (key === 'canEdit') {
      const next = !currentEdit;
      // Edit implies view.
      setEdits((prev) => ({
        ...prev,
        [fieldName]: { canView: next ? true : currentView, canEdit: next },
      }));
      return;
    }
    const next = !currentView;
    setEdits((prev) => ({
      ...prev,
      [fieldName]: { canView: next, canEdit: next ? currentEdit : false },
    }));
  }

  function isViewChecked(fieldName: string): boolean {
    const e = edits[fieldName];
    if (e) return e.canView;
    return fieldsByName.get(fieldName)?.canView ?? false;
  }

  function isEditChecked(fieldName: string): boolean {
    const e = edits[fieldName];
    if (e) return e.canEdit;
    return fieldsByName.get(fieldName)?.canEdit ?? false;
  }

  function fieldRows(): Array<{ key: string; fields: string[] }> {
    const result: Array<{ key: string; fields: string[] }> = [];
    for (const [groupName, fields] of Object.entries(FIELD_GROUPS)) {
      const present = fields.filter((f) => fieldsByName.has(f));
      if (present.length) result.push({ key: groupName, fields: present });
    }
    const assigned = new Set(Object.values(FIELD_GROUPS).flat());
    const extra = [...fieldsByName.keys()].filter((f) => !assigned.has(f));
    if (extra.length) result.push({ key: 'Other', fields: extra });
    return result;
  }

  const dirty = Object.keys(edits).length > 0;

  async function save() {
    if (!dirty || !reason.trim() || action.isPending) return;
    const permissions: Array<{
      roleCode: string;
      fieldName: string;
      canView: boolean;
      canEdit: boolean;
    }> = [];
    for (const [fieldName, values] of Object.entries(edits)) {
      permissions.push({
        roleCode: selectedRole,
        fieldName,
        canView: values.canView,
        canEdit: values.canEdit,
      });
    }
    for (const f of group?.fields ?? []) {
      if (!edits[f.fieldName]) {
        permissions.push({
          roleCode: selectedRole,
          fieldName: f.fieldName,
          canView: f.canView,
          canEdit: f.canEdit,
        });
      }
    }
    try {
      await action.mutateAsync({
        path: '/admin/roles/fields',
        method: 'PUT',
        body: { permissions, reason: reason.trim() },
      });
      setEdits({});
      setReason('');
    } catch {
      /* error shown by ErrorNotice */
    }
  }

  if (query.isPending) return <Loading label="Loading field permissions…" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / ROLES"
        title="Field permissions & roles"
        description="Choose which asset fields each role can see and edit. Hidden fields are not sent to that role."
      />
      <ErrorNotice error={action.error} />
      <div className="dashboard-columns">
        <Panel title="Choose a role">
          {ALL_ROLES.map((role) => (
            <button
              key={role}
              type="button"
              className={`button ${selectedRole === role ? '' : 'secondary'} field-role-button`}
              onClick={() => {
                setSelectedRole(role);
                setEdits({});
                setReason('');
              }}
            >
              {roleLabel(role)}
            </button>
          ))}
          <p className="muted small-text">
            Super Admin can edit all settings. Changes are recorded in the audit trail.
          </p>
        </Panel>
        <Panel title={`Configure ${roleLabel(selectedRole)}`}>
          {!group ? (
            <Empty title="No permission data for this role" />
          ) : (
            <>
              <Field label="Reason for change" htmlFor="role-field-reason">
                <textarea
                  id="role-field-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  maxLength={1000}
                  rows={3}
                />
              </Field>
              <div className="role-field-grid">
                {fieldRows().map(({ key: groupName, fields }) => (
                  <div key={groupName} className="role-field-section">
                    <h3>{groupName}</h3>
                    <table className="role-field-table">
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>View</th>
                          <th>Edit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((fieldName) => {
                          const viewChecked = isViewChecked(fieldName);
                          const editChecked = isEditChecked(fieldName);
                          const effectiveView = viewChecked || editChecked;
                          return (
                            <tr key={fieldName}>
                              <td>
                                <span className="mono">{fieldName}</span>
                                <span className="cell-description">{fieldLabel(fieldName)}</span>
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={effectiveView}
                                  onChange={() => toggle(fieldName, 'canView')}
                                  disabled={!effectiveView && editChecked}
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={editChecked}
                                  onChange={() => toggle(fieldName, 'canEdit')}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
              {dirty ? (
                <div className="form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={action.isPending || !reason.trim()}
                    onClick={() => {
                      setEdits({});
                      setReason('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="button"
                    disabled={action.isPending || !dirty || !reason.trim()}
                    onClick={save}
                  >
                    {action.isPending ? 'Saving…' : 'Save field permissions'}
                  </button>
                </div>
              ) : null}
              <p className="muted small-text">
                Edit implies view: a field that cannot be viewed cannot be edited.
              </p>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
