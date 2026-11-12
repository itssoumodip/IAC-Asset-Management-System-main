import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { buttonClass, cx } from './ui';

// The PDF.js worker is bundled and served from our own origin (CSP: worker-src 'self').
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
// No eval (CSP has no 'unsafe-eval'); fonts are drawn without it.
const PDF_OPTIONS = { isEvalSupported: false };

const iconBtn =
  'grid size-8 place-items-center rounded-md text-gray-600 transition-colors hover:bg-gray-100 hover:text-navy-800 disabled:opacity-40';

/**
 * Invoice viewer for Finance: PDFs are rendered page by page with PDF.js (react-pdf), images are
 * shown directly. Zoom, fit to width, page navigation, open in a new tab and download.
 */
export default function InvoiceViewer({
  src,
  name,
  mime,
  height = '72vh',
}: {
  src: string;
  name: string;
  mime: string;
  height?: string;
}) {
  const isPdf = mime === 'application/pdf';
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [zoom, setZoom] = useState(1);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry!.contentRect.width)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPage(1);
    setPages(0);
    setZoom(1);
    setFailed(false);
  }, [src]);
  const pageWidth = Math.max(240, (width - 32) * zoom);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 px-3 py-2">
        <span className="mr-auto min-w-0 truncate text-sm font-medium text-gray-800" title={name}>
          {name}
        </span>
        {isPdf && pages > 1 ? (
          <span className="flex items-center gap-1 text-xs text-gray-600">
            <button
              type="button"
              className={iconBtn}
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              ‹
            </button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <button
              type="button"
              className={iconBtn}
              aria-label="Next page"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              ›
            </button>
          </span>
        ) : null}
        <span className="mx-1 h-5 w-px bg-gray-200" aria-hidden="true" />
        <button
          type="button"
          className={iconBtn}
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          onClick={() => setZoom(Math.max(0.5, +(zoom - 0.25).toFixed(2)))}
        >
          −
        </button>
        <button
          type="button"
          className="h-8 rounded-md px-2 text-xs text-gray-600 tabular-nums hover:bg-gray-100"
          onClick={() => setZoom(1)}
          title="Fit to width"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className={iconBtn}
          aria-label="Zoom in"
          disabled={zoom >= 3}
          onClick={() => setZoom(Math.min(3, +(zoom + 0.25).toFixed(2)))}
        >
          +
        </button>
        <span className="mx-1 h-5 w-px bg-gray-200" aria-hidden="true" />
        <a href={src} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}>
          Open in new tab
        </a>
        <a href={src} download={name} className={buttonClass('ghost', 'sm')}>
          Download
        </a>
      </div>
      <div ref={box} className="overflow-auto bg-gray-100 p-4" style={{ height }}>
        {failed ? (
          <div className="grid h-full place-items-center text-center text-sm text-gray-500">
            <p>
              This file could not be shown here.{' '}
              <a href={src} target="_blank" rel="noreferrer" className="font-medium text-navy-700">
                Open it in a new tab
              </a>
              .
            </p>
          </div>
        ) : isPdf ? (
          <Document
            file={src}
            options={PDF_OPTIONS}
            onLoadSuccess={({ numPages }) => setPages(numPages)}
            onLoadError={() => setFailed(true)}
            loading={<p className="py-10 text-center text-sm text-gray-500">Loading invoice…</p>}
            className="flex justify-center"
          >
            <Page
              pageNumber={page}
              width={pageWidth}
              className="overflow-hidden rounded-sm bg-white shadow-sm"
              loading={
                <div className="bg-white" style={{ width: pageWidth, height: pageWidth * 1.3 }} />
              }
            />
          </Document>
        ) : (
          <div className={cx('flex', zoom <= 1 && 'justify-center')}>
            <img
              src={src}
              alt={`Invoice ${name}`}
              onError={() => setFailed(true)}
              className="h-auto max-w-none rounded-sm bg-white shadow-sm"
              style={{ width: pageWidth }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
