import { Db } from './db';

/** Currencies the subscription form offers (rupee totals need a rate for each). */
export const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'] as const;

export interface InrRates {
  /** Rupees for one unit of each currency; INR is always 1. */
  rates: Record<string, number>;
  /** When the provider last updated these rates. */
  asOf: string | null;
  /** True when the provider could not be reached and saved rates older than a day are used. */
  stale: boolean;
}

const SOURCE = 'open.er-api.com';
const REFRESH_MS = 6 * 3600_000;
let memory: { at: number; value: InrRates } | null = null;

/**
 * Current rupee rates for converting subscription costs. Order of preference: the in-memory copy
 * (up to 6 hours old), rates saved in the database within 6 hours, a fresh download (only the
 * currency codes are sent to the provider), and finally the last saved rates, marked stale.
 */
export async function inrRates(db: Db): Promise<InrRates> {
  if (memory && Date.now() - memory.at < REFRESH_MS) return memory.value;
  const saved = await db.query('SELECT currency, inr_per_unit::float8 AS rate, rate_date, fetched_at FROM exchange_rates');
  const newest = saved.reduce((m: number, r: any) => Math.max(m, new Date(r.fetched_at).getTime()), 0);
  const fromRows = (rows: any[], stale: boolean): InrRates => ({
    rates: { INR: 1, ...Object.fromEntries(rows.map((r: any) => [String(r.currency).trim(), Number(r.rate)])) },
    asOf: rows[0]?.rate_date ? new Date(rows[0].rate_date).toISOString() : null,
    stale,
  });
  if (saved.length && Date.now() - newest < REFRESH_MS) {
    memory = { at: Date.now(), value: fromRows(saved, false) };
    return memory.value;
  }
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/INR', { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
    if (!res.ok || body.result !== 'success' || !body.rates) throw new Error('rates unavailable');
    const asOf = body.time_last_update_unix ? new Date(body.time_last_update_unix * 1000).toISOString() : null;
    const rates: Record<string, number> = { INR: 1 };
    for (const code of SUPPORTED_CURRENCIES) {
      const perInr = body.rates[code];
      if (code === 'INR' || !perInr || perInr <= 0) continue;
      // The provider gives units per rupee; store rupees per unit.
      rates[code] = Math.round((1 / perInr) * 1e6) / 1e6;
      await db.query(
        `INSERT INTO exchange_rates(currency, inr_per_unit, rate_date, fetched_at, source) VALUES($1, $2, $3, now(), $4)
         ON CONFLICT (currency) DO UPDATE SET inr_per_unit = excluded.inr_per_unit, rate_date = excluded.rate_date,
           fetched_at = now(), source = excluded.source`,
        [code, rates[code], asOf, SOURCE],
      );
    }
    memory = { at: Date.now(), value: { rates, asOf, stale: false } };
    return memory.value;
  } catch {
    // Provider unreachable: use what we saved last, flagged as stale if more than a day old.
    const value = fromRows(saved, Date.now() - newest > 24 * 3600_000);
    memory = { at: Date.now() - REFRESH_MS + 15 * 60_000, value }; // try again in 15 minutes
    return value;
  }
}

/** Rupee amount for a cost, or null when the currency has no known rate. */
export function toInr(amount: number | null | undefined, currency: string, rates: Record<string, number>) {
  if (amount == null) return null;
  const rate = rates[currency?.trim().toUpperCase()];
  return rate ? Math.round(amount * rate * 100) / 100 : null;
}
