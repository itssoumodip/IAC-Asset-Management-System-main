import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useSession } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
} from './ui';

type ApprovalTab = 'requests' | 'transfers' | 'change-requests' | 'verification';

type ApprovalItem = {
  id: string;
  requester: string;
  requesterRole: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  action: string;
  before: string;
  after: string;
  when: string;
  reason?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
};

const TAB_LABELS: Record<ApprovalTab, string> = {
  requests: 'Requests',
  transfers: 'Transfers',
  'change-requests': 'Change requests',
  verification: 'Verification escalations',
};

export function Approvals() {
  useSession();  const [tab, setTab] = useState<ApprovalTab>('requests');
  const [reason, setReason] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const action = useAction<{ approved: number }>();

  const query = useQuery({
    queryKey: ['approvals', tab],
    queryFn: ({ signal }) =>
      api<{ items: ApprovalItem[] }>(`/approvals?tab=${tab}`, { signal }),
  });

  const items = query.data?.items ?? [];
  const pending = items.filter((item) => item.status === 'PENDING');

  if (query.isPending) return <Loading label="Loading approvals…" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  async function approve(item: ApprovalItem) {
    if (!item.id || action.isPending) return;
    setPendingId(item.id);
    try {
      await action.mutateAsync({
        path: `/approvals/${item.id}`,
        method: 'PATCH',
        body: { decision: 'APPROVED', reason: reason.trim() },
      });
      setReason('');
      setPendingId(null);
    } catch {
      setPendingId(null);
    }
  }

  async function reject(item: ApprovalItem) {
    if (!item.id || action.isPending || !reason.trim()) return;
    setPendingId(item.id);
    try {
      await action.mutateAsync({
        path: `/approvals/${item.id}`,
        method: 'PATCH',
        body: { decision: 'REJECTED', reason: reason.trim() },
      });
      setReason('');
      setPendingId(null);
    } catch {
      setPendingId(null);
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / APPROVALS"
        title="Approvals"
        description="Review and approve or reject pending requests, transfers, change requests and verification escalations."
      />
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      <nav className="approval-tabs">
        {Object.entries(TAB_LABELS).map(([key, label]) => {
          const t = key as ApprovalTab;
          const count = items.filter((item) => item.status === 'PENDING').length;
          return (
            <button
              key={key}
              className={`tab ${tab === t ? 'active' : ''}${count > 0 ? ' has-pending' : ''}`}
              onClick={() => {
                setTab(t);
                setReason('');
              }}
            >
              {label}
              {count > 0 && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </nav>
      <Panel title={`${TAB_LABELS[tab]} (${pending.length} pending)`}>
        {pending.length ? (
          <div className="table-scroll">
            <table className="approval-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Before → After</th>
                  <th>When</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="approval-request">
                        <strong>{item.entityLabel}</strong>
                        <span className="cell-description">{item.action}</span>
                      </div>
                    </td>
                    <td>{item.requester}</td>
                    <td>
                      <Badge value={item.requesterRole} />
                    </td>
                    <td>
                      <span className="mono">{item.before}</span> →{' '}
                      <span className="mono">{item.after}</span>
                    </td>
                    <td>{item.when}</td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={action.isPending || pendingId === item.id}
                          onClick={() => approve(item)}
                        >
                          {pendingId === item.id ? 'Approving…' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={
                            action.isPending ||
                            pendingId === item.id ||
                            !reason.trim()
                          }
                          onClick={() => reject(item)}
                        >
                          Reject
                        </button>
                      </div>
                      {!reason.trim() && (
                        <p className="muted small-text">Reason required to reject.</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No pending approvals">
            All {TAB_LABELS[tab].toLowerCase()} are up to date.
          </Empty>
        )}
        {pending.length > 0 && (
          <div className="form-actions">
            <Field label="Reject reason" htmlFor="approval-reason">
              <textarea
                id="approval-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={3}
              />
            </Field>
            <div className="actions">
              <button
                type="button"
                className="button secondary"
                disabled={action.isPending || !reason.trim()}
                onClick={() => setReason('')}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
