import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { base32, totp, validTotp, passwordHash } from '../src/auth';
import { encrypt, decrypt, signedCsrf, validCsrf, hash } from '../src/config';
import { assertVersion } from '../src/security';
import * as argon2 from 'argon2';

test('TOTP follows RFC 6238 SHA-1 vector and rejects replay', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(secret, 1), '287082');
  const counter = Math.floor(Date.now() / 30000),
    code = totp(secret, counter);
  assert.equal(validTotp(secret, code, null), counter);
  assert.equal(validTotp(secret, code, counter), null);
  assert.equal(validTotp(secret, '0000000', null), null);
});
test('AES-GCM envelopes authenticate ciphertext and use randomized IVs', () => {
  process.env.TOTP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const first = encrypt('synthetic-secret', 'TOTP_ENCRYPTION_KEY'),
    second = encrypt('synthetic-secret', 'TOTP_ENCRYPTION_KEY');
  assert.notEqual(first, second);
  assert.equal(decrypt(first, 'TOTP_ENCRYPTION_KEY'), 'synthetic-secret');
  const damaged = Buffer.from(first, 'base64');
  damaged[15] = damaged[15]! ^ 1;
  assert.throws(() => decrypt(damaged.toString('base64'), 'TOTP_ENCRYPTION_KEY'));
});
test('anonymous CSRF token rejects modified signatures and malformed values', () => {
  process.env.CSRF_SECRET = randomBytes(32).toString('hex');
  const csrf = signedCsrf();
  assert.equal(validCsrf(csrf), true);
  assert.equal(validCsrf(csrf + 'x'), false);
  assert.equal(validCsrf({}), false);
  assert.equal(validCsrf('x'.repeat(201)), false);
});
test('Argon2id protects passwords with unique salts', async () => {
  const first = await passwordHash('Synthetic password 2036!'),
    second = await passwordHash('Synthetic password 2036!');
  assert.match(first, /^\$argon2id\$/);
  assert.notEqual(first, second);
  assert.equal(await argon2.verify(first, 'Synthetic password 2036!'), true);
  assert.equal(await argon2.verify(first, 'incorrect password'), false);
  assert.equal(hash('session').length, 64);
});
test('version writes require exact quoted If-Match', () => {
  const req = (value?: string) => ({ get: () => value }) as any;
  assert.throws(
    () => assertVersion(req(), 1),
    (e: any) => e.status === 428,
  );
  assert.throws(
    () => assertVersion(req('1'), 1),
    (e: any) => e.status === 412,
  );
  assert.throws(
    () => assertVersion(req('"1"'), 2),
    (e: any) => e.status === 412,
  );
  assert.doesNotThrow(() => assertVersion(req('"2"'), 2));
});

test('a concurrent password reset prevents stale-password login from opening a session', async () => {
  const { AuthService } = await import('../src/auth');
  const initialHash = await passwordHash('Old synthetic password 2036!');
  const initial = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'synthetic@example.org',
    display_name: 'Synthetic employee',
    password_hash: initialHash,
    state: 'ACTIVE',
    email_verified_at: new Date(),
    version: 1,
    roles: ['EMPLOYEE'],
  };
  let inserted = false;
  const db = {
    query: async (sql: string) => {
      if (sql.includes('INSERT INTO auth_rate_limits')) return [{ attempts: 1 }];
      if (sql.includes('FROM users u')) return [initial];
      if (sql.includes('FOR UPDATE'))
        return [{ ...initial, password_hash: 'changed-by-concurrent-reset', version: 2 }];
      if (sql.includes('INSERT INTO sessions')) inserted = true;
      return [];
    },
    tx: async (fn: any) => fn({}),
  } as any;
  const service = new AuthService(db);
  const req = { ip: '127.0.0.1', cookies: {}, get: () => '' } as any;
  const res = { cookie: () => {} } as any;
  await assert.rejects(
    service.login(req, res, { email: initial.email, password: 'Old synthetic password 2036!' }),
    (error: any) => error.status === 401,
  );
  assert.equal(inserted, false);
});

test('the final active Admin cannot be disabled or have its Admin role removed', async () => {
  const { AuthService } = await import('../src/auth');
  for (const changes of [{ state: 'DISABLED' }, { roles: ['EMPLOYEE'] }]) {
    const sqlStatements: string[] = [];
    const user = {
      id: '00000000-0000-4000-8000-000000000002',
      state: 'ACTIVE',
      version: 1,
      password_hash: 'synthetic',
      email_verified_at: new Date(),
    };
    const db = {
      query: async (sql: string) => {
        sqlStatements.push(sql);
        if (sql.includes('SELECT * FROM users')) return [user];
        if (sql.includes('SELECT role_code')) return [{ role_code: 'ADMIN' }];
        if (sql.includes('count(*)')) return [{ count: 0 }];
        return [];
      },
      tx: async (fn: any) => fn({}),
    } as any;
    const service = new AuthService(db);
    const req = { user: { id: user.id, roles: ['ADMIN'] }, get: () => '"1"' } as any;
    await assert.rejects(
      service.editUser(req, user.id, { ...changes, reason: 'Synthetic final-admin regression' }),
      (error: any) => error.status === 409,
    );
    assert.ok(sqlStatements.some((sql) => sql.includes('pg_advisory_xact_lock')));
    assert.equal(
      sqlStatements.some((sql) => sql.startsWith('UPDATE users')),
      false,
    );
  }
});


test('admin account edits require a reason before database mutation', async () => {
  const { AuthService } = await import('../src/auth');
  let touched = false;
  const service = new AuthService({ tx: async () => { touched = true; } } as any);
  await assert.rejects(service.editUser({ user: { roles: ['ADMIN'] } } as any,
    '00000000-0000-4000-8000-000000000002', { state: 'DISABLED' }),
    (error: any) => error.issues?.some((issue: any) => issue.message.includes('reason')));
  assert.equal(touched, false);
});
