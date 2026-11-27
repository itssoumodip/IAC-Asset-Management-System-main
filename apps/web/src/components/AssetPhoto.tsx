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

interface ExtraPhoto {
  id: string;
  label: string;
  dataUrl: string;
  addedAt: string;
  addedBy: string | null;
}
interface ExtraPhotos {
  max: number;
  labels: string[];
  items: ExtraPhoto[];
}
const SAFE_JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

function saveJpeg(name: string, dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  downloadFile(name, new Blob([bytes], { type: 'image/jpeg' }));
}

/** More pictures of the asset (front, back, screen, serial label…), beside the main photo. */
export function AssetMorePhotos({ asset, manage }: { asset: Asset; manage: boolean }) {
  const query = useQuery({
    queryKey: ['asset-photos', asset.id],
    queryFn: ({ signal }) => api<ExtraPhotos>(`/assets/${asset.id}/photos`, { signal }),
  });
  const action = useAction();
  const [open, setOpen] = useState<ExtraPhoto>();
  const [draft, setDraft] = useState<string>();
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<ExtraPhoto>();
  const [removeReason, setRemoveReason] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const items = (query.data?.items ?? []).filter((p) => SAFE_JPEG.test(p.dataUrl));
  const max = query.data?.max ?? 6;
  const full = items.length >= max;
  const busy = preparing || action.isPending;
  // Suggest the first label not used yet.
  const used = new Set(items.map((p) => p.label));
  const suggested = (query.data?.labels ?? []).find((l) => !used.has(l)) ?? 'Other';

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setError(undefined);
    setMessage('');
    action.reset();
    if (!file) return;
    setPreparing(true);
    try {
      setDraft(await preparePhoto(file, ASSET_LIMITS));
      setLabel((current) => current || suggested);
    } catch (caught) {
      setError(caught);
    } finally {
      setPreparing(false);
    }
  }
  function resetDraft() {
    setDraft(undefined);
    setLabel('');
    setReason('');
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft || !label || !reason.trim() || busy) return;
    setError(undefined);
    try {
      await action.mutateAsync({
        path: `/assets/${asset.id}/photos`,
        body: { dataUrl: draft, label, reason: reason.trim() },
      });
      resetDraft();
      setMessage('Picture added.');
    } catch {
      // Shown below; the draft stays for another try.
    }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!removing || !removeReason.trim() || busy) return;
    try {
      await action.mutateAsync({
        path: `/assets/${asset.id}/photos/${removing.id}/remove`,
        body: { reason: removeReason.trim() },
      });
      if (open?.id === removing.id) setOpen(undefined);
      setRemoving(undefined);
      setRemoveReason('');
      setMessage('Picture removed.');
    } catch {
      // Shown below.
    }
  }

  if (query.isPending) return <Loading label="Loading more pictures…" />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (!items.length && !manage) return null;

  return (
    <section className="mt-6 border-t border-gray-200 pt-5" aria-labelledby={`more-photos-${asset.id}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`more-photos-${asset.id}`} className="text-sm font-semibold text-navy-900">
          More pictures
        </h3>
        <span className="text-xs text-gray-500">
          {items.length} of {max} · front, back, screen, serial label and so on
        </span>
      </div>
      {items.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((p) => (
            <li key={p.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              <button
                type="button"
                className="block w-full bg-gray-50"
                onClick={() => setOpen(p)}
                aria-label={`Open the ${p.label} picture`}
              >
                <img src={p.dataUrl} alt={`${p.label} of ${asset.assetCode}`} className="h-32 w-full object-contain" />
              </button>
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-gray-800">{p.label}</span>
                  <span className="block truncate text-[11px] text-gray-500">{displayDate(p.addedAt)}</span>
                </span>
                {manage ? (
                  <button
                    type="button"
                    className="text-[11px] text-red-700 underline"
                    disabled={busy}
                    onClick={() => {
                      setRemoving(p);
                      setRemoveReason('');
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No more pictures yet.</p>
      )}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${open.label} picture`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(undefined)}
        >
          <div className="max-h-full max-w-3xl rounded-lg bg-white p-3" onClick={(e) => e.stopPropagation()}>
            <img src={open.dataUrl} alt={`${open.label} of ${asset.assetCode}`} className="max-h-[75vh] w-auto" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-gray-700">
                {open.label} · added {displayDate(open.addedAt)}
                {open.addedBy ? ` by ${open.addedBy}` : ''}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass('secondary')}
                  onClick={() => saveJpeg(`${asset.assetCode}-${open.label.toLowerCase().replace(/\s+/g, '-')}.jpg`, open.dataUrl)}
                >
                  Download
                </button>
                <button type="button" className={buttonClass()} onClick={() => setOpen(undefined)}>
                  Close
                </button>
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {removing ? (
        <form className="form-stack subsection" onSubmit={remove}>
          <Field label={`Why remove the ${removing.label} picture?`} htmlFor={`remove-photo-${removing.id}`}>
            <textarea
              id={`remove-photo-${removing.id}`}
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              required
              maxLength={1000}
            />
          </Field>
          <div className={actionsClass}>
            <button type="submit" className={buttonClass('danger')} disabled={busy || !removeReason.trim()}>
              {action.isPending ? 'Removing…' : 'Remove picture'}
            </button>
            <button type="button" className={buttonClass('secondary')} disabled={busy} onClick={() => setRemoving(undefined)}>
              Keep it
            </button>
          </div>
        </form>
      ) : null}

      {manage && !full ? (
        <form className="form-stack subsection" onSubmit={add}>
          <div className="asset-photo-capture-actions">
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={busy}
              onClick={() => cameraInput.current?.click()}
            >
              Take another picture
            </button>
            <input
              ref={cameraInput}
              className="asset-photo-camera-input"
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              tabIndex={-1}
              aria-label="Take another picture of this asset"
              disabled={busy}
              onChange={(e) => void choose(e)}
            />
            <span className="muted small-text">or choose a file:</span>
            <input
              ref={fileInput}
              type="file"
              className={fileInputClass}
              accept="image/jpeg,image/png"
              aria-label="Choose another picture of this asset"
              disabled={busy}
              onChange={(e) => void choose(e)}
            />
          </div>
          {preparing ? <Loading label="Preparing picture…" /> : null}
          {draft ? (
            <>
              <img src={draft} alt="New picture preview" className="h-40 w-auto rounded border border-gray-200" />
              <Field label="Which side is this?" htmlFor={`extra-label-${asset.id}`}>
                <select
                  id={`extra-label-${asset.id}`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {(query.data?.labels ?? []).map((l) => (
                    <option key={l} value={l}>
                      {l}
                      {used.has(l) ? ' (already added)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason" htmlFor={`extra-reason-${asset.id}`} hint="For example: condition check at handover.">
                <textarea
                  id={`extra-reason-${asset.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  maxLength={1000}
                />
              </Field>
              <div className={actionsClass}>
                <button type="submit" className={buttonClass()} disabled={busy || !reason.trim() || !label}>
                  {action.isPending ? 'Saving…' : 'Add picture'}
                </button>
                <button type="button" className={buttonClass('secondary')} disabled={busy} onClick={resetDraft}>
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </form>
      ) : null}
      {manage && full ? (
        <p className="mt-3 text-xs text-gray-500">This asset has the most pictures allowed. Remove one to add another.</p>
      ) : null}
      <ErrorNotice error={error ?? action.error} />
      {message ? (
        <p className={noticeClass('success')} role="status">
          {message}
        </p>
      ) : null}
    </section>
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
      <AssetMorePhotos asset={asset} manage={manage} />
    </Panel>
  );
}
