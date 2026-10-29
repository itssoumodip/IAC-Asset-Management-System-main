import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DeliveryHealthService } from '../src/delivery-health';
import type { AuthRequest } from '../src/security';
const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Isolated _test DB required');
describe('Admin delivery health read-only scope', { skip: !connection }, () => {
  let app: INestApplication, db: Db, service: DeliveryHealthService, id: string;
  const req = (role: string) => ({ user: { id: randomUUID(), roles: [role] } }) as AuthRequest;
  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    db = app.get(Db);
    service = app.get(DeliveryHealthService);
    const o = (
      await db.query(
        "INSERT INTO notification_outbox(event_key,template,payload) VALUES($1,'HEALTH_TEST',$2) RETURNING id",
        [randomUUID(), { ciphertext: 'private-token-never-return' }],
      )
    )[0];
    id = (
      await db.query(
        "INSERT INTO email_deliveries(outbox_id,recipient,state,attempts,last_error_code) VALUES($1,'synthetic-health@example.org','DEAD',6,'EAUTH') RETURNING id",
        [o.id],
      )
    )[0].id;
    await db.query(
      "INSERT INTO email_attempts(delivery_id,attempt_number,result_code) VALUES($1,6,'EAUTH')",
      [id],
    );
  });
  after(async () => app?.close());
  it('Admin sees delivery state and safe attempts, never payload or message body', async () => {
    let d = await service.overview(req('ADMIN'), { state: 'DEAD', limit: 100 });
    let own = d.items.find((x) => x.id === id);
    while (!own && d.nextCursor) {
      d = await service.overview(req('ADMIN'), { state: 'DEAD', limit: 100, before: d.nextCursor });
      own = d.items.find((x) => x.id === id);
    }
    assert.ok(own);
    assert.equal(own.attempts, 6);
    assert.equal(own.last_error_code, 'EAUTH');
    assert.equal(own.attempt_history[0].result_code, 'EAUTH');
    assert.ok(d.summary.dead > 0);
    assert.ok(!JSON.stringify(d).includes('private-token-never-return'));
    assert.ok(!('payload' in own));
  });
  it('Finance, Executive, IT and Employee cannot inspect outbound recipients', async () => {
    for (const role of ['FINANCE', 'EXECUTIVE', 'IT_ADMIN', 'EMPLOYEE'])
      await assert.rejects(service.overview(req(role), {}), /permission/);
  });
  it('rejects mailbox lists and header/address parser injection before queueing', async () => {
    for (const recipient of [
      'a,b@example.org',
      'a@example.org,other@example.org',
      'Display <a@example.org>',
      'a@example.org\r\nBcc:bad@example.org',
    ]) {
      await assert.rejects(
        db.tx((c) =>
          db.notify(c, randomUUID(), 'TEST', [recipient], {
            subject: 'Synthetic',
            text: 'Do not send',
          }),
        ),
        /Invalid notification recipient/,
      );
    }
  });
  it('validates bounded state/pagination and does not mutate deliveries', async () => {
    await assert.rejects(service.overview(req('ADMIN'), { limit: 101 }));
    await assert.rejects(service.overview(req('ADMIN'), { state: 'SENT' }));
    const before = (await db.query('SELECT * FROM email_deliveries WHERE id=$1', [id]))[0];
    const p = await service.overview(req('ADMIN'), { limit: 1 });
    assert.equal(p.items.length, 1);
    assert.ok(p.nextCursor);
    const next = await service.overview(req('ADMIN'), { limit: 1, before: p.nextCursor! });
    assert.notEqual(next.items[0]?.id, p.items[0].id);
    assert.deepEqual(
      (await db.query('SELECT * FROM email_deliveries WHERE id=$1', [id]))[0],
      before,
    );
  });
});
