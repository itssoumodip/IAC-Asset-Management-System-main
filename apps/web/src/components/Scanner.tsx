import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import QrScanner from 'qr-scanner';
import { assetPathFromScan } from '../scan-url';

declare global {
  interface Window {
    __iacScanResult?: (text: string) => void;
  }
}

export function ScannerDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [notice, setNotice] = useState('');
  const [cameraError, setCameraError] = useState(false);
  const [typed, setTyped] = useState('');

  const handleResult = useCallback(
    (text: string) => {
      const path = assetPathFromScan(text, window.location.origin);
      if (!path) {
        setNotice("This isn't an IAC asset label");
        return;
      }
      setNotice('');
      onClose();
      navigate(path);
    },
    [navigate, onClose],
  );
  const resultRef = useRef(handleResult);
  resultRef.current = handleResult;

  useEffect(() => {
    if (!open) return;
    setNotice('');
    setCameraError(false);
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const scanner = new QrScanner(video, (r) => resultRef.current(r.data), {
      returnDetailedScanResult: true,
      preferredCamera: 'environment',
      highlightScanRegion: false,
      highlightCodeOutline: false,
    });
    scanner.start().catch(() => {
      if (!cancelled) setCameraError(true);
    });
    const hook = import.meta.env.DEV ? (text: string) => resultRef.current(text) : null;
    if (hook) window.__iacScanResult = hook;
    return () => {
      cancelled = true;
      scanner.stop();
      scanner.destroy();
      if (hook && window.__iacScanResult === hook) delete window.__iacScanResult;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.classList.add('camera-scanner-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.documentElement.classList.remove('camera-scanner-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  function submitTyped(e: FormEvent) {
    e.preventDefault();
    const code = typed.trim();
    if (!code) return;
    onClose();
    navigate(`/a/${encodeURIComponent(code)}`);
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan asset label"
      className="camera-scanner-dialog"
    >
      <div className="camera-scanner-header">
        <strong>Scan asset label</strong>
        <button type="button" className="button secondary small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="camera-scanner-video">
        <video ref={videoRef} className="camera-scanner-stream" muted playsInline />
        {cameraError ? (
          <p role="alert" className="camera-scanner-error">
            Camera unavailable. Type the asset ID below instead.
          </p>
        ) : null}
        {notice ? (
          <p role="alert" className="camera-scanner-notice">
            {notice}
          </p>
        ) : null}
      </div>
      <form onSubmit={submitTyped} className="camera-scanner-form">
        <label className="sr-only" htmlFor="scan-asset-id">
          Type the asset ID
        </label>
        <input
          id="scan-asset-id"
          className="camera-scanner-input"
          placeholder="Type the asset ID"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
        />
        <button type="submit" className="button small" disabled={!typed.trim()}>
          Go
        </button>
      </form>
    </div>,
    document.body,
  );
}

export function ScanButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className="button small scan-button"
        aria-label="Open camera scanner"
        title="Scan asset label"
        onClick={() => setOpen(true)}
      >
        <svg
          className="scan-button-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M5 7h3l1.5-2h5L16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
        <span className="scan-button-label">Scan</span>
      </button>
      <ScannerDialog open={open} onClose={close} />
    </>
  );
}
