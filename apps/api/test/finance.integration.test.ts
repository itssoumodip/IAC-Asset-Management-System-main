import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { FinanceService } from '../src/finance';
import { configuration, decrypt, hash, signedCsrf, token } from '../src/config';
import type { AuthRequest } from '../src/security';
const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Finance tests require isolated _test database');
describe(
  'Finance workflow, permissions and approved snapshot integration',
  { skip: !connection, concurrency: false },
  () => {
    let app: INestApplication, db: Db, domain: DomainService, finance: FinanceService, base: string;
    let admin: any,
      reviewer: any,
      second: any,
      executive: any,
      employee: any,
      itAdmin: any,
      dual: any,
      asset: any;
    const tag = `fin-${randomUUID()}`;
    const req = (user: any, version?: number) =>
      ({
        user,
        get: (name: string) =>
          name.toLowerCase() === 'if-match' && version !== undefined
            ? `"${version}"`
            : name.toLowerCase() === 'idempotency-key'
              ? randomUUID()
              : undefined,
      }) as AuthRequest;
    async function call(user: any, path: string, body?: unknown, version?: number, csrf = true) {
      const r = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: configuration().origin,
          ...(user
            ? {
                Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
              }
            : {}),
          ...(body !== undefined
            ? {
                'Content-Type': 'application/json',
                ...(csrf ? { 'X-CSRF-Token': user?.csrf } : {}),
                ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    }
    const approval = {
      decision: 'APPROVE',
      reason: 'Invoice and asset details independently checked',
      purchaseCost: '12500.50',
      purchaseDate: '2026-01-05',
      invoiceNumber: 'SYNTHETIC-INV-1',
      supplier: 'Synthetic Supplier',
    };
    before(async () => {
      process.env.DATABASE_URL = connection;
      app = await createApp();
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
      db = app.get(Db);
      domain = app.get(DomainService);
      finance = app.get(FinanceService);
      async function user(roles: string[]) {
        const u = {
          id: randomUUID(),
          email: `${tag}-${randomUUID()}@example.org`,
          displayName: `Synthetic ${roles.join(' ')}`,
          roles,
          csrf: signedCsrf(),
          session: token(),
        };
        await db.query(
          `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at) VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
          [u.id, u.email, u.displayName, configuration().noticeVersion],
        );
        for (const r of roles)
          await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, r]);
        await db.query(
          `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '1 hour',now())`,
          [hash(u.session), u.id, hash(u.csrf)],
        );
        return u;
      }
      admin = await user(['ADMIN']);
      reviewer = await user(['FINANCE']);
      second = await user(['FINANCE']);
      executive = await user(['EXECUTIVE']);
      employee = await user(['EMPLOYEE']);
      itAdmin = await user(['IT_ADMIN']);
      dual = await user(['ADMIN', 'FINANCE']);
      const refs: any = {};
      for (const kind of ['CATEGORY', 'ASSET_TYPE', 'OWNERSHIP', 'CONDITION', 'RISK']) {
        refs[kind] = `${tag}-${kind}`;
        await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
          kind,
          refs[kind],
        ]);
      }
      asset = await domain.createAsset(req(admin), {
        category: refs.CATEGORY,
        assetType: refs.ASSET_TYPE,
        description: `${tag} test asset`,
        ownershipType: refs.OWNERSHIP,
        status: 'In Store',
        condition: refs.CONDITION,
        riskLevel: refs.RISK,
        amcApplies: false,
      });
    });
    after(async () => {
      await app?.close();
    });
    it('Admin records financial drafts, separate Finance reviews full metadata, later Admin bypasses fail', async () => {
      const target = await domain.createAsset(req(admin), {
        category: asset.category,
        assetType: asset.assetType,
        description: 'Financial review test',
        ownershipType: asset.ownershipType,
        status: 'In Store',
        condition: asset.condition,
        riskLevel: asset.riskLevel,
        purchaseCost: '9000.00',
        residualValue: '500.00',
        insurancePolicyNumber: 'DRAFT-POL',
      });
      assert.equal(target.purchaseCost, '9000.00');
      assert.equal(target.financePending, true);
      let edited = await domain.editAsset(req(admin, target.version), target.id, {
        reason: 'Draft invoice supplied',
        invoiceNumber: 'DRAFT-INV',
        supplier: 'Draft Supplier',
        purchaseDate: '2026-01-01',
      });
      await finance.submit(req(admin, edited.version), target.id, {
        reason: 'Finance review requested',
      });
      let detail = await finance.detail(req(reviewer), target.id);
      assert.equal(detail.purchaseCost, '9000.00');
      for (const [key, value] of Object.entries({
        purchaseCost: '999.00',
        residualValue: '0',
        insurancePolicyNumber: 'BYPASS',
        insuranceExpiry: '2027-01-01',
      })) {
        await assert.rejects(
          () =>
            domain.editAsset(req(admin, detail.assetVersion), target.id, {
              reason: 'Attempted bypass',
              [key]: value,
            }),
          /Finance submission/,
        );
      }
      await assert.rejects(() =>
        finance.review(req(admin, detail.financeVersion), target.id, approval),
      );
      await finance.review(req(reviewer, detail.financeVersion), target.id, {
        ...approval,
        residualValue: '1500.00',
        usefulLifeYears: 5,
        insurancePolicyNumber: 'POL-FINANCE',
        insuranceExpiry: '2027-01-05',
      });
      detail = await finance.detail(req(admin), target.id);
      assert.equal(detail.residualValue, '1500.00');
      assert.equal(detail.usefulLifeYears, 5);
      assert.equal(detail.insurancePolicyNumber, 'POL-FINANCE');
      assert.equal(detail.financePending, false);
      assert.equal(detail.approvedCost, approval.purchaseCost);
      assert.equal(detail.history[0].details.insurancePolicyNumber, 'POL-FINANCE');
    });
    it('queues version-keyed Finance messages atomically with scoped recipients and minimal encrypted content', async () => {
      const a = await domain.createAsset(req(admin), {
        category: asset.category,
        assetType: asset.assetType,
        description: 'Synthetic mail-loop asset',
        ownershipType: asset.ownershipType,
        status: 'In Store',
        condition: asset.condition,
        riskLevel: asset.riskLevel,
        amcApplies: false,
      });
      const submit = () =>
        finance.submit(req(admin, a.version), a.id, {
          reason: 'Private invoice reason must stay inside portal',
        });
      await submit();
      const events = () =>
        db.query(
          'SELECT o.*,d.recipient FROM notification_outbox o LEFT JOIN email_deliveries d ON d.outbox_id=o.id WHERE o.event_key LIKE $1 ORDER BY o.event_key,d.recipient',
          [`finance:${a.id}:%`],
        );
      let rows = await events();
      assert.ok(rows.some((r) => r.recipient === reviewer.email));
      assert.ok(rows.some((r) => r.recipient === second.email));
      assert.ok(
        !rows.some((r) =>
          [admin.email, executive.email, employee.email, itAdmin.email].includes(r.recipient),
        ),
      );
      const decoded = JSON.parse(decrypt(rows[0].payload.ciphertext, 'AUTH_MAIL_ENCRYPTION_KEY'));
      assert.ok(decoded.text.includes('/finance/' + a.id));
      assert.ok(!JSON.stringify(decoded).includes('Private invoice reason'));
      assert.ok(!JSON.stringify(rows[0].payload).includes(a.assetCode));
      const before = rows.length;
      await assert.rejects(submit);
      assert.equal((await events()).length, before);
      let d = await finance.detail(req(reviewer), a.id);
      await finance.review(req(reviewer, d.financeVersion), a.id, {
        decision: 'RETURN',
        reason: 'Synthetic return reason',
      });
      rows = await events();
      const returned = rows.filter((r) => r.template === 'FINANCE_RETURNED');
      assert.equal(returned.length, 1);
      assert.equal(returned[0].recipient, admin.email);
      d = await finance.detail(req(admin), a.id);
      await finance.submit(req(admin, d.assetVersion), a.id, {
        reason: 'Corrected synthetic record',
      });
      d = await finance.detail(req(reviewer), a.id);
      await finance.review(req(reviewer, d.financeVersion), a.id, approval);
      rows = await events();
      assert.equal(rows.filter((r) => r.template === 'FINANCE_APPROVED').length, 1);
      const approved = await finance.detail(req(admin), a.id);
      const count = (
        await db.query('SELECT count(*)::int n FROM asset_finance_events WHERE asset_id=$1', [a.id])
      )[0].n;
      const original = db.notify.bind(db);
      db.notify = async () => {
        throw Error('Synthetic queue failure');
      };
      try {
        await assert.rejects(() =>
          finance.submit(req(admin, approved.assetVersion), a.id, {
            reason: 'Atomic rollback check',
          }),
        );
      } finally {
        db.notify = original;
      }
      assert.equal((await finance.detail(req(admin), a.id)).state, 'APPROVED');
      assert.equal(
        (
          await db.query('SELECT count(*)::int n FROM asset_finance_events WHERE asset_id=$1', [
            a.id,
          ])
        )[0].n,
        count,
      );
    });
    it('Finance notifications persist independently of email dispatch and hide from revoked roles', async () => {
      const notifications = await db.query(
        "SELECT n.* FROM workflow_notifications n WHERE n.kind='FINANCE_REVIEW' AND n.user_id=$1",
        [reviewer.id],
      );
      assert(notifications.length > 0);
      const { NotificationsService } = await import('../src/notifications');
      const inbox = new NotificationsService(db);
      const before = await inbox.workflow(req(reviewer));
      assert(before.items.some((n) => n.kind === 'FINANCE_REVIEW'));
      assert.equal((await inbox.workflow(req(executive))).total, 0);
      assert.equal((await call(undefined, '/notifications/workflow')).status, 401);
      const http = await call(reviewer, '/notifications/workflow?limit=1');
      assert.equal(http.status, 200);
      assert.equal(http.body.items.length, 1);
      assert.equal(
        (
          await call(
            executive,
            `/notifications/workflow/${http.body.items[0].id}/read`,
            {},
            undefined,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await call(
            reviewer,
            `/notifications/workflow/${http.body.items[0].id}/read`,
            {},
            undefined,
            false,
          )
        ).status,
        403,
      );
      assert.equal(
        (await call(reviewer, `/notifications/workflow/${http.body.items[0].id}/read`, {})).status,
        201,
      );

      await db.query("DELETE FROM user_roles WHERE user_id=$1 AND role_code='FINANCE'", [
        reviewer.id,
      ]);
      assert.equal((await inbox.workflow(req(reviewer))).total, 0);
      await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'FINANCE')", [
        reviewer.id,
      ]);
    });
    it('Executive weekly activity reconciles source events, zero fills and uses Kolkata Monday boundaries', async () => {
      const [time] = await db.query(
        "SELECT date_trunc('week',now() AT TIME ZONE 'Asia/Kolkata')::date::text week",
      );
      const [trendAsset] = await db.query(
        "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Trend boundary fixture','Owned','In Store','Good','Low',$1)RETURNING id",
        [admin.id],
      );
      await db.query(
        `INSERT INTO asset_finance_events(asset_id,action,actor_id,reason,finance_version,occurred_at)VALUES($1,'APPROVED',$2,'Boundary synthetic approval',1,($3::date-7)::timestamp AT TIME ZONE 'Asia/Kolkata'),($1,'APPROVED',$2,'Second amendment same asset',2,($3::date-7)::timestamp AT TIME ZONE 'Asia/Kolkata'),($1,'APPROVED',$2,'Before boundary',3,(($3::date-7)::timestamp AT TIME ZONE 'Asia/Kolkata')-interval '1 microsecond')`,
        [trendAsset.id, reviewer.id, time.week],
      );
      await db.query(
        `INSERT INTO tickets(reporter_id,subject,description,category,priority,status,resolution,completed_by,created_at,completed_at)VALUES($1,'Trend fixture','Synthetic','HARDWARE','LOW','COMPLETED','Verified synthetic resolution',$1,($2::date-14)::timestamp AT TIME ZONE 'Asia/Kolkata',($2::date-7)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
        [employee.id, time.week],
      );
      const summary = await finance.executive(req(executive));
      assert.equal(summary.activity.length, 12);
      assert.equal(summary.activity.filter((w: any) => w.partialWeek).length, 1);
      assert.equal(summary.activity.at(-1).weekStart, time.week);
      assert(
        summary.activity.every(
          (w: any) =>
            Number.isInteger(w.approvalEvents) &&
            Number.isInteger(w.ticketsCreated) &&
            Number.isInteger(w.ticketsCompleted),
        ),
      );
      const expected = await db.query(
        `SELECT date_trunc('week',occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS week,count(*)::int n FROM asset_finance_events WHERE action='APPROVED' AND occurred_at>=($1::date-77)::timestamp AT TIME ZONE 'Asia/Kolkata' AND occurred_at<=now() GROUP BY 1`,
        [time.week],
      );
      for (const week of summary.activity)
        assert.equal(week.approvalEvents, expected.find((r) => r.week === week.weekStart)?.n ?? 0);
      const opened = await db.query(
        `SELECT date_trunc('week',created_at AT TIME ZONE 'Asia/Kolkata')::date week,count(*)::int n FROM tickets WHERE created_at>=($1::date-77)::timestamp AT TIME ZONE 'Asia/Kolkata' AND created_at<=now() GROUP BY 1`,
        [time.week],
      );
      for (const week of summary.activity)
        assert.equal(week.ticketsCreated, opened.find((r) => r.week === week.weekStart)?.n ?? 0);
      const completed = await db.query(
        `SELECT date_trunc('week',completed_at AT TIME ZONE 'Asia/Kolkata')::date week,count(*)::int n FROM tickets WHERE completed_at>=($1::date-77)::timestamp AT TIME ZONE 'Asia/Kolkata' AND completed_at<=now() GROUP BY 1`,
        [time.week],
      );
      for (const week of summary.activity)
        assert.equal(
          week.ticketsCompleted,
          completed.find((r) => r.week === week.weekStart)?.n ?? 0,
        );
      assert.match(summary.definitions.activity, /including amendments/);
      assert.equal(JSON.stringify(summary.activity).includes('Boundary synthetic'), false);
      assert.equal((await call(employee, '/finance/executive-summary')).status, 403);
      assert.equal((await call(itAdmin, '/finance/executive-summary')).status, 403);
    });
    it('stocktake HTTP requires Admin, CSRF and close version', async () => {
      assert.equal((await call(undefined, '/stocktake')).status, 401);
      for (const u of [employee, itAdmin, reviewer, executive])
        assert.equal((await call(u, '/stocktake')).status, 403);
      assert.equal(
        (await call(admin, '/stocktake', { name: 'No CSRF' }, undefined, false)).status,
        403,
      );
      const result = await call(admin, '/stocktake', { name: 'HTTP inventory count' });
      assert.equal(result.status, 201);
      const id = result.body.id;
      assert.equal(
        (await call(admin, `/stocktake/${id}/close`, { reason: 'Close without version' })).status,
        428,
      );
      assert.equal(
        (await call(admin, `/stocktake/${id}/close`, { reason: 'Stale close' }, 99)).status,
        412,
      );
      assert.equal(
        (await call(admin, `/stocktake/${id}/close`, { reason: 'No inventory correction' }, 1))
          .status,
        201,
      );
    });
    it('lifecycle HTTP denies non-Admin roles and accepts validated coverage windows', async () => {
      for (const u of [employee, itAdmin, reviewer, executive]) {
        assert.equal((await call(u, '/lifecycle/expiry')).status, 403);
        assert.equal((await call(u, '/lifecycle/recovery')).status, 403);
      }
      assert.equal((await call(undefined, '/lifecycle/expiry')).status, 401);
      assert.equal((await call(admin, '/lifecycle/expiry?window=invalid')).status, 422);
      assert.equal((await call(admin, '/lifecycle/expiry?window=MISSING')).status, 200);
    });
    it('invoice HTTP enforces session, CSRF, role, version and private binary retrieval', async () => {
      const Excel = (await import('exceljs')).default,
        wb = new Excel.Workbook();
      wb.addWorksheet('Invoice').addRow(['Invoice Number', 'SAFE-100']);
      const bytes = Buffer.from(await wb.xlsx.writeBuffer()),
        body = { filename: 'Invoice.xlsx', data: bytes.toString('base64') },
        path = `/finance/assets/${asset.id}/invoices`;
      assert.equal((await call(undefined, path)).status, 401);
      for (const u of [employee, itAdmin, executive])
        assert.equal((await call(u, path, body, asset.version)).status, 403);
      assert.equal((await call(admin, path, body, asset.version, false)).status, 403);
      assert.equal((await call(admin, path, body)).status, 428);
      assert.equal((await call(admin, path, body, 999)).status, 412);
      const uploaded = await call(admin, path, body, asset.version);
      assert.equal(uploaded.status, 201);
      assert.equal(uploaded.body.suggestions.invoiceNumber.value, 'SAFE-100');
      const get = async (u: any, p = path + '/' + uploaded.body.id) =>
        fetch(base + p, { headers: { Cookie: `${configuration().sessionCookie}=${u.session}` } });
      const downloaded = await get(reviewer);
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
      assert.match(downloaded.headers.get('content-disposition')!, /^attachment;/);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
      assert.equal((await get(employee)).status, 403);
      assert.equal(
        (await get(reviewer, `/finance/assets/${randomUUID()}/invoices/${uploaded.body.id}`))
          .status,
        404,
      );
    });
    it('denies anonymous, employee, IT and executive queue access; executive cannot mutate', async () => {
      for (const u of [null, employee, itAdmin, executive])
        assert.equal((await call(u, '/finance/queue')).status, u ? 403 : 401);
      for (const u of [employee, itAdmin, executive, reviewer])
        assert.equal(
          (
            await call(
              u,
              `/finance/assets/${asset.id}/submit`,
              { reason: 'Synthetic submission' },
              asset.version,
            )
          ).status,
          403,
        );
      assert.equal((await call(executive, '/finance/executive-summary')).status, 200);
      for (const u of [employee, itAdmin])
        assert.equal((await call(u, '/finance/executive-summary')).status, 403);
    });
    it('requires Finance/Executive MFA without inheriting all-ticket internal-note access', async () => {
      await db.query('UPDATE sessions SET mfa_verified_at=NULL WHERE user_id=$1', [executive.id]);
      assert.equal((await call(executive, '/finance/executive-summary')).status, 403);
      await db.query('UPDATE sessions SET mfa_verified_at=now() WHERE user_id=$1', [executive.id]);
      const [{ id }] = await db.query(
        `INSERT INTO tickets(reporter_id,subject,description,category,priority) VALUES($1,$2,'Synthetic private ticket','OTHER','LOW') RETURNING id`,
        [employee.id, tag],
      );
      assert.equal((await call(reviewer, `/tickets/${id}`)).status, 404);
      assert.equal((await call(executive, `/tickets/${id}`)).status, 404);
    });
    it('validates reason, If-Match and CSRF before submission and rejects direct approval', async () => {
      const path = `/finance/assets/${asset.id}/submit`;
      assert.equal((await call(admin, path, { reason: '' }, asset.version)).status, 422);
      assert.equal((await call(admin, path, { reason: 'Synthetic submission' })).status, 428);
      assert.equal(
        (await call(admin, path, { reason: 'Synthetic submission' }, asset.version, false)).status,
        403,
      );
      assert.equal(
        (await call(reviewer, `/finance/assets/${asset.id}/review`, approval, 1)).status,
        409,
      );
      assert.equal(
        (await db.query('SELECT * FROM asset_finance WHERE asset_id=$1', [asset.id])).length,
        0,
      );
    });
    it('submits, returns, resubmits and approves with complete history and controlled amendments', async () => {
      const submit = () =>
        finance.submit(req(admin, asset.version), asset.id, { reason: 'Synthetic invoice review' });
      let record = await submit();
      assert.equal(record.state, 'SUBMITTED');
      assert.equal(record.financeVersion, 1);
      assert.equal(
        (await call(admin, `/finance/assets/${asset.id}/review`, approval, 1)).status,
        403,
      );
      await assert.rejects(submit(), /already awaiting/);
      await assert.rejects(
        domain.editAsset(req(admin, asset.version), asset.id, {
          purchaseCost: '999',
          reason: 'Must not bypass review',
        }),
        /Finance submission/,
      );
      let r = await call(
        reviewer,
        `/finance/assets/${asset.id}/review`,
        { decision: 'APPROVE', reason: 'Missing fields' },
        1,
      );
      assert.equal(r.status, 422);
      r = await call(
        reviewer,
        `/finance/assets/${asset.id}/review`,
        { ...approval, purchaseDate: '2099-01-01' },
        1,
      );
      assert.equal(r.status, 422);
      r = await call(
        reviewer,
        `/finance/assets/${asset.id}/review`,
        { decision: 'RETURN', reason: 'Invoice reference needs correction' },
        1,
      );
      assert.equal(r.status, 201);
      assert.equal(r.body.state, 'RETURNED');
      record = await submit();
      assert.equal(record.state, 'SUBMITTED');
      r = await call(
        reviewer,
        `/finance/assets/${asset.id}/review`,
        approval,
        record.financeVersion - 1,
      );
      assert.equal(r.status, 412);
      r = await call(
        reviewer,
        `/finance/assets/${asset.id}/review`,
        approval,
        record.financeVersion,
      );
      assert.equal(r.status, 201);
      record = r.body;
      asset.version = record.assetVersion;
      assert.equal(record.state, 'APPROVED');
      assert.equal(record.approvedCost, '12500.50');
      assert.equal(record.history.length, 4);
      const [dbAsset] = await db.query(
        'SELECT purchase_cost,finance_pending FROM assets WHERE id=$1',
        [asset.id],
      );
      assert.equal(dbAsset.purchase_cost, '12500.50');
      assert.equal(dbAsset.finance_pending, false);
      const before = await finance.executive(req(executive));
      record = await submit();
      const during = await finance.executive(req(executive));
      assert.equal(during.approvedAcquisitionCost, before.approvedAcquisitionCost);
      assert.equal(during.approvedAssets, before.approvedAssets);
      r = await call(
        second,
        `/finance/assets/${asset.id}/review`,
        { ...approval, purchaseCost: '13000.25', reason: 'Corrected invoice total' },
        record.financeVersion,
      );
      assert.equal(r.status, 201);
      asset.version = r.body.assetVersion;
      const after = await finance.executive(req(executive));
      assert.equal(
        Number(after.approvedAcquisitionCost) - Number(before.approvedAcquisitionCost),
        499.75,
      );
    });
    it('rejects stale submitted asset version and requires resubmission', async () => {
      let record = await finance.submit(req(admin, asset.version), asset.id, {
        reason: 'New synthetic amendment',
      });
      asset = await domain.editAsset(req(admin, asset.version), asset.id, {
        description: `${tag} updated technical description`,
        reason: 'Synthetic catalog correction',
      });
      assert.equal(
        (
          await call(
            reviewer,
            `/finance/assets/${asset.id}/review`,
            approval,
            record.financeVersion,
          )
        ).status,
        409,
      );
      record = await finance.submit(req(admin, asset.version), asset.id, {
        reason: 'Current catalog version resubmitted',
      });
      assert.equal(
        (
          await call(
            reviewer,
            `/finance/assets/${asset.id}/review`,
            approval,
            record.financeVersion,
          )
        ).status,
        201,
      );
      asset = await domain.asset(req(admin), asset.id);
    });
    it('forbids self-approval even with combined Admin and Finance roles', async () => {
      const record = await finance.submit(req(dual, asset.version), asset.id, {
        reason: 'Combined-role separation regression',
      });
      assert.equal(
        (await call(dual, `/finance/assets/${asset.id}/review`, approval, record.financeVersion))
          .status,
        403,
      );
    });
    it('serializes simultaneous Finance reviewers into one decision', async () => {
      const record = await finance.detail(req(reviewer), asset.id);
      const result = await Promise.all(
        [reviewer, second].map((u) =>
          call(u, `/finance/assets/${asset.id}/review`, approval, record.financeVersion),
        ),
      );
      assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
      const latest = await finance.detail(req(admin), asset.id);
      asset.version = latest.assetVersion;
      assert.equal(latest.history.filter((e: any) => e.action === 'APPROVED').length, 4);
    });
    it('pages deterministic queue, validates filters and exposes only summary fields to executives', async () => {
      const page = await call(admin, `/finance/queue?state=ALL&q=${tag}&limit=1`);
      assert.equal(page.status, 200);
      assert.equal(page.body.items.length, 1);
      assert.equal((await call(admin, '/finance/queue?state=INVENTED')).status, 422);
      assert.equal((await call(admin, '/finance/queue?limit=10000')).status, 422);
      const summary = await call(executive, '/finance/executive-summary');
      assert.equal(summary.status, 200);
      assert.equal(summary.body.currency, 'INR');
      assert.match(summary.body.definitions.approvedAcquisitionCost, /Not net book value/);
      assert.ok(!JSON.stringify(summary.body).includes(employee.email));
    });
    it('combines department and asset-type filters across stable queue pages', async () => {
      const [{ id: departmentId }] = await db.query(
        'INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id',
        [`queue-${randomUUID()}`],
      );
      const ids = await db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by)
        SELECT 'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',CASE WHEN i<=4 THEN 'Laptop' ELSE 'Mouse' END,'Synthetic filtered queue','Owned','In Store','Good','Low',$1,$2 FROM generate_series(1,6)i RETURNING id,asset_code`,
        [departmentId, admin.id],
      );
      const options = await call(reviewer, '/finance/filter-options');
      assert.equal(options.status, 200);
      assert.ok(options.body.values.some((v: any) => v.code === 'Mouse'));
      assert.ok(options.body.departments.some((d: any) => d.id === departmentId));
      for (const u of [employee, itAdmin, executive])
        assert.equal((await call(u, '/finance/filter-options')).status, 403);
      const prefix = `/finance/queue?state=UNSUBMITTED&departmentId=${departmentId}&assetType=Laptop&limit=2`;
      const first = await call(reviewer, prefix);
      assert.equal(first.status, 200);
      assert.equal(first.body.items.length, 2);
      assert.ok(first.body.nextCursor);
      const secondPage = await call(reviewer, prefix + '&after=' + first.body.nextCursor);
      assert.equal(secondPage.body.items.length, 2);
      assert.equal(secondPage.body.nextCursor, null);
      assert.deepEqual(
        [...first.body.items, ...secondPage.body.items].map((a: any) => a.id),
        ids.slice(0, 4).map((a) => a.id),
      );
      for (const a of first.body.items) {
        assert.equal(a.departmentId, departmentId);
        assert.equal(a.assetType, 'Laptop');
      }
      assert.equal((await call(reviewer, '/finance/queue?departmentId=bad')).status, 422);
      assert.equal(
        (await call(reviewer, '/finance/queue?assetType=' + encodeURIComponent('x'.repeat(101))))
          .status,
        422,
      );
      for (const u of [employee, itAdmin, executive])
        assert.equal((await call(u, prefix)).status, 403);
      await db.query('UPDATE departments SET active=false WHERE id=$1', [departmentId]);
      assert.equal((await call(admin, prefix)).body.items.length, 2);
    });
    it('handles concurrent role-isolated HTTP reads while Finance evidence remains unchanged', async () => {
      const before = await finance.detail(req(admin), asset.id);
      const requests = Array.from({ length: 40 }, (_, i) =>
        i % 4 === 0
          ? call(executive, '/finance/executive-summary')
          : i % 4 === 1
            ? call(reviewer, `/finance/assets/${asset.id}`)
            : i % 4 === 2
              ? call(employee, `/finance/assets/${asset.id}`)
              : call(itAdmin, '/finance/queue'),
      );
      const responses = await Promise.all(requests);
      for (const [i, r] of responses.entries()) assert.equal(r.status, i % 4 < 2 ? 200 : 403);
      const after = await finance.detail(req(admin), asset.id);
      assert.equal(after.financeVersion, before.financeVersion);
      assert.equal(after.assetVersion, before.assetVersion);
      assert.deepEqual(after.history, before.history);
    });
    it('executive warranty window explicitly uses the organization date', async () => {
      const original = db.query.bind(db);
      let predicate = '';
      db.query = async (sql: string, values: any[] = [], client?: any) => {
        if (sql.includes('AS warranty_expiring')) predicate = sql;
        return original(sql, values, client);
      };
      let report: any;
      try {
        report = await finance.executive(req(executive));
      } finally {
        db.query = original;
      }
      assert.match(
        predicate,
        /warranty_expiry BETWEEN \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/,
      );
      const [expected] = await db.query(
        `SELECT count(*)::int AS n FROM assets WHERE warranty_expiry BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date AND (now() AT TIME ZONE 'Asia/Kolkata')::date+30`,
      );
      assert.equal(report.warrantyExpiring, expected.n);
    });
    it('executive totals and department breakdown share one database snapshot during writes', async () => {
      const original = db.query.bind(db);
      let inserted = false;
      const departmentName = `snapshot-${randomUUID()}`;
      db.query = async (sql: string, values: any[] = [], client?: any) => {
        const rows = await original(sql, values, client);
        if (!inserted && sql.includes('AS total_assets')) {
          inserted = true;
          // A separate committed writer lands between the summary queries.
          const writer = await db.pool.connect();
          try {
            const [{ id }] = (
              await writer.query('INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id', [
                departmentName,
              ])
            ).rows;
            await writer.query(
              `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by)
              VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Synthetic snapshot race','Owned','In Store','Good','Low',$1,$2)`,
              [id, admin.id],
            );
          } finally {
            writer.release();
          }
        }
        return rows;
      };
      let snapshot: any;
      try {
        snapshot = await finance.executive(req(executive));
      } finally {
        db.query = original;
      }
      assert.equal(inserted, true);
      assert.equal(
        snapshot.departments.some((d: any) => d.department === departmentName),
        false,
      );
      const now = await finance.executive(req(executive));
      assert.equal(now.totalAssets, snapshot.totalAssets + 1);
    });
    it('detail state and review history remain coherent during a concurrent Finance decision', async () => {
      const a = await domain.createAsset(req(admin), {
        category: asset.category,
        assetType: asset.assetType,
        description: 'Synthetic detail snapshot race',
        ownershipType: asset.ownershipType,
        status: 'In Store',
        condition: asset.condition,
        riskLevel: asset.riskLevel,
        amcApplies: false,
      });
      const submitted = await finance.submit(req(admin, a.version), a.id, {
        reason: 'Synthetic concurrent detail test',
      });
      const original = db.query.bind(db);
      const writerDb = new Db();
      const writerFinance = new FinanceService(writerDb);
      let writer: Promise<unknown> | undefined;
      let started = false;
      db.query = async (sql: string, values: any[] = [], client?: any) => {
        const rows = await original(sql, values, client);
        if (!started && sql.includes('s.display_name AS submitted_by_name') && values[0] === a.id) {
          started = true;
          writer = writerFinance.review(req(reviewer, submitted.financeVersion), a.id, {
            decision: 'RETURN',
            reason: 'Synthetic parallel Finance decision',
          });
          // Give the independent writer time to commit if the detail reader has no lock/snapshot.
          await Promise.race([writer, new Promise((r) => setTimeout(r, 100))]);
        }
        return rows;
      };
      let detail: any;
      try {
        detail = await finance.detail(req(admin), a.id);
      } finally {
        db.query = original;
        await writer;
        await writerDb.onModuleDestroy();
      }
      assert.equal(started, true);
      assert.equal(detail.state, 'SUBMITTED');
      assert.equal(detail.history[0].action, 'SUBMITTED');
      assert.equal(detail.history[0].financeVersion, detail.financeVersion);
      assert.equal((await finance.detail(req(admin), a.id)).state, 'RETURNED');
    });
    it('pages full Finance evidence with tied microsecond timestamps and asset-scoped cursors', async () => {
      await db.query(
        `INSERT INTO asset_finance_events(asset_id,action,actor_id,reason,finance_version,occurred_at)
        SELECT $1,'SUBMITTED',$2,'Synthetic old history '||i,i,'2010-01-01 00:00:00.123456+00'::timestamptz
        FROM generate_series(1,57) i`,
        [asset.id, admin.id],
      );
      const expected = await db.query(
        'SELECT id FROM asset_finance_events WHERE asset_id=$1 ORDER BY occurred_at DESC,id DESC',
        [asset.id],
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = await call(
          reviewer,
          `/finance/assets/${asset.id}/history?limit=7${cursor ? '&before=' + cursor : ''}`,
        );
        assert.equal(r.status, 200);
        seen.push(...r.body.items.map((e: any) => e.id));
        cursor = r.body.nextCursor;
      } while (cursor);
      assert.deepEqual(
        seen,
        expected.map((e) => e.id),
      );
      assert.equal(new Set(seen).size, expected.length);
      for (const u of [employee, itAdmin, executive])
        assert.equal((await call(u, `/finance/assets/${asset.id}/history`)).status, 403);
      assert.equal(
        (await call(admin, `/finance/assets/${asset.id}/history?limit=101`)).status,
        422,
      );
      assert.equal(
        (await call(admin, `/finance/assets/${asset.id}/history?before=invalid`)).status,
        422,
      );
      assert.equal(
        (await call(admin, `/finance/assets/${asset.id}/history?before=${randomUUID()}`)).status,
        404,
      );
      assert.equal((await call(admin, `/finance/assets/${randomUUID()}/history`)).status, 404);
    });
    it('finance history is append-only at the database boundary', async () => {
      await assert.rejects(
        db.query(`UPDATE asset_finance_events SET reason='changed' WHERE asset_id=$1`, [asset.id]),
        /append only/,
      );
    });
  },
);
