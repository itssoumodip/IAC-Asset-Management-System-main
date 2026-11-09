import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { Asset } from '../types';
import { useReferences } from './References';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  displayDate,
  actionsClass,
  buttonClass,
  tableWrapClass,
  tableClass,
} from './ui';
import './transfers.css';

interface Transfer {
  id: string;
  assetId: string;
  assetCode: string;
  assetDescription: string;
  fromTeamId: string;
  toTeamId: string;
  fromTeamCode: string;
  toTeamCode: string;
  state: 'REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'FORCED';
  reason: string;
  decisionNote: string | null;
  requestedBy: string;
  requestedByName: string;
  decidedByName: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

const terminalAssetStatuses = new Set(['Retired', 'Disposed', 'Sold', 'Lost', 'Stolen']);

function StateBadge({ state }: { state: Transfer['state'] }) {
  return <span className={`transfer-state ${state.toLowerCase()}`}>{state.toLowerCase()}</span>;
}

/** Asset detail panel: request (or, for Super Admin, force) a move to another team. */
export function AssetTransferPanel({ asset }: { asset: Asset }) {
  const { user } = useSession();
  const refs = useReferences();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [toTeamId, setToTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const team = asset.owningTeamId ?? undefined;
  if (!team || !can(user, 'asset.edit', team) || terminalAssetStatuses.has(asset.status))
    return null;
  const teams = (refs.data?.teams ?? []).filter((t) => t.active && t.id !== team);
  const mayForce = can(user, 'asset.change_team');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!toTeamId || !reason.trim() || action.isPending) return;
    await action
      .mutateAsync({
        path: `/assets/${asset.id}/transfers${force ? '/force' : ''}`,
        method: 'POST',
        body: { toTeamId, reason: reason.trim() },
      })
      .then(() => {
        setOpen(false);
        setToTeamId('');
        setReason('');
        setForce(false);
      })
      .catch(() => undefined);
  }
  return (
    <Panel title="Team ownership">
      <ErrorNotice error={action.error} />
      {!open ? (
        <div className={actionsClass}>
          <button type="button" className={buttonClass('secondary')} onClick={() => setOpen(true)}>
            Transfer to another team
          </button>
          <Link to="/transfers">View transfers</Link>
        </div>
      ) : (
        <form className="transfer-form" onSubmit={submit}>
          <Select
            label="Receiving team"
            htmlFor="transfer-team"
            value={toTeamId}
            onChange={setToTeamId}
            options={[
              { value: '', label: 'Choose a team' },
              ...teams.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` })),
            ]}
            required
          />
          <Field label="Reason" htmlFor="transfer-reason">
            <input
              id="transfer-reason"
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </Field>
          {mayForce ? (
            <label className="checkbox">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>Force immediately (no acceptance needed)</span>
            </label>
          ) : null}
          <div className="form-actions">
            <button
              type="submit"
              className={buttonClass()}
              disabled={!toTeamId || !reason.trim() || action.isPending}
            >
              {force ? 'Transfer now' : 'Send request'}
            </button>
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

/** /transfers: incoming and outgoing team transfer requests. */
export function TeamTransfers() {
  const { user } = useSession();
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const action = useAction();
  const list = useQuery({
    queryKey: ['team-transfers', tab],
    queryFn: ({ signal }) => api<{ items: Transfer[] }>(`/transfers?direction=${tab}`, { signal }),
  });
  const teamIds = new Set((user?.teams ?? []).map((t) => t.teamId));
  const superAdmin = user?.roles.includes('SUPER_ADMIN') ?? false;
  const items = list.data?.items ?? [];

  async function decide(t: Transfer, verb: 'accept' | 'decline' | 'cancel') {
    const note = (notes[t.id] ?? '').trim();
    if (verb === 'decline' && !note) return;
    await action
      .mutateAsync({
        path: `/transfers/${t.id}/${verb}`,
        method: 'POST',
        body: note ? { note } : {},
      })
      .then(() => {
        setNotes((n) => ({ ...n, [t.id]: '' }));
        void list.refetch();
      })
      .catch(() => undefined);
  }

  return (
    <>
      <PageTitle
        eyebrow="ASSETS"
        title="Team transfers"
        description="Requests to move assets between teams. The receiving team accepts or declines."
      />
      <ErrorNotice error={action.error ?? list.error} />
      <div className="transfer-tabs" role="tablist">
        {(['incoming', 'outgoing'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {key === 'incoming' ? 'Incoming' : 'Outgoing'}
          </button>
        ))}
      </div>
      <Panel>
        {list.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>From → To</th>
                  <th>Reason</th>
                  <th>State</th>
                  <th>Requested</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => {
                  const open = t.state === 'REQUESTED';
                  const mayAnswer = open && (superAdmin || teamIds.has(t.toTeamId));
                  const mayCancel =
                    open && (superAdmin || teamIds.has(t.fromTeamId) || t.requestedBy === user?.id);
                  return (
                    <tr key={t.id}>
                      <td data-label="Asset">
                        <Link to={`/assets/${t.assetId}`}>{t.assetCode}</Link>
                        <div className="muted">{t.assetDescription}</div>
                      </td>
                      <td data-label="From → To">
                        {t.fromTeamCode} → {t.toTeamCode}
                      </td>
                      <td data-label="Reason">
                        {t.reason}
                        {t.decisionNote ? (
                          <div className="muted">Note: {t.decisionNote}</div>
                        ) : null}
                      </td>
                      <td data-label="State">
                        <StateBadge state={t.state} />
                      </td>
                      <td data-label="Requested">
                        {displayDate(t.requestedAt)}
                        <div className="muted">{t.requestedByName}</div>
                      </td>
                      <td data-label="Actions">
                        {open ? (
                          <div className="transfer-decision">
                            {mayAnswer ? (
                              <input
                                aria-label="Decision note"
                                placeholder="Note (required to decline)"
                                value={notes[t.id] ?? ''}
                                maxLength={1000}
                                onChange={(e) =>
                                  setNotes((n) => ({ ...n, [t.id]: e.target.value }))
                                }
                              />
                            ) : null}
                            {mayAnswer ? (
                              <>
                                <button
                                  type="button"
                                  className={buttonClass()}
                                  disabled={action.isPending}
                                  onClick={() => void decide(t, 'accept')}
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className={buttonClass('secondary')}
                                  disabled={action.isPending || !(notes[t.id] ?? '').trim()}
                                  onClick={() => void decide(t, 'decline')}
                                >
                                  Decline
                                </button>
                              </>
                            ) : null}
                            {mayCancel && !mayAnswer ? (
                              <button
                                type="button"
                                className={buttonClass('secondary')}
                                disabled={action.isPending}
                                onClick={() => void decide(t, 'cancel')}
                              >
                                Cancel
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <span className="muted">
                            {t.decidedAt ? displayDate(t.decidedAt) : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={`No ${tab} transfers`} />
        )}
      </Panel>
    </>
  );
}
