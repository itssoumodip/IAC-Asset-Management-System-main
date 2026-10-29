import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { StocktakeService } from '../src/stocktake';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Stocktake tests require _test DB');
process.env.DATABASE_URL = url;
const db = new Db(),
  service = new StocktakeService(db);
after(() => db.onModuleDestroy());
const req = (id: string, roles = ['ADMIN'], version = 1) =>
  ({
    user: { id, roles },
    get: (n: string) => (n.toLowerCase() === 'if-match' ? `"${version}"` : undefined),
  }) as AuthRequest;
test('stocktake freezes scope, retains corrections and discrepancies without changing inventory', async () => {
  const user = randomUUID(),
    dept = randomUUID();
  await db.query("INSERT INTO users(id,email,display_name)VALUES($1,$2,'Stocktake admin')", [
    user,
    `count-${user}@example.org`,
  ]);
  await db.query('INSERT INTO departments(id,code,name)VALUES($1,$2,$2)', [dept, `count-${dept}`]);
  const asset = async (department: string | null) => {
    const [a] = await db.query(
      "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by,department_id)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Frozen laptop','Owned','In Store','Good','Low',$1,$2)RETURNING *",
      [user, department],
    );
    return a;
  };
  const a = await asset(dept),
    extra = await asset(null),
    unobserved = await asset(dept);
  for (const role of ['EMPLOYEE', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE'])
    await assert.rejects(
      () => service.create(req(user, [role]), { name: 'Forbidden' }),
      /permission/,
    );
  const run = await service.create(req(user), {
    name: 'Operations physical count',
    departmentId: dept,
  });
  let d = await service.detail(req(user), run.id);
  assert.equal(d.summary.expected, 2);
  assert.equal(d.summary.unobserved, 2);
  assert.equal(d.items[0].snapshot.description, 'Frozen laptop');
  await db.query(
    "UPDATE assets SET description='Changed after snapshot',version=version+1 WHERE id=$1",
    [a.id],
  );
  const key = randomUUID(),
    body = {
      assetCode: a.asset_code,
      outcome: 'SEEN',
      note: 'Serial label checked physically',
      requestKey: key,
    };
  const o = await service.observe(req(user), run.id, body);
  assert.equal((await service.observe(req(user), run.id, body)).id, o.id);
  await assert.rejects(
    () => service.observe(req(user), run.id, { ...body, note: 'Different' }),
    /already used/,
  );
  await service.observe(req(user), run.id, {
    ...body,
    outcome: 'MISMATCH',
    note: 'Correction: serial does not match',
    requestKey: randomUUID(),
  });
  await service.observe(req(user), run.id, {
    assetCode: extra.asset_code,
    outcome: 'SEEN',
    note: 'Registered item outside department found',
    requestKey: randomUUID(),
  });
  d = await service.detail(req(user), run.id);
  assert.equal(d.summary.expected, 2);
  assert.equal(d.summary.seen, 0);
  assert.equal(d.summary.mismatch, 1);
  assert.equal(d.summary.extra, 1);
  assert.equal(d.summary.unobserved, 1);
  const item = d.items.find((i: any) => i.id === a.id);
  assert.equal(item.snapshot.description, 'Frozen laptop');
  assert.equal(item.expectedVersion, 1);
  assert.equal(item.currentVersion, 2);
  const h = await service.history(req(user), run.id, a.id, { limit: 1 });
  assert.equal(h.items.length, 1);
  assert(h.nextCursor);
  assert.equal(
    (await service.history(req(user), run.id, a.id, { limit: 1, after: h.nextCursor })).items
      .length,
    1,
  );
  assert.equal(
    (await service.history(req(user), run.id, extra.id, { after: h.nextCursor })).items.length,
    0,
  );
  await assert.rejects(
    () => db.query('UPDATE stocktake_expected SET asset_version=5 WHERE run_id=$1', [run.id]),
    /append only/,
  );
  await assert.rejects(
    () => db.query('DELETE FROM stocktake_observations WHERE id=$1', [o.id]),
    /append only/,
  );
  await assert.rejects(
    () => service.observe(req(user, ['ADMIN'], 99), run.id, { ...body, requestKey: randomUUID() }),
    /changed/,
  );
  await assert.rejects(
    () =>
      service.observe(req(user), run.id, {
        ...body,
        assetCode: 'UNKNOWN',
        requestKey: randomUUID(),
      }),
    /Registered asset/,
  );
  await service.close(req(user), run.id, {
    reason: 'Recorded discrepancies require separate investigation',
  });
  await assert.rejects(
    () => service.observe(req(user, ['ADMIN'], 2), run.id, { ...body, requestKey: randomUUID() }),
    /closed/,
  );
  assert.equal((await service.observe(req(user), run.id, body)).id, o.id);
  const [unchanged] = await db.query(
    'SELECT version,status,finance_pending FROM assets WHERE id=$1',
    [a.id],
  );
  assert.deepEqual(unchanged, { version: 2, status: 'In Store', finance_pending: true });
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM assignments WHERE asset_id=ANY($1::uuid[])', [
        [a.id, extra.id, unobserved.id],
      ])
    )[0].n,
    0,
  );
  const race = await service.create(req(user), {
    name: 'Concurrent close race',
    departmentId: dept,
  });
  const outcomes = await Promise.allSettled([
    service.observe(req(user), race.id, {
      assetCode: a.asset_code,
      outcome: 'SEEN',
      note: 'Concurrent observation',
      requestKey: randomUUID(),
    }),
    service.close(req(user), race.id, { reason: 'Concurrent close' }),
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal((await service.detail(req(user), race.id)).run.closedAt !== null, true);
  const ordered = await service.create(req(user), {
    name: 'Ordered correction',
    departmentId: dept,
  });
  await db.tx(async () => {
    await service.observe(req(user), ordered.id, {
      assetCode: a.asset_code,
      outcome: 'SEEN',
      note: 'First tied observation',
      requestKey: randomUUID(),
    });
    await service.observe(req(user), ordered.id, {
      assetCode: a.asset_code,
      outcome: 'MISMATCH',
      note: 'Second tied observation',
      requestKey: randomUUID(),
    });
  });
  const latest = await service.detail(req(user), ordered.id);
  assert.equal(latest.items.find((i: any) => i.id === a.id).outcome, 'MISMATCH');
  const scoped = await service.create(req(user), { name: 'Runtime count', departmentId: dept });
  await db.tx(async (c) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    await c.query(await readFile(resolve(__dirname, '../../../infra/runtime-grants.sql'), 'utf8'));
    await c.query('SET LOCAL ROLE iac_runtime');
    await service.observe(req(user), scoped.id, {
      assetCode: a.asset_code,
      outcome: 'SEEN',
      note: 'Runtime evidence',
      requestKey: randomUUID(),
    });
    await service.close(req(user), scoped.id, { reason: 'Scoped close' });
    await c.query('SAVEPOINT immutable');
    await assert.rejects(
      () => c.query('DELETE FROM stocktake_observations WHERE run_id=$1', [scoped.id]),
      (e: any) => e.code === '42501',
    );
    await c.query('ROLLBACK TO SAVEPOINT immutable');
  });
  const seen = new Set();
  let cursor: string | undefined;
  do {
    const page = await service.detail(req(user), run.id, {
      limit: 1,
      ...(cursor ? { after: cursor } : {}),
    });
    page.items.forEach((i: any) => {
      assert(!seen.has(i.id));
      seen.add(i.id);
    });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 3);
});

