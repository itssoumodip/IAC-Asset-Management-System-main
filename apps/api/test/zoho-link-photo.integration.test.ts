import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { ZohoSyncService, type ZohoDirectoryClient } from '../src/zoho';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Zoho link/photo integration tests require a database name ending _test');
const tag = `zlp${randomUUID().slice(0, 8)}`;
const request = (actor: any, version?: number) =>
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
const rec = (n: string, extra: Record<string, unknown> = {}) => ({
  recordId: `${tag}-rec-${n}`,
  EmployeeID: `${tag}-E${n}`,
  FirstName: 'Link',
  LastName: `Person${n}`,
  EmailID: `${tag}-z${n}@example.org`,
  Department: `${tag} Dept`,
  Designation: 'Analyst',
  Employeestatus: 'Active',
  Reporting_To: 'Boss One',
  ...extra,
});

describe('Zoho photos and manual linking', { skip: !connection, concurrency: false }, () => {
  let db: Db, admin: any, domain: DomainService, locationId: string, png: Buffer;
  let photoCalls: string[] = [];
  let failPhoto = false;
  const client = (records: any[]): ZohoDirectoryClient => ({
    async fetchEmployees() {
      return records;
    },
    async fetchPhoto(ref: string) {
      photoCalls.push(ref);
      if (failPhoto) throw new Error('photo boom');
      return png;
    },
  });
  const make = async (roles: string[], state = 'ACTIVE') => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic link test',
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

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    png = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
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

  it('stores a sanitised photo, serves it, and skips unchanged re-downloads', async () => {
    photoCalls = [];
    const svc = new ZohoSyncService(db, client([rec('1', { Photo: `${tag}-ph1` })]));
    await svc.run('MANUAL', admin);
    const u = await byEmail(`${tag}-z1@example.org`);
    const [photo] = await db.query('SELECT * FROM user_photos WHERE user_id=$1', [u.id]);
    assert.equal(photo.source, 'ZOHO');
    assert.ok(photo.content.length > 0 && photo.content.length < png.length * 10);
    assert.equal((await sharp(photo.content).metadata()).format, 'jpeg');
    assert.equal(photoCalls.length, 1);
    await svc.run('MANUAL', admin);
    assert.equal(photoCalls.length, 1, 'unchanged ref is not downloaded again');
    await new ZohoSyncService(db, client([rec('1', { Photo: `${tag}-ph1b` })])).run(
      'MANUAL',
      admin,
    );
    assert.equal(photoCalls.length, 2);
    const served = await svc.photo(request(admin), u.id);
    assert.ok(Buffer.isBuffer(served.content));
  });

  it('photo access: self and staff only; other employees denied', async () => {
    const svc = new ZohoSyncService(db, client([rec('2', { Photo: `${tag}-ph2` })]));
    await svc.run('MANUAL', admin);
    const person = await byEmail(`${tag}-z2@example.org`);
    const self = { ...(await make(['EMPLOYEE'])) };
    await db.query('UPDATE users SET zoho_record_id=$2 WHERE id=$1', [self.id, `${tag}-selfrec`]);
    await db.query(
      "INSERT INTO user_photos(user_id,content,sha256,source) VALUES($1,$2,'x','ZOHO')",
      [self.id, png],
    );
    assert.ok((await svc.photo(request(self), self.id)).content);
    const other = await make(['EMPLOYEE']);
    await assert.rejects(svc.photo(request(other), person.id), (e: any) => e.status === 403);
    const staff = await make(['FINANCE']);
    assert.ok((await svc.photo(request(staff), person.id)).content);
    await assert.rejects(svc.photo(request(admin), randomUUID()), (e: any) => e.status === 404);
  });

  it('a photo failure is skipped and does not fail the run', async () => {
    failPhoto = true;
    try {
      const run = await new ZohoSyncService(db, client([rec('3', { Photo: `${tag}-ph3` })])).run(
        'MANUAL',
        admin,
      );
      assert.equal(run.created, 1);
      const u = await byEmail(`${tag}-z3@example.org`);
      assert.equal(
        (await db.query('SELECT 1 FROM user_photos WHERE user_id=$1', [u.id])).length,
        0,
      );
    } finally {
      failPhoto = false;
    }
  });

  it('link joins a portal account to a directory record and survives the next sync', async () => {
    const svc = new ZohoSyncService(db, client([rec('4', { Photo: `${tag}-ph4` })]));
    await svc.run('MANUAL', admin);
    const portal = await make(['EMPLOYEE']);
    const unmatched = await svc.unmatched(request(admin));
    assert.ok(unmatched.zohoWithoutAccount.some((u: any) => u.email === `${tag}-z4@example.org`));
    assert.ok(unmatched.accountsWithoutZoho.some((u: any) => u.id === portal.id));
    assert.ok(!unmatched.accountsWithoutZoho.some((u: any) => u.id === admin.id && false));
    await svc.link(request(admin), {
      userId: portal.id,
      zohoRecordId: `${tag}-rec-4`,
      reason: 'Same person, different email',
    });
    {
      const m = await byEmail(`${tag}-z4@example.org`);
      assert.equal(m.state, 'DISABLED');
      assert.equal(m.merged_into_user_id, portal.id);
      assert.equal(m.zoho_record_id, null);
      assert.equal(
        (await db.query('SELECT 1 FROM user_photos WHERE user_id=$1', [m.id])).length,
        0,
      );
    }
    const linked = await byEmail(portal.email);
    assert.equal(linked.state, 'ACTIVE');
    assert.equal(linked.zoho_record_id, `${tag}-rec-4`);
    assert.equal(linked.employee_code, `${tag}-E4`);
    assert.equal(linked.manager_name, 'Boss One');
    assert.equal(
      (await db.query('SELECT 1 FROM user_photos WHERE user_id=$1', [portal.id])).length,
      1,
    );
    const after = await svc.unmatched(request(admin));
    assert.ok(!after.accountsWithoutZoho.some((u: any) => u.id === portal.id));
    const run = await svc.run('MANUAL', admin);
    assert.equal(run.created, 0, 'matched by record id, no new directory user');
    assert.equal((await byEmail(portal.email)).zoho_status, 'Active');
    {
      const m = await byEmail(`${tag}-z4@example.org`);
      assert.equal(m.state, 'DISABLED');
      assert.equal(m.merged_into_user_id, portal.id);
      assert.equal(m.zoho_record_id, null);
      assert.equal(
        (await db.query('SELECT 1 FROM user_photos WHERE user_id=$1', [m.id])).length,
        0,
      );
    }
    assert.ok(
      (
        await db.query("SELECT 1 FROM audit_events WHERE action='ZOHO_LINKED' AND entity_id=$1", [
          portal.id,
        ])
      ).length,
    );
    await svc.unlink(request(admin), { userId: portal.id, reason: 'wrong person' });
    const cleared = await byEmail(portal.email);
    assert.equal(cleared.zoho_record_id, null);
    assert.equal(cleared.employee_code, null);
    assert.equal(cleared.zoho_unlinked_record_id, `${tag}-rec-4`);
    const resync = await new ZohoSyncService(db, client([rec('4', { EmailID: portal.email })])).run(
      'MANUAL',
      admin,
    );
    assert.equal(resync.skipped, 1);
    assert.equal(
      (await byEmail(portal.email)).zoho_record_id,
      null,
      'unlink is not undone by email match',
    );
    const lists = await svc.unmatched(request(admin));
    assert.ok(!lists.zohoWithoutAccount.some((u: any) => u.email === `${tag}-z4@example.org`));
  });

  it('link refuses when the directory duplicate holds assets', async () => {
    const svc = new ZohoSyncService(db, client([rec('5')]));
    await svc.run('MANUAL', admin);
    const dup = await byEmail(`${tag}-z5@example.org`);
    const asset = await domain.createAsset(request(admin), {
      category: 'Zoho Cat',
      assetType: 'Zoho Type',
      description: `${tag} laptop`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      locationId,
    } as any);
    await domain.assign(
      request(admin, asset.version),
      asset.id,
      { userId: dup.id, note: 'x' },
      false,
      {},
    );
    const portal = await make(['EMPLOYEE']);
    await assert.rejects(
      svc.link(request(admin), {
        userId: portal.id,
        zohoRecordId: `${tag}-rec-5`,
        reason: 'merge',
      }),
      (e: any) => e.status === 409 && /return|transfer/i.test(e.message),
    );
    assert.equal((await byEmail(`${tag}-z5@example.org`)).state, 'DIRECTORY');
    assert.equal((await byEmail(portal.email)).zoho_record_id, null);
  });

  it('a photo write failure is skipped and does not fail the run or the record', async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION ${tag}_pboom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic photo write failure'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER ${tag}_pboom BEFORE INSERT ON user_photos FOR EACH ROW EXECUTE FUNCTION ${tag}_pboom()`,
    );
    try {
      const run: any = await new ZohoSyncService(
        db,
        client([rec('6', { Photo: `${tag}-ph6` })]),
      ).run('MANUAL', admin);
      assert.equal(run.created, 1);
      assert.equal(run.errors ?? 0, 0);
      const u = await byEmail(`${tag}-z6@example.org`);
      assert.ok(u, 'record is still created');
      assert.equal(
        (await db.query('SELECT 1 FROM user_photos WHERE user_id=$1', [u.id])).length,
        0,
      );
    } finally {
      await db.query(`DROP TRIGGER ${tag}_pboom ON user_photos`);
      await db.query(`DROP FUNCTION ${tag}_pboom()`);
    }
  });

  it('link moves ENDED assignment history from the duplicate and refuses open ones', async () => {
    const svc = new ZohoSyncService(db, client([rec('7')]));
    await svc.run('MANUAL', admin);
    const dup = await byEmail(`${tag}-z7@example.org`);
    const asset = await domain.createAsset(request(admin), {
      category: 'Zoho Cat',
      assetType: 'Zoho Type',
      description: `${tag} mailbox laptop`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      locationId,
    } as any);
    const assigned: any = await domain.assign(
      request(admin, asset.version),
      asset.id,
      { userId: dup.id, note: 'x' },
      false,
      {},
    );
    const portal = await make(['EMPLOYEE']);
    const body = { userId: portal.id, zohoRecordId: `${tag}-rec-7`, reason: 'merge' };
    await assert.rejects(svc.link(request(admin), body), (e: any) => e.status === 409);
    await db.query('UPDATE assignments SET ended_at=now(),ended_by=$2 WHERE id=$1', [
      assigned.id,
      admin.id,
    ]);
    await svc.link(request(admin), body);
    const [row] = await db.query('SELECT user_id FROM assignments WHERE id=$1', [assigned.id]);
    assert.equal(row.user_id, portal.id);
    assert.equal((await byEmail(`${tag}-z7@example.org`)).merged_into_user_id, portal.id);
  });

  it('link refuses a disabled or merged target account', async () => {
    const svc = new ZohoSyncService(db, client([rec('8')]));
    await svc.run('MANUAL', admin);
    const disabled = await make(['EMPLOYEE'], 'DISABLED');
    await assert.rejects(
      svc.link(request(admin), { userId: disabled.id, zohoRecordId: `${tag}-rec-8`, reason: 'r' }),
      (e: any) => e.status === 409,
    );
    const merged = await make(['EMPLOYEE']);
    await db.query('UPDATE users SET merged_into_user_id=$2 WHERE id=$1', [merged.id, admin.id]);
    await assert.rejects(
      svc.link(request(admin), { userId: merged.id, zohoRecordId: `${tag}-rec-8`, reason: 'r' }),
      (e: any) => e.status === 409,
    );
    assert.equal((await byEmail(`${tag}-z8@example.org`)).state, 'DIRECTORY');
  });

  it('unmatched lists Zoho records blocked by an earlier unlink', async () => {
    const svc = new ZohoSyncService(db, client([rec('9')]));
    await svc.run('MANUAL', admin);
    const portal = await make(['EMPLOYEE']);
    await db.query('UPDATE users SET zoho_unlinked_record_id=$2 WHERE id=$1', [
      portal.id,
      `${tag}-rec-9x`,
    ]);
    const lists: any = await svc.unmatched(request(admin));
    const hit = lists.blockedByUnlink.find((u: any) => u.id === portal.id);
    assert.ok(hit);
    assert.equal(hit.zohoUnlinkedRecordId, `${tag}-rec-9x`);
  });

  it('link and unmatched require Super Admin', async () => {
    const svc = new ZohoSyncService(db, client([]));
    const emp = await make(['EMPLOYEE']);
    await assert.rejects(svc.unmatched(request(emp)), (e: any) => e.status === 403);
    await assert.rejects(
      svc.link(request(emp), { userId: emp.id, zohoRecordId: 'x', reason: 'r' }),
      (e: any) => e.status === 403,
    );
  });
});
