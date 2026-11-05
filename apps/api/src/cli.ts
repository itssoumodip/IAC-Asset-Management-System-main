import 'reflect-metadata';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { configuration } from './config';
import { passwordHash } from './auth';
import { seedScale } from './scale-seed';
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
export type BootstrapInput = { email: string; displayName: string; hashedPassword: string };

/**
 * Creates the first Super Admin. A Zoho People sync creates everyone as a DIRECTORY
 * stub with no password, so the operator's own email may already exist. Adopt that
 * stub instead of failing on the unique email constraint.
 */
export async function bootstrapAdmin(
  db: Db,
  input: BootstrapInput,
  client?: PoolClient,
): Promise<{ id: string; email: string; adopted: boolean }> {
  const run = async (c: PoolClient) => {
    await db.query('SELECT pg_advisory_xact_lock(715023)', [], c);
    if (
      (
        await db.query(
          "SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='SUPER_ADMIN' AND u.state='ACTIVE'",
          [],
          c,
        )
      )[0]
    )
      throw new Error('An active Admin already exists. Use administrator user controls.');

    const [existing] = await db.query(
      'SELECT id,state,left_at FROM users WHERE email=$1 FOR UPDATE',
      [input.email],
      c,
    );

    let id: string;
    if (!existing) {
      const [created] = await db.query(
        "INSERT INTO users(email,display_name,password_hash,state,email_verified_at) VALUES($1,$2,$3,'ACTIVE',now()) RETURNING id",
        [input.email, input.displayName, input.hashedPassword],
        c,
      );
      id = created.id;
    } else if (existing.state === 'DIRECTORY' && !existing.left_at) {
      const [adopted] = await db.query(
        `UPDATE users SET password_hash=$2,display_name=$3,state='ACTIVE',email_verified_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING id`,
        [existing.id, input.hashedPassword, input.displayName],
        c,
      );
      id = adopted.id;
    } else if (existing.left_at) {
      throw new Error('This person has left. Ask an administrator to restore the account.');
    } else if (existing.state === 'ACTIVE') {
      throw new Error('This email is already in use by an active account.');
    } else if (existing.state === 'DISABLED') {
      throw new Error('This email belongs to a disabled account.');
    } else {
      throw new Error('This email already has a pending invitation.');
    }

    await db.query(
      "INSERT INTO user_roles(user_id,role_code) VALUES($1,'SUPER_ADMIN'),($1,'EMPLOYEE') ON CONFLICT DO NOTHING",
      [id],
      c,
    );
    await db.query(
      'INSERT INTO approved_emails(email) VALUES($1) ON CONFLICT DO NOTHING',
      [input.email],
      c,
    );
    await db.audit(c, null, 'USER', id, 'OPERATOR_BOOTSTRAP', {
      adoptedDirectoryRecord: Boolean(existing),
    });
    return { id, email: input.email, adopted: Boolean(existing) };
  };
  return client ? run(client) : db.tx(run);
}

async function bootstrap(db: Db) {
  if (!process.stdin.isTTY)
    throw new Error(
      'The prompts need an interactive terminal. Open a PowerShell window in the project folder and run this command there (not from a task runner or an editor "Run" button).',
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let email: string, name: string;
  try {
    const rawEmail = await rl.question('Administrator email: ');
    if (!rawEmail.trim()) throw new Error('No email was entered.');
    email = z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(254)
      .parse(rawEmail);
    const rawName = await rl.question('Display name: ');
    if (!rawName.trim()) throw new Error('No display name was entered.');
    name = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse(rawName);
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
  const result = await bootstrapAdmin(db, { email, displayName: name, hashedPassword: hashed });
  process.stdout.write(
    result.adopted
      ? 'Administrator created from the existing Zoho directory record. Sign in, enroll MFA, and accept the portal notice.\n'
      : 'Administrator created. Sign in, enroll MFA, and accept the portal notice.\n',
  );
}
async function seed(db: Db) {
  if (configuration().production) throw new Error('Synthetic seeding is disabled in production');
  const target = new URL(configuration().databaseUrl);
  if (
    !['127.0.0.1', 'localhost', 'postgres'].includes(target.hostname) ||
    !target.pathname.match(/(?:_dev|_test)$/)
  )
    throw new Error('Synthetic seeding requires a local database name ending _dev or _test');
  await db.tx(async (c) => {
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
    for (const type of ['Laptop', 'Monitor']) {
      const [asset] = await db.query(
        "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,location_id) SELECT 'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',$1,$2,'Owned','In Store','Good','Low',(SELECT id FROM departments WHERE code='DEMO_IT'),(SELECT id FROM locations WHERE code='DEMO_OFFICE') RETURNING id",
        [type, `Synthetic demonstration ${type.toLowerCase()}`],
        c,
      );
      await db.audit(c, null, 'ASSET', asset.id, 'SYNTHETIC_SEED');
    }
  });
  process.stdout.write(
    'Synthetic departments, location, and two assets created. No sample accounts or passwords were created.\n',
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
      case 'seed-scale':
        await seedScale(db, { tag: process.env.SCALE_TAG });
        break;
      case 'seed':
        await seed(db);
        break;
      default:
        throw new Error('Usage: cli.ts migrate [--test] | bootstrap | seed | seed-scale --test');
    }
  } finally {
    await db.onModuleDestroy();
  }
}
if (require.main === module) {
  void main().catch((error) => {
    const message =
      error instanceof z.ZodError
        ? `Invalid ${error.issues[0]?.path.join('.') || 'input'}: ${error.issues[0]?.message}`
        : (error as Error).message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
