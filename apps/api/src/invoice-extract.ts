export interface Proposal {
  value: string;
  confidence: number;
}
export interface InvoiceFields {
  supplier?: Proposal;
  invoiceNumber?: Proposal;
  invoiceDate?: Proposal;
  totalAmount?: Proposal;
  gstin?: Proposal;
}

const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s && y >= 1990 && y <= 2100
    ? s
    : null;
}

export function parseDate(raw: string): string | null {
  let m = raw.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\.?,?[\s-]+(\d{2,4})\b/);
  if (m) {
    const mi = MONTHS.indexOf((m[2] ?? "").toLowerCase());
    if (mi >= 0) return isoDate(Number(m[3]), mi + 1, Number(m[1]));
  }
  return null;
}

function amount(raw: string): string | null {
  const m = raw.match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n.toFixed(2) : null;
}

/** Rule-based proposals from invoice text. Pure; every field is optional. */
export function extractInvoiceFields(text: string): InvoiceFields {
  const out: InvoiceFields = {};
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const gst = text.toUpperCase().match(GSTIN);
  if (gst) {
    const labelled = /GST(?:IN)?\s*(?:NO\.?|NUMBER|UIN)?\s*[:\-]?\s*\d{2}[A-Z]{5}/i.test(text);
    out.gstin = { value: gst[1]!, confidence: labelled ? 0.95 : 0.8 };
  }

  for (const line of lines) {
    const m = line.match(
      /\b(?:invoice|inv|bill)\s*(?:no|number|num|#)\b\.?\s*[:\-#]?\s*([A-Za-z0-9][A-Za-z0-9/\-_.]{1,29})/i,
    );
    if (m) {
      out.invoiceNumber = { value: m[1]!.replace(/[.\-/]+$/, ''), confidence: 0.85 };
      break;
    }
  }

  const dateLine = lines.find((l) => /\b(invoice\s*date|date|dated|dt)\b/i.test(l) && parseDate(l));
  if (dateLine) {
    out.invoiceDate = {
      value: parseDate(dateLine)!,
      confidence: /invoice\s*date/i.test(dateLine) ? 0.9 : 0.7,
    };
  }

  // Prefer Grand Total, then Total Amount / Net Payable, then a plain Total (not Sub Total).
  const tiers: [RegExp, number][] = [
    [/grand\s*total/i, 0.9],
    [/(total\s*amount|net\s*(?:amount|payable)|amount\s*payable|invoice\s*total)/i, 0.85],
    [/(?<!sub[\s-]?)\btotal\b(?!\s*(?:tax|gst|qty|quantity))/i, 0.7],
  ];
  outer: for (const [re, confidence] of tiers) {
    for (const line of [...lines].reverse()) {
      if (!re.test(line) || /amount in words|rupees .* only/i.test(line)) continue;
      if (/sub[\s-]?total/i.test(line) && !/grand/i.test(line)) continue;
      const after = line.slice(line.search(re));
      const tail = after.replace(re, '');
      const value = amount(tail);
      if (value) {
        out.totalAmount = { value, confidence };
        break outer;
      }
    }
  }

  const skip =
    /invoice|gstin|gst\b|bill to|ship to|date|total|page|phone|tel|email|www\.|@|^\d|original|duplicate|copy|receipt|quotation|proforma/i;
  const name = lines.slice(0, 6).find((l) => l.length >= 3 && l.length <= 80 && !skip.test(l));
  if (name) out.supplier = { value: name, confidence: 0.5 };
  return out;
}
