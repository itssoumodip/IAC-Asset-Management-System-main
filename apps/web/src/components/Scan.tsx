import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { can, useSession } from '../session';
import type { ScanView } from '../types';
import { GenericLaptop } from './AssetPhoto';
import { Badge, Empty, ErrorNotice, Loading, Panel } from './ui';

const NOT_FOUND = 'Asset not found. Check the sticker or contact IT.';
const RETIRED = 'This asset is no longer in service.';
const LOST = 'This asset is marked lost or stolen. Please hand it to IT.';
const PHOTO_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const isNotFoundError = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 422);
type NdefReadingEvent = Event & {
  message: { records: { recordType: string; data: ArrayBuffer }[] };
};
type NdefReaderLike = {
  scan: () => Promise<void>;
  addEventListener: (type: 'reading', listener: (event: NdefReadingEvent) => void) => void;
};

function ScanPhoto({ code, scan }: { code: string; scan: ScanView }) {
  const query = useQuery({
    queryKey: ['scan-photo', code],
    queryFn: ({ signal }) =>
      api<{ dataUrl: string | null }>(`/scan/${encodeURIComponent(code)}/photo`, { signal }),
    enabled: scan.hasPhoto,
  });
  const photo = query.data?.dataUrl;
  return (
    <div className="asset-photo-stage">
      {photo && PHOTO_PATTERN.test(photo) ? (
        <img src={photo} alt={`Photo of ${scan.assetCode}`} className="asset-photo-image" />
      ) : /laptop|notebook/i.test(scan.assetType) ? (
        <GenericLaptop />
      ) : (
        <span className="asset-photo-empty" aria-hidden="true">
          ◇
        </span>
      )}
    </div>
  );
}

export function ScanPage() {
  const { assetCode = '' } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const [nfcError, setNfcError] = useState('');
  const nfcAvailable = 'NDEFReader' in window;
  const scanNfc = async () => {
    const Reader = (window as Window & { NDEFReader?: new () => NdefReaderLike }).NDEFReader;
    if (!Reader) return;
    setNfcError('');
    const reader = new Reader();
    reader.addEventListener('reading', (event) => {
      const record = event.message.records[0];
      if (!record) return;
      const value = new TextDecoder().decode(record.data).trim();
      if (value) void navigate(`/a/${encodeURIComponent(value)}`);
    });
    try {
      await reader.scan();
    } catch {
      setNfcError('NFC scanning could not start. Check browser permission and try again.');
    }
  };
  const query = useQuery({
    queryKey: ['scan', assetCode],
    queryFn: ({ signal }) => api<ScanView>(`/scan/${encodeURIComponent(assetCode)}`, { signal }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  if (query.isPending) return <Loading label="Looking up asset..." />;
  if (isNotFoundError(query.error))
    return (
      <Empty
        title="Asset not found"
        action={
          <Link className="button secondary" to="/dashboard">
            Back to workspace
          </Link>
        }
      >
        {NOT_FOUND}
      </Empty>
    );
  if (query.error)
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  const scan = query.data;
  const status = scan.status.toLowerCase();
  const lostOrStolen = status === 'lost' || status === 'stolen';
  const where = scan.location
    ? scan.location.path ||
      [scan.location.site, scan.location.floor, scan.location.room].filter(Boolean).join(' · ')
    : null;
  const details: [string, string | null][] = [
    ['Category', scan.category],
    ['Type', scan.assetType],
    ['Make', [scan.manufacturer, scan.model].filter(Boolean).join(' ') || null],
    ['Asset department', scan.department],
    ['Location', where],
  ];
  return (
    <div className="scan-page">
      <Panel>
        <div className="scan-heading">
          <div>
            <p className="muted small-text">Scanned asset</p>
            <h1>{scan.assetCode}</h1>
          </div>
          <Badge value={scan.status} />
        </div>
        <ScanPhoto code={assetCode} scan={scan} />
        {scan.custodian ? (
          <section className="scan-custodian" aria-labelledby="scan-custodian-title">
            <h2 id="scan-custodian-title">Current custodian</h2>
            <p className="scan-custodian-name">{scan.custodian.name}</p>
            {scan.custodian.designation ? <p>{scan.custodian.designation}</p> : null}
            {scan.custodian.department ? (
              <p className="muted">{scan.custodian.department}</p>
            ) : null}
            <p className="muted small-text">
              {scan.custodian.acknowledgement === 'ACCEPTED'
                ? 'Assignment confirmed'
                : scan.custodian.acknowledgement === 'DISPUTED'
                  ? 'Assignment needs review'
                  : 'Assignment awaiting confirmation'}
              {scan.custodian.assignedAt
                ? ` · Assigned ${new Date(scan.custodian.assignedAt).toLocaleDateString()}`
                : ''}
            </p>
          </section>
        ) : (
          <section className="scan-custodian scan-custodian-empty">
            <h2>Current custodian</h2>
            <p>No employee is currently assigned to this asset.</p>
          </section>
        )}
        <dl className="scan-details">
          {details
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
        {!scan.reportable ? (
          <p className="notice" role="status">
            {lostOrStolen ? LOST : RETIRED}
          </p>
        ) : null}
        <div className="scan-actions">
          {nfcAvailable ? (
            <>
              <button type="button" className="button secondary full" onClick={() => void scanNfc()}>
                Scan NFC tag
              </button>
              {nfcError ? <p className="notice danger" role="alert">{nfcError}</p> : null}
            </>
          ) : null}
          {scan.reportable ? (
            <Link
              className="button full"
              to={`/tickets/new?asset=${encodeURIComponent(scan.assetCode)}&assetId=${encodeURIComponent(scan.id)}`}
            >
              Report a problem
            </Link>
          ) : null}
          {scan.canViewFull ? (
            <Link className="button secondary full" to={`/assets/${scan.id}`}>
              {can(user, 'asset.view_all') ? 'Open full record' : 'View my asset'}
            </Link>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
