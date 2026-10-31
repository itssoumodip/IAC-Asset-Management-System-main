import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { ErrorNotice, Loading, PageTitle, Panel } from './ui';

type ChangeRequest = {
  id: string;
  assetId: string;
  assetCode: string;
  requesterName: string;
  ownerRole: string;
  proposedChanges: Record<string, unknown>;
  reason: string;
  createdAt: string;
};

function displayField(field: string) {
  return field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

export function ChangeRequests() {
  const query = useQuery({
    queryKey: ['asset-change-requests'],
    queryFn: () => api<ChangeRequest[]>('/asset-change-requests'),
  });
  const action = useAction();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const requests = query.data ?? [];
  async function review(requestId: string, decision: 'APPROVE' | 'REJECT') {
    const reason = reasons[requestId]?.trim() ?? '';
    if (!reason) return;
    await action.mutateAsync({
      path: `/asset-change-requests/${requestId}`,
      method: 'PUT',
      body: { decision, reason },
    });
    await query.refetch();
    setReasons((current) => ({ ...current, [requestId]: '' }));
  }
  return (
    <>
      <PageTitle
        title="Change approvals"
        description="Review asset edits that need your role's approval."
      />
      <ErrorNotice error={action.error} />
      <Panel title="Pending requests">
        {!requests.length ? <p className="muted">There are no pending requests.</p> : null}
        <div className="change-request-list">
          {requests.map((request) => (
            <article className="change-request" key={request.id}>
              <div className="change-request-heading">
                <div>
                  <strong>{request.assetCode}</strong>
                  <p className="muted">
                    Requested by {request.requesterName} for {request.ownerRole.toLowerCase()} review
                  </p>
                </div>
                <span className="badge">{new Date(request.createdAt).toLocaleDateString()}</span>
              </div>
              <p>{request.reason}</p>
              <dl className="details">
                {Object.entries(request.proposedChanges).map(([field, value]) => (
                  <div key={field}>
                    <dt>{displayField(field)}</dt>
                    <dd>{value == null ? 'Empty' : String(value)}</dd>
                  </div>
                ))}
              </dl>
              <input
                aria-label={`Review reason for ${request.assetCode}`}
                value={reasons[request.id] ?? ''}
                onChange={(event) => setReasons((current) => ({ ...current, [request.id]: event.target.value }))}
                placeholder="Reason for your decision"
                maxLength={1000}
              />
              <div className="actions">
                <button className="button" type="button" disabled={action.isPending || !reasons[request.id]?.trim()} onClick={() => void review(request.id, 'APPROVE')}>
                  Approve change
                </button>
                <button className="button secondary" type="button" disabled={action.isPending || !reasons[request.id]?.trim()} onClick={() => void review(request.id, 'REJECT')}>
                  Reject change
                </button>
              </div>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
