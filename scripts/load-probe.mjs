// Synthetic disposable local HTTP probe. Not a capacity/SLA certification.
import { config } from 'dotenv';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
config({ quiet: true });
const source = new URL(process.env.TEST_DATABASE_URL || 'invalid:');
if (
  !['postgres:', 'postgresql:'].includes(source.protocol) ||
  !source.pathname.endsWith('_test') ||
  source.search ||
  !['127.0.0.1', 'localhost'].includes(source.hostname)
)
  throw new Error('Loopback isolated _test source required');
const name = `iac_load_${randomBytes(5).toString('hex')}_test`,
  adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.toString() });
const target = new URL(source);
target.pathname = '/' + name;
let created = false,
  pool,
  app;
const hash = (s) => createHash('sha256').update(s).digest('hex');
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = target.toString();
  process.env.TEST_DATABASE_URL = target.toString();
  process.env.MIGRATION_DATABASE_URL = target.toString();
  const migration = spawnSync('npm', ['run', 'db:migrate'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 60000,
  });
  if (migration.status !== 0) throw new Error('Disposable migration failed');
  pool = new Pool({ connectionString: target.toString() });
  const identities = [];
  for (const role of ['ADMIN', 'FINANCE', 'EXECUTIVE', 'EMPLOYEE', 'IT_ADMIN']) {
    const id = randomUUID(),
      session = randomBytes(32).toString('hex'),
      raw = randomBytes(24).toString('hex');
    const csrf =
      raw +
      '.' +
      createHmac('sha256', Buffer.from(process.env.CSRF_SECRET, 'hex'))
        .update(raw)
        .digest('base64url');
    await pool.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1',now())",
      [id, `synthetic-${id}@example.org`, `Synthetic ${role}`],
    );
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
    await pool.query(
      "INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 hour',now())",
      [hash(session), id, hash(csrf)],
    );
    identities.push({ id, session, csrf, role });
  }
  const [registrar, finance, executive, employee, it] = identities;
  await pool.query(
    `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)
  SELECT 'IAC-IT-'||lpad(n::text,6,'0'),'IT Hardware','Laptop','Synthetic mixed-load device '||n,'Owned','In Store','Good','Low',$1 FROM generate_series(1,50000)n`,
    [registrar.id],
  );
  const assets = (
    await pool.query('SELECT id,asset_code FROM assets ORDER BY asset_code LIMIT 1000')
  ).rows;
  await pool.query(
    "INSERT INTO asset_finance(asset_id,state,asset_version,submitted_by,submission_reason) SELECT id,'SUBMITTED',version,$1,'Synthetic load submission' FROM assets ORDER BY asset_code LIMIT 1000",
    [registrar.id],
  );
  await pool.query(
    "INSERT INTO asset_finance_events(asset_id,action,actor_id,reason,finance_version) SELECT id,'SUBMITTED',$1,'Synthetic load evidence',1 FROM assets ORDER BY asset_code LIMIT 1000",
    [registrar.id],
  );
  await pool.query('ANALYZE');
  const restricted = process.argv.includes('--runtime-role');
  if (restricted) {
    await pool.query(
      await readFile(new URL('../infra/runtime-grants.sql', import.meta.url), 'utf8'),
    );
    const runtimeUrl = new URL(target);
    runtimeUrl.searchParams.set('options', '-c role=iac_runtime');
    process.env.DATABASE_URL = runtimeUrl.toString();
  }
  const { createApp } = require('../apps/api/dist/main.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  if (restricted) {
    const { Db } = require('../apps/api/dist/db.js');
    const runtime = app.get(Db);
    const [role] = await runtime.query('SELECT current_user AS name');
    if (role.name !== 'iac_runtime') throw new Error('API did not enter restricted runtime role');
    const response = await fetch(base + `/finance/assets/${assets[0].id}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: process.env.APP_ORIGIN || 'http://127.0.0.1:5173',
        Cookie: `iac_dev_session=${finance.session}; iac_dev_csrf=${finance.csrf}`,
        'X-CSRF-Token': finance.csrf,
        'If-Match': '"1"',
      },
      body: JSON.stringify({
        decision: 'APPROVE',
        reason: 'Synthetic restricted HTTP review',
        purchaseCost: '1234.50',
        purchaseDate: '2026-01-05',
        invoiceNumber: 'SYNTHETIC-ROLE-1',
        supplier: 'Synthetic Supplier',
      }),
    });
    const body = await response.json();
    if (response.status !== 201 || body.state !== 'APPROVED')
      throw new Error('Restricted HTTP Finance approval failed');
    const [evidence] = (
      await pool.query('SELECT count(*)::int AS n FROM asset_finance_events WHERE asset_id=$1', [
        assets[0].id,
      ])
    ).rows;
    if (evidence.n !== 2) throw new Error('Restricted HTTP approval evidence missing');
  }
  const cases = [
    [registrar, '/assets?limit=25', 200],
    [registrar, '/assets?q=25000&limit=25', 200],
    [finance, '/finance/queue?state=SUBMITTED&limit=25', 200],
    [executive, '/finance/executive-summary', 200],
    [finance, `/finance/assets/${assets[0].id}/history`, 200],
    [employee, '/equipment/people', 403],
    [it, '/finance/queue', 403],
    [employee, `/finance/assets/${assets[0].id}`, 403],
  ];
  const measurements = cases.map(([, path, status]) => ({
    path,
    expected: status,
    ms: [],
    errors: 0,
  }));
  const start = performance.now();
  let counter = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (performance.now() - start < 10000) {
        const i = counter++ % cases.length,
          [user, path, expected] = cases[i],
          t = performance.now();
        try {
          const r = await fetch(base + path, {
            headers: { Cookie: `iac_dev_session=${user.session}; iac_dev_csrf=${user.csrf}` },
            signal: AbortSignal.timeout(10000),
          });
          const body = await r.json();
          let valid = r.status === expected;
          if (valid && expected === 200) {
            if (path.includes('executive-summary'))
              valid =
                body.totalAssets === 50000 && body.pendingReviews === (restricted ? 999 : 1000);
            else if (path.endsWith('/history'))
              valid = Array.isArray(body.items) && body.items.length === (restricted ? 2 : 1);
            else
              valid = Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 25;
          }
          if (valid && expected === 403) valid = body.error?.code === 'FORBIDDEN';
          if (!valid) measurements[i].errors++;
        } catch {
          measurements[i].errors++;
        }
        measurements[i].ms.push(performance.now() - t);
      }
    }),
  );
  const elapsed = performance.now() - start;
  const results = measurements.map(({ ms, ...m }) => {
    ms.sort((a, b) => a - b);
    return {
      ...m,
      requests: ms.length,
      medianMs: ms[Math.floor(ms.length * 0.5)],
      p95Ms: ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)],
      maxMs: ms.at(-1),
    };
  });
  const errorCount = results.reduce((s, r) => s + r.errors, 0);
  let mixed;
  if (process.argv.includes('--mixed')) {
    const { default: Excel } = await import('exceljs');
    const wb = new Excel.Workbook();
    const ws = wb.addWorksheet('Invoice');
    ws.addRow(['Supplier', 'Synthetic Systems']);
    ws.addRow(['Invoice Number', 'LOAD-1042']);
    ws.addRow(['Invoice Date', '2026-10-28']);
    ws.addRow(['Grand Total', 'INR 1234.50']);
    const invoice = {
      filename: 'Synthetic-invoice.xlsx',
      data: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'),
    };
    let failures = 0,
      readCount = 0,
      done = false;
    const timings = [];
    async function write(user, path, body, version) {
      const t = performance.now();
      const r = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: process.env.APP_ORIGIN || 'http://127.0.0.1:5173',
          Cookie: `iac_dev_session=${user.session}; iac_dev_csrf=${user.csrf}`,
          'X-CSRF-Token': user.csrf,
          ...(version ? { 'If-Match': `"${version}"` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const result = await r.json();
      timings.push(performance.now() - t);
      if (r.status !== 201) throw Error('Mixed mutation failed ' + r.status);
      return result;
    }
    const startMixed = performance.now();
    const readers = Array.from({ length: 10 }, async () => {
      while (!done) {
        try {
          const r = await fetch(base + '/finance/executive-summary', {
            headers: { Cookie: `iac_dev_session=${executive.session}` },
            signal: AbortSignal.timeout(30000),
          });
          const b = await r.json();
          if (r.status !== 200 || b.totalAssets !== 50000 || b.activity.length !== 12) failures++;
          readCount++;
        } catch {
          failures++;
        }
      }
    });
    try {
      const writes = await Promise.allSettled([
        ...Array.from({ length: 5 }, (_, worker) =>
          (async () => {
            for (let n = 0; n < 5; n++) {
              const a = assets[10 + worker * 5 + n];
              const b = await write(
                finance,
                `/finance/assets/${a.id}/review`,
                {
                  decision: 'APPROVE',
                  reason: 'Synthetic concurrent mixed load review',
                  purchaseCost: '1234.50',
                  purchaseDate: '2026-10-28',
                  invoiceNumber: 'MIXED-' + n,
                  supplier: 'Synthetic Systems',
                },
                1,
              );
              if (b.state !== 'APPROVED') throw Error('Approval state mismatch');
            }
          })(),
        ),
        ...Array.from({ length: 2 }, (_, worker) =>
          (async () => {
            for (let n = 0; n < 3; n++) {
              const a = assets[100 + worker * 3 + n];
              const b = await write(finance, `/finance/assets/${a.id}/invoices`, invoice, 1);
              if (b.suggestions.purchaseCost?.value !== '1234.50')
                throw Error('Invoice extraction mismatch');
            }
          })(),
        ),
        (async () => {
          const run = await write(registrar, '/stocktake', {
            name: 'Synthetic concurrent 50k snapshot',
          });
          for (let n = 0; n < 5; n++)
            await write(
              registrar,
              `/stocktake/${run.id}/observations`,
              {
                assetCode: assets[200 + n].asset_code,
                outcome: 'SEEN',
                note: 'Synthetic workload observation, not a physical count',
                requestKey: randomUUID(),
              },
              1,
            );
          await write(
            registrar,
            `/stocktake/${run.id}/close`,
            { reason: 'Synthetic workload completed' },
            1,
          );
          const [count] = (
            await pool.query('SELECT count(*)::int n FROM stocktake_expected WHERE run_id=$1', [
              run.id,
            ])
          ).rows;
          if (count.n !== 50000) throw Error('Stocktake snapshot count mismatch');
        })(),
      ]);
      const rejected = writes.find((r) => r.status === 'rejected');
      if (rejected) throw rejected.reason;
    } catch (e) {
      failures++;
      throw e;
    } finally {
      done = true;
      await Promise.all(readers);
    }
    const [approved] = (
      await pool.query("SELECT count(*)::int n FROM asset_finance WHERE state='APPROVED'")
    ).rows;
    const [invoices] = (await pool.query('SELECT count(*)::int n FROM finance_invoice_evidence'))
      .rows;
    if (approved.n !== (restricted ? 26 : 25) || invoices.n !== 6)
      throw Error('Mixed persisted reconciliation failed');
    timings.sort((a, b) => a - b);
    mixed = {
      durationMs: performance.now() - startMixed,
      readers: 10,
      readCount,
      mutationCount: timings.length,
      writeP95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
      failures,
      financeApprovals: 25,
      invoiceExtractions: 6,
      stocktakeExpected: 50000,
      observations: 5,
      persistedReconciled: true,
    };
  }
  const evidence = (await pool.query('SELECT count(*)::int AS n FROM asset_finance_events')).rows[0]
    .n;
  if (evidence !== (restricted ? 1001 : 1000) + (mixed ? 25 : 0))
    throw new Error('Read-only workload changed Finance evidence');
  console.log(
    JSON.stringify(
      {
        restrictedRuntimeRole: restricted,
        mixed,
        scope:
          '20 concurrent local HTTP readers over50000synthetic assets and1000Finance records; optional restricted-role run first performs one synthetic Finance approval; followed by optional bounded mixed approval/invoice/stocktake workload; no production traffic or SMTP',
        durationMs: elapsed,
        totalRequests: counter,
        errorCount,
        results,
        financeEvidenceUnchangedByReads: true,
        limits:
          'Local PostgreSQL14/Node24 warm run. Optional mixed slice is small and bounded, not sustained production capacity, WAN latency, broad write contention, large photos/imports, availability or an SLA.',
      },
      null,
      2,
    ),
  );
  if (errorCount) process.exitCode = 1;
} finally {
  await app?.close();
  await pool?.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
