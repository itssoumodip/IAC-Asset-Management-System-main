import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { Db } from './db';
import { assertTestDatabase, seedScale } from './scale-seed';
import { DomainService } from './domain';
import { AdminDashboardService } from './admin-dashboard';
import { ExecutiveDashboardService } from './executive-dashboard';
import { refreshDashboardSummary } from './dashboard-summary';
import type { AuthRequest } from './security';

const ASSETS = 100_000;
const TICKETS = 20_000;
const RUNS = 30;
/** Raised inside the transaction so everything the probe seeds is rolled back. */
class Rollback extends Error {}

interface Result {
  name: string;
  p95: number;
  median: number;
  target: number;
}

export function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

async function measure(
  name: string,
  target: number,
  run: (i: number) => Promise<unknown>,
): Promise<Result> {
  await run(0); // warm-up: plan cache and buffers
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { name, p95: p95(samples), median: sorted[Math.floor(sorted.length / 2)]!, target };
}

export async function main(): Promise<number> {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DASHBOARD_SUMMARY = 'on';
  assertTestDatabase(process.env.TEST_DATABASE_URL);
  const db = new Db();
  const results: Result[] = [];
  const req = {
    user: {
      id: '00000000-0000-4000-8000-0000000000ff',
      roles: ['SUPER_ADMIN'],
      teams: [],
    },
  } as unknown as AuthRequest;
  if (process.env.PROBE_TRACE) {
    // PROBE_TRACE=1 prints every statement slower than 40 ms, to find what a slow endpoint runs.
    const original = db.query.bind(db);
    db.query = async (sql: string, values?: any[], client?: any) => {
      const started = performance.now();
      const rows = await original(sql, values, client);
      const ms = performance.now() - started;
      if (ms > 40) process.stdout.write(`  [slow ${ms.toFixed(0)} ms] ${sql.replace(/\s+/g, ' ').slice(0, 110)}\n`);
      return rows;
    };
  }
  try {
    await db
      .tx(async () => {
        const seedStart = performance.now();
        // Bulk-building the trigram indexes after the load is much faster than maintaining them
        // row by row; the end state is identical and all of it is rolled back.
        const trigram = await db.query(
          `SELECT indexname,indexdef FROM pg_indexes WHERE tablename='assets' AND indexdef LIKE '%gin_trgm_ops%'`,
        );
        if (trigram.length < 3) throw new Error('Missing trigram indexes from migration 043');
        for (const index of trigram) await db.query(`DROP INDEX "${index.indexname}"`);
        // A shared test database can hold codes numbered near 999999 left by other suites, and
        // the seed numbers on from the highest one; move those aside (rolled back) so 100k fit.
        await db.query('ALTER TABLE assets DISABLE TRIGGER USER'); // asset_code is immutable
        await db.query(
          `UPDATE assets a SET asset_code='IAC-OLD-'||lpad(r.n::text,6,'0') FROM (
             SELECT id,row_number() OVER (ORDER BY id) AS n FROM assets
             WHERE asset_code ~ '^IAC-[A-Z]+-[0-9]{6}$' AND right(asset_code,6)::int>=500000) r
           WHERE a.id=r.id`,
        );
        await db.query('ALTER TABLE assets ENABLE TRIGGER USER');
        await seedScale(db, { tag: 'probe', assets: ASSETS, tickets: TICKETS });
        await db.query(
          `UPDATE assets SET serial_number='SN-'||upper(substr(md5(asset_code),1,10)) WHERE description LIKE 'scale:probe %'`,
        );
        for (const index of trigram) await db.query(index.indexdef);
        await db.query('ANALYZE assets');
        process.stdout.write(
          `Seeded ${ASSETS} assets and ${TICKETS} tickets in ${((performance.now() - seedStart) / 1000).toFixed(1)}s (rolled back at the end).\n`,
        );
        const refreshStart = performance.now();
        await refreshDashboardSummary(db);
        process.stdout.write(
          `Dashboard summary refresh (all scopes): ${(performance.now() - refreshStart).toFixed(0)} ms (worker, every 5 min).\n`,
        );

        const domain = new DomainService(db);
        const admin = new AdminDashboardService(db);
        const executive = new ExecutiveDashboardService(db);
        const sample: { id: string; asset_code: string; serial_number: string }[] =
          await db.query(
            `SELECT id,asset_code,serial_number FROM assets WHERE description LIKE 'scale:probe %' AND serial_number IS NOT NULL
             ORDER BY md5(id::text) LIMIT ${RUNS + 1}`,
          );
        const [{ n: total }] = await db.query('SELECT count(*)::int AS n FROM assets');
        const [deep] = await db.query(
          'SELECT asset_code,id FROM assets ORDER BY asset_code,id OFFSET $1 LIMIT 1',
          [Math.floor(total * 0.9)],
        );
        const cursor = Buffer.from(JSON.stringify([deep.asset_code, deep.id])).toString('base64url');
        const pick = (i: number) => sample[i % sample.length]!;

        results.push(await measure('asset list, first page', 300, () => domain.assets(req, {})));
        results.push(
          await measure('asset list, deep cursor (~90%)', 300, () => domain.assets(req, { cursor })),
        );
        results.push(
          await measure('search ILIKE asset_code/serial', 300, (i) => {
            const row = pick(i);
            const term = `%${i % 2 ? row.asset_code.slice(-8) : row.serial_number.slice(3, 11)}%`;
            return db.query(
              // One trigram-indexed branch per column: a single OR makes the planner walk the
              // asset_code index in order and filter, which is slow for rare terms.
              `SELECT id,asset_code,description,status FROM (
                 SELECT id,asset_code,description,status FROM assets WHERE asset_code ILIKE $1
                 UNION
                 SELECT id,asset_code,description,status FROM assets WHERE serial_number ILIKE $1
               ) m ORDER BY asset_code,id LIMIT 25`,
              [term],
            );
          }),
        );
        results.push(
          await measure('GET /assets?q= (current strpos)', 300, (i) =>
            domain.assets(req, { q: i % 2 ? pick(i).asset_code.slice(-8) : pick(i).serial_number }),
          ),
        );
        results.push(await measure('dashboard: admin summary read', 500, () => admin.summary(req, {})));
        results.push(await measure('dashboard: executive summary read', 500, () => executive.summary(req)));
        results.push(await measure('dashboard: home counts', 500, () => domain.dashboard(req)));
        results.push(await measure('asset detail', 200, (i) => domain.asset(req, pick(i).id)));
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
  } finally {
    await db.onModuleDestroy();
  }
  const pad = (v: string, n: number) => v.padEnd(n);
  process.stdout.write(
    `\n${pad('probe', 40)}${pad('median ms', 12)}${pad('p95 ms', 10)}${pad('target', 10)}result\n`,
  );
  let failed = false;
  for (const r of results) {
    const ok = r.p95 < r.target;
    failed ||= !ok;
    process.stdout.write(
      `${pad(r.name, 40)}${pad(r.median.toFixed(1), 12)}${pad(r.p95.toFixed(1), 10)}${pad(`< ${r.target}`, 10)}${ok ? 'PASS' : 'FAIL'}\n`,
    );
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`scale:probe failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
