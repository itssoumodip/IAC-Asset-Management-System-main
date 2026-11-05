import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import type { Asset } from '../types';
import type { AssignablePerson } from '../types';
import {
  Badge,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
} from './ui';
import { useReferences, ReferenceBadge } from './References';
import { FormTransfer } from './DataTransfer';

export function AssetAssignTransfer() {
  const refs = useReferences();
  const { id } = useParams();
  const [params] = useSearchParams();
  const { user } = useSession();
  const transfer = params.get('transfer') === '1';
  const navigate = useNavigate();
  const asset = useQuery({
    queryKey: ['asset', id],
    queryFn: ({ signal }) => api<Asset>(`/assets/${id}`, { signal }),
  });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const employees = useQuery({
    queryKey: ['assignable-people', id, query],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(
        `/assets/${id}/assignable-people?q=${encodeURIComponent(query)}&limit=25`,
        { signal },
      ),
    enabled: !!id,
  });
  const [picked, setPicked] = useState<AssignablePerson>();
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const listed =
    employees.data?.items.filter((person) => person.id !== asset.data?.currentAssignment?.userId) ??
    [];
  const items = picked && !listed.some((p) => p.id === picked.id) ? [picked, ...listed] : listed;
  const [baseline, setBaseline] = useState<{ id: string; transfer: boolean; version: number }>();
  const selectedEmployee = items.find((employee) => employee.id === userId);
  const data = asset.data;
  const custodyAvailable =
    !!data && (transfer ? canTransfer(data) : canAssign(data));
  const isLead = Boolean(user?.teams?.some((t) => t.level === 'LEAD'));
  const ready =
    custodyAvailable &&
    !!selectedEmployee &&
    baseline?.id === id &&
    baseline?.transfer === transfer &&
    !asset.isPending;
  function choose(value: string) {
    const employee = items.find((item) => item.id === value);
    setUserId(employee?.id ?? '');
    setPicked(employee);
    setBaseline(
      employee && data ? { id: data.id, transfer, version: data.version } : undefined,
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !baseline || action.isPending || (transfer && !note.trim())) return;
    const body: Record<string, unknown> = transfer
      ? { userId, reason: note.trim() }
      : { userId, ...(note.trim() ? { note: note.trim() } : {}) };

    // Non-Lead transfers require Team Lead approval (P13 → P15).
    if (transfer && !isLead) {
      body.approvalRequired = true;
      body.approverRole = 'TEAM_LEAD';
    }

    const result = await action
      .mutateAsync({
        path: transfer ? `/assets/${id}/reassign` : `/assets/${id}/assignments`,
        body,
        version: baseline.version,
        idempotent: true,
      })
      .then(() => true)
      .catch(() => false);
    if (result) {
      if (transfer && !isLead) {
        navigate(`/approvals?tab=transfers`);
      } else {
        navigate(`/assets/${id}`);
      }
    }
  }

  return (
    <>
      <Link className="back-link" to={`/assets/${id}`}>
        ← Asset details
      </Link>
      <PageTitle
        title={transfer ? 'Transfer custody' : 'Assign an asset'}
        description={
          transfer
            ? 'Record a custody transfer. Team Lead approval is required before the receiver confirms.'
            : 'Record a clear handover. The employee receives a notification and verifies the asset separately.'
        }
      />
      <ErrorNotice error={asset.error} />
      <ErrorNotice error={action.error} retry={() => window.location.reload()} />
      {asset.isPending ? (
        <Loading />
      ) : data ? (
        <div className="narrow">
          <Panel title={`${data.assetCode} · ${data.description}`}>
            <ReferenceBadge refs={refs.data} kind="STATUS" value={data.status} />
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
                action.isPending || !custodyAvailable
              }
              description="Choose from loaded eligible employees. Review before confirming custody."
              onImport={(record) => {
                if (
                  typeof record.userId === 'string' &&
                  items.some((item) => item.id === record.userId)
                )
                  choose(record.userId);
                if (typeof record.note === 'string') setNote(record.note);
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
                disabled={action.isPending || !custodyAvailable}
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
                directory who have not left. Search above.
              </p>
              {!items.length ? (
                <p className="muted">
                  No eligible employees are loaded. Complete invitation acceptance, email verification
                  and portal access, then refresh this page. Current custodians cannot be selected
                  for a transfer to themselves.
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
              {transfer && !isLead ? (
                <div className="notice warning">
                  <strong>Team Lead approval required.</strong> Your transfer request will appear in
                  <strong>Approvals</strong> for a Team Lead to approve before the receiver confirms.
                </div>
              ) : null}
              <div className="notice">
                Effective immediately.{' '}
                {transfer
                  ? isLead
                    ? 'Approved by Team Lead. Previous custody is closed and the new employee must confirm receipt.'
                    : 'Pending Team Lead approval. Previous custody is closed once approved and the new employee must confirm receipt.'
                  : 'A new pending verification is created.'}
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={action.isPending || !ready || (transfer && !note.trim())}
                  onClick={() => navigate(`/assets/${id}`)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button"
                  disabled={
                    action.isPending ||
                    !ready ||
                    (transfer && !note.trim())
                  }
                >
                  {action.isPending
                    ? 'Saving…'
                    : transfer && !isLead
                    ? 'Request transfer approval'
                    : transfer
                    ? 'Approve & transfer'
                    : 'Confirm assignment'}
                </button>
              </div>
            </form>
          </Panel>
        </div>
      ) : null}
    </>
  );
}

function canAssign(asset: Asset) {
  return asset.status === 'In Store' && !asset.currentAssignment;
}
function canTransfer(asset: Asset) {
  const terminal = new Set(['Retired', 'Disposed', 'Sold']);
  return !!asset.currentAssignment && !terminal.has(asset.status);
}
