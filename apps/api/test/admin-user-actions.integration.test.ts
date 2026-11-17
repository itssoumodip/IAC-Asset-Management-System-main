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
  throw new Error('Admin user actions integration requires a database name ending _test');
const tag = `aua-${randomUUID()}`;

describe('admin: reset authenticator and delete user', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string;
  let admin: any;
  const user = async (roles: string[], withMfa = false) => {
    const u = { id: randomUUID(), email: `${tag}-${randomUUID()}@example.org`, csrf: signedCsrf(), session: token() };
    await db.query(
      `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at,mfa_secret_ciphertext)
       VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,${withMfa ? "now(),'secret'" : 'now(),NULL'})`,
      [u.id, u.email, `${tag} person`, configuration().noticeVersion],
    );
    for (const role of roles) await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, role]);
    await db.query(
      `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 hour',now())`,
      [hash(u.session), u.id, hash(u.csrf)],
    );
    return u;
  };
  const call = async (who: any, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${who.session}; ${configuration().csrfCookie}=${who.csrf}`,
        'X-CSRF-Token': who.csrf,
        'Idempotency-Key': randomUUID(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    admin = await user(['SUPER_ADMIN', 'EMPLOYEE'], true);
  });
  after(async () => app?.close());

  it('resets a lost authenticator: secret, recovery codes and sessions are cleared, and it is audited', async () => {
    const target = await user(['SUPER_ADMIN', 'EMPLOYEE'], true);
    await db.query('INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)', [target.id, 'h1']);
    const r = await call(admin, 'POST', `/users/${target.id}/mfa-reset`, { reason: 'Lost phone' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [u] = await db.query('SELECT mfa_enrolled_at,mfa_secret_ciphertext FROM users WHERE id=$1', [target.id]);
    assert.equal(u.mfa_enrolled_at, null);
    assert.equal(u.mfa_secret_ciphertext, null);
    assert.equal((await db.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id=$1', [target.id])).length, 0);
    assert.equal((await db.query('SELECT 1 FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [target.id])).length, 0);
    const [audit] = await db.query("SELECT changes FROM audit_events WHERE entity_id=$1 AND action='ADMIN_MFA_RESET'", [target.id]);
    assert.equal(audit.changes.reason, 'Lost phone');
    // Not for yourself, and not for non-admins.
    assert.equal((await call(admin, 'POST', `/users/${admin.id}/mfa-reset`, { reason: 'x' })).status, 409);
    const employee = await user(['EMPLOYEE']);
    assert.equal((await call(employee, 'POST', `/users/${target.id}/mfa-reset`, { reason: 'x' })).status, 403);
  });

  it('deletes a person with no history, refuses one with history, never yourself', async () => {
    const fresh = await user(['EMPLOYEE']);
    const ok = await call(admin, 'DELETE', `/users/${fresh.id}`, { reason: 'Created by mistake' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await db.query('SELECT 1 FROM users WHERE id=$1', [fresh.id])).length, 0);
    const [audit] = await db.query("SELECT changes FROM audit_events WHERE entity_id=$1 AND action='ADMIN_USER_DELETED'", [fresh.id]);
    assert.equal(audit.changes.reason, 'Created by mistake');

    const withHistory = await user(['EMPLOYEE']);
    await db.tx((c) => db.audit(c, { id: withHistory.id } as any, 'USER', withHistory.id, 'SOMETHING', {}));
    const refused = await call(admin, 'DELETE', `/users/${withHistory.id}`, { reason: 'x' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error?.message ?? refused.body.message ?? '', /Disabled/);
    assert.equal((await db.query('SELECT 1 FROM users WHERE id=$1', [withHistory.id])).length, 1);

    assert.equal((await call(admin, 'DELETE', `/users/${admin.id}`, { reason: 'x' })).status, 409);
  });
});