test('snapshot creation safely retries serialization abort without duplicate committed run', async () => {
  const user = randomUUID();
  await db.query("INSERT INTO users(id,email,display_name)VALUES($1,$2,'Snapshot retry')", [
    user,
    `retry-${user}@example.org`,
  ]);
  const original = db.query.bind(db);
  let injected = false;
  (db as any).query = async (sql: string, values: any[] = [], client?: any) => {
    if (!injected && sql.startsWith('INSERT INTO stocktake_expected')) {
      injected = true;
      const e: any = Error('synthetic serialization abort');
      e.code = '40001';
      throw e;
    }
    return original(sql, values, client);
  };
  try {
    const run = await service.create(req(user), { name: 'Retried snapshot' });
    assert(injected);
    assert.equal(
      (await original('SELECT count(*)::int n FROM stocktake_runs WHERE created_by=$1', [user]))[0]
        .n,
      1,
    );
    assert(run.id);
  } finally {
    (db as any).query = original;
  }
});

test('repeated snapshot serialization abort is bounded and leaves no count', async () => {
  const user = randomUUID();
  await db.query("INSERT INTO users(id,email,display_name)VALUES($1,$2,'Bounded retry')", [
    user,
    `retry-${user}@example.org`,
  ]);
  const original = db.query.bind(db);
  let calls = 0;
  (db as any).query = async (sql: string, values: any[] = [], client?: any) => {
    if (sql.startsWith('INSERT INTO stocktake_expected')) {
      calls++;
      const e: any = Error('synthetic serialization abort');
      e.code = '40001';
      throw e;
    }
    return original(sql, values, client);
  };
  try {
    await assert.rejects(
      () => service.create(req(user), { name: 'Never committed' }),
      /No count was saved/,
    );
    assert.equal(calls, 3);
    assert.equal(
      (await original('SELECT count(*)::int n FROM stocktake_runs WHERE created_by=$1', [user]))[0]
        .n,
      0,
    );
  } finally {
    (db as any).query = original;
  }
});
