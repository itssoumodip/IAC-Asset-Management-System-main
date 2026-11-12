import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { configuration, hash, signedCsrf, token } from '../src/config';
import { IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Maintenance integration requires a database name ending _test');
const tag = `mnt-${randomUUID()}`;

describe('preventive maintenance', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let member: any, employee: any;
  const refs = {
    CATEGORY: `${tag} cat`,
    ASSET_TYPE: `${tag} type`,
    OWNERSHIP: `${tag} ownership`,
    CONDITION: `${tag} condition`,
    RISK: `${tag} risk`,
  };
  const call = async (user: any, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
        'X-CSRF-Token': user.csrf,
        'Idempotency-Key': randomUUID(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const newAsset = async () => {
    const created = await call(member, 'POST', '/assets', {
      category: refs.CATEGORY,
      assetType: refs.ASSET_TYPE,
      description: `${tag} item`,
      ownershipType: refs.OWNERSHIP,
      status: 'In Store',
      condition: refs.CONDITION,
      riskLevel: refs.RISK,
      amcApplies: false,
      owningTeamId: IT_TEAM_ID,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body as { id: string; assetCode: string };
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    const user = async (roles: string[]) => {
      const u = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Maintenance test',
        roles,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [u.id, u.email, u.displayName, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, role]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(u.session), u.id, hash(u.csrf)],
      );
      return u;
    };
    member = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    employee = await user(['EMPLOYEE']);
    for (const [kind, code] of Object.entries(refs))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
  });

  after(async () => {
    await app?.close();
  });

  it('schedules one asset, lists it as overdue, completes it and moves the due date', async () => {
    const asset = await newAsset();
    const created = await call(member, 'POST', '/maintenance/schedules', {
      assetCode: asset.assetCode,
      title: 'Battery check',
      intervalDays: 90,
      firstDue: '2020-01-01',
      reason: 'Manufacturer interval',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.created, 1);
    const scheduleId = created.body.ids[0];

    const overdue = await call(member, 'GET', '/maintenance?view=overdue');
    assert.equal(overdue.status, 200, JSON.stringify(overdue.body));
    const row = overdue.body.items.find((i: any) => i.id === scheduleId);
    assert.ok(row, 'schedule appears as overdue');
    assert.ok(row.daysUntilDue < 0);
    assert.ok(overdue.body.summary.overdue >= 1);

    const done = await call(member, 'POST', `/maintenance/schedules/${scheduleId}/complete`, {
      notes: 'Replaced cell 2',
    });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const [s] = await db.query(
      "SELECT next_due - (now() AT TIME ZONE 'Asia/Kolkata')::date AS days FROM maintenance_schedules WHERE id=$1",
      [scheduleId],
    );
    assert.equal(s.days, 90, 'next due is 90 days after the completion day');

    const history = await call(member, 'GET', `/maintenance/schedules/${scheduleId}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].notes, 'Replaced cell 2');
    const audits = await db.query(
      "SELECT action FROM audit_events WHERE entity_id=$1 AND action LIKE 'MAINTENANCE_%' ORDER BY occurred_at",
      [asset.id],
    );
    assert.deepEqual(
      audits.map((a) => a.action),
      ['MAINTENANCE_SCHEDULED', 'MAINTENANCE_COMPLETED'],
    );
  });

  it('a subcategory schedule creates one schedule per asset in service', async () => {
    await newAsset();
    const scrapped = await newAsset();
    await db.query(
      "UPDATE assets SET status='Scrapped',disposal_date=current_date,disposal_reference='SYN' WHERE id=$1",
      [scrapped.id],
    );
    const [{ n }] = await db.query(
      "SELECT count(*)::int AS n FROM assets WHERE asset_type=$1 AND status<>'Scrapped'",
      [refs.ASSET_TYPE],
    );
    const created = await call(member, 'POST', '/maintenance/schedules', {
      assetType: refs.ASSET_TYPE,
      title: 'Annual service',
      intervalDays: 365,
      firstDue: '2030-01-01',
      reason: 'Policy',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.created, n, 'scrapped assets are skipped');
  });

  it('a stopped schedule cannot be completed', async () => {
    const asset = await newAsset();
    const created = await call(member, 'POST', '/maintenance/schedules', {
      assetCode: asset.assetCode,
      title: 'Filter clean',
      intervalDays: 30,
      firstDue: '2030-01-01',
      reason: 'Test',
    });
    const id = created.body.ids[0];
    const stopped = await call(member, 'POST', `/maintenance/schedules/${id}/stop`, {
      reason: 'Asset moved to store',
    });
    assert.equal(stopped.status, 201, JSON.stringify(stopped.body));
    const again = await call(member, 'POST', `/maintenance/schedules/${id}/complete`, {});
    assert.equal(again.status, 409);
  });

  it('rejects a request naming both an asset and a subcategory, and staff without work rights', async () => {
    const both = await call(member, 'POST', '/maintenance/schedules', {
      assetCode: 'IAC-IT-000001',
      assetType: refs.ASSET_TYPE,
      title: 'x',
      intervalDays: 30,
      firstDue: '2030-01-01',
      reason: 'x',
    });
    assert.equal(both.status, 422);
    const denied = await call(employee, 'GET', '/maintenance');
    assert.equal(denied.status, 403);
  });
});
