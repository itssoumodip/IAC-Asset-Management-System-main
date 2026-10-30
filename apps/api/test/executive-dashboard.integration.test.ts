import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { configuration, hash, signedCsrf, token } from '../src/config';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Executive dashboard integration requires a database name ending _test');
const tag = `exec-${randomUUID()}`;
const letters = () =>
  Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

describe('executive dashboard integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let executive: any, member: any, teamId: string, projectId: string, prefix: string;
  let counter = 0;
  const get = async (user: any) => {
    const response = await fetch(`${base}/dashboard/executive`, {
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  const fyRow = (body: any, start: number) =>
    body.spendByFy.find((row: any) => row.fyStart === start) ?? { spend: 0, count: 0 };
  const asset = async (extra: Record<string, unknown> = {}) => {
    const row = {
      status: 'In Store',
      purchase_cost: null as number | null,
      purchase_date: null as string | null,
      project_id: null as string | null,
      warranty_expiry: null as string | null,
      amc_applies: false,
      amc_expiry: null as string | null,
      finance_pending: false,
      ...extra,
    };
    counter += 1;
    const [created] = await db.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,
         owning_team_id,project_id,purchase_cost,purchase_date,warranty_expiry,amc_applies,amc_expiry,finance_pending)
       VALUES($1,'Cat','Type',$2,'Owned',$3,'Good','Low',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        `IAC-${prefix}-${String(counter).padStart(6, '0')}`,
        `${tag} asset`,
        row.status,
        teamId,
        row.project_id,
        row.purchase_cost,
        row.purchase_date,
        row.warranty_expiry,
        row.amc_applies,
        row.amc_expiry,
        row.finance_pending,
      ],
    );
    return created.id as string;
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
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [
          result.id,
          role,
        ]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(result.session), result.id, hash(result.csrf)],
      );
      return result;
    };
    executive = await user(['EXECUTIVE']);
    member = await user(['EMPLOYEE']);
    prefix = letters();
    const [team] = await db.query(
      `INSERT INTO teams(code,name,asset_code_prefix) VALUES($1,$2,$1) RETURNING id`,
      [prefix, `${tag} team`],
    );
    teamId = team.id;
    await db.query('INSERT INTO team_asset_counters(team_id,next_value) VALUES($1,1)', [teamId]);
    const [project] = await db.query(
      `INSERT INTO projects(code,name) VALUES($1,$2) RETURNING id`,
      [tag.slice(0, 40), `${tag} project`],
    );
    projectId = project.id;
  });

  after(async () => {
    await app?.close();
  });

  it('requires report.view', async () => {
    assert.equal((await get(member)).status, 403);
    assert.equal((await get(executive)).status, 200);
  });

  it('counts assets by team and status with purchase value', async () => {
    await asset({ status: 'In Store', purchase_cost: 1000 });
    await asset({ status: 'In Store', purchase_cost: 500.5 });
    await asset({ status: 'Assigned', purchase_cost: 2000 });
    await asset({ status: 'Under Repair' });
    const { body } = await get(executive);
    const rows = body.assetsByTeam.filter((row: any) => row.teamId === teamId);
    const find = (status: string) => rows.find((row: any) => row.status === status);
    assert.deepEqual([find('In Store').count, find('In Store').value], [2, 1500.5]);
    assert.deepEqual([find('Assigned').count, find('Assigned').value], [1, 2000]);
    assert.deepEqual([find('Under Repair').count, find('Under Repair').value], [1, 0]);
    assert.equal(rows[0].teamName, `${tag} team`);
  });

  it('computes the needs-attention counters', async () => {
    const before = (await get(executive)).body.needsAttention;
    const today = new Date(Date.now() + 5.5 * 3600e3);
    const day = (offset: number) =>
      new Date(today.getTime() + offset * 86400e3).toISOString().slice(0, 10);
    await asset({ finance_pending: true });
    await asset({ warranty_expiry: day(10) });
    await asset({ warranty_expiry: day(45) });
    await asset({ amc_applies: true, amc_expiry: day(20) });
    const left = await db.query(
      `INSERT INTO users(email,display_name,state,left_at) VALUES($1,$2,'DIRECTORY',now()) RETURNING id`,
      [`${tag}-left@example.org`, `${tag} left`],
    );
    const held = await asset({ status: 'Assigned' });
    await db.query('INSERT INTO assignments(asset_id,user_id,assigned_by) VALUES($1,$2,$3)', [
      held,
      left[0].id,
      executive.id,
    ]);
    await db.query(
      `INSERT INTO tickets(reporter_id,team_id,subject,description,category,priority)
       VALUES($1,$2,'High','Synthetic','HARDWARE','HIGH'),($1,$2,'Low','Synthetic','HARDWARE','LOW')`,
      [member.id, teamId],
    );
    const after = (await get(executive)).body.needsAttention;
    assert.equal(after.pendingFinance - before.pendingFinance, 1);
    assert.equal(after.warrantyExpiring30 - before.warrantyExpiring30, 1);
    assert.equal(after.amcExpiring30 - before.amcExpiring30, 1);
    assert.equal(after.leftHoldersWithAssets - before.leftHoldersWithAssets, 1);
    assert.equal(after.openHighTickets - before.openHighTickets, 1);
  });

  it('buckets spend by project and by Indian financial year', async () => {
    const before = (await get(executive)).body;
    await asset({ project_id: projectId, purchase_cost: 100, purchase_date: '2020-03-31' });
    await asset({ project_id: projectId, purchase_cost: 250, purchase_date: '2020-04-01' });
    await asset({ project_id: projectId, purchase_cost: 40, purchase_date: '2020-04-02' });
    const { body } = await get(executive);
    const project = body.spendByProject.find((row: any) => row.projectId === projectId);
    assert.deepEqual([project.spend, project.count], [390, 3]);
    assert.equal(project.label, `${tag} project`);
    assert.equal(fyRow(body, 2019).spend - fyRow(before, 2019).spend, 100);
    assert.equal(fyRow(body, 2020).spend - fyRow(before, 2020).spend, 290);
    assert.equal(fyRow(body, 2020).count - fyRow(before, 2020).count, 2);
    assert.equal(body.spendByFy.find((row: any) => row.fyStart === 2019).label, 'FY 2019-20');
  });

  it('reports ticket trends with a median resolution time per team', async () => {
    for (const hours of [2, 4, 10]) {
      await db.query(
        `INSERT INTO tickets(reporter_id,team_id,subject,description,category,priority,status,resolution,completed_by,completed_at,created_at)
         VALUES($1,$2,'Done','Synthetic','HARDWARE','LOW','COMPLETED','Fixed',$1,now(),now()-make_interval(hours=>$3))`,
        [member.id, teamId, hours],
      );
    }
    const { body } = await get(executive);
    const team = body.ticketTrends.teams.find((row: any) => row.teamId === teamId);
    // Earlier tests in this file left two open tickets on the team; 3 completed + 2 open.
    assert.equal(team.completed, 3);
    assert.equal(team.opened, 5);
    assert.equal(team.medianResolutionHours, 4);
    const weeks = body.ticketTrends.weeks.filter((row: any) => row.teamId === teamId);
    assert.equal(
      weeks.reduce((sum: number, row: any) => sum + row.opened, 0),
      team.opened,
    );
    assert.equal(
      weeks.reduce((sum: number, row: any) => sum + row.completed, 0),
      3,
    );
    assert.match(weeks[0].weekStart, /^\d{4}-\d{2}-\d{2}$/);
  });
});
