import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { AuthService } from '../src/auth';
import { ZohoSyncService, mapZohoRecord, type ZohoDirectoryClient } from '../src/zoho';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Zoho sync integration tests require a database name ending _test');
const tag = `zoho${randomUUID().slice(0, 8)}`;
const request = (actor: any, version?: number, key = randomUUID()) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match'
        ? version === undefined
          ? undefined
          : `"${version}"`
        : name.toLowerCase() === 'idempotency-key'
          ? key
          : undefined,
  }) as AuthRequest;
const rec = (n: string, extra: Record<string, unknown> = {}) => ({
  recordId: `${tag}-rec-${n}`,
  EmployeeID: `${tag}-E${n}`,
  FirstName: 'Syn',
  LastName: `Person${n}`,
  EmailID: `${tag}-P${n}@Example.org`,
  Department: `${tag} Dept`,
  Designation: 'Analyst',
  Employeestatus: 'Active',
  Reporting_To: 'Boss One',
  ...extra,
});
const stub = (records: any[], delayMs = 0): ZohoDirectoryClient => ({
  async fetchEmployees() {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return records;
  },
});
const assetInput = (description: string, locationId: string) => ({
  category: 'Zoho Cat',
  assetType: 'Zoho Type',
  description,
  ownershipType: 'Owned',
  status: 'In Store',
  condition: 'Good',
  riskLevel: 'Medium',
  amcApplies: false,
  locationId,
});

describe('mapZohoRecord', () => {
  it('maps fields in one place', () => {
    const m = mapZohoRecord({
      recordId: '123',
      EmployeeID: 'E1',
      FirstName: ' Ada ',
      LastName: 'Lovelace',
      EmailID: 'Ada@Example.ORG',
      Department: 'Finance',
      Designation: 'Lead',
      Employeestatus: 'Resigned',
      Reporting_To: 'Boss',
    });
    assert.deepEqual(m, {
      zohoRecordId: '123',
      employeeCode: 'E1',
      displayName: 'Ada Lovelace',
      email: 'ada@example.org',
      department: 'Finance',
      designation: 'Lead',
      managerName: 'Boss',
      status: 'Resigned',
      active: false,
      photoRef: null,
    });
  });
  it('returns null without email or record id; blank status is active', () => {
    assert.equal(mapZohoRecord({ recordId: '1', FirstName: 'A' }), null);
    assert.equal(mapZohoRecord({ EmailID: 'a@b.co' }), null);
    assert.equal(mapZohoRecord({ recordId: '1', EmailID: 'a@b.co' })?.active, true);
  });
});

