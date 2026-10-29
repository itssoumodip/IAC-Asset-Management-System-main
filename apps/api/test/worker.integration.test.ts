import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { dispatchOnce } from '../src/worker';
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Worker tests require isolated TEST_DATABASE_URL ending _test');
process.env.DATABASE_URL = connection;
const db = new Db();
after(async () => db.onModuleDestroy());

// The integration suite requires its fake SMTP dependency. Missing SMTP must fail, not pass silently.
async function checkSmtpAvailable(): Promise<boolean> {
  const smtpPort = process.env.SMTP_PORT || '1025';
  const smtpHost = process.env.SMTP_HOST || '127.0.0.1';
  try {
    const net = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: smtpHost, port: parseInt(smtpPort) }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}
async function delivery() {
  const key = `worker-test-${randomUUID()}`;
  await db.tx((c) =>
    db.notify(c, key, 'TEST', [`${key}@example.org`], {
      subject: 'Synthetic worker test',
      text: 'Local Mailpit only.',
    }),
  );
  const [row] = await db.query(
    'SELECT d.* FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
    [key],
  );
  await db.query("UPDATE email_deliveries SET next_attempt_at='2000-01-01' WHERE id=$1", [row.id]);
  return row;
}
test('SMTP worker accepts local mail and records the sent Message-ID', async () => {
  assert.ok(await checkSmtpAvailable(), 'SMTP integration requires local fake mail sink');
  const row = await delivery();
  await dispatchOnce(db);
  const [sent] = await db.query('SELECT * FROM email_deliveries WHERE id=$1', [row.id]);
  assert.equal(sent.state, 'ACCEPTED');
  assert.ok(sent.provider_message_id.includes(row.id));
  assert.equal(
    (await db.query('SELECT result_code FROM email_attempts WHERE delivery_id=$1', [row.id]))[0]
      .result_code,
    'SMTP_ACCEPTED',
  );
});
test('expired worker lease is reclaimed without creating another delivery', async () => {
  assert.ok(await checkSmtpAvailable(), 'SMTP integration requires local fake mail sink');
  const row = await delivery();
  await db.query(
    "UPDATE email_deliveries SET state='LEASED',attempts=1,leased_until=now()-interval '1 minute',lease_token=$2 WHERE id=$1",
    [row.id, randomUUID()],
  );
  await dispatchOnce(db);
  const [sent] = await db.query('SELECT * FROM email_deliveries WHERE id=$1', [row.id]);
  assert.equal(sent.state, 'ACCEPTED');
  assert.equal(sent.attempts, 2);
  assert.equal(sent.lease_token, null);
});
test('SMTP outage leaves durable pending retry and recovers', async () => {
  assert.ok(await checkSmtpAvailable(), 'SMTP integration requires local fake mail sink');
  const row = await delivery();
  const old = process.env.SMTP_PORT;
  process.env.SMTP_PORT = '1';
  try {
    await dispatchOnce(db);
  } finally {
    process.env.SMTP_PORT = old;
  }
  let [state] = await db.query('SELECT * FROM email_deliveries WHERE id=$1', [row.id]);
  assert.equal(state.state, 'PENDING');
  assert.equal(state.attempts, 1);
  assert.ok(new Date(state.next_attempt_at) > new Date());
  await db.query("UPDATE email_deliveries SET next_attempt_at='2000-01-01' WHERE id=$1", [row.id]);
  await dispatchOnce(db);
  [state] = await db.query('SELECT * FROM email_deliveries WHERE id=$1', [row.id]);
  assert.equal(state.state, 'ACCEPTED');
  assert.equal(state.attempts, 2);
});

test('expired authentication delivery is dead-lettered without sending and lease credentials are cleared', async () => {
  const row = await delivery();
  await db.query(
    "UPDATE notification_outbox SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [row.outbox_id],
  );
  await db.query(
    "UPDATE email_deliveries SET state='LEASED',leased_until=now()-interval '1 minute',lease_token=$2 WHERE id=$1",
    [row.id, randomUUID()],
  );
  await dispatchOnce(db);
  const [dead] = await db.query('SELECT * FROM email_deliveries WHERE id=$1', [row.id]);
  assert.equal(dead.state, 'DEAD');
  assert.equal(dead.last_error_code, 'EXPIRED');
  assert.equal(dead.attempts, 0);
  assert.equal(dead.lease_token, null);
  assert.equal(dead.leased_until, null);
  assert.equal(
    (await db.query('SELECT * FROM email_attempts WHERE delivery_id=$1', [row.id])).length,
    0,
  );
  assert.deepEqual(
    (await db.query('SELECT payload FROM notification_outbox WHERE id=$1', [row.outbox_id]))[0]
      .payload,
    {},
  );
});
test('concurrent worker claims do not send the same queued delivery twice', async () => {
  assert.ok(await checkSmtpAvailable(), 'Concurrent SMTP test requires local fake mail sink');
  const rows = await Promise.all([delivery(), delivery()]);
  await Promise.all([dispatchOnce(db), dispatchOnce(db)]);
  for (const row of rows) {
    const [sent] = await db.query('SELECT state,attempts FROM email_deliveries WHERE id=$1', [
      row.id,
    ]);
    assert.equal(sent.state, 'ACCEPTED');
    assert.equal(sent.attempts, 1);
    assert.equal(
      (await db.query('SELECT id FROM email_attempts WHERE delivery_id=$1', [row.id])).length,
      1,
    );
  }
});

