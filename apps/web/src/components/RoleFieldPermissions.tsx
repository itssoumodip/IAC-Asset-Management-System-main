import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { RoleFieldResponse } from '../types';
import {
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  buttonClass,
  cx,
  inputClass,
  noticeClass,
  tableClass,
} from './ui';

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
  Identity: [
    'assetCode',
    'category',
    'assetType',
    'description',
    'manufacturer',
    'model',
    'serialNumber',
    'barcode',
  ],
  Location: ['departmentId', 'locationId', 'owningTeamId', 'status'],
  Condition: ['condition', 'riskLevel', 'dataWipeRequired', 'remarks', 'commentType'],
  'Warranty & AMC': ['warrantyExpiry', 'amcApplies', 'amcExpiry', 'lastLabelPrintedAt'],
  Purchase: [
    'purchaseDate',
    'purchaseCost',
    'currency',
    'residualValue',
    'depreciationMethod',
    'usefulLifeYears',
    'invoiceNumber',
    'supplier',
  ],
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

const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  EXECUTIVE: 'Executive',
  FINANCE: 'Finance',
  TEAM_LEAD: 'Team Lead',
  TEAM_MEMBER: 'Team Member',
  STORE: 'Store',
  TECHNICIAN: 'Technician',
  AUDITOR: 'Auditor',
  INSURER: 'Insurer',
  PROCUREMENT: 'Procurement',
  EMPLOYEE: 'Employee',
};
function roleLabel(role: string): string {
  return ROLE_NAMES[role] ?? role.replaceAll('_', ' ');
}
const ALL_FIELDS = Object.values(FIELD_GROUPS).flat();

/**
 * Field permissions: per role, which asset fields can be seen and changed.
 * Ticked means allowed (no saved setting = allowed). The API hides or refuses a field only
 * when every role a person holds has it unticked; Super Admin is never restricted.
 */
