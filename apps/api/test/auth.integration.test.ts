import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { configuration, decrypt, hash } from '../src/config';
import { passwordHash, totp } from '../src/auth';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Auth HTTP integration tests require a database name ending _test');
if (!connection)
  process.stderr.write(
    'Auth HTTP integration skipped: set TEST_DATABASE_URL to a disposable database ending _test.\n',
  );
const tag = `auth-${randomUUID()}`;
const pass = 'Synthetic integration password 2036!';
class Browser {
  readonly cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly base: string) {}
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(this.base + path, {
      method,
      headers: {
        Origin: configuration().origin,
        Accept: 'application/json',
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(method === 'GET'
          ? {}
          : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async prepare() {
    const result = await this.request('/auth/csrf');
    assert.equal(result.status, 200);
    this.csrf = result.data.csrfToken;
    return this;
  }
}

describe('authentication HTTP integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, employee: Browser, staffBrowser: Browser;
  let userId: string,
    staffId: string,
    enrollSecret: string,
    acceptedEnrollmentCode: string,
    recovery: string[];
  const registeredEmail = `${tag}@example.org`;
  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    // Persistent throttles are production behavior. Isolate only this guarded test fixture's loopback buckets.
    await db.query('DELETE FROM auth_rate_limits WHERE key_hash=ANY($1::text[])', [
      [hash('ip:127.0.0.1'), hash('ip:::ffff:127.0.0.1')],
    ]);
    employee = await new Browser(base).prepare();
    staffBrowser = await new Browser(base).prepare();
  });
  after(async () => {
    if (app) await app.close();
  });
  const authToken = async (email: string, purpose: string) => {
    const [row] = await db.query(
      `SELECT o.payload FROM notification_outbox o JOIN email_deliveries d ON d.outbox_id=o.id WHERE d.recipient=$1 AND o.template=$2 ORDER BY o.created_at DESC LIMIT 1`,
      [email, purpose],
    );
    assert.ok(row?.payload?.ciphertext);
    const content = JSON.parse(decrypt(row.payload.ciphertext, 'AUTH_MAIL_ENCRYPTION_KEY'));
    const raw = String(content.text).match(/#token=([^\s]+)/)?.[1];
    assert.ok(raw);
    return raw;
  };
  it('protects anonymous writes with both Origin and signed CSRF, normalizes invalid JSON', async () => {
    const fresh = new Browser(base);
    assert.equal(
      (
        await fresh.request('/auth/register', 'POST', {
          email: registeredEmail,
          password: pass,
          displayName: 'Synthetic employee',
        })
      ).status,
      403,
    );
    const invalid = await employee.request(
      '/auth/register',
      'POST',
      { email: registeredEmail, password: pass, displayName: 'Synthetic employee' },
      { Origin: 'https://untrusted.invalid' },
    );
    assert.equal(invalid.status, 403);
    assert.equal(invalid.data.error.code, 'ORIGIN_INVALID');
    const malformed = await fetch(base + '/auth/register', {
      method: 'POST',
      headers: {
        Origin: configuration().origin,
        Cookie: [...employee.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': employee.csrf,
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');
  });
  it('registers only approved emails, rejects injected roles, verifies tokens only once', async () => {
    const unapproved = await employee.request('/auth/register', 'POST', {
      email: registeredEmail,
      password: pass,
      displayName: 'Synthetic employee',
    });
    assert.equal(unapproved.status, 202);
    assert.equal(
      (await db.query('SELECT id FROM users WHERE email=$1', [registeredEmail])).length,
      0,
    );
    await db.query('INSERT INTO approved_emails(email) VALUES($1)', [registeredEmail]);
    assert.equal(
      (
        await employee.request('/auth/register', 'POST', {
          email: registeredEmail,
          password: pass,
          displayName: 'Synthetic employee',
          roles: ['ADMIN'],
        })
      ).status,
      422,
    );
    const approved = await employee.request('/auth/register', 'POST', {
      email: registeredEmail,
      password: pass,
      displayName: 'Synthetic employee',
    });
    assert.equal(approved.status, 202);
    assert.deepEqual(approved.data, unapproved.data);
    const [user] = await db.query('SELECT * FROM users WHERE email=$1', [registeredEmail]);
    userId = user.id;
    assert.equal(user.email_verified_at, null);
    assert.equal(
      (await employee.request('/auth/login', 'POST', { email: registeredEmail, password: pass }))
        .status,
      401,
    );
    const raw = await authToken(registeredEmail, 'VERIFY_EMAIL');
    assert.equal(
      (await employee.request('/auth/verify-email', 'POST', { token: raw })).status,
      200,
    );
    assert.equal(
      (await employee.request('/auth/verify-email', 'POST', { token: raw })).status,
      401,
    );
    assert.deepEqual(
      (await db.query('SELECT role_code FROM user_roles WHERE user_id=$1', [userId])).map(
        (r) => r.role_code,
      ),
      ['EMPLOYEE'],
    );
  });
  it('uses opaque HttpOnly sessions and gates domain access on the current portal notice', async () => {
    const login = await employee.request('/auth/login', 'POST', {
      email: registeredEmail,
      password: pass,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .find((v) => v.startsWith(configuration().sessionCookie + '='));
    assert.match(cookie || '', /HttpOnly/i);
    assert.match(cookie || '', /SameSite=Lax/i);
    assert.ok(employee.cookies.get(configuration().sessionCookie));
    const [session] = await db.query(
      'SELECT id_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
      [userId],
    );
    assert.notEqual(session.id_hash, employee.cookies.get(configuration().sessionCookie));
    assert.equal(session.id_hash, hash(employee.cookies.get(configuration().sessionCookie)!));
    assert.equal((await employee.request('/assets')).status, 403);
    const current = await employee.request('/me');
    assert.equal(current.data.currentNoticeVersion, configuration().noticeVersion);
    assert.equal(
      (await employee.request('/me/portal-acceptance', 'POST', { noticeVersion: 'obsolete' }))
        .status,
      409,
    );
    const accepted = await employee.request('/me/portal-acceptance', 'POST', {
      noticeVersion: configuration().noticeVersion,
    });
    assert.equal(accepted.status, 200);
    assert.equal((await employee.request('/assets')).status, 200);
    await db.query("UPDATE users SET portal_notice_version='obsolete' WHERE id=$1", [userId]);
    assert.equal((await employee.request('/assets')).status, 403);
    await employee.request('/me/portal-acceptance', 'POST', {
      noticeVersion: configuration().noticeVersion,
    });
    const event = await employee.request('/me/portal-acceptance', 'POST', {
      noticeVersion: configuration().noticeVersion,
    });
    const [audit] = await db.query(
      `SELECT request_id FROM audit_events WHERE entity_id=$1 AND action='PORTAL_ACCESS_ACCEPTED' ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );
    assert.equal(audit.request_id, event.headers.get('X-Request-Id'));
    assert.equal((await employee.request('/users')).status, 403);
  });
  it('resets password with a single-use emailed token and revokes existing sessions', async () => {
    assert.equal(
      (await employee.request('/auth/forgot-password', 'POST', { email: registeredEmail })).status,
      202,
    );
    const raw = await authToken(registeredEmail, 'RESET_PASSWORD');
    assert.equal(
      (
        await employee.request('/auth/reset-password', 'POST', {
          token: raw,
          password: pass + ' revised',
        })
      ).status,
      200,
    );
    assert.equal((await employee.request('/me')).status, 401);
    assert.equal(
      (
        await employee.request('/auth/reset-password', 'POST', {
          token: raw,
          password: pass + ' revised',
        })
      ).status,
      401,
    );
    assert.equal(
      (await employee.request('/auth/login', 'POST', { email: registeredEmail, password: pass }))
        .status,
      401,
    );
    assert.equal(
      (
        await employee.request('/auth/login', 'POST', {
          email: registeredEmail,
          password: pass + ' revised',
        })
      ).status,
      200,
    );
  });
  it('restricts privileged users to enrollment until MFA confirms and rotates their session', async () => {
    const email = `${tag}-admin@example.org`;
    const hashed = await passwordHash(pass);
    const [user] = await db.query(
      `INSERT INTO users(email,display_name,password_hash,state,email_verified_at) VALUES($1,'Synthetic auth admin',$2,'ACTIVE',now()) RETURNING id`,
      [email, hashed],
    );
    staffId = user.id;
    await db.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'SUPER_ADMIN')", [staffId]);
    const login = await staffBrowser.request('/auth/login', 'POST', { email, password: pass });
    assert.equal(login.status, 200);
    assert.equal(login.data.mfaEnrollmentRequired, true);
    const previous = staffBrowser.cookies.get(configuration().sessionCookie);
    assert.equal((await staffBrowser.request('/assets')).status, 403);
    assert.equal((await staffBrowser.request('/me')).data.enrollmentOnly, true);
    const setup = await staffBrowser.request('/auth/mfa/enroll', 'POST', {});
    assert.equal(setup.status, 200);
    enrollSecret = setup.data.secret;
    assert.match(setup.data.otpauthUri, /^otpauth:\/\/totp\//);
    acceptedEnrollmentCode = totp(enrollSecret);
    const confirmation = await staffBrowser.request('/auth/mfa/confirm', 'POST', {
      code: acceptedEnrollmentCode,
    });
    assert.equal(confirmation.status, 200);
    recovery = confirmation.data.recoveryCodes;
    assert.equal(recovery.length, 10);
    assert.notEqual(staffBrowser.cookies.get(configuration().sessionCookie), previous);
    assert.equal((await staffBrowser.request('/assets')).status, 403);
    await staffBrowser.request('/me/portal-acceptance', 'POST', {
      noticeVersion: configuration().noticeVersion,
    });
    assert.equal((await staffBrowser.request('/users')).status, 200);
    const [stored] = await db.query('SELECT mfa_secret_ciphertext FROM users WHERE id=$1', [
      staffId,
    ]);
    assert.notEqual(stored.mfa_secret_ciphertext.toString(), enrollSecret);
    assert.equal((await staffBrowser.request('/auth/mfa/enroll', 'POST', {})).status, 409);
  });
  const IT_TEAM = '00000000-0000-4000-8000-000000000001';
  it('session actor carries team memberships and /me exposes capabilities', async () => {
    const email = `${tag}-member@example.org`;
    const [member] = await db.query(
      `INSERT INTO users(email,display_name,password_hash,state,email_verified_at) VALUES($1,'Synthetic IT member',$2,'ACTIVE',now()) RETURNING id`,
      [email, await passwordHash(pass)],
    );
    await db.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'EMPLOYEE')", [member.id]);
    await db.query(
      "INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,'MEMBER')",
      [member.id, IT_TEAM],
    );
    const raw = `session-${tag}`;
    await db.query(
      `INSERT INTO sessions(id_hash,user_id,csrf_hash,scope,expires_at) VALUES($1,$2,'x','APP',now()+interval '1 hour')`,
      [hash(raw), member.id],
    );
    const { resolveSession } = await import('../src/security');
    const actor = await resolveSession(db, {
      cookies: { [configuration().sessionCookie]: raw },
    } as any);
    assert.deepEqual(actor.teams, [{ teamId: IT_TEAM, teamCode: 'IT', level: 'MEMBER' }]);
    // A team member without MFA is held at enrollment and blocked by SessionGuard.
    const browser = await new Browser(base).prepare();
    const login = await browser.request('/auth/login', 'POST', { email, password: pass });
    assert.equal(login.status, 200);
    assert.equal(login.data.mfaEnrollmentRequired, true);
    const blocked = await browser.request('/assets');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.message, 'MFA enrollment or verification is required');
    // /me for the SUPER_ADMIN session includes capabilities.global with system.admin.
    const me = await staffBrowser.request('/me');
    assert.equal(me.status, 200);
    assert.ok(me.data.capabilities.global.includes('system.admin'));
    assert.deepEqual(me.data.teams, []);
  });
  it('protects the last active SUPER_ADMIN and rejects legacy role names', async () => {
    const me = await staffBrowser.request('/me');
    const legacy = await staffBrowser.request(
      '/users/' + staffId,
      'PATCH',
      { roles: ['IT_ADMIN'], reason: 'Synthetic legacy role test' },
      { 'If-Match': `"${me.data.version}"` },
    );
    assert.equal(legacy.status, 422);
    // Other suites leave Super Admins in the shared DB; make this one the last, then restore.
    const parked = await db.query(
      `UPDATE users u SET state='DISABLED' FROM user_roles r WHERE r.user_id=u.id AND r.role_code='SUPER_ADMIN' AND u.state='ACTIVE' AND u.id<>$1 RETURNING u.id`,
      [staffId],
    );
    try {
      for (const change of [{ roles: ['EMPLOYEE'] }, { state: 'DISABLED' }]) {
        const result = await staffBrowser.request(
          '/users/' + staffId,
          'PATCH',
          { ...change, reason: 'Synthetic last admin test' },
          { 'If-Match': `"${me.data.version}"` },
        );
        assert.equal(result.status, 409);
        assert.equal(
          result.data.error.message,
          'The final active Admin cannot be removed or disabled',
        );
      }
    } finally {
      await db.query("UPDATE users SET state='ACTIVE' WHERE id=ANY($1::uuid[])", [
        parked.map((row) => row.id),
      ]);
    }
  });
  it('requires a login challenge, prevents TOTP replay, and consumes recovery codes once', async () => {
    const email = `${tag}-admin@example.org`;
    await staffBrowser.request('/auth/logout', 'POST', {});
    const first = await staffBrowser.request('/auth/login', 'POST', { email, password: pass });
    assert.equal(first.data.mfaRequired, true);
    assert.equal((await staffBrowser.request('/me')).status, 401);
    assert.equal(
      (
        await staffBrowser.request('/auth/mfa/verify', 'POST', {
          challengeToken: first.data.challengeToken,
          code: acceptedEnrollmentCode,
        })
      ).status,
      401,
    );
    const recovered = await staffBrowser.request('/auth/mfa/recover', 'POST', {
      challengeToken: first.data.challengeToken,
      recoveryCode: recovery[0],
    });
    assert.equal(recovered.status, 200);
    assert.equal((await staffBrowser.request('/users')).status, 200);
    assert.equal(
      (
        await staffBrowser.request('/auth/mfa/recover', 'POST', {
          challengeToken: first.data.challengeToken,
          code: recovery[1],
        })
      ).status,
      401,
    );
    await staffBrowser.request('/auth/logout', 'POST', {});
    const next = await staffBrowser.request('/auth/login', 'POST', { email, password: pass });
    assert.equal(
      (
        await staffBrowser.request('/auth/mfa/recover', 'POST', {
          challengeToken: next.data.challengeToken,
          code: recovery[0],
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await staffBrowser.request('/auth/mfa/recover', 'POST', {
          challengeToken: next.data.challengeToken,
          code: recovery[1],
        })
      ).status,
      200,
    );
  });
  it('resends invitations with a new token and restricts resend to Admins and invited accounts', async () => {
    const email = `${tag}-invite@example.org`;
    const body = { email, displayName: 'Synthetic invited employee' };
    const invited = await staffBrowser.request('/invitations', 'POST', body);
    assert.equal(invited.status, 201);
    const previousToken = await authToken(email, 'INVITE');
    const resent = await staffBrowser.request('/invitations', 'POST', body);
    assert.equal(resent.status, 201);
    assert.equal(resent.data.id, invited.data.id);
    const raw = await authToken(email, 'INVITE');
    assert.notEqual(raw, previousToken);
    const invitedBrowser = await new Browser(base).prepare();
    assert.equal(
      (
        await invitedBrowser.request('/auth/invite/accept', 'POST', {
          token: previousToken,
          password: pass,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await invitedBrowser.request('/auth/invite/accept', 'POST', {
          token: raw,
          password: pass,
          displayName: body.displayName,
        })
      ).status,
      200,
    );
    assert.equal(
      (await invitedBrowser.request('/auth/invite/accept', 'POST', { token: raw, password: pass }))
        .status,
      401,
    );
    const login = await invitedBrowser.request('/auth/login', 'POST', { email, password: pass });
    assert.equal(login.status, 200);
    assert.deepEqual(login.data.user.roles, ['EMPLOYEE']);
    assert.ok(login.data.user.emailVerifiedAt);
    assert.equal((await staffBrowser.request('/invitations', 'POST', body)).status, 409);
    const accepted = await invitedBrowser.request('/me/portal-acceptance', 'POST', {
      noticeVersion: configuration().noticeVersion,
    });
    assert.equal(accepted.status, 200);
    const denied = await invitedBrowser.request('/invitations', 'POST', body);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.message, 'Insufficient permission');
    const disabled = await staffBrowser.request(
      '/users/' + invited.data.id,
      'PATCH',
      { state: 'DISABLED', reason: 'Synthetic invitation resend restriction test' },
      { 'If-Match': `"${accepted.data.version}"` },
    );
    assert.equal(disabled.status, 200);
    assert.equal((await staffBrowser.request('/invitations', 'POST', body)).status, 409);
    const [stored] = await db.query(
      `SELECT u.state,(SELECT count(*)::int FROM auth_tokens t WHERE t.user_id=u.id AND t.purpose='INVITE') AS token_count FROM users u WHERE u.id=$1`,
      [invited.data.id],
    );
    assert.equal(stored.state, 'DISABLED');
    assert.equal(stored.token_count, 2);
  });
  it('refuses to invite a Zoho directory person who has left, and 409s a held email', async () => {
    const email = `${tag}-left@example.org`;
    await db.query(
      "INSERT INTO users(email,display_name,state,left_at) VALUES($1,'Left Person','DIRECTORY',now())",
      [email],
    );
    const invite = await staffBrowser.request('/invitations', 'POST', { email });
    assert.equal(invite.status, 409);
    assert.match(invite.data.error.message, /left/i);
    await db.query("INSERT INTO users(email,display_name,state) VALUES($1,'Holder','DIRECTORY')", [
      `${tag}-holder@example.org`,
    ]);
    const [target] = await db.query(
      "INSERT INTO users(email,display_name,state) VALUES($1,'Target','DISABLED') RETURNING id,version",
      [`${tag}-target@example.org`],
    );
    const edit = await staffBrowser.request(
      '/users/' + target.id,
      'PATCH',
      { email: `${tag}-holder@example.org`, reason: 'Synthetic email collision test' },
      { 'If-Match': `"${target.version}"` },
    );
    assert.equal(edit.status, 409);
  });

  it('lists team memberships for each user so staff can be picked as ticket assignees', async () => {
    const itTeamId = '00000000-0000-4000-8000-000000000001';
    await db.query(
      `INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,'MEMBER') ON CONFLICT (user_id,team_id) DO UPDATE SET level='MEMBER'`,
      [userId, itTeamId],
    );
    const listed = await staffBrowser.request('/users?q=' + encodeURIComponent(registeredEmail));
    assert.equal(listed.status, 200);
    assert.equal(listed.data.items.length, 1);
    assert.deepEqual(listed.data.items[0].teams, [
      { teamId: itTeamId, teamCode: 'IT', level: 'MEMBER' },
    ]);
    const all = await staffBrowser.request('/users?limit=100');
    for (const item of all.data.items) assert.ok(Array.isArray(item.teams));
    await db.query('DELETE FROM team_memberships WHERE user_id=$1 AND team_id=$2', [
      userId,
      itTeamId,
    ]);
  });
  it('paginates and searches users and revokes sessions after account changes and logout-all', async () => {
    const page = await staffBrowser.request('/users?limit=1');
    assert.equal(page.status, 200);
    assert.equal(page.data.items.length, 1);
    assert.ok(page.data.nextCursor);
    const next = await staffBrowser.request(
      '/users?limit=1&cursor=' + encodeURIComponent(page.data.nextCursor),
    );
    assert.equal(next.status, 200);
    assert.notEqual(next.data.items[0].id, page.data.items[0].id);
    const searched = await staffBrowser.request('/users?q=' + encodeURIComponent(registeredEmail));
    assert.equal(searched.data.items.length, 1);
    const user = searched.data.items[0];
    const changed = await staffBrowser.request(
      '/users/' + userId,
      'PATCH',
      { state: 'DISABLED', reason: 'Synthetic access control test' },
      { 'If-Match': `"${user.version}"` },
    );
    assert.equal(changed.status, 200);
    assert.equal((await employee.request('/me')).status, 401);
    assert.equal(
      (
        await employee.request('/auth/login', 'POST', {
          email: registeredEmail,
          password: pass + ' revised',
        })
      ).status,
      401,
    );
    assert.equal((await staffBrowser.request('/auth/logout-all', 'POST', {})).status, 200);
    assert.equal((await staffBrowser.request('/me')).status, 401);
  });
});
