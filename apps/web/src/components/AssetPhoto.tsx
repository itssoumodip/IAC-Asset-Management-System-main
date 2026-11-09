import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { Asset } from '../types';
import { downloadFile } from '../transfer-files';
import { ASSET_LIMITS, preparePhoto } from '../photo-prepare';
import {
  ErrorNotice,
  Field,
  Loading,
  Panel,
  displayDate,
  buttonClass,
  actionsClass,
  noticeClass,
  fileInputClass,
} from './ui';

interface PhotoResponse {
  dataUrl: string | null;
  updatedAt: string | null;
  assetVersion?: number;
}
interface PhotoDraft {
  dataUrl: string;
  version: number;
}
export function GenericLaptop() {
  return (
    <svg
      className="asset-photo-illustration"
      viewBox="0 0 360 230"
      role="img"
      aria-label="Generic laptop illustration"
    >
      <ellipse cx="180" cy="205" rx="145" ry="11" fill="#dbe7ef" />
      <rect x="65" y="27" width="230" height="151" rx="9" fill="#315a78" />
      <rect x="74" y="37" width="212" height="130" rx="3" fill="#e1eff7" />
      <path d="M74 140 168 58l118 83v26H74Z" fill="#b6cfdf" />
      <path d="M74 151 139 96l85 71H74Z" fill="#8dadc4" />
      <circle cx="180" cy="32" r="2" fill="#9cbbce" />
      <path d="m65 178-29 22q0 5 9 5h270q9 0 9-5l-29-22Z" fill="#94afc1" />
      <path d="M150 178h60l8 10h-76Z" fill="#d5e2ea" />
      <path d="M36 200h288" stroke="#53768e" strokeWidth="3" />
    </svg>
  );
}

