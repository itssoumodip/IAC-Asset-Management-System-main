import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { Asset } from '../types';
import { formatInr } from '../admin-insights';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Panel,
  Select,
  Timeline,
  displayDate,
  backLinkClass,
  buttonClass,
  noticeClass,
  actionsClass,
  PersonChip,
} from './ui';
import {
  useReferences,
  ReferenceBadge,
  referenceLabel,
  locationLabel,
  referenceOptions,
} from './References';
import { FormTransfer } from './DataTransfer';
import { FinanceStatusPanel } from './FinanceReview';
import { AssetPhoto } from './AssetPhoto';

export function AssetDetailZoho() {
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
  const [activeTab, setActiveTab] = useState('summary');

  const tabs: Array<{ key: string; label: string }> = [
    { key: 'summary', label: 'Summary' },
    { key: 'product', label: 'Product details' },
    { key: 'workorders', label: 'Work orders' },
    { key: 'maintenance', label: 'Maintenance' },
    { key: 'users', label: 'Asset users' },
    { key: 'history', label: 'History' },
  ];

  if (query.isPending) return <Loading label="Loading asset details…" />;
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
  const terminalAssetStatuses = new Set(['Retired', 'Disposed', 'Sold']);
  const canAssign = (a: Asset) => a.status === 'In Store' && !a.currentAssignment;
  const canTransfer = (a: Asset) => !!a.currentAssignment && !terminalAssetStatuses.has(a.status);
  const mayCustody =
    can(user, 'asset.custody', assetTeam) &&
    !asset.kitParent &&
    (canTransfer(asset) || canAssign(asset));
  const assignment = asset.currentAssignment;
  const own = assignment?.userId === user?.id;
  const department = refs.data?.departments.find((value) => value.id === asset.departmentId)?.name;
  const loc = refs.data?.locations.find((value) => value.id === asset.locationId);
  const locationPath = loc
    ? [loc.site, loc.building, loc.floor, loc.room].filter(Boolean).join(' › ')
    : null;

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
      <Link to="/assets" className={backLinkClass}>
        ← Asset catalog
      </Link>
      <header className="zoho-header">
        <div className="zoho-header-main">
          <div className="zoho-header-id">{asset.assetCode}</div>
          <h1 className="zoho-header-name">{asset.description}</h1>
          <p className="zoho-header-sub">
            {referenceLabel(refs.data, 'CATEGORY', asset.category)} ·
            {referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType)}
          </p>
          <div className="zoho-header-badges">
            <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
            {asset.condition ? (
              <Badge
                value={asset.condition}
                label={referenceLabel(refs.data, 'CONDITION', asset.condition)}
              />
            ) : null}
          </div>
        </div>
        <div className="zoho-header-actions">
          {manage && mayEdit ? (
            <Link className={buttonClass('secondary')} to={`/assets/${id}/edit`}>
              Edit
            </Link>
          ) : null}
          {manage && mayLabel ? (
            <Link className={buttonClass('secondary')} to={`/assets/labels?ids=${asset.id}`}>
              Print label
            </Link>
          ) : null}
          {!mayCustody ? null : canTransfer(asset) ? (
            <Link className={buttonClass()} to={`/assets/${id}/assign?transfer=1`}>
              Transfer custody
            </Link>
          ) : canAssign(asset) ? (
            <Link className={buttonClass()} to={`/assets/${id}/assign`}>
              Assign asset
            </Link>
          ) : null}
          {own ? (
            <Link className={buttonClass('secondary')} to={`/tickets/new?assetId=${asset.id}`}>
              Raise a ticket
            </Link>
          ) : null}
        </div>
      </header>
      <ErrorNotice
        error={action.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {!manage ? (
        <div className={noticeClass()}>
          Asset details are read-only. Contact Admin or raise a support ticket to request a
          correction.
        </div>
      ) : null}
      <nav className="zoho-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`zoho-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="zoho-content">
        <main className="zoho-main">
          {activeTab === 'summary' && (
            <>
              <AssetPhoto asset={asset} manage={manage} />
              <Panel title="Work orders">
                {false ? null : (
                  <p className="text-sm text-gray-500">
                    Repairs and service requests for this asset are tracked in{' '}
                    <Link
                      to="/tickets"
                      className="font-medium text-navy-700 no-underline hover:underline"
                    >
                      Support
                    </Link>
                    .
                  </p>
                )}
              </Panel>
              <Panel title="Depreciation">
                <dl className="details">
                  <dt>Purchase cost</dt>
                  <dd>
                    {asset.purchaseCost == null ? 'Pending' : formatInr(Number(asset.purchaseCost))}
                  </dd>
                  <dt>Current value</dt>
                  <dd>
                    {asset.residualValue == null
                      ? 'Pending Finance input'
                      : formatInr(Number(asset.residualValue))}
                  </dd>
                </dl>
              </Panel>
              <FinanceStatusPanel asset={asset} />
            </>
          )}
          {activeTab === 'product' && (
            <Panel title="Product details">
              <dl className="details">
                <dt>Asset ID</dt>
                <dd className="mono">{asset.assetCode}</dd>
                <dt>Category</dt>
                <dd>{referenceLabel(refs.data, 'CATEGORY', asset.category)}</dd>
                <dt>Asset type</dt>
                <dd>{referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType)}</dd>
                <dt>Manufacturer</dt>
                <dd>{asset.manufacturer || 'Unknown'}</dd>
                <dt>Model</dt>
                <dd>{asset.model || 'Unknown'}</dd>
                <dt>Serial number</dt>
                <dd>{asset.serialNumber || 'Unknown'}</dd>
                <dt>Barcode / QR</dt>
                <dd>{asset.barcode || 'Unknown'}</dd>
                <dt>Ownership</dt>
                <dd>{referenceLabel(refs.data, 'OWNERSHIP', asset.ownershipType)}</dd>
                <dt>Department</dt>
                <dd>{department || 'Unknown'}</dd>
                <dt>Location</dt>
                <dd>{locationPath || 'Unknown'}</dd>
                <dt>Status</dt>
                <dd>
                  <ReferenceBadge refs={refs.data} kind="STATUS" value={asset.status} />
                </dd>
                <dt>Condition</dt>
                <dd>{referenceLabel(refs.data, 'CONDITION', asset.condition)}</dd>
                <dt>Risk level</dt>
                <dd>{referenceLabel(refs.data, 'RISK', asset.riskLevel)}</dd>
                <dt>Warranty expiry</dt>
                <dd>{displayDate(asset.warrantyExpiry)}</dd>
                <dt>AMC expiry</dt>
                <dd>
                  {asset.amcApplies
                    ? displayDate(asset.amcExpiry)
                    : asset.amcApplies === false
                      ? 'Not applicable'
                      : 'Unknown'}
                </dd>
                {asset.configuration ? (
                  <>
                    <dt>Configuration</dt>
                    <dd className="preserve">{asset.configuration}</dd>
                  </>
                ) : null}
                {asset.remarks ? (
                  <>
                    <dt>Remarks</dt>
                    <dd className="preserve">{asset.remarks}</dd>
                  </>
                ) : null}
              </dl>
            </Panel>
          )}
          {activeTab === 'workorders' && (
            <Panel title="Work orders">
              <p className="muted">Work order history will appear here.</p>
            </Panel>
          )}
          {activeTab === 'maintenance' && (
            <Panel title="Maintenance">
              <p className="muted">Maintenance schedule and history will appear here.</p>
            </Panel>
          )}
          {activeTab === 'users' && (
            <Panel title="Asset users">
              {assignment && asset.currentAssignment ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <PersonChip
                    userId={asset.currentAssignment.userId ?? ''}
                    name={asset.currentAssignment.employeeName || 'Employee'}
                    hasPhoto={asset.currentAssignment.employeeHasPhoto}
                    detail={asset.currentAssignment.employeeDesignation}
                    designation={asset.currentAssignment.employeeDesignation}
                    department={asset.currentAssignment.employeeDepartment}
                    email={asset.currentAssignment.employeeEmail}
                    size={36}
                  />
                  <span className="text-sm text-gray-500">
                    Since {displayDate(asset.currentAssignment.assignedAt)}
                  </span>
                </div>
              ) : (
                <p className="muted">No current user.</p>
              )}
            </Panel>
          )}
          {activeTab === 'history' && (
            <Panel title="History">
              <Timeline items={asset.timeline ?? []} />
            </Panel>
          )}
        </main>
        <aside className="zoho-sidebar">
          <Panel title="Key facts">
            <div className="sidebar-facts">
              <div className="sidebar-fact">
                <span className="muted small-text">Serial number</span>
                <div>{asset.serialNumber || 'Not set'}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Product</span>
                <div>{asset.manufacturer || 'Not set'}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Model</span>
                <div>{asset.model || 'Not set'}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Category</span>
                <div>{referenceLabel(refs.data, 'CATEGORY', asset.category)}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Subcategory</span>
                <div>{referenceLabel(refs.data, 'ASSET_TYPE', asset.assetType)}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Location path</span>
                <div>{locationPath || 'Not set'}</div>
              </div>
              <div className="sidebar-fact">
                <span className="muted small-text">Tags</span>
                <div>QR / NFC / RFID</div>
              </div>
            </div>
            <div className="sidebar-user">
              {assignment ? (
                <>
                  <PersonChip
                    userId={asset.currentAssignment?.userId ?? ''}
                    name={asset.currentAssignment?.employeeName || 'Employee'}
                    hasPhoto={asset.currentAssignment?.employeeHasPhoto}
                    detail={asset.currentAssignment?.employeeDesignation || 'Current user'}
                    designation={asset.currentAssignment?.employeeDesignation}
                    department={asset.currentAssignment?.employeeDepartment}
                    email={asset.currentAssignment?.employeeEmail}
                    size={36}
                  />
                  <p className="muted small-text">
                    {asset.currentAssignment?.acknowledgement === 'ACCEPTED'
                      ? 'Assignment confirmed'
                      : asset.currentAssignment?.acknowledgement === 'DISPUTED'
                        ? 'Assignment needs review'
                        : 'Assignment awaiting confirmation'}
                  </p>
                </>
              ) : (
                <>
                  <div className="sidebar-user-name">In store</div>
                  <div className="sidebar-user-role">No current user</div>
                  <p className="muted small-text">Available for assignment</p>
                </>
              )}
            </div>
          </Panel>
          {asset.kitParent ? (
            <Panel title="Kit">
              <p>
                Part of kit{' '}
                <Link to={`/assets/${asset.kitParent.id}`}>{asset.kitParent.assetCode}</Link>.
                Custody changes are made on the kit; detach this item first to move it on its own.
              </p>
            </Panel>
          ) : null}
          {can(user, 'asset.custody', assetTeam) && !asset.kitParent ? (
            <KitPanelZoho asset={asset} />
          ) : null}
        </aside>
      </div>
      {own && assignment?.acknowledgement === 'PENDING' ? (
        <div className={noticeClass('warning')}>
          <strong>This asset needs your confirmation</strong>
          <p>
            Check the serial number, description, and condition against the item received. A
            discrepancy records your feedback without changing custody.
          </p>
          <div className={actionsClass}>
            <button
              type="button"
              className={buttonClass()}
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
              className={buttonClass('secondary')}
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
                className={buttonClass()}
                disabled={action.isPending || (decision === 'DISPUTED' && !reason.trim())}
              >
                {action.isPending
                  ? 'Saving...'
                  : decision === 'DISPUTED'
                    ? 'Submit discrepancy'
                    : 'Confirm acceptance'}
              </button>
              <button
                type="button"
                className={buttonClass('ghost')}
                onClick={() => setDecision('')}
              >
                Cancel
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {returning && assignment ? (
        <form className="form-stack subsection" onSubmit={returnAsset}>
          <FormTransfer
            formId="asset-return"
            fields={[
              {
                key: 'condition',
                required: true,
                options: referenceOptions(refs.data, 'CONDITION').map(
                  (item: { code: string }) => item.code,
                ),
              },
              {
                key: 'locationId',
                required: true,
                options:
                  refs.data?.locations.filter((item) => item.active).map((item) => item.id) ?? [],
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
            <Select
              label=""
              htmlFor="return-condition"
              value={condition}
              onChange={setCondition}
              options={referenceOptions(refs.data, 'CONDITION').map((item: { code: string }) => ({
                value: item.code,
                label: item.code,
              }))}
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
              required
              maxLength={5000}
            />
          </Field>
          <button className={buttonClass()} disabled={action.isPending || !reason.trim()}>
            Confirm return
          </button>
        </form>
      ) : null}
    </>
  );
}

function KitPanelZoho({ asset }: { asset: Asset }) {
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [detachReason, setDetachReason] = useState('');
  const parts = asset.kitParts ?? [];
  const action = useAction();
  async function attach(event: React.FormEvent) {
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
                className={buttonClass('secondary')}
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
        <button
          className={buttonClass()}
          disabled={action.isPending || !code.trim() || !reason.trim()}
        >
          Attach part
        </button>
      </form>
    </Panel>
  );
}