describe(
  'Zoho directory sync PostgreSQL integration',
  { skip: !connection, concurrency: false },
  () => {
    let db: Db, admin: any, domain: DomainService, locationId: string;
    const make = async (roles: string[], state = 'ACTIVE') => {
      const user: any = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Synthetic zoho test',
        roles,
        teams: [],
        state,
        version: 1,
      };
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,$4,now(),now(),'1')",
        [user.id, user.email, user.displayName, state],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
      return user;
    };
    const byEmail = async (e: string) =>
      (await db.query('SELECT * FROM users WHERE email=lower($1)', [e]))[0];
    const outbox = async () =>
      Number(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM notification_outbox WHERE template='ZOHO_LEAVERS'",
          )
        )[0].n,
      );

    before(async () => {
      process.env.DATABASE_URL = connection;
      process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
      db = new Db();
      domain = new DomainService(db);
      for (const [kind, code] of [
        ['CATEGORY', 'Zoho Cat'],
        ['ASSET_TYPE', 'Zoho Type'],
        ['OWNERSHIP', 'Owned'],
        ['CONDITION', 'Good'],
        ['RISK', 'Medium'],
        ['STATUS', 'In Store'],
      ])
        await db.query(
          'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
          [kind, code],
        );
      [{ id: locationId }] = await db.query(
        "INSERT INTO locations(code,site) VALUES($1,'Synthetic site') RETURNING id",
        [`${tag}-room`],
      );
      admin = await make(['SUPER_ADMIN']);
    });
    after(async () => {
      if (db) await db.onModuleDestroy();
    });

    it('creates DIRECTORY users with directory fields and EMPLOYEE role', async () => {
      const svc = new ZohoSyncService(db, stub([rec('1')]));
      const run = await svc.run('MANUAL', admin);
      assert.equal(run.created, 1);
      const u = await byEmail(`${tag}-P1@example.org`);
      assert.equal(u.state, 'DIRECTORY');
      assert.equal(u.employee_code, `${tag}-E1`);
      assert.equal(u.display_name, 'Syn Person1');
      assert.equal(u.manager_name, 'Boss One');
      assert.equal(u.designation, 'Analyst');
      assert.equal(u.zoho_status, 'Active');
      assert.ok(u.zoho_synced_at);
      assert.equal(u.left_at, null);
      const roles = await db.query('SELECT role_code FROM user_roles WHERE user_id=$1', [u.id]);
      assert.deepEqual(
        roles.map((r) => r.role_code),
        ['EMPLOYEE'],
      );
      const status = await svc.status(request(admin));
      assert.equal(status.configured, true);
      assert.ok(status.runs.length >= 1);
    });

    it('matches an existing ACTIVE user by email without changing state or roles', async () => {
      const existing = await make(['FINANCE']);
      const svc = new ZohoSyncService(
        db,
        stub([rec('2', { EmailID: existing.email.toUpperCase() })]),
      );
      const run = await svc.run('MANUAL', admin);
      assert.equal(run.created, 0);
      assert.equal(run.updated, 1);
      const u = await byEmail(existing.email);
      assert.equal(u.state, 'ACTIVE');
      assert.equal(u.display_name, 'Synthetic zoho test');
      assert.equal(u.zoho_record_id, `${tag}-rec-2`);
      assert.equal(u.employee_code, `${tag}-E2`);
      const roles = await db.query('SELECT role_code FROM user_roles WHERE user_id=$1', [u.id]);
      assert.deepEqual(
        roles.map((r) => r.role_code),
        ['FINANCE'],
      );
    });

    it('creates a department once and matches it case-insensitively', async () => {
      const svc = new ZohoSyncService(
        db,
        stub([
          rec('3', { Department: `${tag} dept` }),
          rec('4', { Department: `${tag} DEPT` }),
          rec('5', { Department: `${tag} New Unit` }),
        ]),
      );
      await svc.run('MANUAL', admin);
      const depts = await db.query('SELECT id,name FROM departments WHERE lower(name) LIKE $1', [
        `${tag} %`,
      ]);
      assert.equal(depts.length, 2);
      const a = await byEmail(`${tag}-P3@example.org`);
      const b = await byEmail(`${tag}-P4@example.org`);
      assert.equal(a.department_id, b.department_id);
      assert.equal(a.department_id, (await byEmail(`${tag}-P1@example.org`)).department_id);
    });

    it('exit sets left_at once, lists held assets in recover, queues one digest', async () => {
      await new ZohoSyncService(db, stub([rec('6')])).run('MANUAL', admin);
      const holder = await byEmail(`${tag}-P6@example.org`);
      const asset = await domain.createAsset(
        request(admin),
        assetInput(`${tag} laptop`, locationId) as any,
      );
      await domain.assign(
        request(admin, asset.version),
        asset.id,
        { userId: holder.id, note: 'x' },
        false,
        {},
      );
      const before = await outbox();
      const left = new ZohoSyncService(db, stub([rec('6', { Employeestatus: 'Resigned' })]));
      const run = await left.run('MANUAL', admin);
      assert.equal(run.left, 1);
      const u = await byEmail(`${tag}-P6@example.org`);
      assert.ok(u.left_at);
      const firstLeft = u.left_at.toISOString();
      const recover = await left.recover(request(admin));
      const item = recover.items.find((i: any) => i.assetCode === asset.assetCode);
      assert.ok(item, 'held asset should be in recover list');
      assert.equal(item.email, `${tag}-p6@example.org`);
      assert.equal((await outbox()) - before, 1);
      await left.run('MANUAL', admin);
      assert.equal((await byEmail(`${tag}-P6@example.org`)).left_at.toISOString(), firstLeft);
      assert.equal((await outbox()) - before, 1, 'digest must not repeat');
      const other = await domain.createAsset(
        request(admin),
        assetInput(`${tag} mouse`, locationId) as any,
      );
      await assert.rejects(
        domain.assign(
          request(admin, other.version),
          other.id,
          { userId: holder.id, note: 'x' },
          false,
          {},
        ),
        (e: any) => [404, 409, 422].includes(e.status),
      );
    });

    it('assigns an asset to a DIRECTORY user without queueing a custody email', async () => {
      await new ZohoSyncService(db, stub([rec('7')])).run('MANUAL', admin);
      const person = await byEmail(`${tag}-P7@example.org`);
      const asset = await domain.createAsset(
        request(admin),
        assetInput(`${tag} phone`, locationId) as any,
      );
      const a = await domain.assign(
        request(admin, asset.version),
        asset.id,
        { userId: person.id, note: 'x' },
        false,
        {},
      );
      assert.ok(a.id);
      const rows = await db.query('SELECT 1 FROM email_deliveries WHERE recipient=$1', [
        person.email,
      ]);
      assert.equal(rows.length, 0);
      const events = await db.query('SELECT 1 FROM assignment_events WHERE assignment_id=$1', [
        a.id,
      ]);
      assert.ok(events.length > 0);
    });

    it('DIRECTORY users cannot log in', async () => {
      const email = `${tag}-login@example.org`;
      const hash = await argon2.hash('Correct-Horse-Battery-9');
      await db.query(
        "INSERT INTO users(email,display_name,state,password_hash,email_verified_at) VALUES($1,'Dir Login','DIRECTORY',$2,now())",
        [email, hash],
      );
      const auth = new AuthService(db);
      await assert.rejects(
        auth.login(
          { ip: `10.${Math.floor(Math.random() * 250)}.0.1`, headers: {} } as any,
          {} as any,
          { email, password: 'Correct-Horse-Battery-9' },
        ),
        (e: any) => e.status === 401,
      );
    });

    it('allows only one concurrent run', async () => {
      const svc = new ZohoSyncService(db, stub([rec('8')], 300));
      const results = await Promise.allSettled([
        svc.run('MANUAL', admin),
        svc.run('MANUAL', admin),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal((rejected.reason as any).status, 409);
    });

    it('one record failing to apply does not stop the others and the run still succeeds', async () => {
      await db.query(
        `CREATE OR REPLACE FUNCTION ${tag}_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name LIKE '%Boom%' THEN RAISE EXCEPTION 'synthetic apply failure'; END IF; RETURN NEW; END $$`,
      );
      await db.query(
        `CREATE TRIGGER ${tag}_boom BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION ${tag}_boom()`,
      );
      try {
        const run: any = await new ZohoSyncService(
          db,
          stub([rec('10'), rec('11', { FirstName: 'Boom' }), rec('12')]),
        ).run('MANUAL', admin);
        assert.equal(run.created, 2);
        assert.equal(run.errors, 1);
        assert.ok(await byEmail(`${tag}-P10@example.org`));
        assert.ok(await byEmail(`${tag}-P12@example.org`));
        assert.equal(await byEmail(`${tag}-P11@example.org`), undefined);
        const [stored] = await db.query(
          'SELECT status,skipped_count,error FROM zoho_sync_runs WHERE id=$1',
          [run.id],
        );
        assert.equal(stored.status, 'SUCCEEDED');
        assert.equal(stored.skipped_count, 1);
        assert.match(stored.error, /1 record/);
      } finally {
        await db.query(`DROP TRIGGER ${tag}_boom ON users`);
        await db.query(`DROP FUNCTION ${tag}_boom()`);
      }
    });

    it('a sync does not hold row locks on users while fetching from Zoho', async () => {
      await new ZohoSyncService(db, stub([rec('13')])).run('MANUAL', admin);
      const running = new ZohoSyncService(db, stub([rec('13')], 600)).run('MANUAL', admin);
      await new Promise((r) => setTimeout(r, 150));
      const started = Date.now();
      await db.query('UPDATE users SET updated_at=now() WHERE email=$1', [
        `${tag}-p13@example.org`,
      ]);
      assert.ok(Date.now() - started < 400, 'user update must not wait for the sync');
      await running;
    });

    it('is disabled and returns 409 when not configured', async () => {
      const svc = new ZohoSyncService(db, null);
      const status = await svc.status(request(admin));
      assert.equal(status.configured, false);
      await assert.rejects(svc.run('MANUAL', admin), (e: any) => e.status === 409);
    });

    it('records a failed run when the Zoho client throws', async () => {
      const svc = new ZohoSyncService(db, {
        async fetchEmployees() {
          throw new Error('boom');
        },
      });
      await assert.rejects(svc.run('MANUAL', admin));
      const status = await svc.status(request(admin));
      assert.equal(status.runs[0].status, 'FAILED');
      assert.match(status.runs[0].error, /boom/);
    });

    it('only Super Admins may read status', async () => {
      const svc = new ZohoSyncService(db, null);
      const emp = await make(['EMPLOYEE']);
      await assert.rejects(svc.status(request(emp)), (e: any) => e.status === 403);
    });
  },
);
