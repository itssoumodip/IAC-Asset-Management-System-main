import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Db } from './db';
import { extractInvoiceFields } from './invoice-extract';

/** Turns an uploaded invoice into plain text. Injectable so tests can avoid slow OCR. */
export type TextExtractor = (bytes: Buffer, mime: string) => Promise<string>;

export class ExtractionError extends Error {}

export const SCANNED_PDF_MESSAGE = 'Scanned PDF: upload a photo/JPEG of the invoice for OCR';
const TESSDATA = path.resolve(__dirname, '..', 'assets', 'tessdata');

export const MAX_ATTEMPTS = 3;
export const EXTRACTION_TIMEOUT_MS = 60_000;
export const OCR_MAX_SIDE = 2500;
const TIMEOUT_MESSAGE = 'Reading this invoice took too long';
const GENERIC_MESSAGE = 'The invoice could not be read';
const GIVE_UP_MESSAGE = 'The invoice could not be read after several attempts';

// Runs inside a worker thread with hard memory limits, so a crafted file can only kill its own job.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { bytes, mime, tessdata, maxSide, modules } = workerData;
  const input = Buffer.from(bytes);
  if (mime === 'application/pdf') {
    const pdfParse = require(modules.pdfParse);
    let text = '';
    try { text = (await pdfParse(input)).text || ''; } catch { return parentPort.postMessage({ scanned: true }); }
    return parentPort.postMessage(text.replace(/\s/g, '').length < 20 ? { scanned: true } : { text });
  }
  const sharp = require(modules.sharp);
  const small = await sharp(input, { limitInputPixels: 40000000 })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const { createWorker } = require(modules.tesseract);
  const worker = await createWorker('eng', 1, { langPath: tessdata, gzip: false, cacheMethod: 'none' });
  try { parentPort.postMessage({ text: (await worker.recognize(small)).data.text }); }
  finally { await worker.terminate(); }
})().catch(() => parentPort.postMessage({ failed: true }));
`;

/**
 * Local-only extraction: pdf-parse for text-layer PDFs, Tesseract (WASM, bundled
 * English data, never fetched from a CDN) for JPEG/PNG. No network calls. The work runs in a
 * worker thread with memory limits and is terminated on timeout, so one bad file cannot hang or
 * crash the mail worker. Images are downscaled to OCR_MAX_SIDE first.
 */
export function localTextExtractor(
  bytes: Buffer,
  mime: string,
  timeoutMs = EXTRACTION_TIMEOUT_MS - 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        bytes,
        mime,
        tessdata: TESSDATA,
        maxSide: OCR_MAX_SIDE,
        modules: {
          pdfParse: require.resolve('pdf-parse/lib/pdf-parse.js'),
          sharp: require.resolve('sharp'),
          tesseract: require.resolve('tesseract.js'),
        },
      },
      resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new ExtractionError(TIMEOUT_MESSAGE))), timeoutMs);
    worker.once('message', (m: { text?: string; scanned?: boolean }) =>
      finish(() =>
        m.scanned
          ? reject(new ExtractionError(SCANNED_PDF_MESSAGE))
          : typeof m.text === 'string'
            ? resolve(m.text)
            : reject(new Error('extraction failed')),
      ),
    );
    worker.once('error', () => finish(() => reject(new Error('extraction crashed'))));
    worker.once('exit', () => finish(() => reject(new Error('extraction exited'))));
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExtractionError(TIMEOUT_MESSAGE)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Processes up to `max` invoices; returns how many were handled. Each attempt is claimed
 * (PROCESSING, attempts+1) in its own committed transaction BEFORE any work, so a crash
 * mid-extraction is bounded by MAX_ATTEMPTS. PROCESSING rows older than 10 minutes are
 * retryable. Extraction never holds a database transaction open.
 */
export async function processPendingInvoices(
  db: Db,
  extract: TextExtractor = localTextExtractor,
  max = 3,
  timeoutMs = EXTRACTION_TIMEOUT_MS,
): Promise<number> {
  let handled = 0;
  while (handled < max) {
    const claim = await db.tx(async (c) => {
      const [row] = await db.query(
        `SELECT id,attempts FROM invoices
         WHERE extraction_state='PENDING'
            OR (extraction_state='PROCESSING' AND processing_started_at < now()-interval '10 minutes')
         ORDER BY uploaded_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [],
        c,
      );
      if (!row) return null;
      if (row.attempts >= MAX_ATTEMPTS) {
        await db.query(
          `UPDATE invoices SET extraction_state='FAILED',extraction_error=$2,processing_started_at=NULL WHERE id=$1`,
          [row.id, GIVE_UP_MESSAGE],
          c,
        );
        return { id: row.id as string, skip: true };
      }
      const [claimed] = await db.query(
        `UPDATE invoices SET extraction_state='PROCESSING',attempts=attempts+1,processing_started_at=now()
         WHERE id=$1 RETURNING id,file,mime,attempts`,
        [row.id],
        c,
      );
      return { ...claimed, skip: false };
    });
    if (!claim) break;
    handled++;
    if (claim.skip) continue;
    try {
      const text = (await withTimeout(extract(claim.file, claim.mime), timeoutMs)).slice(0, 50_000);
      const fields = extractInvoiceFields(text);
      await db.query(
        `UPDATE invoices SET extraction_state='DONE',extracted_text=$2,extracted_fields=$3,extraction_error=NULL,processing_started_at=NULL WHERE id=$1`,
        [claim.id, text, JSON.stringify(fields)],
      );
    } catch (error) {
      const known = error instanceof ExtractionError;
      const message = known ? error.message : GENERIC_MESSAGE;
      // Scanned PDFs are deterministic; timeouts and unknown errors get retried up to the cap.
      const final = (known && message === SCANNED_PDF_MESSAGE) || claim.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE invoices SET extraction_state=$2,extraction_error=$3,processing_started_at=NULL WHERE id=$1`,
        [claim.id, final ? 'FAILED' : 'PENDING', message],
      );
    }
  }
  return handled;
}
