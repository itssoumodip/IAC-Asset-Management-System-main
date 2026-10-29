import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Database limits tests require isolated _test DB');
process.env.DATABASE_URL = url;
const db = new Db();
after(() => db.onModuleDestroy());
test('runtime sessions bound active statements, lock waits and idle transactions', async () => {
  const [row] = await db.query(
    "SELECT current_setting('statement_timeout') statement,current_setting('lock_timeout') lock,current_setting('idle_in_transaction_session_timeout') idle",
  );
  assert.deepEqual(row, { statement: '30s', lock: '5s', idle: '30s' });
});
test('a timed-out transaction rolls back writes and returns a usable pool connection', async () => {
  const marker = `timeout-${crypto.randomUUID()}@example.org`;
  await assert.rejects(
    () =>
      db.tx(async (c) => {
        await db.query("SET LOCAL statement_timeout='20ms'", [], c);
        await db.query(
          "INSERT INTO users(email,display_name)VALUES($1,'Synthetic timeout rollback')",
          [marker],
          c,
        );
        await db.query('SELECT pg_sleep(0.1)', [], c);
      }),
    (e: any) => e.code === '57014',
  );
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM users WHERE email=$1', [marker]))[0].n,
    0,
  );
  assert.equal((await db.query('SELECT 1 n'))[0].n, 1);
});
test('lock timeout rolls back without bypassing the contended lock', async () => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(715029)');
    await assert.rejects(
      () =>
        db.tx(async (other) => {
          await db.query("SET LOCAL lock_timeout='20ms'", [], other);
          await db.query('SELECT pg_advisory_xact_lock(715029)', [], other);
        }),
      (e: any) => e.code === '55P03',
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  await db.tx((c) => db.query('SELECT pg_advisory_xact_lock(715029)', [], c));
});
