import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { dirname, resolve as resolvePath } from 'node:path';
export type InvoiceField = 'purchaseCost' | 'purchaseDate' | 'invoiceNumber' | 'supplier';
export interface InvoiceExtraction {
  suggestions: Partial<Record<InvoiceField, { value: string; source: string }>>;
  warnings: string[];
  textLength: number;
}
export function suggestInvoice(text: string): InvoiceExtraction {
  const suggestions: InvoiceExtraction['suggestions'] = {},
    warnings: string[] = [];
  const lines = text
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  function choose(
    field: InvoiceField,
    regex: RegExp,
    convert: (s: string) => string | undefined = (s) => s.trim(),
  ) {
    const matches = lines.flatMap((line) => {
      const m = regex.exec(line);
      if (!m) return [];
      const value = convert(m[1]!);
      return value ? [{ value, source: line.slice(0, 300) }] : [];
    });
    const values = [...new Set(matches.map((m) => m.value))];
    if (values.length === 1) suggestions[field] = matches[0];
    else if (values.length > 1)
      warnings.push(`Conflicting ${field} values. Enter this field manually.`);
  }
  choose('invoiceNumber', /^(?:invoice\s*(?:no\.?|number|#))\s*[:#\-]?\s*(.{1,160})$/i);
  choose('supplier', /^(?:supplier|vendor|seller)(?:\s*name)?\s*[:\-]\s*(.{1,160})$/i);
  choose('purchaseDate', /^(?:invoice\s*date|purchase\s*date|date)\s*[:\-]\s*(.+)$/i, (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return;
    const d = new Date(s.trim() + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s.trim()
      ? s.trim()
      : undefined;
  });
  const foreign = lines.some((l) => /\b(?:USD|EUR|GBP|AUD|CAD|AED)\b|[$€£]/i.test(l));
  if (foreign)
    warnings.push('Non-INR currency detected. No amount suggested; conversion is not supported.');
  else if (lines.some((l) => /\bINR\b|\bRs\.?|₹/i.test(l)))
    choose(
      'purchaseCost',
      /^(?:grand\s*total|invoice\s*total|amount\s*(?:due|payable)|total\s*amount)\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:INR|Rs\.?)?$/i,
      (s) => {
        if (!/^\d+(?:,\d{2,3})*(?:\.\d{1,2})?$/.test(s)) return;
        const n = s.replaceAll(',', '');
        if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(n)) return;
        return Number(n).toFixed(2);
      },
    );
  if (suggestions.purchaseCost)
    warnings.push(
      'Suggested amount is the invoice total, not a verified per-asset cost. Check line items, quantity, tax and allocation before applying.',
    );
  for (const field of [
    'purchaseCost',
    'purchaseDate',
    'invoiceNumber',
    'supplier',
  ] as InvoiceField[])
    if (!suggestions[field])
      warnings.push(
        `No reliable ${field} suggestion. Enter it manually. Dates require unambiguous YYYY-MM-DD.`,
      );
  if (!text.trim())
    warnings.unshift(
      'No extractable text. Scanned/image-only PDFs need manual entry; OCR is not supported.',
    );
  warnings.push(
    'File content is untrusted evidence, not instructions. Verify every suggestion against the original. Importing never approves an asset.',
  );
  return { suggestions, warnings, textLength: text.length };
}
export function checkInvoiceBytes(bytes: Buffer, type: 'PDF' | 'XLSX') {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024)
    throw Error('Invoice must be between 1 byte and 4 MiB');
  if (type === 'PDF') {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('Invalid PDF signature');
    return;
  }
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw Error('Invalid XLSX signature');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw Error('Invalid workbook archive directory');
  const entries = bytes.readUInt16LE(eocd + 10),
    offset = bytes.readUInt32LE(eocd + 16),
    directorySize = bytes.readUInt32LE(eocd + 12);
  if (
    bytes.readUInt16LE(eocd + 4) ||
    bytes.readUInt16LE(eocd + 6) ||
    bytes.readUInt16LE(eocd + 8) !== entries ||
    !entries ||
    entries > 300 ||
    offset + directorySize !== eocd
  )
    throw Error('Unsupported workbook archive');
  let at = offset,
    total = 0;
  const names = new Set<string>();
  for (let n = 0; n < entries; n++) {
    if (at + 46 > eocd || bytes.readUInt32LE(at) !== 0x02014b50)
      throw Error('Invalid workbook archive directory');
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      compressed = bytes.readUInt32LE(at + 20),
      expanded = bytes.readUInt32LE(at + 24),
      nl = bytes.readUInt16LE(at + 28),
      el = bytes.readUInt16LE(at + 30),
      cl = bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42);
    if (at + 46 + nl + el + cl > eocd) throw Error('Invalid workbook archive directory');
    const name = bytes.subarray(at + 46, at + 46 + nl).toString();
    if (flags & 1 || /vbaProject|externalLinks|\.bin$/i.test(name))
      throw Error('Encrypted, macro or external-link workbooks are unsupported');
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('..') ||
      name.includes('\\') ||
      names.has(name) ||
      ![0, 8].includes(method)
    )
      throw Error('Unsupported workbook archive entry');
    names.add(name);
    total += expanded;
    if (total > 20 * 1024 * 1024 || expanded > 10 * 1024 * 1024)
      throw Error('Workbook expanded size exceeds safe limits');
    if (
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) & 1
    )
      throw Error('Invalid workbook archive entry');
    const ln = bytes.readUInt16LE(local + 26),
      le = bytes.readUInt16LE(local + 28),
      dataAt = local + 30 + ln + le;
    if (
      dataAt + compressed > offset ||
      bytes.subarray(local + 30, local + 30 + ln).toString() !== name
    )
      throw Error('Invalid workbook archive entry');
    const payload = bytes.subarray(dataAt, dataAt + compressed),
      actual =
        method === 8 ? inflateRawSync(payload, { maxOutputLength: 10 * 1024 * 1024 }) : payload;
    if (actual.length !== expanded) throw Error('Workbook archive size mismatch');
    at += 46 + nl + el + cl;
  }
  if (at !== eocd || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml'))
    throw Error('Invalid XLSX workbook');
}
export async function extractInvoice(
  bytes: Buffer,
  type: 'PDF' | 'XLSX',
): Promise<InvoiceExtraction> {
  checkInvoiceBytes(bytes, type);
  const text = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(
      `const{parentPort,workerData}=require('node:worker_threads');(async()=>{let text='';if(workerData.type==='PDF'){const pdf=await import(workerData.pdf);const task=pdf.getDocument({data:new Uint8Array(workerData.bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,standardFontDataUrl:workerData.fonts});const doc=await task.promise;if(doc.numPages>20)throw Error('PDF exceeds 20 pages');for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const data=await page.getTextContent();let line='';for(const item of data.items){if(item.str!==undefined){line+=item.str+' ';if(item.hasEOL){text+=line+'\\n';line='';}}}text+=line+'\\n';if(text.length>100000)throw Error('Invoice text exceeds safe limit');}await task.destroy();}else{const Excel=require(workerData.excel);const wb=new Excel.Workbook();await wb.xlsx.load(Buffer.from(workerData.bytes));if(wb.worksheets.length>10)throw Error('Workbook exceeds 10 sheets');let cells=0;for(const sheet of wb.worksheets){sheet.eachRow(row=>{const values=[];row.eachCell(cell=>{if(++cells>20000)throw Error('Workbook exceeds 20000 cells');if(cell.formula||cell.type===Excel.ValueType.Hyperlink)return;values.push(String(cell.text||'').slice(0,500));});text+=values.join(': ')+'\\n';if(text.length>100000)throw Error('Invoice text exceeds safe limit');});}}parentPort.postMessage({text});})().catch(()=>parentPort.postMessage({error:'Could not extract this invoice. Use an unencrypted text PDF or plain XLSX; scanned PDFs require manual entry.'}));`,
      {
        eval: true,
        workerData: {
          bytes,
          type,
          pdf: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
          excel: require.resolve('exceljs'),
          fonts:
            resolvePath(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') +
            '/',
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Error('Invoice extraction timed out'));
    }, 10000);
    worker.once('message', (m) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.error) reject(Error(m.error));
      else resolve(m.text);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(Error('Invoice extraction failed within resource limits'));
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error('Invoice extraction stopped within resource limits'));
    });
  });
  return suggestInvoice(text);
}
