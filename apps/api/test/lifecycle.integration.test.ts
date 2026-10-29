import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { LifecycleService } from '../src/lifecycle';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('Lifecycle requires _test DB');
process.env.DATABASE_URL = url;
const db = new Db(),
  service = new LifecycleService(db);
after(() => db.onModuleDestroy());
const req = (id: string, roles = ['ADMIN']) => ({ user: { id, roles } }) as AuthRequest;
test('coverage date boundaries, AMC applicability and role-changed custody stay evidence-only', async () => {
  const id = randomUUID(),
    employee = randomUUID();
  for (const [u, state] of [
    [id, 'ACTIVE'],
    [employee, 'DISABLED'],
  ])
    await db.query('INSERT INTO users(id,email,display_name,state)VALUES($1,$2,$3,$4)', [
      u,
      `life-${u}@example.org`,
      `Lifecycle ${u}`,
      state,
    ]);
  const [t] = await db.query("SELECT(now() AT TIME ZONE 'Asia/Kolkata')::date today");
  const make = async (warranty: number | null, amc: boolean, days: number | null) => {
    const [a] = await db.query(
      "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by,warranty_expiry,amc_applies,amc_expiry)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Lifecycle boundary','Owned','In Store','Good','Low',$1,$2::date+$3::int,$4,$2::date+$5::int)RETURNING *",
      [id, t.today, warranty, amc, days],
    );
    return a;
  };
  const today = await make(0, false, null),
    day30 = await make(30, false, null),
    day31 = await make(31, true, -1),
    day90 = await make(90, true, 90),
    missing = await make(null, true, null),
    ignoredAmc = await make(200, false, null);
  for (const role of ['EMPLOYEE', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE']) {
    await assert.rejects(() => service.expiry(req(id, [role])), /permission/);
    await assert.rejects(() => service.recovery(req(id, [role])), /permission/);
  }
  const all = async (window: string) => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const p = await service.expiry(req(id), {
        window,
        limit: 1,
        ...(cursor ? { after: cursor } : {}),
      });
      assert.equal(p.today, t.today);
      p.items.forEach((a: any) => {
        assert(!ids.has(a.id));
        ids.add(a.id);
      });
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  };
  const due = await all('DUE30');
  assert(due.has(today.id));
  assert(due.has(day30.id));
  assert(!due.has(day31.id));
  assert(!due.has(day90.id));
  assert(!due.has(missing.id));
  const expired = await all('EXPIRED');
  assert(expired.has(day31.id));
  assert(!expired.has(ignoredAmc.id));
  assert(!expired.has(today.id));
  const due90 = await all('DUE90');
  assert(due90.has(day90.id));
  const noDates = await all('MISSING');
  assert(noDates.has(missing.id));
  assert(!noDates.has(ignoredAmc.id));
  await db.query('INSERT INTO assignments(asset_id,user_id,assigned_by)VALUES($1,$2,$3)', [
    today.id,
    employee,
    id,
  ]);
  const p = await service.recovery(req(id), { q: `life-${employee}@example.org` });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].state, 'DISABLED');
  assert.equal(p.items[0].outstanding, 1);
  assert.match(p.definition, /not a list of confirmed leavers/);
  assert.equal(
    (await db.query('SELECT version,status FROM assets WHERE id=$1', [today.id]))[0].version,
    1,
  );
});
