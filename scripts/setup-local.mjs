import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(target)) {
  console.log('.env already exists; preserved.');
  process.exit(0);
}
const password = randomBytes(24).toString('hex');
writeFileSync(
  target,
  `NODE_ENV=development
PORT=3000
APP_ORIGIN=http://127.0.0.1:5173
DB_PORT=55432
DB_PASSWORD=${password}
DATABASE_URL=postgresql://iac_local:${password}@127.0.0.1:55432/iac_dev
MIGRATION_DATABASE_URL=postgresql://iac_local:${password}@127.0.0.1:55432/iac_dev
TEST_DATABASE_URL=postgresql://iac_local:${password}@127.0.0.1:55432/iac_test
SMTP_HOST=127.0.0.1
SMTP_PORT=11025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=IAC Asset Portal <assets@example.org>
TOTP_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}
AUTH_MAIL_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}
CSRF_SECRET=${randomBytes(32).toString('hex')}
`,
  { mode: 0o600 },
);
console.log('Created local .env with generated secrets. Values were not printed.');
