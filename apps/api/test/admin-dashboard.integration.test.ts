import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { AdminDashboardService } from '../src/admin-dashboard';
import { configuration, hash, signedCsrf, token } from '../src/config';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Admin dashboard integration requires a database name ending _test');
const tag = `dash-${randomUUID()}`;
describe('admin dashboard integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, employee: any, itAdmin: any;
  let departmentId: string, category: string;
  let laptop: any, monitor: any, unpriced: any;
  const req = (user: any) =>
    ({
      user,
      get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
    }) as AuthRequest;
  const get = async (user: any, path: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  const dashboard = (user: any, query = '') =>
    get(user, `/dashboard/admin?departmentId=${departmentId}${query}`);

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[], displayName: string) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName,
        roles,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [result.id, result.email, result.displayName, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [
          result.id,
          role,
        ]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(result.session), result.id, hash(result.csrf)],
      );
      return result;
    };
    admin = await user(['ADMIN'], `${tag} Admin`);
    employee = await user(['EMPLOYEE'], `${tag} Employee`);
    itAdmin = await user(['IT_ADMIN'], `${tag} IT`);
    category = `${tag} category`;
    const references = {
      CATEGORY: category,
      ASSET_TYPE: `${tag} type`,
      OWNERSHIP: `${tag} ownership`,
      CONDITION: `${tag} condition`,
      RISK: `${tag} risk`,
    };
    for (const [kind, code] of Object.entries(references))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
    const [department] = await db.query(
      'INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id',
      [`${tag}-dept`],
    );
    departmentId = department.id;
    const create = () =>
      domain.createAsset(req(admin), {
        category: references.CATEGORY,
        assetType: references.ASSET_TYPE,
        description: `${tag} synthetic asset`,
        ownershipType: references.OWNERSHIP,
        departmentId,
        status: 'In Store',
        condition: references.CONDITION,
        riskLevel: references.RISK,
        amcApplies: false,
      });
    laptop = await create();
    monitor = await create();
    unpriced = await create();
    // Purchases in FY 2024-25 (Apr 2024 - Mar 2025) and FY 2025-26.
    await db.query(
      `UPDATE assets SET purchase_cost=85000,purchase_date='2024-06-10',finance_pending=false,
       warranty_expiry=(now() AT TIME ZONE 'Asia/Kolkata')::date+20 WHERE id=$1`,
      [laptop.id],
    );
    await db.query(
      `UPDATE assets SET purchase_cost=15000.50,purchase_date='2025-04-02',finance_pending=false WHERE id=$1`,
      [monitor.id],
    );
    await db.query(
      `INSERT INTO tickets(reporter_id,asset_id,subject,description,category,priority)
       VALUES($1,$2,'Screen flicker','Synthetic','HARDWARE','MEDIUM'),($1,$2,'Fan noise','Synthetic','HARDWARE','LOW')`,
      [employee.id, laptop.id],
    );
  });

  after(async () => {
    await app?.close();
  });

  it('admin gets KPIs and spend scoped by department', async () => {
    const { status, body } = await dashboard(admin);
    assert.equal(status, 200);
    assert.equal(body.kpis.totalAssets, 3);
    assert.equal(body.kpis.totalSpend, 100000.5);
    assert.equal(body.kpis.missingCost, 1);
    assert.equal(body.kpis.warrantyExpiring, 1);
    assert.deepEqual(
      body.spendByYear.map((r: any) => [r.label, r.spend]),
      [
        ['FY 2024-25', 85000],
        ['FY 2025-26', 15000.5],
      ],
    );
    assert.deepEqual(body.spendByCategory, [{ label: category, spend: 100000.5, count: 2 }]);
    assert.deepEqual(body.statusCounts, [{ label: 'In Store', count: 3 }]);
    assert.equal(body.ticketWeeks.length, 12);
    assert.equal(
      body.ticketWeeks.reduce((sum: number, w: any) => sum + w.opened, 0),
      2,
    );
  });

  it('financial year filter narrows spend', async () => {
    const { body } = await dashboard(admin, '&fy=2024');
    assert.equal(body.kpis.fySpend, 85000);
    assert.deepEqual(body.spendByCategory, [{ label: category, spend: 85000, count: 1 }]);
  });

  it('watch lists', async () => {
    const { body } = await dashboard(admin);
    assert.deepEqual(
      body.expiring.map((r: any) => [r.assetCode, r.kind]),
      [[laptop.assetCode, 'Warranty']],
    );
    assert.equal(body.topReported[0].assetCode, laptop.assetCode);
    assert.equal(body.topReported[0].tickets, 2);
    assert.deepEqual(
      body.financeGaps.map((r: any) => r.assetCode),
      [unpriced.assetCode],
    );
    assert.ok(Array.isArray(body.recentActivity));
  });

  it('dashboard totals and breakdowns share a snapshot during a concurrent catalog write', async () => {
    const original = db.query.bind(db);
    let inserted = false;
    db.query = async (sql: string, values: any[] = [], client?: any) => {
      const rows = await original(sql, values, client);
      if (!inserted && sql.includes('AS total_assets')) {
        inserted = true;
        const writer = await db.pool.connect();
        try {
          await writer.query(
            `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by) VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),$1,$2,'Synthetic dashboard snapshot race',$3,'In Store',$4,$5,$6,$7)`,
            [
              laptop.category,
              laptop.assetType,
              laptop.ownershipType,
              laptop.condition,
              laptop.riskLevel,
              departmentId,
              admin.id,
            ],
          );
        } finally {
          writer.release();
        }
      }
      return rows;
    };
    let snapshot: any;
    try {
      snapshot = await new AdminDashboardService(db).summary(req(admin), { departmentId });
    } finally {
      db.query = original;
    }
    assert.equal(inserted, true);
    assert.equal(
      snapshot.statusCounts.reduce((n: number, r: any) => n + r.count, 0),
      snapshot.kpis.totalAssets,
    );
    const current = await new AdminDashboardService(db).summary(req(admin), { departmentId });
    assert.equal(current.kpis.totalAssets, snapshot.kpis.totalAssets + 1);
  });
  it('is admin only and validates filters', async () => {
    assert.equal((await dashboard(employee)).status, 403);
    assert.equal((await dashboard(itAdmin)).status, 403);
    assert.equal((await dashboard(admin, '&fy=abc')).status, 422);
  });
});
