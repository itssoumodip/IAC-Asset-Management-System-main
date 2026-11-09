import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { configuration, hash, signedCsrf, token } from '../src/config';
import { refreshDashboardSummary, type SummaryPayload } from '../src/dashboard-summary';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Dashboard summary integration requires a database name ending _test');
// The summary is bypassed under NODE_ENV=test so other suites see live data; opt in here.
process.env.DASHBOARD_SUMMARY = 'on';
const tag = `dsum-${randomUUID()}`;
const letters = () =>
  Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

describe('dashboard summary integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let executive: any, member: any;
  const teams: { id: string; code: string; prefix: string; n: number }[] = [];
  const get = async (user: any, path: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  const stored = async (scope: string) =>
    (await db.query('SELECT payload,refreshed_at FROM dashboard_daily WHERE scope=$1', [scope]))[0] as
      | { payload: SummaryPayload; refreshed_at: Date }
      | undefined;
  const team = async () => {
    const code = letters();
    const [row] = await db.query(
      'INSERT INTO teams(code,name,asset_code_prefix) VALUES($1,$2,$1) RETURNING id',
      [code, `${tag} ${code}`],
    );
    await db.query('INSERT INTO team_asset_counters(team_id,next_value) VALUES($1,1)', [row.id]);
    const t = { id: row.id as string, code, prefix: code, n: 0 };
    teams.push(t);
    return t;
  };
  const asset = async (
    t: (typeof teams)[number],
    status: string,
    cost: number | null,
    category = 'Cat',
  ) => {
    t.n += 1;
    await db.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,
         owning_team_id,purchase_cost,purchase_date)
       VALUES($1,$2,'Type',$3,'Owned',$4,'Good','Low',$5,$6,$7)`,
      [
        `IAC-${t.prefix}-${String(t.n).padStart(6, '0')}`,
        category,
        `${tag} asset`,
        status,
        t.id,
        cost,
        cost === null ? null : '2024-06-15',
      ],
    );
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    const user = async (roles: string[]) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [result.id, result.email, `${tag} user`, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [result.id, role]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(result.session), result.id, hash(result.csrf)],
      );
      return result;
    };
    executive = await user(['EXECUTIVE']);
    member = await user(['TEAM_MEMBER']);
  });

  after(async () => {
    await app?.close();
  });

  it('refresh stores ORG and per-team aggregates', async () => {
    const a = await team();
    await asset(a, 'Assigned', 1000, 'Laptops');
    await asset(a, 'In Store', 500.5, 'Laptops');
    await asset(a, 'In Store', null, 'Chairs');
    const result = await refreshDashboardSummary(db);
    assert.equal(result.failed, 0);
    const row = await stored(`TEAM:${a.code}`);
    assert.ok(row);
    assert.equal(row.payload.kpis.totalAssets, 3);
    assert.equal(row.payload.kpis.totalSpend, 1500.5);
    assert.equal(row.payload.kpis.missingCost, 1);
    assert.equal(row.payload.kpis.assigned, 1);
    assert.deepEqual(row.payload.statusCounts.map((s) => [s.label, s.count]).sort(), [
      ['Assigned', 1],
      ['In Store', 2],
    ]);
    assert.deepEqual(row.payload.spendByCategory, [{ label: 'Laptops', spend: 1500.5, count: 2 }]);
    assert.equal(row.payload.spendByFy.find((f) => f.fyStart === 2024)?.spend, 1500.5);
    const org = await stored('ORG');
    assert.ok(org);
    assert.ok(org.payload.kpis.totalAssets >= 3);
    assert.equal(
      org.payload.assetsByTeam.filter((r) => r.teamId === a.id).reduce((n, r) => n + r.count, 0),
      3,
    );
  });

  it('scopes team summaries to the owning team only', async () => {
    const a = teams[0]!;
    const b = await team();
    await asset(b, 'In Store', 200);
    await refreshDashboardSummary(db);
    const rowB = await stored(`TEAM:${b.code}`);
    assert.equal(rowB!.payload.kpis.totalAssets, 1);
    assert.ok(rowB!.payload.assetsByTeam.every((r) => r.teamId === b.id));
    // A member of team A sees A's aggregates and none of B's.
    await db.query('INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,$3)', [
      member.id,
      a.id,
      'MEMBER',
    ]);
    const { status, body } = await get(member, '/dashboard/team');
    assert.equal(status, 200);
    assert.ok(body.assetsByTeam.length > 0);
    assert.ok(body.assetsByTeam.every((r: any) => r.teamId === a.id));
    assert.equal(
      body.assetsByTeam.reduce((n: number, r: any) => n + r.count, 0),
      3,
    );
    assert.ok(typeof body.asOf === 'string' && !Number.isNaN(Date.parse(body.asOf)));
  });

  it('serves a stale summary with its asOf instead of recomputing', async () => {
    const a = teams[0]!;
    await refreshDashboardSummary(db);
    const old = new Date(Date.now() - 86400e3);
    await db.query('UPDATE dashboard_daily SET refreshed_at=$1', [old]);
    await asset(a, 'In Store', 10); // not in the stored summary
    const stale = (await get(executive, '/dashboard/executive')).body;
    assert.equal(stale.asOf, old.toISOString());
    const count = (body: any) =>
      body.assetsByTeam
        .filter((r: any) => r.teamId === a.id)
        .reduce((n: number, r: any) => n + r.count, 0);
    assert.equal(count(stale), 3);
    const admin = await get(executive, '/dashboard/admin');
    assert.equal(admin.status, 200);
    assert.equal(admin.body.asOf, old.toISOString());
    // The next refresh picks the new asset up.
    await refreshDashboardSummary(db);
    const fresh = (await get(executive, '/dashboard/executive')).body;
    assert.equal(count(fresh), 4);
    assert.ok(Date.parse(fresh.asOf) > old.getTime());
  });

  it('keeps the last good summary when a refresh fails', async () => {
    const a = teams[0]!;
    const good = await stored(`TEAM:${a.code}`);
    const failing = {
      query: (sql: string, values?: any[]) =>
        /FROM teams\s*$/.test(sql.trim())
          ? db.query(sql, values)
          : Promise.reject(new Error('boom')),
    } as unknown as Db;
    const result = await refreshDashboardSummary(failing);
    assert.ok(result.failed > 0 && result.refreshed === 0);
    const after = await stored(`TEAM:${a.code}`);
    assert.deepEqual(after!.payload, good!.payload);
    assert.equal(after!.refreshed_at.getTime(), good!.refreshed_at.getTime());
    assert.equal((await get(executive, '/dashboard/executive')).status, 200);
  });

  it('computes a missing summary once and stores it', async () => {
    await db.query("DELETE FROM dashboard_daily WHERE scope='ORG'");
    const { status, body } = await get(executive, '/dashboard/admin');
    assert.equal(status, 200);
    assert.ok(body.asOf);
    assert.ok(body.kpis.totalAssets >= 4);
    assert.ok(await stored('ORG'));
  });
});
