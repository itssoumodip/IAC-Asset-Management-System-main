import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { RoleFieldResponse } from '../types';
import {
  Checkbox,
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

/**
 * Pages with field settings. Other pages' fields are saved as `<prefix><field>` (for example
 * `subscription_cost`); the API applies them on that page (see page-fields.ts).
 */
interface PageFields {
  key: string;
  title: string;
  prefix: string;
  /** No editing on this page, so only "Can see" applies. */
  viewOnly?: boolean;
  groups: Record<string, string[]>;
  labels?: Record<string, string>;
}
const PAGES: PageFields[] = [
  { key: 'asset', title: 'Asset catalog', prefix: '', groups: FIELD_GROUPS },
  {
    key: 'subscription',
    title: 'Subscriptions',
    prefix: 'subscription_',
    groups: {
      Plan: ['vendor', 'plan', 'cost', 'billingCycle', 'renewal', 'seats'],
      'Who uses it': ['people', 'department'],
      Account: ['accountEmail', 'paymentMethod', 'website', 'notes'],
    },
    labels: {
      vendor: 'Vendor',
      plan: 'Plan',
      cost: 'Cost and spend totals',
      billingCycle: 'Billing cycle',
      renewal: 'Start, renewal date and auto-renew',
      seats: 'Seats',
      people: 'People using it',
      department: 'Department',
      accountEmail: 'Account email',
      paymentMethod: 'Payment method',
      website: 'Website',
      notes: 'Notes',
    },
  },
  {
    key: 'vendor',
    title: 'Vendors',
    prefix: 'vendor_',
    groups: {
      Contact: ['contactPerson', 'phone', 'email', 'address', 'website'],
      Details: ['services', 'gstin', 'score', 'notes', 'referencePeople'],
      'Linked records': ['assets', 'subscriptions'],
    },
    labels: {
      contactPerson: 'Contact person',
      phone: 'Phone',
      email: 'Email',
      address: 'Address',
      website: 'Website',
      services: 'Services',
      gstin: 'GSTIN',
      score: 'Score',
      notes: 'Notes',
      referencePeople: 'Reference people',
      assets: 'Assets bought (and their value)',
      subscriptions: 'Subscriptions from this vendor',
    },
  },
  {
    key: 'person',
    title: 'People',
    prefix: 'person_',
    viewOnly: true,
    groups: {
      Details: ['email', 'employeeCode', 'designation', 'department', 'manager'],
      'What they hold': ['assets', 'subscriptions', 'tickets'],
    },
    labels: {
      email: 'Email',
      employeeCode: 'Employee code',
      designation: 'Designation',
      department: 'Department',
      manager: 'Manager',
      assets: 'Assets held (now and before)',
      subscriptions: 'Subscriptions',
      tickets: 'Support tickets',
    },
  },
];

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
/** Every saved field name across all pages. */
const ALL_FIELDS = PAGES.flatMap((page) => Object.values(page.groups).flat().map((f) => page.prefix + f));

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
  const [pageKey, setPageKey] = useState('asset');
  const page = PAGES.find((p) => p.key === pageKey) ?? PAGES[0]!;
  const pageFields = Object.values(page.groups).flat().map((f) => page.prefix + f);
  const label = (stored: string) => {
    const short = stored.slice(page.prefix.length);
    return page.labels?.[short] ?? fieldLabel(short);
  };
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
  // "Allow all" / "View only" apply to the page being shown.
  function setAll(canView: boolean, canEdit: boolean) {
    setEdits((prev) => ({ ...prev, ...Object.fromEntries(pageFields.map((f) => [f, { canView, canEdit }])) }));
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
        description="Choose which fields each role can see and change on the asset catalog, subscriptions, vendors and people pages. Unticked fields are removed from what that role receives."
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
              {/* One tab per page that has its own fields. */}
              <div role="tablist" aria-label="Page" className="mb-5 flex flex-wrap gap-1 border-b border-gray-200">
                {PAGES.map((p) => {
                  const changed = Object.keys(edits).filter((f) =>
                    Object.values(p.groups).flat().some((short) => p.prefix + short === f),
                  ).length;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      role="tab"
                      aria-selected={p.key === page.key}
                      onClick={() => setPageKey(p.key)}
                      className={cx(
                        '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                        p.key === page.key
                          ? 'border-navy-600 font-medium text-navy-700'
                          : 'border-transparent text-gray-600 hover:text-gray-900',
                      )}
                    >
                      {p.title}
                      {changed ? <span className="ml-1.5 text-xs text-yellow-700">({changed})</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
                {Object.entries(page.groups).map(([groupName, shortFields]) => (
                  <section key={groupName}>
                    <h3 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                      {groupName}
                    </h3>
                    <table className={tableClass}>
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th className="w-20 text-center">Can see</th>
                          {page.viewOnly ? null : <th className="w-24 text-center">Can change</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {shortFields.map((short) => {
                          const field = page.prefix + short;
                          const value = current(field);
                          return (
                            <tr key={field} className={edits[field] ? 'bg-yellow-50' : undefined}>
                              <td className="text-gray-800">{label(field)}</td>
                              <td className="text-center">
                                <Checkbox
                                  ariaLabel={`${roleLabel(selectedRole)} can see ${label(field)}`}
                                  checked={value.canView}
                                  onChange={() => toggle(field, 'canView')}
                                />
                              </td>
                              {page.viewOnly ? null : (
                                <td className="text-center">
                                  <Checkbox
                                    ariaLabel={`${roleLabel(selectedRole)} can change ${label(field)}`}
                                    checked={value.canEdit}
                                    onChange={() => toggle(field, 'canEdit')}
                                  />
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>
                ))}
              </div>
              {page.viewOnly ? (
                <p className="mt-3 text-xs text-gray-500">
                  Nothing is edited on this page, so only "Can see" applies. A person always sees
                  everything on their own page.
                </p>
              ) : null}
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