export function RoleFieldPermissions() {
  const query = useQuery({
    queryKey: ['role-field-permissions'],
    queryFn: ({ signal }) => api<RoleFieldResponse>('/admin/roles/fields', { signal }),
  });
  const action = useAction<{ updated: number }>();
  const [selectedRole, setSelectedRole] = useState<string>('EMPLOYEE');
  const [reason, setReason] = useState('');
  const [edits, setEdits] = useState<Record<string, { canView: boolean; canEdit: boolean }>>({});

  const group = query.data?.permissions.find((g) => g.roleCode === selectedRole);
  const saved = new Map(group?.fields.map((f) => [f.fieldName, f]) ?? []);
  const isSuper = selectedRole === 'SUPER_ADMIN';
  const current = (field: string) =>
    edits[field] ?? {
      canView: saved.get(field)?.canView ?? true,
      canEdit: saved.get(field)?.canEdit ?? true,
    };
  const restrictedCount = (role: string) =>
    (query.data?.permissions.find((g) => g.roleCode === role)?.fields ?? []).filter(
      (f) => !f.canView || !f.canEdit,
    ).length;

  function toggle(field: string, key: 'canView' | 'canEdit') {
    const now = current(field);
    // Changing implies seeing; hiding a field also stops changes to it.
    const next =
      key === 'canEdit'
        ? { canView: !now.canEdit ? true : now.canView, canEdit: !now.canEdit }
        : { canView: !now.canView, canEdit: !now.canView ? now.canEdit : false };
    setEdits((prev) => ({ ...prev, [field]: next }));
  }
  function setAll(canView: boolean, canEdit: boolean) {
    setEdits(Object.fromEntries(ALL_FIELDS.map((f) => [f, { canView, canEdit }])));
  }

  const dirty = Object.keys(edits).length > 0;
  async function save() {
    if (!dirty || !reason.trim() || action.isPending) return;
    // Send every field so the role's settings are complete after the first save.
    const fields = new Set([...ALL_FIELDS, ...saved.keys()]);
    const permissions = [...fields].map((fieldName) => ({
      roleCode: selectedRole,
      fieldName,
      ...current(fieldName),
    }));
    try {
      await action.mutateAsync({
        path: '/admin/roles/fields',
        method: 'PUT',
        body: { permissions, reason: reason.trim() },
      });
      setEdits({});
      setReason('');
      void query.refetch();
    } catch {
      /* shown by ErrorNotice */
    }
  }

  if (query.isPending) return <Loading label="Loading field permissions…" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  return (
    <>
      <PageTitle
        eyebrow="Administration"
        title="Field permissions"
        description="Choose which asset fields each role can see and change. Unticked fields are removed from what that role receives."
      />
      <ErrorNotice error={action.error} />
      <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Panel title="Roles">
          <ul className="-mx-2 flex flex-col">
            {ALL_ROLES.map((role) => {
              const restricted = role === 'SUPER_ADMIN' ? 0 : restrictedCount(role);
              return (
                <li key={role}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRole(role);
                      setEdits({});
                      setReason('');
                    }}
                    className={cx(
                      'flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition-colors',
                      selectedRole === role
                        ? 'bg-navy-50 font-medium text-navy-700'
                        : 'text-gray-700 hover:bg-gray-50',
                    )}
                  >
                    {roleLabel(role)}
                    <span className="text-xs text-gray-400">
                      {role === 'SUPER_ADMIN'
                        ? 'Full access'
                        : restricted
                          ? `${restricted} limited`
                          : 'All allowed'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel
          title={roleLabel(selectedRole)}
          action={
            isSuper ? null : (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => setAll(true, true)}
                >
                  Allow all
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => setAll(true, false)}
                >
                  View only
                </button>
              </div>
            )
          }
        >
          {isSuper ? (
            <p className={noticeClass('info')}>
              Super Admin always sees and can change every field. Choose another role to limit it.
            </p>
          ) : (
            <>
              <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
                {Object.entries(FIELD_GROUPS).map(([groupName, fields]) => (
                  <section key={groupName}>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                      {groupName}
                    </h3>
                    <table className={tableClass}>
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th className="w-20 text-center">Can see</th>
                          <th className="w-24 text-center">Can change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field) => {
                          const value = current(field);
                          return (
                            <tr key={field} className={edits[field] ? 'bg-yellow-50' : undefined}>
                              <td className="text-gray-800">{fieldLabel(field)}</td>
                              <td className="text-center">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-navy-700"
                                  aria-label={`${roleLabel(selectedRole)} can see ${fieldLabel(field)}`}
                                  checked={value.canView}
                                  onChange={() => toggle(field, 'canView')}
                                />
                              </td>
                              <td className="text-center">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-navy-700"
                                  aria-label={`${roleLabel(selectedRole)} can change ${fieldLabel(field)}`}
                                  checked={value.canEdit}
                                  onChange={() => toggle(field, 'canEdit')}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>
                ))}
              </div>
              <p className="mt-4 text-xs text-gray-500">
                A person with several roles keeps a field if any of their roles allows it. Changing
                a field also needs the role's normal edit permission.
              </p>
              {dirty ? (
                <div className="sticky bottom-0 mt-4 flex flex-wrap items-end gap-3 border-t border-gray-200 bg-white pt-4">
                  <div className="min-w-64 flex-1">
                    <Field label="Reason for change" htmlFor="role-field-reason">
                      <input
                        id="role-field-reason"
                        className={inputClass}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={1000}
                        placeholder="For example: insurers should not see supplier details"
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    className={buttonClass('secondary')}
                    disabled={action.isPending}
                    onClick={() => {
                      setEdits({});
                      setReason('');
                    }}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className={buttonClass()}
                    disabled={action.isPending || !reason.trim()}
                    onClick={() => void save()}
                  >
                    {action.isPending
                      ? 'Saving…'
                      : `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? '' : 's'}`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
