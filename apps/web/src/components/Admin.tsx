import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAction, usePages } from '../hooks';
import type { ImportBatch, References, Role, User } from '../types';
import { fetchAllPages, readTable } from '../transfer-files';
import { BulkTransfer, ExportRecords, FormTransfer } from './DataTransfer';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  Select,
  displayDate,
} from './ui';
export function UserAdmin() {
  const [staffSearch, setStaffSearch] = useState('');
  const query = usePages<User>('/users', { q: staffSearch.trim() || undefined });
  const refs = useQuery({
    queryKey: ['references'],
    queryFn: ({ signal }) => api<References>('/references', { signal }),
  });
  const action = useAction<{ message?: string }>();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [designation, setDesignation] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [invite, setInvite] = useState(true);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<User>();
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedDisplayName, setSelectedDisplayName] = useState('');
  const [selectedEmail, setSelectedEmail] = useState('');
  const [selectedDesignation, setSelectedDesignation] = useState('');
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState('ACTIVE');
  const [resendingId, setResendingId] = useState<string>();
  const resendInFlight = useRef(false);
  const users = query.data?.pages.flatMap((page) => page.items) ?? [];
  async function approve(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    const result = await action
      .mutateAsync({
        path: invite ? '/invitations' : '/approved-emails',
        body: invite
          ? {
              email: email.trim(),
              displayName: displayName.trim(),
              designation: designation.trim() || null,
              departmentId: departmentId || null,
            }
          : { email: email.trim() },
        idempotent: true,
      })
      .catch(() => undefined);
    if (result) {
      setMessage(
        result.message ?? (invite ? 'Invitation queued.' : 'Email approved for registration.'),
      );
      setEmail('');
      setDisplayName('');
      setDesignation('');
      setDepartmentId('');
    }
  }
  function select(user: User) {
    setSelected(user);
    setRoles([...user.roles]);
    setSelectedDisplayName(user.displayName);
    setSelectedEmail(user.email);
    setSelectedDesignation(user.designation || '');
    setSelectedDepartmentId(user.departmentId || '');
    setState(user.state === 'DISABLED' ? 'DISABLED' : 'ACTIVE');
    setReason('');
    action.reset();
  }
  async function resendInvitation(user: User) {
    if (user.state !== 'INVITED' || resendInFlight.current || action.isPending) return;
    resendInFlight.current = true;
    setResendingId(user.id);
    setMessage('');
    try {
      const result = await action
        .mutateAsync({
          path: '/invitations',
          body: {
            email: user.email,
            displayName: user.displayName,
            designation: user.designation ?? null,
            departmentId: user.departmentId ?? null,
          },
        })
        .catch(() => undefined);
      if (result)
        setMessage('Invitation queued again. Earlier invitation links have been replaced.');
    } finally {
      resendInFlight.current = false;
      setResendingId(undefined);
    }
  }
  async function edit(event: FormEvent) {
    event.preventDefault();
    if (!selected || !reason.trim()) return;
    const result = await action
      .mutateAsync({
        path: `/users/${selected.id}`,
        method: 'PATCH',
        body: {
          ...(state !== (selected.state === 'INVITED' ? 'ACTIVE' : selected.state) ? { state } : {}),
          ...(roles.slice().sort().join(',') !== selected.roles.slice().sort().join(',')
            ? { roles }
            : {}),
          ...(selectedDisplayName.trim() !== selected.displayName
            ? { displayName: selectedDisplayName.trim() }
            : {}),
          ...(selectedEmail.trim().toLowerCase() !== selected.email
            ? { email: selectedEmail.trim() }
            : {}),
          designation: selectedDesignation.trim() || null,
          departmentId: selectedDepartmentId || null,
          reason: reason.trim(),
        },
        version: selected.version,
      })
      .then((value) => value.message ?? 'Account updated.')
      .catch(() => '');
    if (result) {
      setSelected(undefined);
      setMessage(result);
    }
  }
  async function sendPasswordReset() {
    if (!selected || !reason.trim() || action.isPending) return;
    const result = await action.mutateAsync({
      path: `/users/${selected.id}/password-reset`,
      body: { reason: reason.trim() },
      idempotent: true,
    }).then((value) => value.message ?? 'Password reset instructions sent.').catch(() => '');
    if (result) {
      setSelected(undefined);
      setMessage(result);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / PEOPLE"
        title="People & access"
        description="Approve individual work emails, invite employees, and keep permissions current."
      />
      <ExportRecords
        name="staff-accounts"
        columns={[
          'id',
          'email',
          'pendingEmail',
          'displayName',
          'designation',
          'department',
          'roles',
          'state',
          'emailVerifiedAt',
          'portalAcceptedAt',
          'version',
        ]}
        load={async () =>
          (await fetchAllPages<User>('/users')).map((user) => ({
            id: user.id,
            email: user.email,
            pendingEmail: user.pendingEmail,
            displayName: user.displayName,
            designation: user.designation,
            department: user.department,
            roles: user.roles,
            state: user.state,
            emailVerifiedAt: user.emailVerifiedAt,
            portalAcceptedAt: user.portalAcceptedAt,
            version: user.version,
          }))
        }
      />
      <BulkTransfer module="people" disabled={action.isPending} />
      <ErrorNotice
        error={action.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {message ? (
        <div className="notice success" role="status">
          {message}
        </div>
      ) : null}
      <div className="dashboard-columns">
        <Panel title="Bring someone on board">
          <FormTransfer
            formId="people-onboarding"
            fields={[
              { key: 'email', required: true },
              { key: 'displayName' },
              { key: 'designation' },
              { key: 'departmentId' },
              { key: 'invite', type: 'boolean' },
            ]}
            values={{ email, displayName, designation, departmentId, invite }}
            disabled={action.isPending}
            description="Load one approved employee into this form, then review and submit. Sending an invitation remains an explicit action."
            onImport={(record) => {
              if ('email' in record) setEmail(String(record.email ?? ''));
              if ('displayName' in record) setDisplayName(String(record.displayName ?? ''));
              if ('designation' in record) setDesignation(String(record.designation ?? ''));
              if ('departmentId' in record) setDepartmentId(String(record.departmentId ?? ''));
              if (typeof record.invite === 'boolean') setInvite(record.invite);
            }}
          />
          <form className="form-stack" onSubmit={approve}>
            <Field label="Work email" htmlFor="admin-email">
              <input
                id="admin-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={invite}
                onChange={(event) => setInvite(event.target.checked)}
              />
              Send an invitation to this email
            </label>
            {invite ? (
              <>
                <Field label="Employee name" htmlFor="admin-displayName">
                  <input
                    id="admin-displayName"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                    maxLength={120}
                  />
                </Field>
                <Field label="Designation" htmlFor="admin-designation">
                  <input
                    id="admin-designation"
                    value={designation}
                    onChange={(event) => setDesignation(event.target.value)}
                    maxLength={120}
                    placeholder="For example, Occupational Therapist"
                  />
                </Field>
                <Select
                  label="Employee department"
                  htmlFor="admin-department"
                  value={departmentId}
                  onChange={setDepartmentId}
                  options={[
                    { value: '', label: 'Not set' },
                    ...(refs.data?.departments
                      .filter((department) => department.active)
                      .map((department) => ({ value: department.id, label: department.name })) ?? []),
                  ]}
                />
              </>
            ) : null}
            <button className="button" disabled={action.isPending}>
              {action.isPending
                ? 'Saving...'
                : invite
                  ? 'Approve & send invitation'
                  : 'Approve email'}
            </button>
            <p className="muted small-text">
              Name, designation and department are shown to signed-in staff on the scanned asset
              page. Registration grants Employee access only; staff roles are assigned separately.
            </p>
          </form>
        </Panel>
        <div className="help-card">
          <h2>The right access, for the right people.</h2>
          <p>
            Use verified individual work addresses. Employee reference numbers do not authenticate
            an account.
          </p>
          <p>
            Admins manage inventory and user access. IT staff manage support. Roles can be combined
            when approved.
          </p>
          <p className="small-text">
            Privileged accounts require authenticator enrollment. The final active Admin cannot be
            removed.
          </p>
        </div>
      </div>
      {selected ? (
        <Panel title={`Update access · ${selected.displayName}`}>
          <FormTransfer
            formId={`people-access:${selected.id}`}
            fields={[
              { key: 'displayName', required: true },
              { key: 'email', required: true },
              {
                key: 'roles',
                type: 'list',
                required: true,
                options: ['EMPLOYEE', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE', 'ADMIN'],
              },
              { key: 'state', required: true, options: ['ACTIVE', 'DISABLED'] },
              { key: 'designation' },
              { key: 'departmentId' },
              { key: 'reason', required: true },
            ]}
            values={{ displayName: selectedDisplayName, email: selectedEmail, roles, state, designation: selectedDesignation, departmentId: selectedDepartmentId, reason }}
            disabled={action.isPending}
            description="Loads access changes for this selected account only. Review the roles and reason before saving."
            onImport={(record) => {
              if ('displayName' in record) setSelectedDisplayName(String(record.displayName ?? ''));
              if ('email' in record) setSelectedEmail(String(record.email ?? ''));
              if (Array.isArray(record.roles)) setRoles(record.roles as Role[]);
              if ('state' in record) setState(String(record.state));
              if ('designation' in record) setSelectedDesignation(String(record.designation ?? ''));
              if ('departmentId' in record) setSelectedDepartmentId(String(record.departmentId ?? ''));
              if ('reason' in record) setReason(String(record.reason ?? ''));
            }}
          />
          <form className="form-stack" onSubmit={edit}>
            <Field label="Employee name" htmlFor="staff-display-name">
              <input id="staff-display-name" value={selectedDisplayName} onChange={(event) => setSelectedDisplayName(event.target.value)} required maxLength={120} />
            </Field>
            <Field label="Work email" htmlFor="staff-email" hint={selected.pendingEmail ? `Pending confirmation: ${selected.pendingEmail}` : 'Changing an active user email sends a verification link to the new address.'}>
              <input id="staff-email" type="email" value={selectedEmail} onChange={(event) => setSelectedEmail(event.target.value)} required maxLength={254} />
            </Field>
            <fieldset>
              <legend>Roles</legend>
              {(['EMPLOYEE', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE', 'ADMIN'] as Role[]).map((role) => (
                <label className="checkbox" key={role}>
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(event) =>
                      setRoles(
                        event.target.checked
                          ? [...roles, role]
                          : roles.filter((value) => value !== role),
                      )
                    }
                  />
                  {role.replace('_', ' ')}
                </label>
              ))}
            </fieldset>
<Field label="Account status" htmlFor="account-state">
  <Select
    label=""
    htmlFor="account-state"
    value={state}
    onChange={setState}
    options={[
      { value: 'ACTIVE', label: 'Active' },
      { value: 'DISABLED', label: 'Disabled' },
    ]}
  />
</Field>
            <Field label="Designation" htmlFor="staff-designation">
              <input
                id="staff-designation"
                value={selectedDesignation}
                onChange={(event) => setSelectedDesignation(event.target.value)}
                maxLength={120}
                placeholder="For example, Occupational Therapist"
              />
            </Field>
            <Select
              label="Employee department"
              htmlFor="staff-department"
              value={selectedDepartmentId}
              onChange={setSelectedDepartmentId}
              options={[
                { value: '', label: 'Not set' },
                ...(refs.data?.departments.map((department) => ({
                  value: department.id,
                  label: `${department.name}${department.active ? '' : ' (inactive)'}`,
                })) ?? []),
              ]}
            />
            <Field label="Reason for access change" htmlFor="access-reason">
              <textarea
                id="access-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                maxLength={5000}
              />
            </Field>
            <div className="actions">
              <button
                className="button"
                disabled={action.isPending || !roles.length || !reason.trim()}
              >
                Save account access
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={action.isPending || !reason.trim()}
                onClick={() => void sendPasswordReset()}
              >
                Send password reset link
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => setSelected(undefined)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      ) : null}
      <Panel title={`Staff accounts${query.data?.pages[0]?.totalCount !== undefined ? ` · ${query.data.pages[0].totalCount}` : ''}`}>
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {!query.isPending ? (
          <div className="filter-bar staff-search-bar">
            <Field label="Search staff" htmlFor="staff-search">
              <input
                id="staff-search"
                type="search"
                value={staffSearch}
                onChange={(event) => setStaffSearch(event.target.value)}
                placeholder="Search name or work email"
                maxLength={120}
                autoComplete="off"
              />
            </Field>
            <p className="muted small-text staff-search-count" aria-live="polite">
              {query.isPlaceholderData
                ? 'Searching...'
                : query.data?.pages[0]?.totalCount !== undefined
                ? `${query.data.pages[0].totalCount} ${query.data.pages[0].totalCount === 1 ? 'staff account' : 'staff accounts'}${staffSearch.trim() ? ' match your search' : ''}`
                : `${users.length} loaded`}
            </p>
          </div>
        ) : null}
        {query.isPending ? (
          <Loading />
        ) : users.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Roles</th>
                  <th>Designation / department</th>
                  <th>State</th>
                  <th>Email verified</th>
                  <th>Portal accepted</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.displayName}</strong>
                      <span className="cell-description">{user.email}</span>
                    </td>
                    <td>
                      {user.roles.map((role) => (
                        <Badge key={role} value={role} />
                      ))}
                    </td>
                    <td>
                      {user.designation || 'Not set'}
                      <span className="cell-description">{user.department || 'Department not set'}</span>
                    </td>
                    <td>
                      <Badge value={user.state} />
                    </td>
                    <td>{user.emailVerifiedAt ? 'Verified' : 'Pending'}</td>
                    <td>{user.portalAcceptedAt ? 'Accepted' : 'Pending'}</td>
                    <td>
                      <div className="actions">
                        {user.state === 'INVITED' ? (
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={action.isPending || !!resendingId}
                            onClick={() => {
                              void resendInvitation(user);
                            }}
                            aria-label={`Resend invitation to ${user.displayName}`}
                          >
                            {resendingId === user.id ? 'Queuing...' : 'Resend invitation'}
                          </button>
                        ) : null}
                        <button
                          className="button secondary small"
                          type="button"
                          disabled={action.isPending || !!resendingId}
                          onClick={() => select(user)}
                          aria-label={`Manage ${user.displayName}`}
                        >
                          Manage access
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !query.error ? (
          <Empty title="No staff accounts found">
            Approved staff appear here after invitation or registration.
          </Empty>
        ) : null}
        <LoadMore
          available={query.hasNextPage && !query.isPlaceholderData}
          loading={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        />
      </Panel>
    </>
  );
}
interface AuditEvent {
  id: string;
  occurredAt: string;
  changes?: unknown;
  action?: string;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  summary?: unknown;
  requestId?: string;
}
export function AuditView() {
  const [entityType, setEntityType] = useState('');
  const query = usePages<AuditEvent>('/audit-events', { entityType: entityType || undefined });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / EVIDENCE"
        title="Audit trail"
        description="Timestamped activity across assets, custody, accounts, and support."
      />
      <ExportRecords
        name="audit-trail"
        columns={[
          'id',
          'occurredAt',
          'action',
          'entityType',
          'entityId',
          'actorId',
          'requestId',
          'changes',
        ]}
        load={async () =>
          (
            await fetchAllPages<AuditEvent>('/audit-events', {
              entityType: entityType || undefined,
            })
          ).map((item) => ({
            id: item.id,
            occurredAt: item.occurredAt,
            action: item.action ?? item.eventType,
            entityType: item.entityType,
            entityId: item.entityId,
            actorId: item.actorId,
            requestId: item.requestId,
            changes: item.changes,
          }))
        }
      />
<Panel>
  <Field label="Record type" htmlFor="audit-entity">
    <Select
      label=""
      htmlFor="audit-entity"
      value={entityType}
      onChange={setEntityType}
      options={[
        { value: '', label: 'All records' },
        { value: 'asset', label: 'Asset' },
        { value: 'assignment', label: 'Assignment' },
        { value: 'ticket', label: 'Ticket' },
        { value: 'USER', label: 'User' },
      ]}
    />
  </Field>
  <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {query.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className="audit-list">
            {items.map((item) => (
              <article key={item.id}>
                <time dateTime={item.occurredAt}>{displayDate(item.occurredAt, true)}</time>
                <div>
                  <strong>{item.action ?? item.eventType ?? 'Recorded event'}</strong>
                  <p className="muted small-text">
                    {item.entityType} · {item.entityId}
                  </p>
                  {item.changes ? (
                    <pre className="audit-summary">
                      {typeof item.changes === 'string'
                        ? item.changes
                        : JSON.stringify(item.changes, null, 2)}
                    </pre>
                  ) : null}
                  <small>
                    Actor {item.actorId ?? 'system'} · Reference {item.requestId ?? item.id}
                  </small>
                </div>
              </article>
            ))}
          </div>
        ) : !query.error ? (
          <Empty title="No activity to display">Recorded changes will appear here.</Empty>
        ) : null}
        <LoadMore
          available={query.hasNextPage && !query.isPlaceholderData}
          loading={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        />
      </Panel>
    </>
  );
}
const register44Headers = [
  'Asset ID',
  'Asset Category',
  'Asset Type',
  'Asset Description',
  'Manufacturer',
  'Model',
  'Serial Number',
  'Barcode / QR Code',
  'Configuration Details',
  'Graphics Details',
  'Ownership Type',
  'Purchase Date',
  'Invoice Number',
  'Supplier',
  'Purchase Cost',
  'Residual Value',
  'Depreciation Method',
  'Useful Life (Years)',
  'Annual Depreciation',
  'Accumulated Depreciation',
  'Net Book Value',
  'Department',
  'Asset Owner',
  'Old Custodian',
  'Custodian',
  'Employee ID',
  'Floor',
  'Room / Location',
  'Asset Status',
  'Condition',
  'Risk Level',
  'Warranty Expiry',
  'AMC Expiry',
  'Insurance Policy No.',
  'Insurance Expiry',
  'Last Audit Date',
  'Next Audit Date',
  'Disposal Date',
  'Disposal Method',
  'Data Wipe Required',
  'Remarks',
  'Comment Type',
  'Custodian Login ID',
  'Custodian Login ID (Manual)',
];
const register42Headers = [
  ...register44Headers.filter(
    (header) =>
      !['Comment Type', 'Custodian Login ID', 'Custodian Login ID (Manual)'].includes(header),
  ),
  'Column1',
];
const correctionColumns = [
  'rowNumber',
  'assetCode',
  'custodianEmail',
  'category',
  'assetType',
  'description',
  'manufacturer',
  'model',
  'serialNumber',
  'barcode',
  'configuration',
  'graphics',
  'ownershipType',
  'departmentId',
  'locationId',
  'assetOwner',
  'status',
  'condition',
  'riskLevel',
  'warrantyExpiry',
  'amcApplies',
  'amcExpiry',
  'purchaseDate',
  'purchaseCost',
  'currency',
  'residualValue',
  'depreciationMethod',
  'usefulLifeYears',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'insuranceExpiry',
  'lastAuditDate',
  'nextAuditDate',
  'disposalDate',
  'disposalMethod',
  'disposalReference',
  'dataWipeRequired',
  'remarks',
  'commentType',
];
type CorrectionRow = {
  rowNumber: number;
  fields: Record<string, string | number | boolean | null>;
};
function checkedCorrectionRows(payload: unknown, maximum: number): CorrectionRow[] {
  if (!Array.isArray(payload) || payload.length > 500)
    throw new Error('Corrections must be a JSON array containing at most 500 rows.');
  const seen = new Set<number>();
  return payload.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['rowNumber', 'fields'].includes(key)) ||
      !Number.isInteger(item.rowNumber) ||
      item.rowNumber < 1 ||
      item.rowNumber > maximum ||
      seen.has(item.rowNumber) ||
      !item.fields ||
      typeof item.fields !== 'object' ||
      Array.isArray(item.fields)
    )
      throw new Error(
        'Use unique, one-based batch rowNumber values and field objects for this batch.',
      );
    seen.add(item.rowNumber);
    for (const [key, value] of Object.entries(item.fields)) {
      if (key === 'rowNumber' || !correctionColumns.includes(key))
        throw new Error(`The correction field ${key} is unsupported.`);
      if (value === null) continue;
      if (key === 'amcApplies') {
        if (typeof value !== 'boolean')
          throw new Error('amcApplies must be a boolean or null in the draft.');
      } else if (key === 'usefulLifeYears') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100)
          throw new Error('usefulLifeYears must be an integer from 1 to 100 or null.');
      } else if (typeof value !== 'string' || value.length > 5000)
        throw new Error(`The correction field ${key} must be text up to 5,000 characters or null.`);
    }
    return item as CorrectionRow;
  });
}
export function ImportsView() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id') ?? '';
  const [lookup, setLookup] = useState(id);
  const [bundle, setBundle] = useState<Record<string, unknown>>();
  const [fileError, setFileError] = useState<unknown>();
  const [fileName, setFileName] = useState('');
  const [sourceWorkbookHash, setSourceWorkbookHash] = useState('');
  const sourceWorkbookHashRef = useRef('');
  const [templateLayout, setTemplateLayout] = useState('REGISTER_44');
  const [corrections, setCorrections] = useState('[]');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reviewVersion, setReviewVersion] = useState<number>();
  const [commitVersion, setCommitVersion] = useState<number>();
  const [expectedCodes, setExpectedCodes] = useState('');
  const [expectedCost, setExpectedCost] = useState('');
  const [unknownCost, setUnknownCost] = useState('0');
  const [acceptFinance, setAcceptFinance] = useState(false);
  const action = useAction<ImportBatch>();
  const query = useQuery({
    queryKey: ['import', id],
    queryFn: () => api<ImportBatch>(`/imports/${id}`),
    enabled: !!id,
  });
  const controlsReadGeneration = useRef(0);
  const stagingReadGeneration = useRef(0);
  useLayoutEffect(
    () => () => {
      stagingReadGeneration.current++;
    },
    [],
  );
  const controlsContext = useRef<{ id: string; version: number | undefined } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    controlsContext.current = { id, version: query.data?.version };
    controlsReadGeneration.current++;
    return () => {
      controlsContext.current = undefined;
      controlsReadGeneration.current++;
    };
  }, [id, query.data?.version]);
  async function loadFile(file: File | undefined) {
    const generation = ++stagingReadGeneration.current;
    controlsReadGeneration.current++;
    setFileError(undefined);
    setBundle(undefined);
    setFileName('');
    if (!file) return;
    try {
      if (/\.(xlsx|csv)$/i.test(file.name)) {
        const table = await readTable(file);
        if (generation !== stagingReadGeneration.current) return;
        const headers = Object.keys(table.rows[0] ?? {});
        const exact = (expected: string[]) =>
          headers.length === expected.length &&
          expected.every((header) => headers.includes(header));
        const layout = exact(register44Headers)
          ? 'REGISTER_44'
          : exact(register42Headers)
            ? 'REGISTER_42'
            : undefined;
        if (!layout)
          throw new Error(
            'Use exactly the 44-column or 42-column register headers. Download a register template for the required columns.',
          );
        const columns = layout === 'REGISTER_44' ? register44Headers : register42Headers;
        const csvText =
          [columns, ...table.rows.map((row) => columns.map((header) => row[header]))]
            .map((row) =>
              row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','),
            )
            .join('\r\n') + '\r\n';
        const csvHash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csvText))),
        )
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (generation !== stagingReadGeneration.current) return;
        const isWorkbook = /\.xlsx$/i.test(file.name);
        const value = {
          filename: table.filename,
          sourceSha256: isWorkbook ? csvHash : table.sha256,
          sourceWorkbookSha256: isWorkbook
            ? table.sha256
            : sourceWorkbookHashRef.current.trim().toLowerCase(),
          exportedAt: new Date().toISOString(),
          sourceLayout: layout,
          rows: table.rows,
        };
        if (new Blob([JSON.stringify(value)]).size > 60_000)
          throw new Error(
            'This staging request exceeds 60 KB. Split the values-only register into smaller source files, fingerprint each file separately, and preserve the original workbook SHA-256 when loading CSV.',
          );
        if (isWorkbook) {
          sourceWorkbookHashRef.current = table.sha256;
          setSourceWorkbookHash(table.sha256);
        }
        setBundle(value);
        setFileName(file.name);
        return;
      }
      if (file.size > 60_000)
        throw new Error(
          'The staging request must be under 60 KB. Split large reviewed exports into approved batches.',
        );
      const payload: unknown = JSON.parse(await file.text());
      if (generation !== stagingReadGeneration.current) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Choose a JSON staging request object.');
      const value = payload as Record<string, unknown>;
      if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 500)
        throw new Error('The request must contain between 1 and 500 rows.');
      if (
        !value.sourceSha256 ||
        !value.sourceWorkbookSha256 ||
        !value.exportedAt ||
        !value.filename
      )
        throw new Error('Both source hashes, export timestamp, and source filename are required.');
      setBundle(value);
      setFileName(file.name);
    } catch (error) {
      if (generation === stagingReadGeneration.current) setFileError(error);
    }
  }
  async function loadCorrectionTable(file: File | undefined) {
    const generation = ++controlsReadGeneration.current;
    const batchId = id;
    const batchVersion = query.data?.version;
    const isCurrent = () =>
      generation === controlsReadGeneration.current &&
      controlsContext.current?.id === batchId &&
      controlsContext.current?.version === batchVersion;
    setFileError(undefined);
    if (!file) return;
    try {
      const table = await readTable(file);
      if (!isCurrent()) return;
      const maximum = query.data?.total ?? 500;
      const rows = table.rows.map((row) => {
        if (!Object.keys(row).every((key) => correctionColumns.includes(key)))
          throw new Error(
            'The correction table has unsupported columns. Use the correction template.',
          );
        const rowNumber = Number(row.rowNumber);
        if (
          !/^\d+$/.test(row.rowNumber ?? '') ||
          !Number.isInteger(rowNumber) ||
          rowNumber < 1 ||
          rowNumber > maximum
        )
          throw new Error('Use unique, one-based batch rowNumber values within this batch.');
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key === 'rowNumber' || value === '') continue;
          if (value.startsWith('json:')) {
            try {
              fields[key] = JSON.parse(value.slice(5));
            } catch {
              throw new Error(`Use valid JSON after json: in correction field ${key}.`);
            }
          } else if (key === 'amcApplies') {
            if (!['true', 'false'].includes(value.toLowerCase()))
              throw new Error('amcApplies must be true or false.');
            fields[key] = value.toLowerCase() === 'true';
          } else if (key === 'usefulLifeYears') {
            if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)
              throw new Error('usefulLifeYears must be an integer from 1 to 100.');
            fields[key] = Number(value);
          } else fields[key] = value;
        }
        return { rowNumber, fields };
      });
      setCorrections(JSON.stringify(checkedCorrectionRows(rows, maximum), null, 2));
      setReviewVersion(batchVersion);
      setAcceptFinance(false);
      setConfirmed(false);
      setCommitVersion(undefined);
    } catch (error) {
      if (isCurrent()) setFileError(error);
    }
  }
  async function loadReviewControls(file: File | undefined) {
    const generation = ++controlsReadGeneration.current;
    const batchId = id;
    const batchVersion = query.data?.version;
    const isCurrent = () =>
      generation === controlsReadGeneration.current &&
      controlsContext.current?.id === batchId &&
      controlsContext.current?.version === batchVersion;
    setFileError(undefined);
    if (!file) return;
    try {
      if (file.size > 60_000) throw new Error('The review controls file must be under 60 KB.');
      let payload: unknown;
      try {
        const contents = await file.text();
        if (!isCurrent()) return;
        payload = JSON.parse(contents);
      } catch {
        throw new Error('Choose a valid review controls JSON file.');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Choose a JSON review controls object.');
      const value = payload as Record<string, unknown>;
      const codes = value.expectedAssetCodes;
      if (
        !Array.isArray(codes) ||
        codes.length < 1 ||
        codes.length > 500 ||
        codes.some((code) => typeof code !== 'string' || !/^IAC-IT-\d{6}$/.test(code)) ||
        new Set(codes).size !== codes.length
      )
        throw new Error('Review controls require 1 to 500 unique permanent Asset IDs.');
      if (query.data?.total !== undefined && codes.length !== query.data.total)
        throw new Error('The review controls row count does not match this batch.');
      if (
        typeof value.expectedTotalCost !== 'string' ||
        !/^\d{1,12}(\.\d{1,2})?$/.test(value.expectedTotalCost)
      )
        throw new Error(
          'The known purchase-cost total must be a nonnegative amount with up to two decimals.',
        );
      if (
        typeof value.expectedUnknownPurchaseCost !== 'number' ||
        !Number.isInteger(value.expectedUnknownPurchaseCost) ||
        value.expectedUnknownPurchaseCost < 0 ||
        value.expectedUnknownPurchaseCost > codes.length
      )
        throw new Error(
          'The unknown purchase-cost count must be an integer within the batch row count.',
        );
      const rows = value.corrections;
      if (
        !Array.isArray(rows) ||
        rows.length > 500 ||
        rows.some(
          (row) =>
            !row ||
            typeof row !== 'object' ||
            Array.isArray(row) ||
            typeof row.rowNumber !== 'number' ||
            !Number.isInteger(row.rowNumber) ||
            row.rowNumber < 1 ||
            row.rowNumber > codes.length ||
            !row.fields ||
            typeof row.fields !== 'object' ||
            Array.isArray(row.fields),
        ) ||
        new Set(rows.map((row) => row.rowNumber)).size !== rows.length
      )
        throw new Error('Corrections must contain unique batch row numbers and field objects.');
      if (!isCurrent()) return;
      setExpectedCodes(codes.join('\n'));
      setExpectedCost(value.expectedTotalCost);
      setUnknownCost(String(value.expectedUnknownPurchaseCost));
      setCorrections(JSON.stringify(rows, null, 2));
      setReviewVersion(batchVersion);
      setAcceptFinance(false);
      setConfirmed(false);
      setCommitVersion(undefined);
    } catch (error) {
      if (isCurrent()) setFileError(error);
    }
  }
  async function stage(event: FormEvent) {
    event.preventDefault();
    if (!bundle) return;
    const result = await action
      .mutateAsync({ path: '/imports', body: bundle, idempotent: true })
      .catch(() => undefined);
    if (result) {
      setParams({ id: result.id });
      setLookup(result.id);
      setBundle(undefined);
      setConfirmed(false);
    }
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    try {
      const rows: unknown = JSON.parse(corrections);
      if (!Array.isArray(rows)) throw new Error('Corrections must be a JSON array of row reviews.');
      setFileError(undefined);
      await action.mutateAsync({
        path: `/imports/${id}/review`,
        body: {
          rows,
          reason: reason.trim(),
          acceptFinancePending: acceptFinance,
          expectedAssetCodes: expectedCodes
            .split(/[\n,;]/)
            .map((value) => value.trim())
            .filter(Boolean),
          expectedTotalCost: expectedCost,
          expectedUnknownPurchaseCost: Number(unknownCost),
        },
        version: reviewVersion ?? query.data?.version,
      });
      setConfirmed(false);
      setReviewVersion(undefined);
    } catch (error) {
      setFileError(error);
    }
  }
  async function commit() {
    await action
      .mutateAsync({
        path: `/imports/${id}/commit`,
        body: { reviewed: true },
        version: commitVersion ?? query.data?.version,
        idempotent: true,
      })
      .catch(() => undefined);
    setConfirmed(false);
  }
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / MIGRATION"
        title="Import review"
        description="Stage approved source rows, resolve exceptions, then promote eligible records once."
      />
      <ErrorNotice error={fileError} />
      <ErrorNotice error={action.error} />
      <div className="dashboard-columns">
        <Panel title="Stage a reviewed export">
          <div className="form-stack">
<Field label="Register template layout" htmlFor="register-template-layout">
  <Select
    label=""
    htmlFor="register-template-layout"
    value={templateLayout}
    onChange={setTemplateLayout}
    options={[
      { value: 'REGISTER_44', label: '44-column register' },
      { value: 'REGISTER_42', label: '42-column register' },
    ]}
  />
</Field>
            <ExportRecords
              name={`register-template-${templateLayout.toLowerCase()}`}
              columns={templateLayout === 'REGISTER_44' ? register44Headers : register42Headers}
              load={async () => []}
            />
          </div>
          <form className="form-stack" onSubmit={stage}>
            <Field
              label="Register file (.xlsx, .csv or prepared .json)"
              htmlFor="import-file"
              hint="Excel/CSV must use exactly the 42 or 44 source headers. Values are preserved and remain restricted until reviewed. Prepared JSON bundles remain supported."
            >
              <input
                id="import-file"
                type="file"
                accept=".xlsx,.csv,.json,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                disabled={action.isPending}
                onChange={(event) => {
                  void loadFile(event.target.files?.[0]);
                }}
              />
            </Field>
            <Field
              label="Original workbook SHA-256 (required for CSV)"
              htmlFor="source-workbook-hash"
              hint="Excel selection calculates its original file hash. For a CSV export, enter the approved original workbook fingerprint separately."
            >
              <input
                id="source-workbook-hash"
                value={sourceWorkbookHash}
                pattern="[a-fA-F0-9]{64}"
                maxLength={64}
                onChange={(event) => {
                  const value = event.target.value;
                  sourceWorkbookHashRef.current = value;
                  setSourceWorkbookHash(value);
                  if (bundle && /\.csv$/i.test(String(bundle.filename)))
                    setBundle({ ...bundle, sourceWorkbookSha256: value.trim().toLowerCase() });
                }}
              />
            </Field>
            {bundle ? (
              <div className="notice">
                {fileName} · {(bundle.rows as unknown[]).length} rows ready for staging.
              </div>
            ) : null}
            <button
              className="button"
              disabled={
                !bundle ||
                action.isPending ||
                !/^[a-f0-9]{64}$/.test(String(bundle.sourceWorkbookSha256 ?? ''))
              }
            >
              Stage import for review
            </button>
          </form>
        </Panel>
        <div className="help-card">
          <h2>Preserve the evidence.</h2>
          <p>
            Select a values-only Excel register or approved CSV export and preserve the original
            workbook hash. Every source-header value remains in restricted staging.
          </p>
          <p className="small-text">
            Manual email overrides take priority. Employee IDs never link accounts. Invalid
            identities and operational exceptions remain quarantined.
          </p>
          <p className="small-text">
            Excel selection fingerprints the original file and its canonical CSV values. CSV
            selection preserves the selected CSV fingerprint and requires the original workbook
            fingerprint. Staging requests over 60 KB must be split into separately fingerprinted
            files. Selecting a file never promotes assets.
          </p>
        </div>
      </div>
      <Panel title="Open an import batch">
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (lookup.trim()) {
              setParams({ id: lookup.trim() });
              setConfirmed(false);
              setReviewVersion(undefined);
              setCommitVersion(undefined);
              setReason('');
              setCorrections('[]');
              setExpectedCodes('');
              setExpectedCost('');
              setUnknownCost('0');
              setAcceptFinance(false);
            }
          }}
        >
          <label className="sr-only" htmlFor="batch-id">
            Batch ID
          </label>
          <input
            id="batch-id"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            placeholder="Import batch UUID"
            pattern="[0-9a-fA-F-]{36}"
            required
          />
          <button className="button secondary">Open batch</button>
        </form>
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {id && query.isPending ? <Loading /> : null}
        {query.data ? (
          <>
            <ExportRecords
              name={`import-batch-${query.data.id}`}
              columns={['rowNumber', 'state', 'assetCode', 'description', 'status', 'issues']}
              load={async () => {
                const batch = await api<ImportBatch>(`/imports/${id}`);
                return (batch.rows ?? []).map((row) => {
                  const fields =
                    row.normalizedFields && typeof row.normalizedFields === 'object'
                      ? (row.normalizedFields as Record<string, unknown>)
                      : {};
                  return {
                    rowNumber: row.rowNumber,
                    state: row.state,
                    assetCode: fields.assetCode ?? row.rawFields?.['Asset ID'],
                    description: fields.description,
                    status: fields.status,
                    issues: row.issues,
                  };
                });
              }}
            />
            <div className="subsection">
              <Badge value={query.data.state} />
              <p className="mono small-text">
                {query.data.id} · Version {query.data.version}
              </p>
              <div className="mini-stats">
                <span>Total: {query.data.total ?? '—'}</span>
                <span>Eligible: {query.data.accepted ?? '—'}</span>
                <span>Quarantined: {query.data.quarantined ?? '—'}</span>
              </div>
            </div>
            {query.data.issues?.length ||
            query.data.rows?.some((row) => Array.isArray(row.issues) && row.issues.length) ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Code</th>
                      <th>Exception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      query.data.issues ??
                      query.data.rows?.flatMap((row) =>
                        (Array.isArray(row.issues) ? row.issues : []).map((issue: unknown) => ({
                          rowNumber: row.rowNumber,
                          code:
                            typeof issue === 'object' && issue !== null && 'code' in issue
                              ? String(issue.code)
                              : 'REVIEW',
                          message: typeof issue === 'string' ? issue : JSON.stringify(issue),
                        })),
                      ) ??
                      []
                    ).map((issue, index) => (
                      <tr key={`${issue.rowNumber}-${index}`}>
                        <td>{issue.rowNumber}</td>
                        <td>{issue.code}</td>
                        <td>{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {query.data.state !== 'COMMITTED' ? (
              <form className="form-stack subsection" onSubmit={review}>
                <FormTransfer
                  formId={`import-reconciliation:${id}:${query.data.version}`}
                  fields={[
                    { key: 'expectedAssetCodes', type: 'list', required: true },
                    { key: 'expectedTotalCost', required: true },
                    { key: 'expectedUnknownPurchaseCost', required: true },
                    { key: 'reason', required: true },
                  ]}
                  values={{
                    expectedAssetCodes: expectedCodes
                      .split(/[\n,;]/)
                      .map((value) => value.trim())
                      .filter(Boolean),
                    expectedTotalCost: expectedCost,
                    expectedUnknownPurchaseCost: unknownCost,
                    reason,
                  }}
                  disabled={action.isPending}
                  description="Load reconciliation values for this batch, then verify the exact IDs, amounts and reason. Finance and promotion approval must be confirmed separately."
                  onImport={(record) => {
                    if (Array.isArray(record.expectedAssetCodes))
                      setExpectedCodes(record.expectedAssetCodes.map(String).join('\n'));
                    if ('expectedTotalCost' in record)
                      setExpectedCost(String(record.expectedTotalCost ?? ''));
                    if ('expectedUnknownPurchaseCost' in record)
                      setUnknownCost(String(record.expectedUnknownPurchaseCost ?? ''));
                    if ('reason' in record) setReason(String(record.reason ?? ''));
                    setReviewVersion(query.data?.version);
                    setAcceptFinance(false);
                    setConfirmed(false);
                    setCommitVersion(undefined);
                  }}
                />
                <ExportRecords
                  name="import-row-corrections-template"
                  columns={correctionColumns}
                  load={async () => []}
                />
                <ExportRecords
                  name={`import-row-corrections-${id}`}
                  columns={correctionColumns}
                  disabled={action.isPending}
                  load={async () =>
                    checkedCorrectionRows(JSON.parse(corrections), query.data?.total ?? 500).map(
                      (row) => ({
                        rowNumber: row.rowNumber,
                        ...Object.fromEntries(
                          Object.entries(row.fields).map(([key, value]) => [
                            key,
                            `json:${JSON.stringify(value)}`,
                          ]),
                        ),
                      }),
                    )
                  }
                />
                <Field
                  label="Row corrections (.xlsx or .csv)"
                  htmlFor="import-corrections-table"
                  hint={
                    'Each supplied row replaces its complete stored override set when Apply review is chosen. Include every override you want to retain for that row. Blank cells carry no override and use raw-source normalization; rows absent from the table keep their stored corrections. A rowNumber-only row resets all overrides for that row. Use json:null for an explicit null, json:"" for an empty string, and json:"json:literal" for text starting with json:. Current exports preserve each specified value and type. The API still validates corrections; reconciliation totals remain separate.'
                  }
                >
                  <input
                    id="import-corrections-table"
                    type="file"
                    accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={action.isPending}
                    onChange={(event) => {
                      void loadCorrectionTable(event.target.files?.[0]);
                    }}
                  />
                </Field>
                <Field
                  label="Review controls (.json)"
                  htmlFor="import-review-controls"
                  hint="Optionally fill reconciliation values and corrections from a prepared file, then review them before approval."
                >
                  <input
                    id="import-review-controls"
                    type="file"
                    accept=".json,application/json"
                    disabled={action.isPending}
                    onChange={(event) => {
                      void loadReviewControls(event.target.files?.[0]);
                    }}
                  />
                </Field>
                <Field
                  label="Reviewed row corrections (JSON array)"
                  htmlFor="import-corrections"
                  hint={
                    'Each item: {"rowNumber":1,"fields":{"status":"In Store"}}. Its fields replace all stored overrides for that row; include every override to retain. An empty fields object resets that row to raw-source normalization. Rows omitted from this array keep their stored corrections. Changes apply only after explicit review.'
                  }
                >
                  <textarea
                    className="mono"
                    id="import-corrections"
                    value={corrections}
                    onChange={(event) => {
                      setCorrections(event.target.value);
                      setReviewVersion((value) => value ?? query.data?.version);
                    }}
                    rows={6}
                    required
                  />
                </Field>
                <Field label="Review evidence / reason" htmlFor="import-reason">
                  <textarea
                    id="import-reason"
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setReviewVersion((value) => value ?? query.data?.version);
                    }}
                    maxLength={5000}
                    required
                  />
                </Field>
                <Field
                  label="Expected Asset IDs"
                  htmlFor="expected-ids"
                  hint="Approved reconciliation set, one permanent Asset ID per line."
                >
                  <textarea
                    id="expected-ids"
                    value={expectedCodes}
                    onChange={(event) => {
                      setExpectedCodes(event.target.value);
                      setReviewVersion((value) => value ?? query.data?.version);
                    }}
                    required
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Expected known purchase cost (INR)" htmlFor="expected-cost">
                    <input
                      id="expected-cost"
                      inputMode="decimal"
                      pattern="[0-9]+([.][0-9]{1,2})?"
                      value={expectedCost}
                      onChange={(event) => {
                        setExpectedCost(event.target.value);
                        setReviewVersion((value) => value ?? query.data?.version);
                      }}
                      required
                    />
                  </Field>
                  <Field label="Expected unknown purchase costs" htmlFor="unknown-cost">
                    <input
                      id="unknown-cost"
                      type="number"
                      min="0"
                      step="1"
                      value={unknownCost}
                      onChange={(event) => {
                        setUnknownCost(event.target.value);
                        setReviewVersion((value) => value ?? query.data?.version);
                      }}
                      required
                    />
                  </Field>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={acceptFinance}
                    onChange={(event) => {
                      setAcceptFinance(event.target.checked);
                      setReviewVersion((value) => value ?? query.data?.version);
                    }}
                  />
                  I approve operational import of rows with explicitly pending Finance metadata.
                </label>
                <button
                  className="button secondary"
                  disabled={
                    action.isPending || !reason.trim() || !expectedCodes.trim() || !expectedCost
                  }
                >
                  Apply review and revalidate
                </button>
              </form>
            ) : (
              <div className="notice success">
                This batch has been committed. Live assets are never overwritten by a rerun.
              </div>
            )}
            {query.data.state === 'REVIEWED' ? (
              <div className="subsection">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => {
                      setConfirmed(event.target.checked);
                      setCommitVersion(query.data?.version);
                    }}
                  />
                  I have reconciled the reviewed rows, exceptions, identity mapping, and source
                  evidence.
                </label>
                <button
                  className="button"
                  type="button"
                  disabled={!confirmed || action.isPending}
                  onClick={() => {
                    void commit();
                  }}
                >
                  Promote eligible reviewed rows
                </button>
              </div>
            ) : null}
          </>
        ) : !id ? (
          <Empty title="Choose a batch to review">
            Stage a request or enter a known batch ID above.
          </Empty>
        ) : null}
      </Panel>
    </>
  );
}