export function AssetPhoto({ asset, manage }: { asset: Asset; manage: boolean }) {
  const query = useQuery({
    queryKey: ['asset-photo', asset.id],
    queryFn: ({ signal }) => api<PhotoResponse>(`/assets/${asset.id}/photo`, { signal }),
  });
  const action = useAction<PhotoResponse>();
  const [draft, setDraft] = useState<PhotoDraft>();
  const [reason, setReason] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const saving = useRef(false);
  const current = useRef({ active: false, version: asset.version });
  useEffect(() => {
    current.current.active = true;
    return () => {
      current.current.active = false;
      selection.current++;
    };
  }, []);
  useEffect(() => {
    current.current.version = asset.version;
  }, [asset.version]);
  const busy = preparing || action.isPending;
  const laptop = /laptop|notebook/i.test(asset.assetType ?? '');
  const photo = draft?.dataUrl ?? query.data?.dataUrl;
  const validPhoto = photo && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(photo);

  function clearFileInputs() {
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
  }

  function downloadSavedPhoto() {
    const saved = query.data?.dataUrl;
    if (!saved || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(saved)) return;
    try {
      const bytes = Uint8Array.from(atob(saved.slice(saved.indexOf(',') + 1)), (value) =>
        value.charCodeAt(0),
      );
      downloadFile(`${asset.assetCode}-photo.jpg`, new Blob([bytes], { type: 'image/jpeg' }));
    } catch {
      setError(new Error('The saved picture could not be downloaded. Refresh and try again.'));
    }
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const generation = ++selection.current;
    const version = asset.version;
    setDraft(undefined);
    setReason('');
    setMessage('');
    setError(undefined);
    action.reset();
    if (!file) {
      setPreparing(false);
      return;
    }
    setPreparing(true);
    try {
      const dataUrl = await preparePhoto(file, ASSET_LIMITS);
      if (!current.current.active || generation !== selection.current) return;
      if (current.current.version !== version)
        throw new Error(
          'This asset changed. Review the latest details and choose the photo again.',
        );
      setDraft({ dataUrl, version });
    } catch (caught) {
      if (!current.current.active || generation !== selection.current) return;
      setError(caught);
      clearFileInputs();
    } finally {
      if (current.current.active && generation === selection.current) setPreparing(false);
    }
  }
  async function savePhoto(event: FormEvent) {
    event.preventDefault();
    if (!manage || !draft || !reason.trim() || busy || saving.current) return;
    if (draft.version !== asset.version) {
      setError(
        new Error('This asset changed. Review the latest details and choose the photo again.'),
      );
      return;
    }
    saving.current = true;
    setError(undefined);
    setMessage('');
    try {
      await action.mutateAsync({
        path: `/assets/${asset.id}/photo`,
        method: 'PUT',
        body: { dataUrl: draft.dataUrl, reason: reason.trim() },
        version: draft.version,
      });
      if (!current.current.active) return;
      setDraft(undefined);
      setReason('');
      setMessage('Asset photo saved.');
      clearFileInputs();
    } catch {
      // useAction exposes the safe API error below and retains the draft for retry.
    } finally {
      saving.current = false;
    }
  }
  return (
    <Panel title="Asset picture" className="asset-photo-panel">
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {query.isPending ? (
        <figure
          className="asset-photo-figure asset-photo-loading"
          aria-label="Loading saved picture"
        >
          <div className="asset-photo-stage" />
          <figcaption>Checking for a saved picture…</figcaption>
        </figure>
      ) : null}
      {!query.isPending && !query.error ? (
        <figure className="asset-photo-figure">
          <div className="asset-photo-stage">
            {validPhoto ? (
              <img
                src={photo}
                alt={`${draft ? 'Photo preview' : 'Asset photo'} for ${asset.assetCode}`}
                className="asset-photo-image"
              />
            ) : laptop ? (
              <GenericLaptop />
            ) : (
              <span className="asset-photo-empty" aria-hidden="true">
                ◇
              </span>
            )}
          </div>
          <figcaption>
            {validPhoto ? (
              draft ? (
                'Preview, not saved'
              ) : (
                'Asset photo'
              )
            ) : (
              <>
                <strong>No asset photo yet</strong>
                {laptop ? <span>Generic illustration, not the actual asset</span> : null}
              </>
            )}
          </figcaption>
          {!draft && query.data?.dataUrl && query.data.updatedAt ? (
            <p className="muted small-text">Updated {displayDate(query.data.updatedAt)}</p>
          ) : null}
        </figure>
      ) : null}
      {query.data?.dataUrl && !query.error ? (
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={downloadSavedPhoto}
          disabled={busy}
        >
          Download saved picture
        </button>
      ) : null}
      {manage ? (
        <form className="form-stack subsection" onSubmit={savePhoto}>
          <div className="asset-photo-capture-actions">
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={busy}
              onClick={() => cameraInput.current?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7.5h3l1.5-2h7l1.5 2h3A1.5 1.5 0 0 1 21.5 9v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Take photo
            </button>
            <input
              ref={cameraInput}
              className="asset-photo-camera-input"
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              tabIndex={-1}
              aria-label="Take a photo of this asset"
              disabled={busy}
              onChange={(event) => {
                void choosePhoto(event);
              }}
            />
            <span className="muted small-text">Opens your phone’s rear camera when supported.</span>
          </div>
          <Field
            label="Choose asset photo"
            htmlFor={`asset-photo-${asset.id}`}
            hint="JPEG or PNG, up to 10 MiB. Prepared locally to 640 × 480 pixels or smaller; image metadata is removed."
          >
            <input
              ref={fileInput}
              id={`asset-photo-${asset.id}`}
              type="file"
              className={fileInputClass}
              accept="image/jpeg,image/png"
              disabled={action.isPending}
              onChange={(event) => {
                void choosePhoto(event);
              }}
            />
          </Field>
          {preparing ? <Loading label="Preparing photo preview..." /> : null}
          <ErrorNotice error={error ?? action.error} />
          {draft ? (
            <>
              <Field label="Photo change reason" htmlFor={`asset-photo-reason-${asset.id}`}>
                <textarea
                  id={`asset-photo-reason-${asset.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  maxLength={1000}
                  disabled={action.isPending}
                />
              </Field>
              <div className={actionsClass}>
                <button
                  type="submit"
                  className={buttonClass()}
                  disabled={busy || !reason.trim() || !!query.error}
                >
                  {action.isPending ? 'Saving photo...' : 'Save photo'}
                </button>
                <button
                  type="button"
                  className={buttonClass('secondary')}
                  disabled={busy}
                  onClick={() => {
                    selection.current++;
                    setDraft(undefined);
                    setReason('');
                    setError(undefined);
                    action.reset();
                    clearFileInputs();
                  }}
                >
                  Cancel photo change
                </button>
              </div>
            </>
          ) : null}
          {message ? (
            <p className={noticeClass('success')} role="status">
              {message}
            </p>
          ) : null}
        </form>
      ) : null}
    </Panel>
  );
}
