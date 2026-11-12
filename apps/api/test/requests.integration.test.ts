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
  throw new Error('Requests integration requires a database name ending _test');
const tag = `req-${randomUUID()}`;

describe('item requests', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let employee: any, lead: any, member: any;
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
        displayName: 'Requests test',
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
    employee = await user(['EMPLOYEE']);
    lead = await joinTeam(db, await user(['EMPLOYEE']), 'LEAD', IT_TEAM_ID);
    member = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
  });

  after(async () => {
    await app?.close();
  });

  it('lists requestable subcategories with stock', async () => {
    const catalog = await call(employee, 'GET', '/requests/catalog');
    assert.equal(catalog.status, 200);
    const laptop = catalog.body.items.find((i: any) => i.assetTypeCode === 'Laptop');
    assert.ok(laptop, 'Laptop can be requested');
    assert.equal(typeof laptop.inStock, 'number');
  });

  it('request → lead approves one line, rejects another → team hands over', async () => {
    const created = await call(employee, 'POST', '/requests', {
      items: [
        { assetType: 'Laptop', quantity: 1 },
        { assetType: 'Monitor', quantity: 2 },
      ],
      neededBy: '2030-01-15',
      remarks: 'New joiner in IT',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const lines = await db.query(
      'SELECT id,asset_type_code FROM asset_request_items WHERE request_id=$1',
      [created.body.id],
    );
    const laptopLine = lines.find((l) => l.asset_type_code === 'Laptop')!.id;
    const monitorLine = lines.find((l) => l.asset_type_code === 'Monitor')!.id;

    // A plain team member cannot decide; the requester cannot decide their own.
    const notLead = await call(member, 'POST', `/requests/items/${laptopLine}/decision`, {
      decision: 'APPROVE',
      reason: 'ok',
    });
    assert.equal(notLead.status, 403);

    // The lead sees both lines in Approvals and decides there (old APPROVED spelling still works).
    const inbox = await call(lead, 'GET', '/approvals?tab=requests');
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.ok(inbox.body.items.some((i: any) => i.id === laptopLine));
    const approved = await call(lead, 'PATCH', `/approvals/${laptopLine}`, {
      decision: 'APPROVED',
      reason: 'Budgeted',
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const rejected = await call(lead, 'POST', `/requests/items/${monitorLine}/decision`, {
      decision: 'REJECT',
      reason: 'One monitor is enough',
    });
    assert.equal(rejected.status, 201, JSON.stringify(rejected.body));

    const queue = await call(member, 'GET', '/requests/queue');
    assert.ok(queue.body.toFulfil.some((l: any) => l.id === laptopLine));
    // Naming an asset that is not with the requester is refused.
    const [stranger] = await db.query(
      `SELECT a.id FROM assets a WHERE NOT EXISTS (SELECT 1 FROM assignments s WHERE s.asset_id=a.id AND s.ended_at IS NULL AND s.user_id=$1) LIMIT 1`,
      [employee.id],
    );
    if (stranger) {
      const wrong = await call(member, 'POST', `/requests/items/${laptopLine}/fulfil`, {
        assetIds: [stranger.id],
      });
      assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
    }
    const handed = await call(member, 'POST', `/requests/items/${laptopLine}/fulfil`, {});
    assert.equal(handed.status, 201, JSON.stringify(handed.body));

    const mine = await call(employee, 'GET', '/requests/mine');
    const request = mine.body.items.find((r: any) => r.id === created.body.id);
    assert.equal(request.status, 'FULFILLED');
    const byType = Object.fromEntries(request.items.map((i: any) => [i.assetType, i.status]));
    assert.deepEqual(byType, { Laptop: 'FULFILLED', Monitor: 'REJECTED' });

    const mails = await db.query(
      `SELECT o.event_key FROM notification_outbox o WHERE o.event_key = ANY($1::text[])`,
      [
        [
          `request-created:${created.body.id}`,
          `request-item-approved:${laptopLine}`,
          `request-item-to-hand-over:${laptopLine}`,
          `request-item-fulfilled:${laptopLine}`,
        ],
      ],
    );
    assert.equal(mails.length, 4, 'lead, requester decision, team hand-over and ready emails are queued');
  });

  it('a request can be cancelled only before any line is decided', async () => {
    const first = await call(employee, 'POST', '/requests', {
      items: [{ assetType: 'Laptop', quantity: 1 }],
    });
    const cancelled = await call(employee, 'POST', `/requests/${first.body.id}/cancel`, {});
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    const second = await call(employee, 'POST', '/requests', {
      items: [{ assetType: 'Laptop', quantity: 1 }],
    });
    const [line] = await db.query('SELECT id FROM asset_request_items WHERE request_id=$1', [
      second.body.id,
    ]);
    await call(lead, 'POST', `/requests/items/${line.id}/decision`, {
      decision: 'APPROVE',
      reason: 'ok',
    });
    const late = await call(employee, 'POST', `/requests/${second.body.id}/cancel`, {});
    assert.equal(late.status, 409);
  });

  it('rejects unknown subcategories and duplicate lines', async () => {
    const unknown = await call(employee, 'POST', '/requests', {
      items: [{ assetType: `${tag}-nope`, quantity: 1 }],
    });
    assert.equal(unknown.status, 422);
    const dup = await call(employee, 'POST', '/requests', {
      items: [
        { assetType: 'Laptop', quantity: 1 },
        { assetType: 'Laptop', quantity: 2 },
      ],
    });
    assert.equal(dup.status, 422);
  });
});
