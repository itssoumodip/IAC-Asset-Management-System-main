/** Synthetic, rollback-only query probe. Not a production capacity certification. */
import 'reflect-metadata';
import { Pool } from 'pg';
import { assetColumns } from './domain-helpers';
import { performance } from 'node:perf_hooks';
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Scale probe requires isolated _test database');
async function run() {
  const pool = new Pool({ connectionString: connection }),
    client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = (await client.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0]?.id;
    if (!owner) throw new Error('Seed one synthetic user first');
    await client.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by) SELECT 'IAC-IT-'||lpad((n+900000)::text,6,'0'),'IT Hardware','Laptop','Rollback synthetic device '||n,'Owned','In Store','Good','Low',$1 FROM generate_series(1,50000)n`,
      [owner],
    );
    await client.query('ANALYZE assets');
    const measurements = [];
    for (const [label, sql, args] of [
      [
        'catalog_first_page',
        `SELECT ${assetColumns({ roles: ['ADMIN'] } as any)},(SELECT max(lp.printed_at) FROM asset_label_prints lp WHERE lp.asset_id=a.id) AS last_label_printed_at FROM assets a WHERE status='In Store' ORDER BY a.asset_code,a.id LIMIT 26`,
        [],
      ],
      [
        'exact_asset_lookup',
        `SELECT id,asset_code FROM assets WHERE asset_code=$1`,
        ['IAC-IT-925000'],
      ],
      [
        'contains_search',
        `SELECT a.id,a.asset_code FROM assets a WHERE strpos(lower(a.asset_code),lower($1))>0 OR strpos(lower(a.description),lower($1))>0 OR strpos(lower(coalesce(a.serial_number,'')),lower($1))>0 ORDER BY a.asset_code,a.id LIMIT 26`,
        ['25000'],
      ],
      ['executive_counts', `SELECT status,count(*)::int FROM assets GROUP BY status`, []],
    ] as [string, string, any[]][]) {
      const ms = [];
      for (let i = 0; i < 21; i++) {
        const start = performance.now();
        await client.query(sql, args);
        if (i) ms.push(performance.now() - start);
      }
      ms.sort((a, b) => a - b);
      const plan = (await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args))
        .rows[0]['QUERY PLAN'];
      measurements.push({
        label,
        samples: 20,
        medianMs: ms[10],
        p95Ms: ms[18],
        maxMs: ms[19],
        plan,
      });
    }
    console.log(
      JSON.stringify(
        {
          syntheticAssets: 50000,
          rollbackOnly: true,
          environment:
            'single local PostgreSQL14 connection; warm cache; no HTTP/concurrent users/history/files',
          measurements,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
run().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
