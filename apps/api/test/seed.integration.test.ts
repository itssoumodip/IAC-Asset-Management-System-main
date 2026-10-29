import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Db } from '../src/db';
import { migrate, seed } from '../src/cli';
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Seed test requires an isolated _test database');
test('fresh migration and concurrent repeated seed preserve exactly four coherent items without accounts', async () => {
  const owner = new Pool({ connectionString: connection });
  const schema = `seed_${randomUUID().replaceAll('-', '')}`;
  const original = process.env.DATABASE_URL;
  let db: Db | undefined;
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    db = new Db();
    await migrate(db);
    await migrate(db);
    assert.equal((await db.query('SELECT count(*) FROM schema_migrations'))[0].count, '23');
    await seed(db);
    const first = await db.query('SELECT id,asset_code,asset_type FROM assets ORDER BY asset_type');
    assert.deepEqual(
      first.map((a) => a.asset_type),
      ['Keyboard', 'Laptop', 'Monitor', 'Mouse'],
    );
    const laptop = first.find((a) => a.asset_type === 'Laptop')!;
    await db.query(
      "UPDATE assets SET remarks='Synthetic presenter note',version=version+1 WHERE id=$1",
      [laptop.id],
    );
    await Promise.all([seed(db), seed(db)]);
    assert.deepEqual(
      await db.query('SELECT id,asset_code,asset_type FROM assets ORDER BY asset_type'),
      first,
    );
    assert.equal(
      (await db.query('SELECT remarks FROM assets WHERE id=$1', [laptop.id]))[0].remarks,
      'Synthetic presenter note',
    );
    assert.equal((await db.query('SELECT count(*) FROM users'))[0].count, '0');
    assert.equal((await db.query('SELECT count(*) FROM assignments'))[0].count, '0');
    assert.equal((await db.query('SELECT count(*) FROM notification_outbox'))[0].count, '0');
    assert.equal(
      (await db.query("SELECT count(*) FROM audit_events WHERE action='SYNTHETIC_SEED'"))[0].count,
      '4',
    );
    const mapped = await db.query(
      "SELECT count(*) FROM assets a JOIN departments d ON d.id=a.department_id JOIN locations l ON l.id=a.location_id WHERE d.code='DEMO_IT' AND l.code='DEMO_OFFICE' AND a.status='In Store'",
    );
    assert.equal(mapped[0].count, '4');
  } finally {
    await db?.onModuleDestroy();
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
});
