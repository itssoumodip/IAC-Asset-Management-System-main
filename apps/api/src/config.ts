import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
export const requestContext = new AsyncLocalStorage<{ id: string }>();
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
dotenv({ path: resolve(__dirname, '../../../.env'), quiet: true });
export const configuration = () => {
  const production = process.env.NODE_ENV === 'production';
  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
  const url = new URL(origin);
  if (url.origin !== origin || (production && url.protocol !== 'https:'))
    throw new Error('APP_ORIGIN must be an origin and use HTTPS in production');
  const origins = [
    ...new Set([
      origin,
      ...(process.env.ADDITIONAL_APP_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ];
  for (const allowedOrigin of origins) {
    const parsed = new URL(allowedOrigin);
    if (parsed.origin !== allowedOrigin || (production && parsed.protocol !== 'https:'))
      throw new Error('Every additional app origin must be an exact HTTPS origin in production');
  }
  return {
    production,
    origin,
    origins,
    port: Number(process.env.PORT || 3000),
    databaseUrl: process.env.DATABASE_URL || '',
    // Connections this process may hold. Keep (API instances + worker) x this below Postgres max_connections.
    databasePoolMax: boundedInt(process.env.DATABASE_POOL_MAX, 10, 2, 200),
    // How long an identical dashboard request is served from memory. Off outside production
    // so local edits and tests always read live numbers.
    dashboardCacheSeconds: boundedInt(process.env.DASHBOARD_CACHE_SECONDS, production ? 30 : 0, 0, 600),
    sessionCookie: production ? '__Host-iac_session' : 'iac_dev_session',
    csrfCookie: production ? '__Host-iac_csrf' : 'iac_dev_csrf',
    noticeVersion: process.env.PORTAL_NOTICE_VERSION || '1',
  };
};
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected a whole number between ${min} and ${max}`);
  return value;
}
/**
 * Master switch for anything that reaches people outside the portal (email, web push).
 * OFF unless OUTBOUND_NOTIFICATIONS=on: while the system is being tested, nobody may
 * receive mail or push from it. In-app notices inside the portal are unaffected.
 */
export function outboundNotificationsEnabled(): boolean {
  return process.env.OUTBOUND_NOTIFICATIONS?.trim().toLowerCase() === 'on';
}
export function isAllowedAppOrigin(value: string): boolean {
  const config = configuration();
  if (config.origins.includes(value)) return true;
  if (config.production) return false;

  try {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'http:' || url.port !== '5173') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]') return true;
    const octets = host.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return false;
    const first = octets[0]!;
    const second = octets[1]!;
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  } catch {
    return false;
  }
}
export function encryptionKey(name: string): Buffer {
  const value = process.env[name] || '';
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error(`${name} must contain 32 random bytes encoded as 64 hexadecimal characters`);
  return Buffer.from(value, 'hex');
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value: string, keyName: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyName), iv);
  return Buffer.concat([
    iv,
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export function decrypt(value: string, keyName: string): string {
  const data = Buffer.from(value, 'base64');
  if (data.length < 28) throw new Error('Invalid encrypted envelope');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyName), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(
    'utf8',
  );
}
export function signedCsrf(value = token()): string {
  return `${value}.${createHmac('sha256', encryptionKey('CSRF_SECRET')).update(value).digest('base64url')}`;
}
export function validCsrf(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  const raw = value.split('.')[0];
  return !!raw && equal(value, signedCsrf(raw));
}
