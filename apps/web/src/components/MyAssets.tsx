import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAction } from '../hooks';
import type { Asset } from '../types';
import { Empty, ErrorNotice, Loading, PageTitle, Panel, displayDate, buttonClass, cx } from './ui';
import { useSession } from '../session';

function assetStatusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active' || s === 'in use' || s === 'assigned') return 'success';
  if (s === 'in store' || s === 'ready to assign') return '';
  if (s === 'under repair' || s === 'under verification') return 'warning';
  return '';
}

export function MyAssets() {
  const { user } = useSession();
  const query = useQuery<{ items: Asset[] }>({
    queryKey: ['my-assets'],
    queryFn: ({ signal }) =>
      api<{ items: Asset[] }>('/assets?' + new URLSearchParams({ limit: '100' }).toString(), {
        signal,
      }),
  });
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<Set<string>>(new Set());
  const action = useAction<{ verified: number }>();
  const allItems = query.data?.items ?? [];
  const items = allItems.filter((asset) => asset.currentAssignment?.userId === user?.id);

  const isNotFoundError = (error: unknown) => error instanceof ApiError && error.status === 404;

  if (query.isPending) return <Loading label="Loading your assets…" />;
  if (isNotFoundError(query.error)) {
    return (
      <Empty
        title="Your assets"
        action={
          <Link className={buttonClass()} to="/dashboard">
            Back to workspace
          </Link>
        }
      >
        No assets are currently assigned to you.
      </Empty>
    );
  }
  if (query.error) return <ErrorNotice error={query.error} />;

  async function verifyAsset(assetCode: string) {
    if (verifying.has(assetCode)) return;
    setVerifying((prev) => new Set([...prev, assetCode]));
    try {
      await action.mutateAsync({
        path: `/assets/${encodeURIComponent(assetCode)}/verify`,
        method: 'POST',
        body: { reason: 'Employee self-verification' },
      });
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(assetCode);
        return next;
      });
    } catch {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(assetCode);
        return next;
      });
    }
  }

  async function confirmReceived(assetId: string) {
    if (confirming.has(assetId)) return;
    setConfirming((prev) => new Set([...prev, assetId]));
    try {
      await action.mutateAsync({
        path: `/assignments/${assetId}/acknowledge`,
        method: 'POST',
        body: {},
      });
      setConfirming((prev) => {
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
      await query.refetch();
    } catch {
      setConfirming((prev) => {
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
    }
  }

  function reportProblem(assetId: string) {
    window.location.href = `/tickets/new?assetId=${assetId}`;
  }

  return (
    <>
      <PageTitle
        eyebrow="MY WORKSPACE / ASSETS"
        title="My assets"
        description="Equipment currently assigned to you. Confirm receipt, report problems, and verify during audit cycles."
      />
      <ErrorNotice error={query.error} />
      <div className="flex flex-col gap-6">
        <Panel title="Your assigned equipment">
          {items.length ? (
            <div className="asset-cards">
              {items.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  verifying={verifying.has(asset.id)}
                  confirming={confirming.has(asset.id)}
                  onVerify={() => verifyAsset(asset.assetCode)}
                  onConfirm={() =>
                    asset.currentAssignment?.id && confirmReceived(asset.currentAssignment.id)
                  }
                  onReport={() => reportProblem(asset.id)}
                />
              ))}
            </div>
          ) : (
            <Empty title="No assets assigned to you">
              Equipment assigned to you will appear here as cards.
            </Empty>
          )}
        </Panel>
      </div>
    </>
  );
}

function AssetCard({
  asset,
  verifying,
  confirming,
  onVerify,
  onConfirm,
  onReport,
}: {
  asset: Asset;
  verifying: boolean;
  confirming: boolean;
  onVerify: () => void;
  onConfirm: () => void;
  onReport: () => void;
}) {
  const assignment = asset.currentAssignment;
  const since = assignment?.assignedAt ? displayDate(assignment.assignedAt) : 'Unknown';
  const tone = assetStatusTone(asset.status);
  const canConfirm = assignment?.acknowledgement === 'PENDING';
  return (
    <article className="asset-card">
      <div className="card-header">
        <div className="card-photo">
          {/laptop|notebook/i.test(asset.assetType ?? '') ? (
            <span className="asset-photo-empty" aria-hidden="true">
              ◇
            </span>
          ) : (
            <span className="asset-photo-empty" aria-hidden="true">
              {String(asset.assetCode ?? '').charAt(0) || '?'}
            </span>
          )}
        </div>
        <div className="card-actions">
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            disabled={verifying}
            onClick={onVerify}
          >
            {verifying ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </div>
      <div className="card-body">
        <h3 className="card-name">{asset.assetCode}</h3>
        <p className="card-description">{asset.description}</p>
        <div className="card-meta">
          <span className="card-meta-item">
            <span className="muted small-text">Since</span>
            <br />
            {since}
          </span>
          <span className="card-meta-item">
            <span className="muted small-text">Warranty ends</span>
            <br />
            {displayDate(asset.warrantyExpiry)}
          </span>
        </div>
        <span className={`badge ${tone}`}>{asset.status}</span>
      </div>
      <div className="card-footer">
        <button className={cx(buttonClass(), 'full')} onClick={onReport}>
          Report a problem
        </button>
        {canConfirm && (
          <button
            className={cx(buttonClass('ghost'), 'full')}
            disabled={confirming}
            onClick={onConfirm}
          >
            {confirming ? 'Confirming…' : 'Confirm received'}
          </button>
        )}
      </div>
    </article>
  );
}
