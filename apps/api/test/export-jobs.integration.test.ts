import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { configuration, hash, signedCsrf, token } from '../src/config';
import { processNextExport, purgeExpiredExports } from '../src/export-jobs';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Export jobs integration requires a database name ending _test');
const tag = `exp-${randomUUID()}`;
const letters = () =>
  Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const TOTAL = 5000;

describe('export jobs integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let owner: any, other: any, admin: any;
  let teamA: { id: string; prefix: string }, teamB: { id: string; prefix: string };

  const call = async (user: any, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': user.csrf,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };
  const makeTeam = async () => {
    const prefix = letters();
    const [row] = await db.query(
      'INSERT INTO teams(code,name,asset_code_prefix) VALUES($1,$2,$1) RETURNING id',
      [prefix, `${tag} ${prefix}`],
    );
    await db.query('INSERT INTO team_asset_counters(team_id,next_value) VALUES($1,1)', [row.id]);
    return { id: row.id as string, prefix };
  };
  const seed = (team: { id: string; prefix: string }, count: number) =>
    db.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,
         owning_team_id,purchase_cost)
       SELECT 'IAC-'||$1||'-'||lpad(g::text,6,'0'),'Cat','Type',$2||' asset '||g,'Owned',
         CASE WHEN g%5=0 THEN 'Active' ELSE 'In Store' END,'Good','Low',$3,100+g
       FROM generate_series(1,$4::int) g`,
      [team.prefix, tag, team.id, count],
    );
  const runJobs = async (id: string) => {
    for (let i = 0; i < 20; i += 1) {
      const [job] = await db.query('SELECT state FROM export_jobs WHERE id=$1', [id]);
      if (job.state !== 'QUEUED' && job.state !== 'RUNNING') return job.state as string;
      await processNextExport(db);
    }
    throw new Error('Export job did not finish');
  };
  const request = async (user: any, filters: Record<string, unknown>) => {
    const response = await call(user, '/exports', 'POST', { kind: 'assets', filters, format: 'csv' });
    assert.equal(response.status, 201);
    return (await response.json()).id as string;
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
    owner = await user(['TEAM_MEMBER']);
    other = await user(['TEAM_MEMBER']);
    admin = await user(['SUPER_ADMIN']);
    teamA = await makeTeam();
    teamB = await makeTeam();
    await seed(teamA, TOTAL);
    await seed(teamB, 10);
    await db.query(
      `UPDATE assets SET description='=HYPERLINK("x")' WHERE asset_code=$1`,
      [`IAC-${teamA.prefix}-000001`],
    );
    await db.query('INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,$3)', [
      owner.id,
      teamA.id,
      'MEMBER',
    ]);
    await db.query('INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,$3)', [
      other.id,
      teamB.id,
      'MEMBER',
    ]);
  });

  after(async () => {
    await app?.close();
  });

  it('exports every row the requester can see, in order, as CSV', async () => {
    const id = await request(owner, {});
    const early = await call(owner, `/exports/${id}/file`);
    assert.equal(early.status, 409);
    const queued = await (await call(owner, `/exports/${id}`)).json();
    assert.equal(queued.state, 'QUEUED');
    assert.equal(await runJobs(id), 'READY');
    const status = await (await call(owner, `/exports/${id}`)).json();
    assert.equal(status.state, 'READY');
    assert.equal(status.rowCount, TOTAL);
    const file = await call(owner, `/exports/${id}/file`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(file.headers.get('content-disposition') ?? '', /^attachment/);
    const lines = (await file.text()).split('\r\n');
    assert.equal(lines.pop(), '');
    const header = lines.shift()!.split(',');
    assert.ok(header.includes('asset_code') && header.includes('purchase_cost'));
    assert.equal(lines.length, TOTAL);
    const codes = lines.map((l) => l.split(',')[header.indexOf('asset_code')]!);
    assert.deepEqual(codes, [...codes].sort());
    assert.equal(new Set(codes).size, TOTAL);
    assert.ok(codes.every((c) => c.startsWith(`IAC-${teamA.prefix}-`)), 'team B rows must not leak');
    // Spreadsheet formulas are neutralised.
    assert.ok(lines[0]!.includes(`"'=HYPERLINK(""x"")"`));
  });

  it('applies the same filters as the asset list', async () => {
    const id = await request(owner, { status: 'Active' });
    assert.equal(await runJobs(id), 'READY');
    const [{ n }] = await db.query(
      "SELECT count(*)::int AS n FROM assets WHERE owning_team_id=$1 AND status='Active'",
      [teamA.id],
    );
    assert.equal((await (await call(owner, `/exports/${id}`)).json()).rowCount, n);
    assert.equal(n, TOTAL / 5);
  });

  it('denies other users and allows a super admin', async () => {
    const id = await request(owner, { status: 'Active' });
    await runJobs(id);
    for (const path of [`/exports/${id}`, `/exports/${id}/file`])
      assert.equal((await call(other, path)).status, 403);
    assert.equal((await call(admin, `/exports/${id}/file`)).status, 200);
    assert.equal((await call(owner, `/exports/${randomUUID()}`)).status, 404);
    assert.equal((await call(owner, '/exports', 'POST', { kind: 'tickets' })).status, 422);
  });

  it('purges expired files', async () => {
    const id = await request(owner, { status: 'Active' });
    await runJobs(id);
    await db.query("UPDATE export_jobs SET expires_at=now()-interval '1 minute' WHERE id=$1", [id]);
    assert.equal((await call(owner, `/exports/${id}`)).status, 404);
    assert.ok((await purgeExpiredExports(db)) >= 1);
    assert.equal((await db.query('SELECT 1 FROM export_jobs WHERE id=$1', [id])).length, 0);
  });
});
