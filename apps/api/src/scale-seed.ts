import { Db } from './db';
import { reconcileAssetCounters } from './domain-assets';

const TEAMS: string[] = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
const PREFIX: Record<string, string> = {
  '00000000-0000-4000-8000-000000000001': 'IT',
  '00000000-0000-4000-8000-000000000002': 'ADM',
  '00000000-0000-4000-8000-000000000003': 'PRJ',
};

/** Test databases only: the database name must end in `_test`. */
export function assertTestDatabase(url: string | undefined) {
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('seed:scale refuses to run: the database name must end with _test');
}

/**
 * Inserts synthetic assets, holders and tickets with set-based SQL. Idempotent per run tag:
 * rows from an earlier run with the same tag are removed first.
 */
export async function seedScale(
  db: Db,
  options: { tag?: string; assets?: number; tickets?: number } = {},
) {
  assertTestDatabase(process.env.DATABASE_URL);
  assertTestDatabase(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
  const tag = (options.tag ?? 'scale').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'scale';
  const assets = options.assets ?? 50_000;
  const tickets = options.tickets ?? 5_000;
  const label = `scale:${tag}`;
  await db.tx(async (c) => {
    await db.query("DELETE FROM tickets WHERE subject LIKE $1||' %'", [label], c);
    await db.query(
      `DELETE FROM assignments WHERE asset_id IN (SELECT id FROM assets WHERE description LIKE $1||' %')`,
      [label],
      c,
    );
    await db.query("DELETE FROM assets WHERE description LIKE $1||' %'", [label], c);
    await db.query("DELETE FROM users WHERE email LIKE $1||'-%@example.invalid'", [label], c);
    await db.query("DELETE FROM projects WHERE code LIKE $1||'-%'", [label], c);

    await db.query(
      `INSERT INTO projects(code,name,funder)
       SELECT $1||'-'||g,'Scale grant '||g||' ('||$2||')','Synthetic funder' FROM generate_series(1,8) g`,
      [label, tag],
      c,
    );
    // 40 holders: the even-numbered ones have left the organisation.
    await db.query(
      `INSERT INTO users(email,display_name,state,left_at)
       SELECT $1||'-holder'||g||'@example.invalid','Scale holder '||g,'DIRECTORY',
         CASE WHEN g%2=0 THEN now()-interval '10 days' END
       FROM generate_series(1,40) g`,
      [label],
      c,
    );
    for (const team of TEAMS) {
      const share = Math.floor(assets / TEAMS.length) + (team === TEAMS[0] ? assets % TEAMS.length : 0);
      await db.query(
        `WITH base AS (
           SELECT coalesce(max(right(asset_code,6)::int) FILTER(WHERE asset_code ~ '^IAC-[A-Z]+-[0-9]{6}$'),0) AS n
           FROM assets WHERE owning_team_id=$1),
         projects_ AS (
           SELECT array_agg(id ORDER BY code) AS ids FROM projects WHERE code LIKE $3||'-%')
         INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,
           owning_team_id,project_id,purchase_cost,purchase_date,warranty_expiry,amc_applies,amc_expiry,finance_pending)
         SELECT 'IAC-'||$2||'-'||lpad((base.n+g)::text,6,'0'),
           (ARRAY['IT Hardware','Furniture','Networking','Appliance'])[1+g%4],
           (ARRAY['Laptop','Monitor','Desk','Router','Printer','Phone'])[1+g%6],
           $3||' synthetic asset '||g,'Owned',
           (ARRAY['Assigned','Assigned','Assigned','Assigned','Assigned','Assigned','Assigned','Assigned','In Store','In Store',
                  'In Store','In Store','Active','Active','Under Repair','Under Verification','Leased','Lost','Active','Assigned'])[1+g%20],
           'Good','Low',$1,
           CASE WHEN g%4=0 THEN NULL ELSE projects_.ids[1+g%8] END,
           CASE WHEN g%25=0 THEN NULL ELSE 500+(g*37)%90000 END,
           CASE WHEN g%40=0 THEN NULL ELSE date '2018-04-01'+((g*13)%3000) END,
           CASE WHEN g%5=0 THEN NULL ELSE (now() AT TIME ZONE 'Asia/Kolkata')::date+((g*7)%400-30) END,
           g%7=0,
           CASE WHEN g%7=0 THEN (now() AT TIME ZONE 'Asia/Kolkata')::date+((g*11)%300) END,
           g%10=0
         FROM base,projects_,generate_series(1,$4::int) g`,
        [team, PREFIX[team], label, share],
        c,
      );
      await db.query(
        `UPDATE team_asset_counters SET next_value=greatest(next_value,
           (SELECT max(right(asset_code,6)::int)+1 FROM assets WHERE owning_team_id=$1 AND asset_code ~ '^IAC-[A-Z]+-[0-9]{6}$'))
         WHERE team_id=$1`,
        [team],
        c,
      );
    }
    // Hand every tenth assigned asset to one of the holders (half have left).
    await db.query(
      `WITH holders AS (
         SELECT id,row_number() OVER (ORDER BY email) AS rn FROM users WHERE email LIKE $1||'-%@example.invalid'),
       picked AS (
         SELECT id,row_number() OVER (ORDER BY asset_code) AS rn FROM assets
         WHERE description LIKE $1||' %' AND status='Assigned')
       INSERT INTO assignments(asset_id,user_id,assigned_by)
       SELECT p.id,h.id,h.id FROM picked p JOIN holders h ON h.rn=1+p.rn%40 WHERE p.rn%10=0`,
      [label],
      c,
    );
    await db.query(
      `WITH numbered AS (
         SELECT id,row_number() OVER (ORDER BY asset_code) AS rn FROM assets WHERE description LIKE $1||' %'),
       reporter AS (SELECT id FROM users WHERE email LIKE $1||'-holder1@example.invalid'),
       t AS (
         SELECT g,now()-(g%2880)*interval '1 hour' AS created,(1+g%70)*interval '1 hour' AS took FROM generate_series(1,$2::int) g)
       INSERT INTO tickets(reporter_id,asset_id,team_id,subject,description,category,priority,status,resolution,
         completed_by,completed_at,created_at)
       SELECT r.id,n.id,($3::uuid[])[1+t.g%3],$1||' ticket '||t.g,'Synthetic ticket',
         (ARRAY['HARDWARE','SOFTWARE','ACCESS','OTHER'])[1+t.g%4],(ARRAY['LOW','MEDIUM','HIGH','MEDIUM','LOW'])[1+t.g%5],
         CASE WHEN t.g%10<6 AND t.created+t.took<=now() THEN 'COMPLETED' ELSE 'OPEN' END,
         CASE WHEN t.g%10<6 AND t.created+t.took<=now() THEN 'Resolved (synthetic)' END,
         CASE WHEN t.g%10<6 AND t.created+t.took<=now() THEN r.id END,
         CASE WHEN t.g%10<6 AND t.created+t.took<=now() THEN t.created+t.took END,
         t.created
       FROM t CROSS JOIN reporter r JOIN numbered n ON n.rn=1+(t.g*7)%$4::int`,
      [label, tickets, TEAMS, assets],
      c,
    );
    // Seeded codes bypass allocation, so move the IT sequence and team counters past them.
    await reconcileAssetCounters(db, c);
  });
  await db.query('ANALYZE assets');
  await db.query('ANALYZE tickets');
  await db.query('ANALYZE assignments');
  process.stdout.write(`Scale seed "${tag}": ${assets} assets and ${tickets} tickets inserted.\n`);
}