test('Finance mail checks current role at dispatch and never sends to revoked recipients', async () => {
  const id = randomUUID(),
    email = `finance-worker-${id}@example.org`;
  await db.query(
    "INSERT INTO users(id,email,display_name,state,email_verified_at) VALUES($1,$2,'Synthetic Finance worker','ACTIVE',now())",
    [id, email],
  );
  await db.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'FINANCE')", [id]);
  async function queued() {
    const key = `finance-worker:${randomUUID()}`;
    await db.tx((c) =>
      db.notify(
        c,
        key,
        'FINANCE_SUBMITTED',
        [email],
        {
          subject: 'Synthetic Finance review',
          text: 'Local fake SMTP only',
        },
        {
          kind: 'FINANCE_REVIEW',
          entityId: randomUUID(),
          title: 'Synthetic',
          message: 'Local only',
        },
      ),
    );
    const [row] = await db.query(
      'SELECT d.id FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
      [key],
    );
    await db.query("UPDATE email_deliveries SET next_attempt_at='1900-01-01' WHERE id=$1", [
      row.id,
    ]);
    return row.id;
  }
  const revoked = await queued();
  await db.query("DELETE FROM user_roles WHERE user_id=$1 AND role_code='FINANCE'", [id]);
  await dispatchOnce(db);
  assert.deepEqual(
    (
      await db.query(
        'SELECT state,last_error_code,provider_message_id FROM email_deliveries WHERE id=$1',
        [revoked],
      )
    )[0],
    { state: 'DEAD', last_error_code: 'RECIPIENT_INELIGIBLE', provider_message_id: null },
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM email_attempts WHERE delivery_id=$1', [revoked])
    )[0].n,
    0,
  );
  assert.ok(await checkSmtpAvailable(), 'Finance acceptance requires local fake mail sink');
  await db.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'FINANCE')", [id]);
  const reused = await queued();
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [id, `changed-${id}@example.org`]);
  const replacement = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,display_name,state,email_verified_at)VALUES($1,$2,'Replacement Finance identity','ACTIVE',now())",
    [replacement, email],
  );
  await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'FINANCE')", [replacement]);
  await dispatchOnce(db);
  assert.equal(
    (await db.query('SELECT state FROM email_deliveries WHERE id=$1', [reused]))[0].state,
    'DEAD',
  );
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM email_attempts WHERE delivery_id=$1', [reused]))[0]
      .n,
    0,
  );
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [
    replacement,
    `replacement-${replacement}@example.org`,
  ]);
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [id, email]);
  const valid = await queued();
  await dispatchOnce(db);
  assert.equal(
    (await db.query('SELECT state FROM email_deliveries WHERE id=$1', [valid]))[0].state,
    'ACCEPTED',
  );
});

test('superseded invitation is suppressed while its replacement is dispatched', async () => {
  assert.ok(await checkSmtpAvailable(), 'Invitation dispatch requires local fake mail sink');
  const { AuthService } = await import('../src/auth');
  const auth = new AuthService(db);
  const id = randomUUID(),
    email = `reinvite-worker-${id}@example.org`;
  await db.query(
    "INSERT INTO users(id,email,display_name) VALUES($1,$2,'Synthetic invitation recipient')",
    [id, email],
  );
  await db.tx((c) => auth.issue(c, { id, email }, 'INVITE'));
  const first = (
    await db.query(
      'SELECT d.id,o.id AS outbox_id FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE d.recipient=$1',
      [email],
    )
  )[0];
  await db.tx((c) => auth.issue(c, { id, email }, 'INVITE'));
  const replacement = (
    await db.query('SELECT id FROM email_deliveries WHERE recipient=$1 AND id<>$2', [
      email,
      first.id,
    ])
  )[0];
  await db.query("UPDATE email_deliveries SET next_attempt_at='1900-01-01' WHERE id=$1", [
    first.id,
  ]);
  await dispatchOnce(db);
  const stale = (
    await db.query(
      'SELECT state,last_error_code,provider_message_id FROM email_deliveries WHERE id=$1',
      [first.id],
    )
  )[0];
  assert.deepEqual(stale, {
    state: 'DEAD',
    last_error_code: 'AUTH_TOKEN_INACTIVE',
    provider_message_id: null,
  });
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM email_attempts WHERE delivery_id=$1', [first.id])
    )[0].n,
    0,
  );
  await db.query("UPDATE email_deliveries SET next_attempt_at='1900-01-01' WHERE id=$1", [
    replacement.id,
  ]);
  await dispatchOnce(db);
  assert.equal(
    (await db.query('SELECT state FROM email_deliveries WHERE id=$1', [replacement.id]))[0].state,
    'ACCEPTED',
  );
});

