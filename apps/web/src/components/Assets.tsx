import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAction, usePages } from '../hooks';
import { can, useSession } from '../session';
import type { Asset, AssignablePerson } from '../types';
import { fetchAllPages } from '../transfer-files';
import { AssetPhoto } from './AssetPhoto';
import { BulkTransfer, ExportRecords, FormTransfer } from './DataTransfer';
import { FinanceStatusPanel } from './FinanceReview';
import {
  useReferences,
  ReferenceSelect,
  ReferenceBadge,
  referenceLabel,
  locationLabel,
  referenceOptions,
} from './References';
import {
  Badge,
  Empty,
  ErrorNotice,
  Checkbox,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  Timeline,
  displayDate,
  Select,
} from './ui';
const assetExportColumns = [
  'assetCode',
  'description',
  'category',
  'assetType',
  'manufacturer',
  'model',
  'serialNumber',
  'barcode',
  'configuration',
  'graphics',
  'ownershipType',
  'status',
  'condition',
  'riskLevel',
  'departmentId',
  'locationId',
  'warrantyExpiry',
  'amcApplies',
  'amcExpiry',
  'purchaseDate',
  'insuranceExpiry',
  'lastAuditDate',
  'nextAuditDate',
  'disposalDate',
  'disposalMethod',
  'dataWipeRequired',
];
const assetAdminExportColumns = [
  'purchaseCost',
  'residualValue',
  'depreciationMethod',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'disposalReference',
  'remarks',
  'commentType',
  'financePending',
];
function assetExportRow(asset: Record<string, unknown>, manage: boolean) {
  const columns = [...assetExportColumns, ...(manage ? assetAdminExportColumns : [])];
  return Object.fromEntries(columns.map((key) => [key, asset[key] ?? '']));
}
const terminalAssetStatuses = new Set(['Retired', 'Disposed', 'Sold']);
function canAssign(asset: Asset) {
  return asset.status === 'In Store' && !asset.currentAssignment;
}
function canTransfer(asset: Asset) {
  return !!asset.currentAssignment && !terminalAssetStatuses.has(asset.status);
}
export function AssetList({ assignmentMode = false }: { assignmentMode?: boolean }) {
  const { user } = useSession();
  const manage = can(user, 'asset.view_all');
  const [params, setParams] = useSearchParams();
  const refs = useReferences();
  const filters = {
    q: params.get('q') || undefined,
    status: assignmentMode ? 'In Store' : params.get('status') || undefined,
    category: params.get('category') || undefined,
    departmentId: params.get('departmentId') || undefined,
    labelPrinted: params.get('labelPrinted') === 'no' ? 'no' : undefined,
    owningTeamId: params.get('owningTeamId') || undefined,
    projectId: params.get('projectId') || undefined,
  };
  const teamName = (teamId?: string | null) =>
    refs.data?.teams?.find((item) => item.id === teamId)?.code ?? '';
  const showAssign = !assignmentMode && can(user, 'asset.custody');
  const showCreate = can(user, 'asset.create');
  const query = usePages<Asset>('/assets', filters);
  const loadedItems = query.data?.pages.flatMap((page) => page.items) ?? [];
  const items = assignmentMode ? loadedItems.filter(canAssign) : loadedItems;
  const [search, setSearch] = useState(filters.q ?? '');
  function update(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  }
  function searchSubmit(event: FormEvent) {
    event.preventDefault();
    update('q', search.trim());
  }
  return (
    <>
      {assignmentMode ? (
        <Link to="/assets" className="back-link">
          ← Asset catalog
        </Link>
      ) : null}
      <PageTitle
        eyebrow={manage ? 'INVENTORY / ASSETS' : 'MY WORKSPACE / ASSETS'}
        title={assignmentMode ? 'Assign an asset' : manage ? 'Asset catalog' : 'Your assets'}
        description={
          assignmentMode
            ? 'Choose an In Store asset below, then select an eligible employee and confirm the handover.'
            : manage
              ? 'One register. Clear custody. Every asset accounted for.'
              : 'Review the equipment assigned to you and confirm its details.'
        }
        action={
          manage && (showAssign || showCreate) ? (
            <div className="actions">
              {showAssign ? (
                <Link className="button" to="/assignments/new">
                  Assign asset
                </Link>
              ) : null}
              {showCreate ? (
                <Link className="button secondary" to="/assets/new">
                  Create asset
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <ExportRecords
        name="assets"
        columns={[...assetExportColumns, ...(manage ? assetAdminExportColumns : [])]}
        load={async () =>
          (await fetchAllPages('/assets', filters)).map((item) => assetExportRow(item, manage))
        }
      />
      {can(user, 'asset.import') && !assignmentMode ? (
        <>
          <BulkTransfer module="assets" />
          <BulkTransfer module="assignments" />
          {can(user, 'system.admin') ? (
            <p className="muted">
              For an original asset register with permanent Asset IDs, use{' '}
              <Link to="/admin/imports">Import review</Link> to preserve source provenance and
              reconciliation.
            </p>
          ) : null}
        </>
      ) : null}
      <Panel>
        <div className="filter-bar">
          <form className="search-form" onSubmit={searchSubmit}>
            <label htmlFor="asset-search" className="sr-only">
              Search assets
            </label>
            <input
              id="asset-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search asset ID, description or serial"
              maxLength={100}
            />
            <button className="button secondary" type="submit">
              Search
            </button>
          </form>
          {!assignmentMode ? (
            <Field label="Status" htmlFor="filter-status">
              <ReferenceSelect
                refs={refs.data}
                kind="status"
                id="filter-status"
                value={filters.status ?? ''}
                onChange={(value) => update('status', value)}
                required={false}
                allowEmpty
                includeInactive
              />
            </Field>
          ) : null}
          <Field label="Category" htmlFor="filter-category">
            <ReferenceSelect
              refs={refs.data}
              kind="category"
              id="filter-category"
              value={filters.category ?? ''}
              onChange={(value) => update('category', value)}
              required={false}
              allowEmpty
              includeInactive
            />
          </Field>
          {manage ? (
            <>
              <Select
                label="Department"
                htmlFor="filter-department"
                value={filters.departmentId ?? ''}
                onChange={(value) => update('departmentId', value)}
                options={[
                  { value: '', label: 'All departments' },
                  ...(refs.data?.departments.map((item) => ({
                    value: item.id,
                    label: `${item.name}${!item.active ? ' (inactive)' : ''}`,
                  })) || []),
                ]}
              />
              <Select
                label="Owning team"
                htmlFor="filter-team"
                value={filters.owningTeamId ?? ''}
                onChange={(value) => update('owningTeamId', value)}
                options={[
                  { value: '', label: 'All teams' },
                  ...(refs.data?.teams?.map((item) => ({
                    value: item.id,
                    label: `${item.name} (${item.code})${!item.active ? ' (inactive)' : ''}`,
                  })) || []),
                ]}
              />
              <Select
                label="Project / grant"
                htmlFor="filter-project"
                value={filters.projectId ?? ''}
                onChange={(value) => update('projectId', value)}
                options={[
                  { value: '', label: 'All projects' },
                  ...(refs.data?.projects?.map((item) => ({
                    value: item.id,
                    label: `${item.name} (${item.code})${!item.active ? ' (inactive)' : ''}`,
                  })) || []),
                ]}
              />
              <Checkbox
                label="Not printed yet"
                className="filter-checkbox"
                checked={filters.labelPrinted === 'no'}
                onChange={(checked) => update('labelPrinted', checked ? 'no' : '')}
              />
            </>
          ) : null}
        </div>
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {query.isPending ? (
          <Loading label="Loading assets..." />
        ) : items.length ? (
          <div className="table-scroll asset-catalog-table">
            <table>
              <thead>
                <tr>
                  <th>Asset / description</th>
                  <th>Category</th>
                  {manage ? <th>Team</th> : null}
                  <th>Status</th>
                  <th>Condition</th>
                  <th>Verification</th>
                  {manage ? <th>Last label printed</th> : null}
                  <th>
                    <span className="sr-only">View</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((asset) => (
                  <tr key={asset.id}>
                    <td data-label="Asset / description">
                      <Link className="asset-code" to={`/assets/${asset.id}`}>
                        {asset.assetCode}
                      </Link>
                      <span className="cell-description">{asset.description}</span>
                    </td>
                    <td data-label="Category">
                      {referenceLabel(refs.data, 'CATEGORY', asset.category)}
                    </td>
                    {manage ? <td data-label="Team">{teamName(asset.owningTeamId)}</td> : null}
                    <td data-label="Status">
                      <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
                    </td>
                    <td data-label="Condition">
                      {referenceLabel(refs.data, 'CONDITION', asset.condition)}
                    </td>
                    <td data-label="Verification">
                      {asset.currentAssignment ? (
                        <Badge value={asset.currentAssignment.acknowledgement} />
                      ) : (
                        <span className="muted">No custody</span>
                      )}
                    </td>
                    {manage ? (
                      <td data-label="Last label printed">
                        {asset.lastLabelPrintedAt ? (
                          <span>{displayDate(asset.lastLabelPrintedAt, true)}</span>
                        ) : (
                          <span className="muted">Not printed</span>
                        )}
                      </td>
                    ) : null}
                    <td data-label="Actions">
                      <div className="actions">
                        {can(user, 'asset.custody', asset.owningTeamId ?? undefined) &&
                        canAssign(asset) ? (
                          <Link
                            to={`/assets/${asset.id}/assign`}
                            className="table-link"
                            aria-label={`Assign ${asset.assetCode}`}
                          >
                            Assign asset
                          </Link>
                        ) : can(user, 'asset.custody', asset.owningTeamId ?? undefined) &&
                          !assignmentMode &&
                          canTransfer(asset) ? (
                          <Link
                            to={`/assets/${asset.id}/assign?transfer=1`}
                            className="table-link"
                            aria-label={`Transfer ${asset.assetCode}`}
                          >
                            Transfer custody
                          </Link>
                        ) : null}
                        {can(user, 'asset.label', asset.owningTeamId ?? undefined) &&
                        !assignmentMode ? (
                          <Link
                            to={`/assets/labels?ids=${asset.id}`}
                            className="table-link"
                            aria-label={`Print label for ${asset.assetCode}`}
                          >
                            Print label
                          </Link>
                        ) : null}
                        <Link
                          to={`/assets/${asset.id}`}
                          className="table-link"
                          aria-label={`View ${asset.assetCode}`}
                        >
                          View →
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !query.error ? (
          <Empty
            title={
              assignmentMode
                ? 'No assets ready for assignment'
                : manage
                  ? 'Your register starts here'
                  : 'No assets to display'
            }
            action={
              assignmentMode ? (
                <div className="actions">
                  {showCreate ? (
                    <Link className="button" to="/assets/new">
                      Create asset
                    </Link>
                  ) : null}
                  {can(user, 'system.admin') ? (
                    <Link className="button secondary" to="/admin/imports">
                      Import review
                    </Link>
                  ) : null}
                </div>
              ) : showCreate ? (
                <Link className="button" to="/assets/new">
                  Create your first asset
                </Link>
              ) : undefined
            }
          >
            {assignmentMode
              ? 'Only In Store assets without current custody can be assigned. Adjust the search filters, create an asset, or review and explicitly promote eligible register rows in Import review first.'
              : manage
                ? 'Add an asset or stage a reviewed import to begin.'
                : 'Assigned equipment will appear here. Adjust your filters if needed.'}
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
function KitPanel({ asset }: { asset: Asset }) {
  const action = useAction();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [detachReason, setDetachReason] = useState('');
  const parts = asset.kitParts ?? [];
  async function attach(event: FormEvent) {
    event.preventDefault();
    setLookupError('');
    const wanted = code.trim().toUpperCase();
    const found = await api<{ items: Asset[] }>(
      `/assets?q=${encodeURIComponent(wanted)}&limit=20`,
    ).catch(() => undefined);
    const part = found?.items.find((item) => item.assetCode.toUpperCase() === wanted);
    if (!part) {
      setLookupError('No asset with that code was found.');
      return;
    }
    await action
      .mutateAsync({
        path: `/assets/${asset.id}/kit`,
        body: { partAssetId: part.id, reason: reason.trim() },
        idempotent: true,
      })
      .then(() => {
        setCode('');
        setReason('');
      })
      .catch(() => undefined);
  }
  async function detach(part: { id: string }) {
    if (!detachReason.trim()) return;
    await action
      .mutateAsync({
        path: `/assets/${asset.id}/kit/${part.id}`,
        method: 'DELETE',
        body: { reason: detachReason.trim() },
        idempotent: true,
      })
      .then(() => setDetachReason(''))
      .catch(() => undefined);
  }
  return (
    <Panel title="Kit">
      <p className="muted">
        Parts in a kit are assigned, transferred and returned together with this asset.
      </p>
      {parts.length ? (
        <Field label="Detach reason" htmlFor="kit-detach-reason">
          <input
            id="kit-detach-reason"
            value={detachReason}
            onChange={(event) => setDetachReason(event.target.value)}
            maxLength={5000}
            placeholder="Required to detach a part"
          />
        </Field>
      ) : null}
      {parts.length ? (
        <ul className="plain-list">
          {parts.map((part) => (
            <li key={part.id}>
              <Link to={`/assets/${part.id}`}>{part.assetCode}</Link> {part.description}
              <button
                type="button"
                className="button secondary"
                disabled={action.isPending || !detachReason.trim()}
                onClick={() => void detach(part)}
              >
                Detach
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No parts attached.</p>
      )}
      <form className="form-stack subsection" onSubmit={attach}>
        <Field label="Part asset code" htmlFor="kit-part-code">
          <input
            id="kit-part-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="IAC-IT-000123"
            required
          />
        </Field>
        <Field label="Reason" htmlFor="kit-reason">
          <input
            id="kit-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={5000}
            required
          />
        </Field>
        {lookupError ? <p role="alert">{lookupError}</p> : null}
        <button className="button" disabled={action.isPending || !code.trim() || !reason.trim()}>
          Attach part
        </button>
      </form>
    </Panel>
  );
}
export function AssetDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const manage = can(user, 'asset.view_all');
  const refs = useReferences();
  const query = useQuery({
    queryKey: ['asset', id],
    queryFn: ({ signal }) => api<Asset>(`/assets/${id}`, { signal }),
    enabled: !!id,
  });
  const action = useAction();
  const [custodySnapshot, setCustodySnapshot] = useState<{ id: string; version: number }>();
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [returning, setReturning] = useState(false);
  const [condition, setCondition] = useState('');
  const [location, setLocation] = useState('');
  if (query.isPending) return <Loading label="Loading asset details..." />;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <Empty title="Asset not found">
          <p>This asset does not exist or belongs to another team.</p>
        </Empty>
      );
    }
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const asset = query.data;
  if (!asset) return <Empty title="Asset not found" />;
  const assetTeam = asset.owningTeamId ?? undefined;
  const mayEdit = can(user, 'asset.edit', assetTeam) || can(user, 'asset.finance_edit');
  const mayLabel = can(user, 'asset.label', assetTeam);
  const mayCustody =
    can(user, 'asset.custody', assetTeam) &&
    !asset.kitParent &&
    (canTransfer(asset) || canAssign(asset));
  const assignment = asset.currentAssignment;
  const own = assignment?.userId === user?.id;
  const department = refs.data?.departments.find((value) => value.id === asset.departmentId)?.name;
  const loc = refs.data?.locations.find((value) => value.id === asset.locationId);
  async function acknowledge(event: FormEvent) {
    event.preventDefault();
    if (!custodySnapshot) return;
    await action
      .mutateAsync({
        path: `/assignments/${custodySnapshot.id}/acknowledgement`,
        body: { decision, ...(decision === 'DISPUTED' ? { reason: reason.trim() } : {}) },
        version: custodySnapshot.version,
        idempotent: true,
      })
      .then(() => {
        setDecision('');
        setReason('');
      })
      .catch(() => undefined);
  }
  async function returnAsset(event: FormEvent) {
    event.preventDefault();
    if (!custodySnapshot) return;
    await action
      .mutateAsync({
        path: `/assignments/${custodySnapshot.id}/return`,
        body: { condition, locationId: location, reason: reason.trim() },
        version: custodySnapshot.version,
        idempotent: true,
      })
      .then(() => {
        setReturning(false);
        setReason('');
      })
      .catch(() => undefined);
  }
  return (
    <>
      <Link to="/assets" className="back-link">
        ← Asset catalog
      </Link>
      <PageTitle
        eyebrow={asset.assetCode}
        title={asset.description}
        description={`${referenceLabel(refs.data, 'CATEGORY', asset.category)} · ${referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType)}`}
        action={
          manage && (mayEdit || mayLabel || mayCustody) ? (
            <div className="actions">
              {mayEdit ? (
                <Link className="button secondary" to={`/assets/${id}/edit`}>
                  Edit asset
                </Link>
              ) : null}
              {mayLabel ? (
                <Link className="button secondary" to={`/assets/labels?ids=${asset.id}`}>
                  Print label
                </Link>
              ) : null}
              {!mayCustody ? null : canTransfer(asset) ? (
                <Link className="button" to={`/assets/${id}/assign?transfer=1`}>
                  Transfer custody
                </Link>
              ) : canAssign(asset) ? (
                <Link className="button" to={`/assets/${id}/assign`}>
                  Assign asset
                </Link>
              ) : null}
            </div>
          ) : own ? (
            <Link className="button" to={`/tickets/new?assetId=${asset.id}`}>
              Raise a ticket
            </Link>
          ) : undefined
        }
      />
      <ExportRecords
        name={`asset-${asset.assetCode}`}
        columns={[...assetExportColumns, ...(manage ? assetAdminExportColumns : [])]}
        load={async () => [assetExportRow(await api<Asset>(`/assets/${asset.id}`), manage)]}
      />
      <ErrorNotice
        error={action.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {manage ? <FinanceStatusPanel asset={asset} /> : null}
      {!manage ? (
        <div className="notice">
          Asset details are read-only. Contact Admin or raise a support ticket to request a
          correction.
        </div>
      ) : null}
      {own && assignment?.acknowledgement === 'PENDING' ? (
        <div className="notice warning">
          <strong>This asset needs your confirmation</strong>
          <p>
            Check the serial number, description, and condition against the item received. A
            discrepancy records your feedback without changing custody.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setDecision('ACCEPTED');
                setReason('');
                setCustodySnapshot(
                  assignment ? { id: assignment.id, version: assignment.version } : undefined,
                );
              }}
            >
              Details are correct
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setDecision('DISPUTED');
                setReason('');
                setCustodySnapshot(
                  assignment ? { id: assignment.id, version: assignment.version } : undefined,
                );
              }}
            >
              Report discrepancy
            </button>
          </div>
          {decision ? (
            <form className="inline-form" onSubmit={acknowledge}>
              {decision === 'DISPUTED' ? (
                <FormTransfer
                  formId="asset-discrepancy"
                  fields={[{ key: 'reason', label: 'Discrepancy reason', required: true }]}
                  values={{ reason }}
                  disabled={action.isPending}
                  onImport={(data) => {
                    if (typeof data.reason === 'string') setReason(data.reason);
                  }}
                  description="Load a discrepancy description for review. Submission remains a separate action."
                />
              ) : null}
              {decision === 'DISPUTED' ? (
                <Field label="What needs correcting?" htmlFor="dispute-reason">
                  <textarea
                    id="dispute-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    maxLength={5000}
                  />
                </Field>
              ) : (
                <p>Confirm that these asset details match the equipment you received.</p>
              )}
              <button
                className="button"
                disabled={action.isPending || (decision === 'DISPUTED' && !reason.trim())}
              >
                {action.isPending
                  ? 'Saving...'
                  : decision === 'DISPUTED'
                    ? 'Submit discrepancy'
                    : 'Confirm acceptance'}
              </button>
              <button type="button" className="button text" onClick={() => setDecision('')}>
                Cancel
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <div className="detail-grid">
        <Panel title="Asset overview">
          <dl className="details">
            <dt>Asset ID</dt>
            <dd className="mono">{asset.assetCode}</dd>
            <dt>Status</dt>
            <dd>
              <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
            </dd>
            <dt>Manufacturer / model</dt>
            <dd>{[asset.manufacturer, asset.model].filter(Boolean).join(' / ') || 'Unknown'}</dd>
            <dt>Serial number</dt>
            <dd>{asset.serialNumber || 'Unknown'}</dd>
            <dt>Condition</dt>
            <dd>{referenceLabel(refs.data, 'CONDITION', asset.condition)}</dd>
            <dt>Risk level</dt>
            <dd>{referenceLabel(refs.data, 'RISK', asset.riskLevel)}</dd>
            {manage ? (
              <>
                <dt>Owning team</dt>
                <dd>
                  {refs.data?.teams?.find((item) => item.id === asset.owningTeamId)?.name ??
                    'Unknown'}
                </dd>
                <dt>Project / grant</dt>
                <dd>
                  {refs.data?.projects?.find((item) => item.id === asset.projectId)?.name ?? 'None'}
                </dd>
              </>
            ) : null}
            <dt>Department</dt>
            <dd>{department || 'Unknown'}</dd>
            <dt>Location</dt>
            <dd>{loc ? locationLabel(loc) : 'Unknown'}</dd>
            <dt>Ownership</dt>
            <dd>{referenceLabel(refs.data, 'OWNERSHIP', asset.ownershipType)}</dd>
          </dl>
          {asset.configuration ? (
            <div className="subsection">
              <h3>Configuration</h3>
              <p className="preserve">{asset.configuration}</p>
            </div>
          ) : null}
        </Panel>
        <div className="stack">
          <AssetPhoto key={asset.id} asset={asset} manage={manage} />
          <Panel title="Current custody">
            {assignment ? (
              <>
                <Badge value={assignment.acknowledgement} />
                <p className="muted">
                  {assignment.assignedAt
                    ? `Assigned ${displayDate(assignment.assignedAt)}`
                    : 'Current assignment recorded'}
                </p>
                {manage ? (
                  <div className="custody-person">
                    <strong>{assignment.employeeName || 'Employee name not recorded'}</strong>
                    {assignment.employeeDesignation ? (
                      <span>{assignment.employeeDesignation}</span>
                    ) : null}
                    {assignment.employeeDepartment ? (
                      <span className="muted">{assignment.employeeDepartment}</span>
                    ) : null}
                  </div>
                ) : null}
                {assignment.acknowledgedAt ? (
                  <p>Confirmed {displayDate(assignment.acknowledgedAt, true)}</p>
                ) : null}
                {manage && !asset.kitParent ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setReturning(!returning);
                      setCustodySnapshot(
                        assignment ? { id: assignment.id, version: assignment.version } : undefined,
                      );
                      setCondition(asset.condition ?? '');
                      setLocation(asset.locationId ?? '');
                      setReason('');
                    }}
                  >
                    Record return
                  </button>
                ) : null}
              </>
            ) : (
              <p className="muted">No current assignment.</p>
            )}
            {returning && assignment ? (
              <form className="form-stack subsection" onSubmit={returnAsset}>
                <FormTransfer
                  formId="asset-return"
                  fields={[
                    {
                      key: 'condition',
                      required: true,
                      options: referenceOptions(refs.data, 'CONDITION').map((item) => item.code),
                    },
                    {
                      key: 'locationId',
                      required: true,
                      options:
                        refs.data?.locations.filter((item) => item.active).map((item) => item.id) ??
                        [],
                    },
                    { key: 'reason', required: true },
                  ]}
                  values={{ condition, locationId: location, reason }}
                  disabled={action.isPending || refs.isPending || !!refs.error}
                  onImport={(data) => {
                    if (typeof data.condition === 'string') setCondition(data.condition);
                    if (typeof data.locationId === 'string') setLocation(data.locationId);
                    if (typeof data.reason === 'string') setReason(data.reason);
                  }}
                />
                <Field label="Returned condition" htmlFor="return-condition">
                  <ReferenceSelect
                    id="return-condition"
                    kind="condition"
                    refs={refs.data}
                    value={condition}
                    onChange={setCondition}
                  />
                </Field>
                <Select
                  label="Return location"
                  htmlFor="return-location"
                  value={location}
                  onChange={setLocation}
                  required={true}
                  options={[
                    { value: '', label: 'Select location' },
                    ...(refs.data?.locations
                      .filter((item) => item.active || item.id === location)
                      .map((item) => ({
                        value: item.id,
                        label: `${locationLabel(item)}${!item.active ? ' (inactive)' : ''}`,
                        disabled: !item.active,
                      })) || []),
                  ]}
                />
                <Field label="Return reason" htmlFor="return-reason">
                  <textarea
                    id="return-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={5000}
                    required
                  />
                </Field>
                <button className="button" disabled={action.isPending || !reason.trim()}>
                  Confirm return
                </button>
              </form>
            ) : null}
          </Panel>
          <Panel title="Coverage & dates">
            <dl className="details">
              <dt>Warranty expires</dt>
              <dd>{displayDate(asset.warrantyExpiry)}</dd>
              <dt>AMC</dt>
              <dd>
                {asset.amcApplies
                  ? displayDate(asset.amcExpiry)
                  : asset.amcApplies === false
                    ? 'Not applicable'
                    : 'Unknown'}
              </dd>
              <dt>Next audit</dt>
              <dd>{displayDate(asset.nextAuditDate)}</dd>
            </dl>
          </Panel>
        </div>
        {manage ? (
          <Panel title="Finance metadata">
            <p className="muted">
              Operational records only. Valuations require Finance policy approval.
            </p>
            <dl className="details">
              <dt>Purchase cost</dt>
              <dd>{asset.purchaseCost == null ? 'Pending' : `INR ${asset.purchaseCost}`}</dd>
              <dt>Residual value</dt>
              <dd>
                {asset.residualValue == null
                  ? 'Pending Finance input'
                  : `INR ${asset.residualValue}`}
              </dd>
              <dt>Purchase date</dt>
              <dd>{displayDate(asset.purchaseDate)}</dd>
            </dl>
          </Panel>
        ) : null}
        {asset.kitParent ? (
          <Panel title="Kit">
            <p>
              Part of kit{' '}
              <Link to={`/assets/${asset.kitParent.id}`}>{asset.kitParent.assetCode}</Link>. Custody
              changes are made on the kit; detach this item first to move it on its own.
            </p>
          </Panel>
        ) : null}
        {can(user, 'asset.custody', assetTeam) && !asset.kitParent ? (
          <KitPanel asset={asset} />
        ) : null}
        <Panel title="Asset history">
          <Timeline items={asset.timeline ?? []} />
        </Panel>
      </div>
    </>
  );
}
const textFields = [
  ['description', 'Description'],
  ['manufacturer', 'Manufacturer'],
  ['model', 'Model'],
  ['serialNumber', 'Serial number'],
  ['barcode', 'Barcode / QR value'],
] as const;
const dateFields = [
  ['purchaseDate', 'Purchase date'],
  ['warrantyExpiry', 'Warranty expiry'],
  ['insuranceExpiry', 'Insurance expiry'],
  ['lastAuditDate', 'Last audit date'],
  ['nextAuditDate', 'Next audit date'],
  ['disposalDate', 'Disposal date'],
] as const;
const assetEditableFields = [
  ...textFields.map(([key]) => key),
  ...dateFields.map(([key]) => key),
  'category',
  'assetType',
  'ownershipType',
  'status',
  'condition',
  'riskLevel',
  'departmentId',
  'locationId',
  'configuration',
  'graphics',
  'amcExpiry',
  'purchaseCost',
  'residualValue',
  'invoiceNumber',
  'supplier',
  'insurancePolicyNumber',
  'disposalMethod',
  'depreciationMethod',
  'commentType',
  'dataWipeRequired',
  'disposalReference',
  'remarks',
];
const assetReferenceKinds: Record<string, string> = {
  category: 'CATEGORY',
  assetType: 'ASSET_TYPE',
  ownershipType: 'OWNERSHIP',
  status: 'STATUS',
  condition: 'CONDITION',
  riskLevel: 'RISK',
  disposalMethod: 'DISPOSAL_METHOD',
  depreciationMethod: 'DEPRECIATION_METHOD',
  commentType: 'COMMENT_TYPE',
  dataWipeRequired: 'DATA_WIPE',
};
export function AssetEditor() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['asset', id],
    queryFn: () => api<Asset>(`/assets/${id}`),
    enabled: !!id,
  });
  if (id && query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return <AssetEditForm asset={query.data} key={id ?? 'new'} />;
}
const financeKeys = new Set([
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
  'financePending',
]);
function AssetEditForm({ asset }: { asset?: Asset }) {
  const [baseline] = useState(asset);
  const navigate = useNavigate();
  const refs = useReferences();
  const { user } = useSession();
  const action = useAction<Asset>();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const data: Record<string, string> = {
      status: 'In Store',
      category: '',
      ownershipType: '',
      condition: '',
      riskLevel: '',
      assetType: '',
      description: '',
      reason: '',
    };
    if (asset)
      Object.entries(asset).forEach(([name, value]) => {
        if (typeof value === 'string' || typeof value === 'number') data[name] = String(value);
      });
    return data;
  });
  const [amc, setAmc] = useState(asset?.amcApplies ?? false);
  const [validation, setValidation] = useState('');
  const set = (name: string, value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  const teams = refs.data?.teams ?? [];
  const projects = refs.data?.projects ?? [];
  const createTeams = teams.filter((item) => item.active && can(user, 'asset.create', item.id));
  // A single permitted team is preselected for a new asset.
  const teamId =
    values.owningTeamId || (!baseline && createTeams.length === 1 ? createTeams[0].id : '');
  const selectedTeam = teams.find((item) => item.id === teamId);
  const projectId = values.projectId ?? '';
  const requiresProject = !!selectedTeam?.requiresProject;
  const canFinance = can(user, 'asset.finance_edit', teamId || undefined);
  const canChangeTeam = !!baseline && can(user, 'asset.change_team');
  // Finance without asset.edit for this team may change only the finance fields.
  const financeOnly =
    !!baseline && canFinance && !can(user, 'asset.edit', baseline.owningTeamId ?? undefined);
  const lockedStyle = { display: 'contents' } as const;
  const roomHeld =
    refs.data?.assetTypePolicies?.find((item) => item.assetTypeCode === values.assetType)
      ?.requiresCustodian === false;
  const blocked =
    !financeOnly &&
    ((!baseline && !teamId) || (requiresProject && !projectId) || (roomHeld && !values.locationId));
  const editableFields = assetEditableFields.filter((key) => canFinance || !financeKeys.has(key));
  const lockFinance = (name: string) => !canFinance && financeKeys.has(name);
  function fillDemo() {
    const firstCode = (kind: string) => referenceOptions(refs.data, kind)[0]?.code ?? '';
    const demo: Record<string, string> = {
      description: 'Demo laptop — Dell Latitude 5540 (sample record)',
      manufacturer: 'Dell',
      model: 'Latitude 5540',
      serialNumber: 'DL5540-DEMO-001',
      barcode: 'IAC-DEMO-0001',
      category: firstCode('CATEGORY'),
      assetType: firstCode('ASSET_TYPE'),
      ownershipType: firstCode('OWNERSHIP'),
      status: 'In Store',
      condition: firstCode('CONDITION'),
      riskLevel: firstCode('RISK'),
      departmentId: refs.data?.departments.find((item) => item.active)?.id ?? '',
      locationId: refs.data?.locations.find((item) => item.active)?.id ?? '',
      configuration: 'Intel Core i7-1355U · 16 GB RAM · 512 GB NVMe SSD · Windows 11 Pro',
      purchaseDate: '2024-04-15',
      warrantyExpiry: '2027-04-15',
      insuranceExpiry: '2027-03-31',
      lastAuditDate: '2025-06-15',
      nextAuditDate: '2026-12-15',
      disposalDate: '2026-01-10',
      disposalMethod: firstCode('DISPOSAL_METHOD'),
      dataWipeRequired: firstCode('DATA_WIPE'),
      disposalReference: 'DEMO-DISPOSAL-REF-001',
      amcExpiry: '2027-04-15',
      purchaseCost: '45999.00',
      residualValue: '12000',
      invoiceNumber: 'INV-DEMO-2024-0415',
      supplier: 'Demo Technologies Pvt Ltd',
      insurancePolicyNumber: 'POL-DEMO-88421',
      depreciationMethod: firstCode('DEPRECIATION_METHOD'),
      commentType: firstCode('COMMENT_TYPE'),
      remarks: 'Sample record created with Fill demo values. Safe to edit or discard.',
    };
    // Only Finance may fill finance fields, so leave them out for everyone else.
    const allowed = Object.fromEntries(Object.entries(demo).filter(([key]) => !lockFinance(key)));
    setValues((current) => ({ ...current, ...allowed }));
    setAmc(true);
    setValidation('');
    action.reset();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation('');
    if ((!financeOnly && !values.description.trim()) || (baseline && !values.reason?.trim())) {
      setValidation('Description and change reason must contain text.');
      return;
    }
    const body: Record<string, unknown> = {};
    const allowed = [
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
      'status',
      'condition',
      'riskLevel',
      'warrantyExpiry',
      'amcExpiry',
      'purchaseDate',
      'purchaseCost',
      'residualValue',
      'invoiceNumber',
      'supplier',
      'insurancePolicyNumber',
      'insuranceExpiry',
      'lastAuditDate',
      'nextAuditDate',
      'disposalDate',
      'disposalMethod',
      'depreciationMethod',
      'commentType',
      'dataWipeRequired',
      'disposalReference',
      'remarks',
    ];
    if (blocked) {
      setValidation(
        requiresProject && !projectId
          ? 'Choose the project / grant this asset was bought under.'
          : roomHeld && !values.locationId
            ? 'This asset type is kept in a room. Choose a location.'
            : 'Choose the owning team.',
      );
      return;
    }
    if (financeOnly && baseline) {
      for (const name of allowed) {
        if (!financeKeys.has(name)) continue;
        const next = (values[name] ?? '').trim();
        const raw = baseline[name];
        const before =
          raw == null
            ? ''
            : String(raw).slice(
                0,
                name.endsWith('Date') || name.endsWith('Expiry') ? 10 : undefined,
              );
        if (next !== before) body[name] = next || null;
      }
      body.reason = values.reason.trim();
      const sent = await action
        .mutateAsync({
          path: `/assets/${baseline.id}`,
          method: 'PATCH',
          body,
          version: baseline.version,
        })
        .catch(() => undefined);
      if (sent) navigate(`/assets/${sent.id}`);
      return;
    }
    if (!baseline) body.owningTeamId = teamId;
    else if (canChangeTeam && teamId !== baseline.owningTeamId) body.owningTeamId = teamId;
    if (projectId) body.projectId = projectId;
    else if (baseline?.projectId) body.projectId = null;
    for (const name of allowed) {
      if (lockFinance(name)) continue;
      const value = values[name];
      if (value?.trim()) body[name] = value.trim();
      else if (
        baseline &&
        baseline[name] != null &&
        ![
          'category',
          'assetType',
          'description',
          'ownershipType',
          'status',
          'condition',
          'riskLevel',
        ].includes(name)
      )
        body[name] = null;
    }
    body.amcApplies = amc;
    if (!amc) body.amcExpiry = null;
    if (baseline) body.reason = values.reason.trim();
    const result = await action
      .mutateAsync({
        path: baseline ? `/assets/${baseline.id}` : '/assets',
        method: baseline ? 'PATCH' : 'POST',
        body,
        version: baseline?.version,
        idempotent: !baseline,
      })
      .catch(() => undefined);
    if (result) navigate(`/assets/${result.id}`);
  }
  return (
    <>
      <Link className="back-link" to={baseline ? `/assets/${baseline.id}` : '/assets'}>
        ← Back to asset
      </Link>
      <PageTitle
        title={baseline ? 'Edit asset' : 'Create an asset'}
        description={
          baseline
            ? `${baseline.assetCode} · The Asset ID is permanent.`
            : 'Add an item to the register. Its permanent Asset ID is assigned automatically.'
        }
        action={
          !baseline ? (
            <button
              type="button"
              className="button secondary"
              onClick={fillDemo}
              disabled={refs.isPending || !!refs.error}
              title="Fill every field with sample data"
            >
              Fill demo values
            </button>
          ) : undefined
        }
      />
      <FormTransfer
        formId={baseline ? 'asset-edit' : 'asset-create'}
        fields={[
          ...editableFields.map((key) => {
            const kind = assetReferenceKinds[key];
            let options = kind
              ? referenceOptions(refs.data, kind).map((item) => item.code)
              : undefined;
            if (key === 'departmentId')
              options =
                refs.data?.departments.filter((item) => item.active).map((item) => item.id) ?? [];
            if (key === 'locationId')
              options =
                refs.data?.locations.filter((item) => item.active).map((item) => item.id) ?? [];
            if (options && typeof baseline?.[key] === 'string' && !options.includes(baseline[key]))
              options = [...options, baseline[key]];
            return {
              key,
              required: [
                'description',
                'category',
                'assetType',
                'ownershipType',
                'status',
                'condition',
                'riskLevel',
              ].includes(key),
              ...(options ? { options } : {}),
            };
          }),
          { key: 'amcApplies', label: 'AMC applies', type: 'boolean' },
          ...(baseline ? [{ key: 'reason', label: 'Change reason', required: true }] : []),
        ]}
        values={{ ...values, amcApplies: amc }}
        disabled={action.isPending || refs.isPending || !!refs.error}
        description="Load editable fields for review, then use the normal Save action. The selected asset and its permanent Asset ID are unchanged."
        onImport={(data) => {
          const editable = [...editableFields, ...(baseline ? ['reason'] : [])];
          setValues((previous) => ({
            ...previous,
            ...Object.fromEntries(
              editable
                .filter((key) => typeof data[key] === 'string')
                .map((key) => [key, data[key] as string]),
            ),
          }));
          if (typeof data.amcApplies === 'boolean') setAmc(data.amcApplies);
          setValidation('');
          action.reset();
        }}
      />
      <form onSubmit={submit} className="form-stack">
        <ErrorNotice error={action.error} retry={() => window.location.reload()} />
        <ErrorNotice
          error={refs.error}
          retry={() => {
            void refs.refetch();
          }}
        />
        {validation ? (
          <div className="notice danger" role="alert">
            {validation}
          </div>
        ) : null}
        <fieldset disabled={financeOnly} style={lockedStyle}>
          <Panel title="Ownership">
            <div className="form-grid">
              <Select
                label="Owning team"
                htmlFor="owningTeamId"
                value={teamId}
                onChange={(value) => set('owningTeamId', value)}
                disabled={!!baseline && !canChangeTeam}
                required
                hint={
                  !baseline && selectedTeam
                    ? `IAC-${selectedTeam.assetCodePrefix}-…`
                    : baseline
                      ? `Asset code ${baseline.assetCode} stays the same if the team changes.`
                      : undefined
                }
                options={[
                  { value: '', label: 'Select team' },
                  ...(baseline
                    ? teams.filter((t) => t.active || t.id === teamId)
                    : createTeams
                  ).map((item) => ({ value: item.id, label: `${item.name} (${item.code})` })),
                ]}
              />
              <Select
                label={requiresProject ? 'Project / grant (required)' : 'Project / grant'}
                htmlFor="projectId"
                value={projectId}
                onChange={(value) => set('projectId', value)}
                required={requiresProject}
                options={[
                  { value: '', label: 'Select project' },
                  ...projects
                    .filter((item) => item.active || item.id === projectId)
                    .map((item) => ({ value: item.id, label: `${item.name} (${item.code})` })),
                ]}
              />
            </div>
            {roomHeld ? (
              <p className="notice" role="note">
                A location is required because this asset type is held in a room.
              </p>
            ) : null}
          </Panel>
          <Panel title="Identity & configuration">
            <div className="form-grid">
              {textFields.map(([name, label]) => (
                <Field key={name} label={label} htmlFor={name}>
                  <input
                    id={name}
                    value={values[name] ?? ''}
                    onChange={(event) => set(name, event.target.value)}
                    required={name === 'description'}
                    maxLength={name === 'description' ? 2000 : 200}
                  />
                </Field>
              ))}
              {['category', 'ownershipType', 'status', 'condition', 'riskLevel'].map(
                (name) => (
                  <Field
                    key={name}
                    label={
                      {
                        category: 'Category',
                        ownershipType: 'Ownership type',
                        status: 'Status',
                        condition: 'Condition',
                        riskLevel: 'Risk level',
                      }[name] ?? name
                    }
                    htmlFor={name}
                  >
                    <ReferenceSelect
                      refs={refs.data}
                      kind={name}
                      id={name}
                      value={values[name] ?? ''}
                      onChange={(value) => set(name, value)}
                      preserveCurrent={!!baseline}
                    />
                  </Field>
                ),
              )}
              {/* Asset type is filtered by the chosen owning team's type→team mapping. */}
              <Field
                key="assetType"
                label="Asset type"
                htmlFor="assetType"
              >
                <Select
                  label=""
                  htmlFor="assetType"
                  value={values.assetType ?? ''}
                  onChange={(value) => set('assetType', value)}
                  required
                  options={[
                    { value: '', label: 'Select asset type' },
                    ...(refs.data?.assetTypePolicies ?? [])
                      .filter((policy) => {
                        if (can(user, 'asset.change_team')) return true;
                        if (!selectedTeam) return false;
                        if (policy.owningTeamId === selectedTeam.id) return true;
                        // Projects may use Admin's facility types for grant purchases.
                        if (
                          selectedTeam.code === 'PRJ' &&
                          policy.owningTeamId ===
                            teams.find((t) => t.code === 'ADM')?.id
                        )
                          return true;
                        return false;
                      })
                      .filter((policy) => {
                        const ref = refs.data?.values.find(
                          (v) => v.kind === 'ASSET_TYPE' && v.code === policy.assetTypeCode,
                        );
                        return ref?.active ?? false;
                      })
                      .map((policy) => {
                        const ref = refs.data?.values.find(
                          (v) => v.kind === 'ASSET_TYPE' && v.code === policy.assetTypeCode,
                        );
                        return {
                          value: policy.assetTypeCode,
                          label: ref?.label ?? policy.assetTypeCode,
                        };
                      }),
                    // When editing, keep the current type selectable even if the mapping changed.
                    ...(baseline && baseline.assetType
                      ? [
                          {
                            value: baseline.assetType,
                            label:
                              refs.data?.values.find(
                                (v) => v.kind === 'ASSET_TYPE' && v.code === baseline.assetType,
                              )?.label ?? baseline.assetType,
                          },
                        ]
                      : []),
                  ]}
                />
              </Field>
              <Select
                label="Department"
                htmlFor="departmentId"
                value={values.departmentId ?? ''}
                onChange={(value) => set('departmentId', value)}
                options={[
                  { value: '', label: 'Not set' },
                  ...(refs.data?.departments
                    .filter((item) => item.active || item.id === values.departmentId)
                    .map((item) => ({
                      value: item.id,
                      label: `${item.name}${!item.active ? ' (inactive)' : ''}`,
                      disabled: !item.active,
                    })) || []),
                ]}
              />
              <Select
                label="Location"
                htmlFor="locationId"
                value={values.locationId ?? ''}
                onChange={(value) => set('locationId', value)}
                options={[
                  { value: '', label: 'Not set' },
                  ...(refs.data?.locations
                    .filter((item) => item.active || item.id === values.locationId)
                    .map((item) => ({
                      value: item.id,
                      label: `${locationLabel(item)}${!item.active ? ' (inactive)' : ''}`,
                      disabled: !item.active,
                    })) || []),
                ]}
              />
            </div>
            <Field label="Configuration" htmlFor="configuration">
              <textarea
                id="configuration"
                value={values.configuration ?? ''}
                onChange={(event) => set('configuration', event.target.value)}
                maxLength={5000}
              />
            </Field>
          </Panel>
        </fieldset>
        <Panel title="Dates & coverage">
          <div className="form-grid">
            {dateFields.map(([name, label]) => (
              <Field key={name} label={label} htmlFor={name}>
                <input
                  type="date"
                  id={name}
                  value={values[name]?.slice(0, 10) ?? ''}
                  onChange={(event) => set(name, event.target.value)}
                  readOnly={lockFinance(name)}
                  disabled={financeOnly && !financeKeys.has(name)}
                />
              </Field>
            ))}
            <fieldset disabled={financeOnly} style={lockedStyle}>
              <Field label="Disposal method" htmlFor="disposalMethod">
                <ReferenceSelect
                  refs={refs.data}
                  kind="DISPOSAL_METHOD"
                  id="disposalMethod"
                  value={values.disposalMethod ?? ''}
                  onChange={(value) => set('disposalMethod', value)}
                  required={false}
                  preserveCurrent={!!baseline}
                />
              </Field>
              <Field label="Data wipe required" htmlFor="dataWipeRequired">
                <ReferenceSelect
                  refs={refs.data}
                  kind="DATA_WIPE"
                  id="dataWipeRequired"
                  value={values.dataWipeRequired ?? ''}
                  onChange={(value) => set('dataWipeRequired', value)}
                  required={false}
                  preserveCurrent={!!baseline}
                />
              </Field>
              <Field
                label="Disposal evidence / reference"
                htmlFor="disposalReference"
                hint="Required with disposal date for terminal status changes."
              >
                <input
                  id="disposalReference"
                  value={values.disposalReference ?? ''}
                  onChange={(event) => set('disposalReference', event.target.value)}
                />
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={amc}
                  onChange={(event) => setAmc(event.target.checked)}
                />
                AMC applies to this asset
              </label>
              {amc ? (
                <Field
                  label="AMC expiry"
                  htmlFor="amcExpiry"
                  hint="Independent of the warranty expiry."
                >
                  <input
                    type="date"
                    id="amcExpiry"
                    value={values.amcExpiry?.slice(0, 10) ?? ''}
                    onChange={(event) => set('amcExpiry', event.target.value)}
                    required
                  />
                </Field>
              ) : null}
            </fieldset>
          </div>
        </Panel>
        <Panel title="Financial metadata">
          <p className="muted">
            {canFinance
              ? 'Leave unknown values blank. Depreciation is not calculated in this release.'
              : 'Finance fills in these values. They are shown read-only.'}
          </p>
          <fieldset disabled={!canFinance} className="form-grid" data-testid="finance-fields">
            <Field label="Depreciation method" htmlFor="depreciationMethod">
              <ReferenceSelect
                refs={refs.data}
                kind="DEPRECIATION_METHOD"
                id="depreciationMethod"
                value={values.depreciationMethod ?? ''}
                onChange={(value) => set('depreciationMethod', value)}
                required={false}
                preserveCurrent={!!baseline}
              />
            </Field>
            {[
              ['purchaseCost', 'Purchase cost (INR)'],
              ['residualValue', 'Residual value (INR)'],
              ['invoiceNumber', 'Invoice number'],
              ['supplier', 'Supplier'],
              ['insurancePolicyNumber', 'Insurance policy number'],
            ].map(([name, label]) => (
              <Field key={name} label={label} htmlFor={name}>
                <input
                  id={name}
                  value={values[name] ?? ''}
                  onChange={(event) => set(name, event.target.value)}
                  inputMode={
                    name === 'purchaseCost' || name === 'residualValue' ? 'decimal' : 'text'
                  }
                  pattern={
                    name === 'purchaseCost' || name === 'residualValue'
                      ? '[0-9]+([.][0-9]{1,2})?'
                      : undefined
                  }
                />
              </Field>
            ))}
          </fieldset>
        </Panel>
        <Panel title="Notes & accountability">
          <fieldset disabled={financeOnly} style={lockedStyle}>
            <Field label="Comment type" htmlFor="commentType">
              <ReferenceSelect
                refs={refs.data}
                kind="COMMENT_TYPE"
                id="commentType"
                value={values.commentType ?? ''}
                onChange={(value) => set('commentType', value)}
                required={false}
                preserveCurrent={!!baseline}
              />
            </Field>
            <Field label="Remarks" htmlFor="remarks">
              <textarea
                id="remarks"
                value={values.remarks ?? ''}
                onChange={(event) => set('remarks', event.target.value)}
                maxLength={5000}
              />
            </Field>
          </fieldset>
          {baseline ? (
            <Field label="Reason for this change" htmlFor="reason">
              <textarea
                id="reason"
                value={values.reason ?? ''}
                onChange={(event) => set('reason', event.target.value)}
                required
                maxLength={5000}
              />
            </Field>
          ) : null}
        </Panel>
        <div className="form-actions">
          <Link className="button secondary" to={baseline ? `/assets/${baseline.id}` : '/assets'}>
            Cancel
          </Link>
          <button
            className="button"
            disabled={action.isPending || refs.isPending || !!refs.error || blocked}
          >
            {action.isPending ? 'Saving...' : baseline ? 'Save changes' : 'Create asset'}
          </button>
        </div>
      </form>
    </>
  );
}
export function AssignmentForm() {
  const refs = useReferences();
  const { id } = useParams();
  const [params] = useSearchParams();
  const transfer = params.get('transfer') === '1';
  const navigate = useNavigate();
  const asset = useQuery({ queryKey: ['asset', id], queryFn: () => api<Asset>(`/assets/${id}`) });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  // Server-side eligible people (active employees and Zoho directory people), searchable.
  const employees = usePages<AssignablePerson>(
    `/assets/${id}/assignable-people`,
    { q: query || undefined },
    !!id,
  );
  const [picked, setPicked] = useState<AssignablePerson>();
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const listed =
    employees.data?.pages
      .flatMap((page) => page.items)
      .filter((person) => person.id !== asset.data?.currentAssignment?.userId) ?? [];
  // Keep the chosen person selectable while the search results change underneath.
  const items = picked && !listed.some((p) => p.id === picked.id) ? [picked, ...listed] : listed;
  const [baseline, setBaseline] = useState<{ id: string; transfer: boolean; version: number }>();
  const selectedEmployee = items.find((employee) => employee.id === userId);
  const custodyAvailable =
    !!asset.data && (transfer ? canTransfer(asset.data) : canAssign(asset.data));
  const ready =
    custodyAvailable &&
    !!selectedEmployee &&
    baseline?.id === id &&
    baseline?.transfer === transfer &&
    !employees.isPending &&
    !employees.error;
  // Capture the version when the user deliberately chooses the recipient; background refetches cannot upgrade it.
  function choose(value: string) {
    const employee = items.find((item) => item.id === value);
    setUserId(employee?.id ?? '');
    setPicked(employee);
    setBaseline(
      employee && asset.data
        ? { id: asset.data.id, transfer, version: asset.data.version }
        : undefined,
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !baseline || action.isPending || (transfer && !note.trim())) return;
    const result = await action
      .mutateAsync({
        path: transfer ? `/assets/${id}/reassign` : `/assets/${id}/assignments`,
        body: transfer
          ? { userId, reason: note.trim() }
          : { userId, ...(note.trim() ? { note: note.trim() } : {}) },
        version: baseline.version,
        idempotent: true,
      })
      .then(() => true)
      .catch(() => false);
    if (result) navigate(`/assets/${id}`);
  }
  return (
    <>
      <Link className="back-link" to={`/assets/${id}`}>
        ← Asset details
      </Link>
      <PageTitle
        title={transfer ? 'Transfer custody' : 'Assign an asset'}
        description="Record a clear handover. The employee receives a notification and verifies the asset separately."
      />
      <ErrorNotice error={asset.error} />
      <ErrorNotice
        error={employees.error}
        retry={() => {
          void employees.refetch();
        }}
      />
      <ErrorNotice error={action.error} retry={() => window.location.reload()} />
      {asset.isPending ? (
        <Loading />
      ) : asset.data ? (
        <div className="narrow">
          <Panel title={`${asset.data.assetCode} · ${asset.data.description}`}>
            <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.data.status} />
            {!custodyAvailable ? (
              <div className="notice warning">
                {transfer
                  ? 'This asset has no transferable current custody. Review its details before continuing.'
                  : 'This asset must be In Store without current custody before it can be assigned.'}{' '}
                <Link to="/assignments/new">Choose another asset</Link>.
              </div>
            ) : null}
            <FormTransfer
              formId={transfer ? 'asset-transfer' : 'asset-assignment'}
              fields={[
                {
                  key: 'userId',
                  label: 'Approved employee ID',
                  required: true,
                  options: items.map((item) => item.id),
                },
                {
                  key: 'note',
                  label: transfer ? 'Transfer reason' : 'Handover note',
                  required: transfer,
                },
              ]}
              values={{ userId, note }}
              disabled={
                action.isPending || employees.isPending || !!employees.error || !custodyAvailable
              }
              description="Choose from loaded eligible employees. Load more employees below if the intended recipient is not listed. Review before confirming custody."
              onImport={(data) => {
                if (
                  typeof data.userId === 'string' &&
                  items.some((item) => item.id === data.userId)
                )
                  choose(data.userId);
                if (typeof data.note === 'string') setNote(data.note);
                action.reset();
              }}
            />
            <form className="form-stack subsection" onSubmit={submit}>
              <Field label="Search people" htmlFor="assignment-search">
                <input
                  id="assignment-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, email or employee code"
                  maxLength={100}
                  autoComplete="off"
                />
              </Field>
              <Select
                label="Approved employee"
                htmlFor="assignment-user"
                value={selectedEmployee ? userId : ''}
                onChange={choose}
                disabled={
                  action.isPending || employees.isPending || !!employees.error || !custodyAvailable
                }
                ariaDescribedBy="assignment-eligibility"
                required
                options={[
                  { value: '', label: 'Choose an employee' },
                  ...items.map((user) => ({
                    value: user.id,
                    label: `${user.displayName}${user.employeeCode ? ` (${user.employeeCode})` : ''} · ${user.email}${user.state === 'DIRECTORY' ? ' · No login' : ''}`,
                  })),
                ]}
              />
              {selectedEmployee?.state === 'DIRECTORY' ? (
                <p className="muted">
                  <Badge value="DIRECTORY" label="No login" /> This person has no portal login, so no
                  assignment email is sent. Record the handover in person.
                </p>
              ) : null}
              <p id="assignment-eligibility" className="muted">
                Recipients are active employees with portal access, or people synced from the staff
                directory who have not left. Search above, or load more if the intended recipient is
                not listed.
              </p>
              <LoadMore
                available={employees.hasNextPage}
                loading={employees.isFetchingNextPage}
                onClick={() => {
                  void employees.fetchNextPage();
                }}
              />
              {!employees.isPending && !items.length ? (
                <p className="muted">
                  No eligible employees are loaded. Complete invitation acceptance, email
                  verification and portal access, then refresh this page. Current custodians cannot
                  be selected for a transfer to themselves.
                </p>
              ) : null}
              <Field
                label={transfer ? 'Reason for transfer' : 'Handover note'}
                htmlFor="assignment-note"
              >
                <textarea
                  id="assignment-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required={transfer}
                  maxLength={5000}
                />
              </Field>
              <div className="notice">
                Effective immediately.{' '}
                {transfer
                  ? 'Previous custody is closed and the new employee must confirm receipt.'
                  : 'A new pending verification is created.'}
              </div>
              <div className="actions">
                <button
                  className="button"
                  disabled={action.isPending || !ready || (transfer && !note.trim())}
                >
                  {action.isPending
                    ? 'Saving...'
                    : transfer
                      ? 'Confirm transfer'
                      : 'Confirm assignment'}
                </button>
                <Link className="button secondary" to={`/assets/${id}`}>
                  Cancel
                </Link>
              </div>
            </form>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
