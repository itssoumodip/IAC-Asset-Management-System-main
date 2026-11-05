import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Db } from '../src/db';
import { bootstrapAdmin } from '../src/cli';
import { passwordHash } from '../src/auth';

const connection = process.env.TEST_DATABASE_URL;
if (!connection)
  process.stderr.write(
    'Bootstrap integration skipped: set TEST_DATABASE_URL to a disposable database ending _test.\n',
  );
const tag = `bootstrap-${randomUUID()}`;
const pass = 'Synthetic bootstrap password 2036!';

describe('operator bootstrap', { skip: !connection, concurrency: false }, () => {
  let db: Db;
  before(() => {
    process.env.DATABASE_URL = connection;
    db = new Db();
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('promotes an existing Zoho directory record instead of failing on the email', async () => {
    const email = `${tag}-adopt@example.org`;
    await assert.rejects(
      db.tx(async (client) => {
        // Zoho People sync creates people as DIRECTORY stubs with no password.
        await db.query(
          "INSERT INTO users(email,display_name,state) VALUES($1,'Directory Name','DIRECTORY')",
          [email],
          client,
        );
        // Simulate an empty database: no active admin competes with the bootstrap.
        await db.query(
          `DELETE FROM user_roles WHERE user_id IN (
             SELECT u.id FROM users u WHERE u.state='ACTIVE' AND u.email<>$1
           ) AND role_code='SUPER_ADMIN'`,
          [email],
          client,
        );

        await bootstrapAdmin(
          db,
          { email, displayName: 'Synthetic Admin', hashedPassword: await passwordHash(pass) },
          client,
        );

        const [user] = await db.query(
          'SELECT state,email_verified_at,password_hash FROM users WHERE email=$1',
          [email],
          client,
        );
        assert.equal(user.state, 'ACTIVE');
        assert.ok(user.email_verified_at, 'adopted account must be email verified');
        assert.ok(await argon2.verify(user.password_hash, pass), 'password must be usable');

        const roles = (
          await db.query('SELECT role_code FROM user_roles WHERE user_id=(SELECT id FROM users WHERE email=$1) ORDER BY role_code', [email], client)
        ).map((row) => row.role_code);
        assert.deepEqual(roles, ['EMPLOYEE', 'SUPER_ADMIN']);

        const [approved] = await db.query('SELECT 1 FROM approved_emails WHERE email=$1', [email], client);
        assert.ok(approved, 'adopted account must be approved for registration');

        const [audit] = await db.query(
          "SELECT action FROM audit_events WHERE entity_id=(SELECT id FROM users WHERE email=$1) ORDER BY occurred_at DESC LIMIT 1",
          [email],
          client,
        );
        assert.equal(audit.action, 'OPERATOR_BOOTSTRAP');

        // Roll the fixture back so the shared test database is untouched.
        throw new Error('__rollback__');
      }),
      /__rollback__/,
    );
  });

  it('refuses to take over an active account or a leaver', async () => {
    const activeEmail = `${tag}-active@example.org`;
    const leftEmail = `${tag}-left@example.org`;
    await assert.rejects(
      db.tx(async (client) => {
        // The shared test database may still hold an admin from another suite.
        await db.query(
          "DELETE FROM user_roles WHERE role_code='SUPER_ADMIN' AND user_id IN (SELECT id FROM users WHERE email<>$1)",
          [activeEmail],
          client,
        );
        await db.query(
          "INSERT INTO users(email,display_name,state,email_verified_at) VALUES($1,'Active Person','ACTIVE',now())",
          [activeEmail],
          client,
        );
        await db.query(
          "INSERT INTO users(email,display_name,state,left_at) VALUES($1,'Left Person','DIRECTORY',now())",
          [leftEmail],
          client,
        );
        await assert.rejects(
          bootstrapAdmin(
            db,
            { email: activeEmail, displayName: 'X', hashedPassword: await passwordHash(pass) },
            client,
          ),
          /already in use/i,
        );
        await assert.rejects(
          bootstrapAdmin(
            db,
            { email: leftEmail, displayName: 'X', hashedPassword: await passwordHash(pass) },
            client,
          ),
          /has left/i,
        );
        throw new Error('__rollback__');
      }),
      /__rollback__/,
    );
  });
});
