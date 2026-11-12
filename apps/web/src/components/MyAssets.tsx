import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';
import type { Asset } from '../types';
import { useSession } from '../session';
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  PageTitle,
  buttonClass,
  cx,
  displayDate,
  inputClass,
} from './ui';

/** The signed-in person's equipment: confirm receipt, report a discrepancy, or raise a problem. */
export function MyAssets() {
  const { user } = useSession();
  const query = useQuery<{ items: Asset[] }>({
    queryKey: ['my-assets'],
    queryFn: ({ signal }) => api<{ items: Asset[] }>('/assets?limit=100', { signal }),
  });
  const action = useAction();
  const items = (query.data?.items ?? []).filter((a) => a.currentAssignment?.userId === user?.id);

  async function acknowledge(asset: Asset, decision: 'ACCEPTED' | 'DISPUTED', reason?: string) {
    const assignment = asset.currentAssignment;
    if (!assignment) return;
    await action
      .mutateAsync({
        path: `/assignments/${assignment.id}/acknowledgement`,
        body: { decision, ...(decision === 'DISPUTED' ? { reason } : {}) },
        version: assignment.version,
        idempotent: true,
      })
      .then(
        () => query.refetch(),
        () => undefined,
      );
  }

  return (
    <>
      <PageTitle
        eyebrow="My workspace"
        title="My assets"
        description="Equipment assigned to you. Confirm what you received, and report problems here."
      />
      <ErrorNotice error={query.error ?? action.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <Loading label="Loading your assets…" />
      ) : items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              busy={action.isPending}
              onAccept={() => void acknowledge(asset, 'ACCEPTED')}
              onDispute={(reason) => void acknowledge(asset, 'DISPUTED', reason)}
            />
          ))}
        </div>
      ) : (
        <Empty title="No assets assigned to you">
          When equipment is handed to you, it appears here for you to confirm.
        </Empty>
      )}
    </>
  );
}

function AssetCard({
  asset,
  busy,
  onAccept,
  onDispute,
}: {
  asset: Asset;
  busy: boolean;
  onAccept: () => void;
  onDispute: (reason: string) => void;
}) {
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const assignment = asset.currentAssignment;
  const pending = assignment?.acknowledgement === 'PENDING';
  return (
    <article
      className={cx(
        'flex flex-col rounded-xl border bg-white p-5',
        pending ? 'border-yellow-200' : 'border-gray-200',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/assets/${asset.id}`}
            className="font-medium text-navy-700 no-underline hover:underline"
          >
            {asset.assetCode}
          </Link>
          <p className="mt-0.5 line-clamp-2 text-sm text-gray-700">{asset.description}</p>
        </div>
        <Badge value={asset.status} label={asset.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-gray-500">With you since</dt>
          <dd className="text-gray-800">{displayDate(assignment?.assignedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Warranty ends</dt>
          <dd className="text-gray-800">
            {asset.warrantyExpiry ? displayDate(asset.warrantyExpiry) : 'Not recorded'}
          </dd>
        </div>
      </dl>
      {pending ? (
        <div className="mt-4 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-900">
          <p className="font-medium">Please confirm you received this.</p>
          {disputing ? (
            <div className="mt-2 flex flex-col gap-2">
              <label htmlFor={`dispute-${asset.id}`} className="text-xs text-yellow-900">
                What is wrong? (missing item, damage, wrong serial number…)
              </label>
              <input
                id={`dispute-${asset.id}`}
                className={inputClass}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass('danger', 'sm')}
                  disabled={busy || !reason.trim()}
                  onClick={() => onDispute(reason.trim())}
                >
                  Report discrepancy
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => setDisputing(false)}
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass('primary', 'sm')}
                disabled={busy}
                onClick={onAccept}
              >
                Confirm received
              </button>
              <button
                type="button"
                className={buttonClass('secondary', 'sm')}
                onClick={() => setDisputing(true)}
              >
                Something's wrong
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs text-gray-500">
          {assignment?.acknowledgement === 'DISPUTED'
            ? 'You reported a discrepancy. The asset team will follow up.'
            : 'You confirmed receiving this asset.'}
        </p>
      )}
      <div className="mt-auto pt-4">
        <Link to={`/tickets/new?assetId=${asset.id}`} className={buttonClass('secondary', 'sm')}>
          Report a problem
        </Link>
      </div>
    </article>
  );
}
