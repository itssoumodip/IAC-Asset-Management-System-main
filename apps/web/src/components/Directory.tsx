import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { Avatar, Badge, Empty, ErrorNotice, Loading, PageTitle, Panel, displayDate } from './ui';

interface Run {
  id: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  created: number;
  updated: number;
  left: number;
  skipped: number;
  error: string | null;
}
interface RecoverItem {
  userId: string;
  displayName: string;
  email: string;
  employeeCode: string | null;
  state: string;
  leftAt: string;
  assetId: string;
  assetCode: string;
  description: string | null;
  hasPhoto: boolean;
}
interface Person {
  id: string;
  email: string;
  displayName: string;
  employeeCode: string | null;
  zohoRecordId: string | null;
  state: string;
  designation: string | null;
  hasPhoto: boolean;
  assetsHeld: number;
}
interface Unmatched {
  zohoWithoutAccount: Person[];
  accountsWithoutZoho: Person[];
  blockedByUnlink?: (Person & { zohoUnlinkedRecordId: string })[];
}

function PersonList({
  people,
  selectedId,
  onSelect,
}: {
  people: Person[];
  selectedId?: string;
  onSelect: (person: Person) => void;
}) {
  if (!people.length) return <Empty title="Nothing to match" />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Person</th>
            <th>Code</th>
            <th>
              <span className="sr-only">Select</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id} aria-selected={p.id === selectedId}>
              <td>
                <div className="person-row">
                  <Avatar userId={p.id} name={p.displayName} hasPhoto={p.hasPhoto} />
                  <div>
                    <strong>{p.displayName}</strong>
                    <span className="cell-description">{p.email}</span>
                  </div>
                </div>
              </td>
              <td>{p.employeeCode ?? ''}</td>
              <td>
                <button
                  type="button"
                  className={`button small ${p.id === selectedId ? '' : 'secondary'}`}
                  onClick={() => onSelect(p)}
                  aria-label={`Select ${p.displayName} to link`}
                >
                  {p.id === selectedId ? 'Selected' : 'Select'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Directory() {
  const status = useQuery({
    queryKey: ['directory-status'],
    queryFn: ({ signal }) => api<{ configured: boolean; runs: Run[] }>('/directory/sync', { signal }),
  });
  const recover = useQuery({
    queryKey: ['directory-recover'],
    queryFn: ({ signal }) => api<{ items: RecoverItem[] }>('/directory/recover', { signal }),
  });
  const unmatched = useQuery({
    queryKey: ['directory-unmatched'],
    queryFn: ({ signal }) => api<Unmatched>('/directory/unmatched', { signal }),
  });
  const action = useAction();
  const [zohoPick, setZohoPick] = useState<Person>();
  const [accountPick, setAccountPick] = useState<Person>();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const refreshAll = () => {
    void status.refetch();
    void recover.refetch();
    void unmatched.refetch();
  };
  const syncNow = async () => {
    setMessage('');
    try {
      await action.mutateAsync({ path: '/directory/sync' });
      setMessage('Sync finished.');
    } catch {
      /* shown by ErrorNotice */
    }
    refreshAll();
  };
  const link = async () => {
    if (!zohoPick?.zohoRecordId || !accountPick) return;
    setMessage('');
    try {
      await action.mutateAsync({
        path: '/directory/link',
        body: { userId: accountPick.id, zohoRecordId: zohoPick.zohoRecordId, reason: reason.trim() },
      });
      setMessage(`Linked ${accountPick.displayName} to their Zoho record.`);
      setZohoPick(undefined);
      setAccountPick(undefined);
      setReason('');
    } catch {
      /* shown by ErrorNotice */
    }
    refreshAll();
  };

  if (status.isPending) return <Loading />;
  if (status.error) return <ErrorNotice error={status.error} retry={() => void status.refetch()} />;
  const configured = status.data.configured;
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION"
        title="Directory & Zoho"
        description="People from Zoho People are kept as directory entries so assets can be assigned to them. They cannot sign in unless invited."
      />
      <ErrorNotice error={action.error} />
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      <Panel title="Sync status">
        {configured ? (
          <p>Zoho People is connected. A sync runs every night at 02:00 India time.</p>
        ) : (
          <p>
            Zoho People sync is not configured. Add ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and
            ZOHO_REFRESH_TOKEN to the server settings (see the README).
          </p>
        )}
        <button
          type="button"
          className="button"
          disabled={!configured || action.isPending}
          onClick={() => void syncNow()}
        >
          {action.isPending ? 'Syncing...' : 'Sync now'}
        </button>
      </Panel>
      <Panel title="Recent runs">
        {status.data.runs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>How</th>
                  <th>Result</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th>Left</th>
                  <th>Skipped</th>
                </tr>
              </thead>
              <tbody>
                {status.data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{displayDate(run.startedAt, true)}</td>
                    <td>{run.trigger === 'MANUAL' ? 'Sync now' : 'Nightly'}</td>
                    <td>
                      <Badge value={run.status === 'SUCCEEDED' ? 'COMPLETED' : run.status} />
                      {run.error ? <span className="cell-description">{run.error}</span> : null}
                    </td>
                    <td>{run.created}</td>
                    <td>{run.updated}</td>
                    <td>{run.left}</td>
                    <td>{run.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No syncs yet" />
        )}
      </Panel>
      <Panel title="To recover">
        <p className="muted">
          People Zoho reports as left who still hold assets. Nothing is returned automatically;
          return or transfer each asset from its page.
        </p>
        {recover.isPending ? (
          <Loading />
        ) : recover.data?.items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Left</th>
                  <th>Asset</th>
                  <th>Portal account</th>
                </tr>
              </thead>
              <tbody>
                {recover.data.items.map((item) => (
                  <tr key={`${item.userId}-${item.assetId}`}>
                    <td>
                      <div className="person-row">
                        <Avatar userId={item.userId} name={item.displayName} hasPhoto={item.hasPhoto} />
                        <div>
                          <strong>{item.displayName}</strong>
                          <span className="cell-description">{item.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>{displayDate(item.leftAt)}</td>
                    <td>
                      <a href={`/assets/${item.assetId}`}>{item.assetCode}</a>
                      <span className="cell-description">{item.description}</span>
                    </td>
                    <td>{item.state === 'DIRECTORY' ? 'No login' : 'Has portal account'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No assets to recover" />
        )}
      </Panel>
      <Panel title="Match Zoho people to accounts">
        <p className="muted">
          Pick a Zoho person and the portal account that is the same human, then link them. The
          Zoho-only entry is removed; it must not hold open assets or team memberships. Past asset history moves to the account.
        </p>
        {unmatched.isPending ? (
          <Loading />
        ) : unmatched.error ? (
          <ErrorNotice error={unmatched.error} retry={() => void unmatched.refetch()} />
        ) : (
          <>
            <h3>Zoho people without an account</h3>
            <PersonList
              people={unmatched.data.zohoWithoutAccount}
              selectedId={zohoPick?.id}
              onSelect={setZohoPick}
            />
            <h3>Portal accounts without Zoho</h3>
            <PersonList
              people={unmatched.data.accountsWithoutZoho}
              selectedId={accountPick?.id}
              onSelect={setAccountPick}
            />
            {unmatched.data.blockedByUnlink?.length ? (
              <>
                <h3>Unlinked from Zoho (blocked from re-matching)</h3>
                <ul>
                  {unmatched.data.blockedByUnlink.map((person) => (
                    <li key={person.id}>
                      {person.displayName} ({person.email}) - Zoho record {person.zohoUnlinkedRecordId}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="form-row">
              <label htmlFor="link-reason">Reason</label>
              <input
                id="link-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why these are the same person"
              />
              <button
                type="button"
                className="button"
                disabled={!zohoPick || !accountPick || !reason.trim() || action.isPending}
                onClick={() => void link()}
              >
                Link {zohoPick?.displayName ?? 'Zoho person'} to {accountPick?.displayName ?? 'account'}
              </button>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
