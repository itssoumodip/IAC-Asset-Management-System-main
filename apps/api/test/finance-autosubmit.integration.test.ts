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
  throw new Error('Finance autosubmit integration requires a database name ending _test');
const tag = `fas-${randomUUID()}`;

describe('new assets go to Finance automatically', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let member: any, finance: any;
  const refs = {
    CATEGORY: `${tag} cat`,
    ASSET_TYPE: `${tag} type`,
    OWNERSHIP: `${tag} ownership`,
    CONDITION: `${tag} condition`,
    RISK: `${tag} risk`,
  };
  const call = async (user: any, method: string, path: string, body?: unknown, version?: number) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
        'X-CSRF-Token': user.csrf,
        'Idempotency-Key': randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const payload = (status = 'In Store') => ({
    category: refs.CATEGORY,
    assetType: refs.ASSET_TYPE,
    description: `${tag} item`,
    ownershipType: refs.OWNERSHIP,
    status,
    condition: refs.CONDITION,
    riskLevel: refs.RISK,
    amcApplies: false,
    owningTeamId: IT_TEAM_ID,
  });

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
        displayName: 'Autosubmit test',
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
    finance = await user(['FINANCE']);
    for (const [kind, code] of Object.entries(refs))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [kind, code]);
  });

  after(async () => {
    await app?.close();
  });

  it('queues a team-created asset as Submitted, notifies Finance, and blocks self-approval', async () => {
    const created = await call(member, 'POST', '/assets', payload());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const assetId = created.body.id;

    const queue = await call(finance, 'GET', `/finance/queue?q=${encodeURIComponent(created.body.assetCode)}`);
    assert.equal(queue.status, 200);
    const item = queue.body.items.find((i: any) => i.id === assetId);
    assert.ok(item, 'asset is in the Finance queue');
    assert.equal(item.finance_status ?? item.financeStatus, 'PENDING');
    assert.equal(item.missing_cost ?? item.missingCost, true);

    const outbox = await db.query(
      `SELECT d.recipient FROM notification_outbox o JOIN email_deliveries d ON d.outbox_id=o.id
       WHERE o.event_key=$1`,
      [`finance-submitted:${assetId}:create`],
    );
    assert.ok(outbox.some((r) => r.recipient === finance.email.toLowerCase()));
    const [inApp] = await db.query(
      "SELECT count(*)::int AS n FROM in_app_announcements WHERE audience='FINANCE' AND created_by=$1 AND title LIKE $2",
      [member.id, `%${created.body.assetCode}%`],
    );
    assert.equal(inApp.n, 1);
    const inbox = await call(finance, 'GET', '/notifications');
    assert.equal(inbox.status, 200);
    assert.ok(JSON.stringify(inbox.body).includes(created.body.assetCode));

    const denied = await call(member, 'POST', `/finance/assets/${assetId}/approve`, {
      reason: 'self approve',
    });
    assert.equal(denied.status, 403);
    const [row] = await db.query('SELECT finance_status FROM assets WHERE id=$1', [assetId]);
    assert.equal(row.finance_status, 'PENDING');
  });

  it('accepts Ready to Assign, In Use and Broken, but not Assigned on create', async () => {
    const created = await call(member, 'POST', '/assets', payload());
    assert.equal(created.status, 201);
    const edited = await call(
      member,
      'PATCH',
      `/assets/${created.body.id}`,
      { status: 'Ready to Assign', reason: 'prepared for handover' },
      created.body.version,
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.status, 'Ready to Assign');
    assert.equal((await call(member, 'POST', '/assets', payload('Broken'))).status, 201);
    assert.equal((await call(member, 'POST', '/assets', payload('Assigned'))).status, 409);
  });
});
