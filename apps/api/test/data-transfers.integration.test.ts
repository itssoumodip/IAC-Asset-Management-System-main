import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { configuration, hash } from '../src/config';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Transfer integration requires an isolated _test database');
if (process.env.SMTP_HOST !== '127.0.0.1' || process.env.SMTP_USER || process.env.SMTP_PASSWORD)
  throw new Error('Transfer integration requires local Mailpit without external SMTP credentials');
const tag = `transfer-${randomUUID()}`;
const reason = 'Synthetic transfer review';
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};
class Browser {
  csrf = '';
  cookies = new Map<string, string>();
  constructor(
    readonly base: string,
    token?: string,
  ) {
    if (token) this.cookies.set(configuration().sessionCookie, token);
  }
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
        Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
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
    return { status: response.status, data: await response.json() };
  }
  async prepare() {
    const result = await this.request('/auth/csrf');
    this.csrf = result.data.csrfToken;
    return this;
  }
}
describe('Excel/CSV transfer PostgreSQL and HTTP integration', { concurrency: false }, () => {
  let app: INestApplication, db: Db, domain: DomainService, base: string;
  let admin: any, otherAdmin: any, employee: any, itAdmin: any;
  let asset: any;
  const assetInput = {
    category: `${tag}-category`,
    assetType: `${tag}-type`,
    description: `${tag} device`,
    ownershipType: `${tag}-owned`,
    status: 'In Store',
    condition: `${tag}-good`,
    riskLevel: `${tag}-low`,
  };
  const req = (actor: any, version?: number) =>
    ({
      user: actor,
      get: (name: string) =>
        name.toLowerCase() === 'if-match'
          ? version === undefined
            ? undefined
            : `"${version}"`
          : name.toLowerCase() === 'idempotency-key'
            ? randomUUID()
            : undefined,
    }) as AuthRequest;
  const input = (module: string, rows: Record<string, string>[]) => ({
    module,
    filename: 'synthetic.csv',
    sha256: 'a'.repeat(64),
    reason,
    rows,
  });
  const preview = async (actor: any, module: string, rows: Record<string, string>[]) => {
    const response = await actor.browser.request('/transfers/preview', 'POST', input(module, rows));
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  const commit = (actor: any, batch: any) =>
    actor.browser.request(`/transfers/${batch.id}/commit`, 'POST', { confirmed: true });
  const counts = async () =>
    (
      await db.query(`SELECT
    (SELECT count(*)::int FROM assets) AS assets,
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM approved_emails) AS approved,
    (SELECT count(*)::int FROM tickets) AS tickets,
    (SELECT count(*)::int FROM assignments) AS assignments,
    (SELECT count(*)::int FROM assignment_events) AS assignment_events,
    (SELECT count(*)::int FROM asset_movements) AS movements,
    (SELECT count(*)::int FROM notification_outbox) AS outbox,
    (SELECT count(*)::int FROM email_deliveries) AS deliveries,
    (SELECT count(*)::int FROM idempotency_keys) AS idempotency,
    (SELECT count(*)::int FROM auth_tokens) AS tokens,
    (SELECT count(*)::int FROM audit_events WHERE entity_type<>'data_transfer') AS audits`)
    )[0];
  before(async () => {
    process.env.DATABASE_URL = connection;
    for (const key of ['AUTH_MAIL_ENCRYPTION_KEY', 'TOTP_ENCRYPTION_KEY', 'CSRF_SECRET'])
      process.env[key] ||= randomBytes(32).toString('hex');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    db = app.get(Db);
    domain = app.get(DomainService);
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    const make = async (role: string) => {
      const token = randomBytes(32).toString('hex');
      const user: any = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Synthetic transfer user',
        roles: [role],
        state: 'ACTIVE',
        version: 1,
        portalAcceptedAt: new Date().toISOString(),
        portalNoticeVersion: configuration().noticeVersion,
        emailVerifiedAt: new Date().toISOString(),
        mfaEnrolled: true,
        mfaVerifiedAt: new Date().toISOString(),
        sessionScope: 'APP',
        sessionHash: hash(token),
      };
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),$4)",
        [user.id, user.email, user.displayName, configuration().noticeVersion],
      );
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
      await db.query('INSERT INTO approved_emails(email) VALUES($1)', [user.email]);
      await db.query(
        "INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,'synthetic',now()+interval '1 hour',now())",
        [user.sessionHash, user.id],
      );
      user.browser = await new Browser(base, token).prepare();
      return user;
    };
    admin = await make('ADMIN');
    otherAdmin = await make('ADMIN');
    employee = await make('EMPLOYEE');
    itAdmin = await make('IT_ADMIN');
    for (const [kind, code] of [
      ['CATEGORY', assetInput.category],
      ['ASSET_TYPE', assetInput.assetType],
      ['OWNERSHIP', assetInput.ownershipType],
      ['CONDITION', assetInput.condition],
      ['RISK', assetInput.riskLevel],
      ['TICKET_CATEGORY', `${tag}-ticket`],
    ])
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
    asset = await domain.createAsset(req(admin), assetInput);
  });
  after(async () => {
    if (app) await app.close();
  });
  it('keeps nested transactions and implicit queries on the correct client, including outer rollback and concurrent contexts', async () => {
    const code = `${tag}-rollback`;
    await assert.rejects(
      db.tx(async (outer) => {
        await db.tx(async (inner) => {
          assert.equal(inner, outer);
          await db.query('INSERT INTO departments(code,name) VALUES($1,$1)', [code]);
        });
        assert.equal(
          (await db.query('SELECT code FROM departments WHERE code=$1', [code])).length,
          1,
        );
        throw new Error('Synthetic rollback');
      }),
      /Synthetic rollback/,
    );
    assert.equal((await db.query('SELECT code FROM departments WHERE code=$1', [code])).length, 0);
    const contexts = await Promise.all(
      [1, 2].map((index) =>
        db.tx(async (outer) => {
          const first = (await db.query('SELECT pg_backend_pid() AS pid'))[0].pid;
          await db.tx(async (inner) => {
            assert.equal(inner, outer);
            await db.query('SELECT pg_sleep(0.02)');
          });
          const last = (await db.query('SELECT pg_backend_pid() AS pid'))[0].pid;
          assert.equal(first, last);
          return { index, pid: first };
        }),
      ),
    );
    assert.notEqual(contexts[0]!.pid, contexts[1]!.pid);
    await db.tx(async () => {
      await assert.rejects(
        db.tx(async () => {
          await db.query('SELECT 1/0');
        }),
      );
      assert.equal((await db.query('SELECT 7 AS value'))[0].value, 7);
    });
  });
  it('enforces HTTP authentication, CSRF and role-scoped definitions, rows and request limits', async () => {
    const anonymous = await new Browser(base).prepare();
    assert.equal((await anonymous.request('/transfers/definitions')).status, 401);
    for (const actor of [employee, itAdmin]) {
      const result = await actor.browser.request('/transfers/definitions');
      assert.equal(result.status, 200);
      assert.deepEqual(
        result.data.items.map((item: any) => item.module),
        ['tickets'],
      );
      assert.equal(
        (
          await actor.browser.request(
            '/transfers/preview',
            'POST',
            input('people', [{ action: 'INVITE', email: 'synthetic@example.org' }]),
          )
        ).status,
        403,
      );
    }
    const available = await admin.browser.request('/transfers/definitions');
    assert.ok(available.data.items.some((item: any) => item.module === 'masters:TICKET_STATUS'));
    assert.equal(
      (await admin.browser.request('/transfers/preview', 'POST', input('tickets', []))).status,
      422,
    );
    assert.equal(
      (
        await admin.browser.request(
          '/transfers/preview',
          'POST',
          input(
            'tickets',
            Array.from({ length: 501 }, () => ({ subject: 'Example' })),
          ),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await admin.browser.request('/transfers/preview', 'POST', {
          ...input('tickets', [{}]),
          filename: '../private.csv',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await admin.browser.request('/transfers/preview', 'POST', input('tickets', [{}]), {
          'X-CSRF-Token': 'invalid',
        })
      ).status,
      403,
    );
    const large = input(
      'tickets',
      Array.from({ length: 500 }, () => ({ description: 'x'.repeat(5000), subject: 'x'.repeat(5000), category: 'x'.repeat(5000) })),
    );
    assert.equal((await admin.browser.request('/transfers/preview', 'POST', large)).status, 413);
    const [{ previews }] = await db.query('SELECT count(*)::int AS previews FROM data_transfers');
    const forbidden = await admin.browser.request(
      '/transfers/preview',
      'POST',
      input('people', [
        { action: 'INVITE', email: 'synthetic@example.org', password: 'not accepted' },
      ]),
    );
    assert.equal(forbidden.status, 422);
    assert.match(forbidden.data.error.message, /Unrecognized columns/);
    assert.equal(
      (await db.query('SELECT count(*)::int AS previews FROM data_transfers'))[0].previews,
      previews,
    );
  });
  it('previews without committing business data or mail, preserving exact raw provenance and invalid row results', async () => {
    const beforeCounts = await counts();
    const rows = [
      {
        action: 'CREATE',
        code: `${tag}-preview`,
        name: `  Synthetic department ${tag}  `,
        active: 'true',
      },
      { action: 'CREATE', code: `${tag}-invalid`, name: '', active: 'true' },
    ];
    const batch = await preview(admin, 'masters:departments', rows);
    assert.equal(batch.valid, false);
    assert.deepEqual(
      batch.rows.map((row: any) => row.valid),
      [true, false],
    );
    assert.deepEqual(await counts(), beforeCounts);
    assert.equal(
      (await db.query('SELECT id FROM departments WHERE code=$1', [rows[0]!.code])).length,
      0,
    );
    const [stored] = await db.query('SELECT * FROM data_transfers WHERE id=$1', [batch.id]);
    assert.deepEqual(stored.raw_rows, rows);
    assert.equal(stored.actor_id, admin.id);
    assert.equal(stored.source_filename, 'synthetic.csv');
    assert.equal(stored.source_sha256, 'a'.repeat(64));
    const committed = await commit(admin, batch);
    assert.equal(committed.status, 201);
    assert.equal(committed.data.rowCount, 1);
    assert.equal(committed.data.skippedCount, 1);
    assert.equal((await db.query('SELECT id FROM departments WHERE code=$1',[rows[1]!.code])).length,0);
  });
  it('commits atomically, returns one stored receipt on repeats, binds the actor and protects source payload', async () => {
    const rows = [1, 2].map((index) => ({
      action: 'CREATE',
      code: `${tag}-apply-${index}`,
      name: `${tag} applied ${index}`,
      active: 'true',
    }));
    const batch = await preview(admin, 'masters:departments', rows);
    assert.equal(batch.valid, true);
    assert.equal((await commit(otherAdmin, batch)).status, 404);
    assert.equal(
      (await admin.browser.request(`/transfers/${batch.id}/commit`, 'POST', { confirmed: false }))
        .status,
      422,
    );
    const [applied, simultaneous] = await Promise.all([commit(admin, batch), commit(admin, batch)]);
    assert.equal(applied.status, 201);
    assert.equal(simultaneous.status, 201);
    assert.deepEqual(simultaneous.data, applied.data);
    assert.equal(applied.data.state, 'COMMITTED');
    assert.equal(applied.data.results.length, 2);
    assert.deepEqual((await commit(admin, batch)).data, applied.data);
    const [{ count }] = await db.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='TRANSFER_COMMITTED'",
      [batch.id],
    );
    assert.equal(count, 1);
    await assert.rejects(
      db.query('UPDATE data_transfers SET raw_rows=$2 WHERE id=$1', [batch.id, '[]']),
      /immutable/,
    );
    await assert.rejects(
      db.query('DELETE FROM data_transfers WHERE id=$1', [batch.id]),
      /cannot be deleted/,
    );
  });
  it('rolls back all earlier rows when a later record version changed after preview', async () => {
    const department = await domain.createMaster(req(admin), 'departments', {
      code: `${tag}-stale`,
      name: `${tag} stale`,
      reason,
    });
    const batch = await preview(admin, 'masters:departments', [
      { action: 'CREATE', code: `${tag}-must-rollback`, name: `${tag} must roll back` },
      {
        action: 'UPDATE',
        code: department.code,
        version: String(department.version),
        name: `${tag} changed`,
      },
    ]);
    assert.equal(batch.valid, true);
    await domain.updateMaster(req(admin, department.version), 'departments', department.id, {
      name: `${tag} concurrent`,
      reason,
    });
    const result = await commit(admin, batch);
    assert.equal(result.status, 409);
    assert.match(result.data.error.message, /Row 2.*No rows were applied/);
    assert.equal(
      (await db.query('SELECT id FROM departments WHERE code=$1', [`${tag}-must-rollback`])).length,
      0,
    );
    assert.equal(
      (await db.query('SELECT state FROM data_transfers WHERE id=$1', [batch.id]))[0].state,
      'PREVIEWED',
    );
  });
  it('preserves permanent Asset IDs and prevents fixed workflow changes', async () => {
    assert.equal(
      (
        await preview(admin, 'masters:TICKET_STATUS', [
          { action: 'CREATE', code: 'UNAPPROVED_WORKFLOW', label: 'No' },
        ])
      ).valid,
      false,
    );
    assert.equal(
      (
        await admin.browser.request(
          '/transfers/preview',
          'POST',
          input('masters:TICKET_STATUS', [
            { action: 'UPDATE', code: 'OPEN', version: '1', label: 'No', active: 'false' },
          ]),
        )
      ).status,
      422,
    );
    const duplicateCode = await preview(admin, 'assets', [
      { action: 'CREATE', assetCode: 'IAC-IT-999999', ...assetInput },
    ]);
    assert.equal(duplicateCode.valid, false);
    assert.match(duplicateCode.rows[0].errors[0], /Import review/);
    const create = await preview(admin, 'assets', [{ action: 'CREATE', ...assetInput }]);
    assert.equal(create.valid, true);
    const applied = await commit(admin, create);
    assert.equal(applied.status, 201);
    const [created] = await db.query('SELECT asset_code,finance_pending FROM assets WHERE id=$1', [
      applied.data.results[0].id,
    ]);
    assert.match(created.asset_code, /^IAC-IT-\d{6}$/);
    assert.equal(created.finance_pending, true);
    const edit = await preview(admin, 'assets', [
      {
        action: 'UPDATE',
        assetCode: asset.assetCode,
        version: String(asset.version),
        description: 'Synthetic updated details',
      },
    ]);
    assert.equal(edit.valid, true);
    assert.equal((await commit(admin, edit)).status, 201);
    const [after] = await db.query(
      'SELECT asset_code,description,version FROM assets WHERE id=$1',
      [asset.id],
    );
    assert.equal(after.asset_code, asset.assetCode);
    assert.equal(after.description, 'Synthetic updated details');
    asset.version = after.version;
  });
  it('creates only the current reporter’s tickets and queues confirmations once after explicit commit', async () => {
    const beforeCounts = await counts();
    const batch = await preview(employee, 'tickets', [
      {
        subject: 'Synthetic support',
        description: 'Synthetic issue details',
        category: `${tag}-ticket`,
        priority: 'MEDIUM',
      },
    ]);
    assert.equal(batch.valid, true);
    assert.deepEqual(await counts(), beforeCounts);
    const applied = await commit(employee, batch);
    assert.equal(applied.status, 201);
    assert.deepEqual((await commit(employee, batch)).data, applied.data);
    const [ticket] = await db.query('SELECT reporter_id FROM tickets WHERE id=$1', [
      applied.data.results[0].id,
    ]);
    assert.equal(ticket.reporter_id, employee.id);
    const [{ count }] = await db.query(
      'SELECT count(*)::int AS count FROM notification_outbox WHERE event_key LIKE $1',
      [`ticket:${applied.data.results[0].id}:%`],
    );
    assert.ok(count >= 1);
    const unrelated = await preview(employee, 'tickets', [
      {
        subject: 'Synthetic unrelated',
        description: 'Not in custody',
        category: `${tag}-ticket`,
        priority: 'LOW',
        assetCode: asset.assetCode,
      },
    ]);
    assert.equal(unrelated.valid, false);
    const missing = await preview(employee, 'tickets', [
      {
        subject: 'Synthetic missing',
        description: 'Missing asset',
        category: `${tag}-ticket`,
        priority: 'LOW',
        assetCode: 'IAC-IT-999999',
      },
    ]);
    assert.deepEqual(unrelated.rows[0].errors, missing.rows[0].errors);
    const privateTicket = await domain.createTicket(req(admin), {
      subject: 'Synthetic private request',
      description: 'Admin reported request',
      category: `${tag}-ticket`,
      priority: 'LOW',
    });
    const related = async (relatedTicketNumber: string) =>
      preview(employee, 'tickets', [
        {
          subject: 'Synthetic related request',
          description: 'Reference check',
          category: `${tag}-ticket`,
          priority: 'LOW',
          relatedTicketNumber,
        },
      ]);
    const inaccessible = await related(String(privateTicket.ticketNumber));
    const nonexistent = await related('9999999999999999');
    assert.equal(inaccessible.valid, false);
    assert.deepEqual(inaccessible.rows[0].errors, nonexistent.rows[0].errors);
  });
  it('creates no accounts, invite tokens or outbox during preview and sends through normal outbox once on confirmed invite', async () => {
    const email = `${tag}-invite@example.org`;
    const beforeCounts = await counts();
    const duplicate = await preview(admin, 'people', [
      { action: 'INVITE', email, displayName: 'Synthetic duplicate invitation' },
      {
        action: 'INVITE',
        email: email.toUpperCase(),
        displayName: 'Synthetic repeated invitation',
      },
    ]);
    assert.equal(duplicate.valid, false);
    assert.match(duplicate.rows[1].errors[0], /more than once/);
    assert.deepEqual(await counts(), beforeCounts);
    const response = await admin.browser.request('/transfers/preview', 'POST', {
      ...input('people', [{ action: 'INVITE', email, displayName: 'Synthetic invited employee' }]), sendEmails: true,
    });
    assert.equal(response.status, 201);
    const batch = response.data;
    assert.equal(batch.valid, true);
    assert.deepEqual(await counts(), beforeCounts);
    assert.equal((await db.query('SELECT id FROM users WHERE email=$1', [email])).length, 0);
    assert.equal(
      (await db.query('SELECT email FROM approved_emails WHERE email=$1', [email])).length,
      0,
    );
    const applied = await commit(admin, batch);
    assert.equal(applied.status, 201);
    const postCommit = await counts();
    assert.equal(postCommit.tokens, beforeCounts.tokens + 1);
    assert.equal(postCommit.outbox, beforeCounts.outbox + 1);
    assert.deepEqual((await commit(admin, batch)).data, applied.data);
    assert.deepEqual(await counts(), postCommit);
    const [user] = await db.query(
      'SELECT state,email_verified_at,password_hash FROM users WHERE id=$1',
      [applied.data.results[0].id],
    );
    assert.equal(user.state, 'INVITED');
    assert.equal(user.email_verified_at, null);
    assert.equal(user.password_hash, null);
  });
  it('rechecks custody and both versions for assign, transfer and return, with normal audit/mail and no historical overwrite', async () => {
    const assign = await preview(admin, 'assignments', [
      {
        action: 'ASSIGN',
        assetCode: asset.assetCode,
        assetVersion: String(asset.version),
        employeeEmail: employee.email,
      },
    ]);
    assert.equal(assign.valid, true);
    assert.equal(
      (await db.query('SELECT id FROM assignments WHERE asset_id=$1', [asset.id])).length,
      0,
    );
    assert.equal((await commit(admin, assign)).status, 201);
    let [current] = await db.query(
      'SELECT a.version AS asset_version,s.* FROM assets a JOIN assignments s ON s.asset_id=a.id WHERE a.id=$1 AND s.ended_at IS NULL',
      [asset.id],
    );
    assert.equal(current.user_id, employee.id);
    const transfer = await preview(admin, 'assignments', [
      {
        action: 'TRANSFER',
        assetCode: asset.assetCode,
        assetVersion: String(current.asset_version),
        assignmentVersion: String(current.version),
        employeeEmail: employee.email,
      },
    ]);
    assert.equal(transfer.valid, false);
    const returnBatch = await preview(admin, 'assignments', [
      {
        action: 'RETURN',
        assetCode: asset.assetCode,
        assetVersion: String(current.asset_version),
        assignmentVersion: String(current.version),
        condition: assetInput.condition,
      },
    ]);
    assert.equal(returnBatch.valid, true);
    await db.query('UPDATE assets SET version=version+1 WHERE id=$1', [asset.id]);
    assert.equal((await commit(admin, returnBatch)).status, 409);
    [current] = await db.query(
      'SELECT a.version AS asset_version,s.* FROM assets a JOIN assignments s ON s.asset_id=a.id WHERE a.id=$1 AND s.ended_at IS NULL',
      [asset.id],
    );
    assert.equal(current.ended_at, null);
    const fresh = await preview(admin, 'assignments', [
      {
        action: 'RETURN',
        assetCode: asset.assetCode,
        assetVersion: String(current.asset_version),
        assignmentVersion: String(current.version),
        condition: assetInput.condition,
      },
    ]);
    assert.equal((await commit(admin, fresh)).status, 201);
    const [history] = await db.query('SELECT ended_at FROM assignments WHERE id=$1', [current.id]);
    assert.ok(history.ended_at);
  });
  it('rolls back row-one custody, audit, idempotency and outbox when a later custody version is stale', async () => {
    const first = await domain.createAsset(req(admin), {
      ...assetInput,
      description: 'Synthetic first atomic device',
    });
    const second = await domain.createAsset(req(admin), {
      ...assetInput,
      description: 'Synthetic second atomic device',
    });
    const batch = await preview(
      admin,
      'assignments',
      [first, second].map((entry) => ({
        action: 'ASSIGN',
        assetCode: entry.assetCode,
        assetVersion: String(entry.version),
        employeeEmail: employee.email,
      })),
    );
    assert.equal(batch.valid, true);
    await db.query('UPDATE assets SET version=version+1 WHERE id=$1', [second.id]);
    const beforeCounts = await counts();
    const applied = await commit(admin, batch);
    assert.equal(applied.status, 409);
    assert.match(applied.data.error.message, /Row 2.*No rows were applied/);
    assert.deepEqual(await counts(), beforeCounts);
    const [unchanged] = await db.query('SELECT status,version FROM assets WHERE id=$1', [first.id]);
    assert.equal(unchanged.status, 'In Store');
    assert.equal(unchanged.version, first.version);
  });
  it('validates notification role membership before replacing group recipients', async () => {
    const invalid = await preview(admin, 'notifications', [
      { code: 'IT', enabled: 'true', recipients: employee.email },
    ]);
    assert.equal(invalid.valid, false);
    const batch = await preview(admin, 'notifications', [
      { code: 'IT', enabled: 'true', recipients: itAdmin.email },
    ]);
    assert.equal(batch.valid, true);
    const applied = await commit(admin, batch);
    assert.equal(applied.status, 201);
    const recipients = await db.query(
      "SELECT r.email FROM notification_recipients r JOIN notification_groups g ON g.id=r.group_id WHERE g.code='IT'",
    );
    assert.deepEqual(
      recipients.map((row) => row.email),
      [itAdmin.email],
    );
  });
  it('revalidates current roles and expiry at commit instead of trusting a previous Admin preview', async () => {
    const batch = await preview(otherAdmin, 'masters:departments', [
      { action: 'CREATE', code: `${tag}-role-denied`, name: `${tag} role denied` },
    ]);
    await db.query("UPDATE user_roles SET role_code='EMPLOYEE' WHERE user_id=$1", [otherAdmin.id]);
    assert.equal((await commit(otherAdmin, batch)).status, 403);
    assert.equal(
      (await db.query('SELECT id FROM departments WHERE code=$1', [`${tag}-role-denied`])).length,
      0,
    );
    await db.query("UPDATE user_roles SET role_code='ADMIN' WHERE user_id=$1", [otherAdmin.id]);
    // The immutable expiry is exercised through PostgreSQL's transaction clock: use an
    // intentionally old test fixture, never edit the accepted preview payload.
    const expired = randomUUID();
    await db.query(
      "INSERT INTO data_transfers(id,actor_id,module,source_filename,source_sha256,raw_rows,reason,preview,created_at,expires_at) VALUES($1,$2,'tickets','synthetic.csv',$3,$4,$5,$6,now()-interval '1 hour',now()-interval '1 minute')",
      [
        expired,
        admin.id,
        'b'.repeat(64),
        JSON.stringify([{ subject: 'Expired synthetic' }]),
        reason,
        JSON.stringify({ valid: true }),
      ],
    );
    assert.equal((await commit(admin, { id: expired })).status, 409);
    // Direct service role checks remain in the delegated commands too.
    await assert.rejects(
      domain.createMaster(req(employee), 'departments', { code: 'DENIED', name: 'Denied', reason }),
      status(403),
    );
  });
});
