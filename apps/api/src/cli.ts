import 'reflect-metadata';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { Db } from './db';
import { configuration } from './config';
import { passwordHash } from './auth';
export async function migrate(db: Db): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(715024)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const folder = resolve(__dirname, '../db/migrations');
    for (const file of (await readdir(folder)).filter((v) => v.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT name FROM schema_migrations WHERE name=$1', [file])).rowCount)
        continue;
      const sql = (await readFile(resolve(folder, file), 'utf8'))
        .replace(/^\uFEFF/, '')
        .replace(/^BEGIN;\s*/m, '')
        .replace(/COMMIT;\s*$/m, '');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(715024)');
    client.release();
  }
}
async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Use an interactive terminal; passwords are never accepted in command arguments or environment variables',
    );
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write(prompt);
    hidden = true;
    const answer = await rl.question('');
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}
async function bootstrap(db: Db) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let email: string, name: string;
  try {
    email = z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(254)
      .parse(await rl.question('Administrator email: '));
    name = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse(await rl.question('Display name: '));
  } finally {
    rl.close();
  }
  const pass = z
    .string()
    .min(12)
    .max(128)
    .parse(await secret('Password (12+ characters; hidden): '));
  if ((await secret('Confirm password (hidden): ')) !== pass)
    throw new Error('Passwords do not match');
  const hashed = await passwordHash(pass);
  await db.tx(async (c) => {
    await db.query('SELECT pg_advisory_xact_lock(715023)', [], c);
    if (
      (
        await db.query(
          "SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='ADMIN' AND u.state='ACTIVE'",
          [],
          c,
        )
      )[0]
    )
      throw new Error('An active Admin already exists. Use administrator user controls.');
    const [user] = await db.query(
      "INSERT INTO users(email,display_name,password_hash,state,email_verified_at) VALUES($1,$2,$3,'ACTIVE',now()) RETURNING id",
      [email, name, hashed],
      c,
    );
    await db.query(
      "INSERT INTO user_roles(user_id,role_code) VALUES($1,'ADMIN'),($1,'EMPLOYEE')",
      [user.id],
      c,
    );
    await db.query(
      'INSERT INTO approved_emails(email) VALUES($1) ON CONFLICT DO NOTHING',
      [email],
      c,
    );
    await db.audit(c, null, 'USER', user.id, 'OPERATOR_BOOTSTRAP');
  });
  process.stdout.write(
    'Administrator created. Sign in, enroll MFA, and accept the portal notice.\n',
  );
}
export async function seed(db: Db) {
  if (configuration().production) throw new Error('Synthetic seeding is disabled in production');
  const target = new URL(configuration().databaseUrl);
  if (
    !['127.0.0.1', 'localhost', 'postgres'].includes(target.hostname) ||
    !target.pathname.match(/(?:_dev|_test)$/)
  )
    throw new Error('Synthetic seeding requires a local database name ending _dev or _test');
  await db.tx(async (c) => {
    await db.query('SELECT pg_advisory_xact_lock(715025)', [], c);
    await db.query(
      "INSERT INTO departments(code,name) VALUES('DEMO_IT','Demo IT'),('DEMO_OPS','Demo Operations') ON CONFLICT DO NOTHING",
      [],
      c,
    );
    await db.query(
      "INSERT INTO locations(code,site,floor,room) VALUES('DEMO_OFFICE','Synthetic office','1','Demo room') ON CONFLICT DO NOTHING",
      [],
      c,
    );
    for (const type of ['Laptop', 'Monitor', 'Mouse', 'Keyboard']) {
      const existing = await db.query(
        `SELECT a.id FROM assets a JOIN audit_events e ON e.entity_id=a.id AND e.action='SYNTHETIC_SEED' WHERE a.description=$1 AND a.asset_type=$2 AND a.department_id=(SELECT id FROM departments WHERE code='DEMO_IT') LIMIT 1`,
        [`Synthetic demonstration ${type.toLowerCase()}`, type],
        c,
      );
      if (existing.length) continue;
      const [asset] = await db.query(
        "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,location_id) SELECT 'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',$1,$2,'Owned','In Store','Good','Low',(SELECT id FROM departments WHERE code='DEMO_IT'),(SELECT id FROM locations WHERE code='DEMO_OFFICE') RETURNING id",
        [type, `Synthetic demonstration ${type.toLowerCase()}`],
        c,
      );
      await db.audit(c, null, 'ASSET', asset.id, 'SYNTHETIC_SEED');
    }
  });
  process.stdout.write(
    'Synthetic demo dataset ready: departments, location and laptop/monitor/mouse/keyboard. Existing seed items preserved; no accounts or passwords created.\n',
  );
}
async function main() {
  if (process.argv[2] === 'migrate' && process.env.MIGRATION_DATABASE_URL)
    process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
  if (process.argv.includes('--test')) {
    if (
      !process.env.TEST_DATABASE_URL ||
      !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
    )
      throw new Error('TEST_DATABASE_URL must select a database name ending _test');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  const db = new Db();
  try {
    switch (process.argv[2]) {
      case 'migrate':
        await migrate(db);
        break;
      case 'bootstrap':
        await bootstrap(db);
        break;
      case 'seed':
        await seed(db);
        break;
      default:
        throw new Error('Usage: cli.ts migrate [--test] | bootstrap | seed');
    }
  } finally {
    await db.onModuleDestroy();
  }
}
if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof z.ZodError ? 'Invalid input' : (error as Error).message}\n`,
    );
    process.exitCode = 1;
  });
}