test('consumed verification, reset and email-change links are not dispatched', async () => {
  const { AuthService } = await import('../src/auth');
  const auth = new AuthService(db);
  for (const purpose of ['VERIFY_EMAIL', 'RESET_PASSWORD', 'EMAIL_CHANGE'] as const) {
    const id = randomUUID(),
      email = `consumed-worker-${id}@example.org`;
    await db.query(
      "INSERT INTO users(id,email,display_name)VALUES($1,$2,'Synthetic consumed token')",
      [id, email],
    );
    await db.tx((c) =>
      purpose === 'EMAIL_CHANGE'
        ? auth.issueEmailChange(c, { id }, email)
        : auth.issue(c, { id, email }, purpose),
    );
    const [row] = await db.query('SELECT id FROM email_deliveries WHERE recipient=$1', [email]);
    await db.query('UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1', [id]);
    await db.query("UPDATE email_deliveries SET next_attempt_at='1900-01-01' WHERE id=$1", [
      row.id,
    ]);
    await dispatchOnce(db);
    assert.deepEqual(
      (
        await db.query(
          'SELECT state,last_error_code,provider_message_id FROM email_deliveries WHERE id=$1',
          [row.id],
        )
      )[0],
      { state: 'DEAD', last_error_code: 'AUTH_TOKEN_INACTIVE', provider_message_id: null },
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int n FROM email_attempts WHERE delivery_id=$1', [row.id])
      )[0].n,
      0,
    );
  }
});

test('ticket dispatch binds the original account, current access and current owner', async () => {
  assert.ok(await checkSmtpAvailable());
  const reporter = randomUUID(),
    support = randomUUID(),
    email = `ticket-worker-${support}@example.org`;
  for (const [id, address] of [
    [reporter, `reporter-${reporter}@example.org`],
    [support, email],
  ])
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at)VALUES($1,$2,'Synthetic ticket worker','ACTIVE',now())",
      [id, address],
    );
  await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'IT_ADMIN')", [support]);
  const [ticket] = await db.query(
    "INSERT INTO tickets(reporter_id,owner_id,subject,description,category,priority)VALUES($1,$2,'Synthetic worker scope','Synthetic','HARDWARE','LOW')RETURNING id",
    [reporter, support],
  );
  async function queue(template = 'TICKET_REPLY') {
    const key = `ticket-worker:${randomUUID()}`;
    await db.tx((c) =>
      db.notify(
        c,
        key,
        template,
        [email],
        { subject: 'Synthetic ticket check', text: 'Local Mailpit only' },
        { kind: 'TICKET', entityId: ticket.id, title: 'Synthetic', message: 'Synthetic' },
      ),
    );
    const [row] = await db.query(
      'SELECT d.id FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
      [key],
    );
    await db.query("UPDATE email_deliveries SET next_attempt_at='1900-01-01' WHERE id=$1", [
      row.id,
    ]);
    return row.id;
  }
  async function check(id: string, state = 'DEAD') {
    await dispatchOnce(db);
    const [row] = await db.query(
      'SELECT state,last_error_code,provider_message_id FROM email_deliveries WHERE id=$1',
      [id],
    );
    assert.equal(row.state, state);
    if (state === 'DEAD') {
      assert.equal(row.last_error_code, 'RECIPIENT_INELIGIBLE');
      assert.equal(row.provider_message_id, null);
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM email_attempts WHERE delivery_id=$1', [id]))[0]
          .n,
        0,
      );
    }
  }
  const revoked = await queue();
  await db.query('DELETE FROM user_roles WHERE user_id=$1', [support]);
  await check(revoked);
  await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'IT_ADMIN')", [support]);
  const disabled = await queue();
  await db.query("UPDATE users SET state='DISABLED' WHERE id=$1", [support]);
  await check(disabled);
  await db.query("UPDATE users SET state='ACTIVE' WHERE id=$1", [support]);
  const staleOwner = await queue('TICKET_OWNER');
  await db.query('UPDATE tickets SET owner_id=NULL WHERE id=$1', [ticket.id]);
  await check(staleOwner);
  const reused = await queue();
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [
    support,
    `changed-${support}@example.org`,
  ]);
  const replacement = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,display_name,state,email_verified_at)VALUES($1,$2,'Replacement identity','ACTIVE',now())",
    [replacement, email],
  );
  await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'IT_ADMIN')", [replacement]);
  await check(reused);
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [
    replacement,
    `replacement-${replacement}@example.org`,
  ]);
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [support, email]);
  await check(await queue(), 'ACCEPTED');
});
