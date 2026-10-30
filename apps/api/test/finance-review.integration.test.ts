import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { configuration, hash, signedCsrf, token } from '../src/config';
import { processPendingInvoices, localTextExtractor, SCANNED_PDF_MESSAGE } from '../src/invoice-ocr';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Finance integration requires a database name ending _test');
const tag = `fin-${randomUUID()}`;

const INVOICE_TEXT = `Shree Technologies Pvt Ltd
GSTIN: 19AABCS1234F1Z5
Invoice No: ST/0457
Invoice Date: 14/08/2025
Grand Total: Rs. 64,310.00`;

describe('finance review and invoices', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, finance: any, owner: any, stranger: any, asset: any, png: string;
  let invoiceId = '';
  const req = (user: any) =>
    ({
      user,
      get: (n: string) => (n.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
    }) as AuthRequest;
  const call = async (user: any, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
        'X-CSRF-Token': user.csrf,
        ...extra,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes('json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer()),
    };
  };
  const state = async () => (await db.query('SELECT * FROM assets WHERE id=$1', [asset.id]))[0];

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[]) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Synthetic finance test',
        roles,
        csrf: signedCsrf(),
        session: token(),
      } as any;
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
    admin = await user(['SUPER_ADMIN']);
    finance = await user(['FINANCE']);
    owner = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', ADM_TEAM_ID);
    stranger = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    const refs = {
      CATEGORY: `${tag} category`,
      ASSET_TYPE: `${tag} type`,
      OWNERSHIP: `${tag} ownership`,
      CONDITION: `${tag} condition`,
      RISK: `${tag} risk`,
    };
    for (const [kind, code] of Object.entries(refs))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
    asset = await domain.createAsset(req(admin), {
      category: refs.CATEGORY,
      assetType: refs.ASSET_TYPE,
      description: `${tag} synthetic printer`,
      ownershipType: refs.OWNERSHIP,
      owningTeamId: ADM_TEAM_ID,
      status: 'In Store',
      condition: refs.CONDITION,
      riskLevel: refs.RISK,
      amcApplies: false,
    });
    const bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) } },
    })
      .png()
      .toBuffer();
    png = `data:image/png;base64,${bytes.toString('base64')}`;
  });
  after(async () => {
    if (app) await app.close();
  });

  it('starts new assets PENDING with finance_pending in sync', async () => {
    const row = await state();
    assert.equal(row.finance_status, 'PENDING');
    assert.equal(row.finance_pending, true);
    assert.equal((await call(owner, 'GET', `/assets/${asset.id}`)).body.financeStatus, 'PENDING');
  });

  it('lets the owning team upload an invoice but not another team', async () => {
    const denied = await call(stranger, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: png,
      fileName: 'inv.png',
    });
    assert.equal(denied.status, 403);
    const ok = await call(owner, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: png,
      fileName: 'inv.png',
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.extractionState, 'PENDING');
    invoiceId = ok.body.id;
    const again = await call(owner, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: png,
      fileName: 'again.png',
    });
    assert.equal(again.body.id, invoiceId); // same content is stored once
    const bad = await call(owner, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: 'data:text/plain;base64,aGVsbG8=',
      fileName: 'x.txt',
    });
    assert.equal(bad.status, 422);
  });

  it('extracts fields in the worker (stub extractor) and serves metadata and file', async () => {
    assert.ok((await processPendingInvoices(db, async () => INVOICE_TEXT)) >= 1);
    const meta = await call(finance, 'GET', `/invoices/${invoiceId}`);
    assert.equal(meta.status, 200);
    assert.equal(meta.body.extractionState, 'DONE');
    assert.equal(meta.body.fields.invoiceNumber.value, 'ST/0457');
    assert.equal(meta.body.fields.totalAmount.value, '64310.00');
    assert.equal(meta.body.fields.invoiceDate.value, '2025-08-14');
    const file = await call(owner, 'GET', `/invoices/${invoiceId}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal((file.body as Buffer).subarray(1, 4).toString(), 'PNG');
  });

  it('shows the asset in the finance queue only to Finance', async () => {
    assert.equal((await call(owner, 'GET', '/finance/queue')).status, 403);
    const queue = await call(finance, 'GET', `/finance/queue?teamId=${ADM_TEAM_ID}&status=PENDING&q=${tag}`);
    assert.equal(queue.status, 200);
    assert.ok(queue.body.items.some((i: any) => i.id === asset.id));
  });

  it('refuses team members approving, and lets Finance approve with fields', async () => {
    const fields = {
      supplier: 'Shree Technologies',
      purchaseCost: '64310.00',
      invoiceNumber: 'ST/0457',
      purchaseDate: '2025-08-14',
    };
    assert.equal(
      (await call(owner, 'POST', `/finance/assets/${asset.id}/approve`, { reason: 'x', fields }))
        .status,
      403,
    );
    const noMatch = await call(finance, 'POST', `/finance/assets/${asset.id}/approve`, {
      reason: 'Checked invoice',
      fields,
    });
    assert.equal(noMatch.status, 428);
    const patchApprove = await call(
      finance,
      'PATCH',
      `/assets/${asset.id}`,
      { financePending: false, reason: 'sneaky' },
      { 'If-Match': `"${(await state()).version}"` },
    );
    assert.ok([409, 422].includes(patchApprove.status), JSON.stringify(patchApprove.body));
    assert.equal((await state()).finance_status, 'PENDING');
    const ok = await call(
      finance,
      'POST',
      `/finance/assets/${asset.id}/approve`,
      { reason: 'Checked invoice', fields },
      { 'If-Match': `"${(await state()).version}"` },
    );
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.financeStatus, 'APPROVED');
    const row = await state();
    assert.equal(row.finance_status, 'APPROVED');
    assert.equal(row.finance_pending, false);
    assert.equal(row.supplier, 'Shree Technologies');
    assert.equal(row.purchase_cost, '64310.00');
    assert.equal(row.finance_reviewed_by, finance.id);
    const audit = await db.query(
      "SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='FINANCE_APPROVED'",
      [asset.id],
    );
    assert.equal(audit.length, 1);
  });

  it('rejects with an emailed reason and returns to PENDING on resubmit', async () => {
    assert.equal(
      (await call(finance, 'POST', `/finance/assets/${asset.id}/reject`, {})).status,
      422,
    );
    assert.equal(
      (await call(owner, 'POST', `/finance/assets/${asset.id}/reject`, { reason: 'x' })).status,
      403,
    );
    const rejected = await call(finance, 'POST', `/finance/assets/${asset.id}/reject`, {
      reason: 'Invoice number does not match',
    });
    assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
    assert.equal(rejected.body.financeStatus, 'REJECTED');
    assert.equal(rejected.body.financeRejectionReason, 'Invoice number does not match');
    const mail = await db.query(
      `SELECT d.recipient FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id
       WHERE o.template='finance_rejected' AND o.event_key LIKE $1`,
      [`finance-rejected:${asset.id}:%`],
    );
    assert.ok(mail.some((m) => m.recipient === owner.email.toLowerCase()));
    assert.ok(!mail.some((m) => m.recipient === stranger.email.toLowerCase()));
    assert.equal(
      (await call(stranger, 'POST', `/finance/assets/${asset.id}/resubmit`)).status,
      403,
    );
    const resubmit = await call(owner, 'POST', `/finance/assets/${asset.id}/resubmit`);
    assert.equal(resubmit.status, 201, JSON.stringify(resubmit.body));
    assert.equal(resubmit.body.financeStatus, 'PENDING');
    const row = await state();
    assert.equal(row.finance_pending, true);
    assert.equal(row.finance_rejection_reason, null);
  });

  it('records PDFs without a text layer as FAILED with guidance', async () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n% ' + tag,
    );
    const up = await call(finance, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`,
      fileName: 'scan.pdf',
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await processPendingInvoices(db, localTextExtractor);
    const meta = await call(finance, 'GET', `/invoices/${up.body.id}`);
    assert.equal(meta.body.extractionState, 'FAILED');
    assert.equal(meta.body.extractionError, SCANNED_PDF_MESSAGE);
  });

  it('really OCRs a rendered invoice image locally', { timeout: 60_000 }, async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400"><rect width="100%" height="100%" fill="white"/>
      <text x="30" y="70" font-size="40" font-family="Arial, sans-serif">ACME TRADERS PVT LTD</text>
      <text x="30" y="140" font-size="36" font-family="Arial, sans-serif">GSTIN: 19AABCA1234F1Z5</text>
      <text x="30" y="210" font-size="36" font-family="Arial, sans-serif">Invoice No: AT/0042</text>
      <text x="30" y="280" font-size="36" font-family="Arial, sans-serif">Invoice Date: 14/08/2025</text>
      <text x="30" y="350" font-size="36" font-family="Arial, sans-serif">Grand Total: Rs. 64,310.00</text></svg>`;
    const image = await sharp(Buffer.from(svg)).png({ compressionLevel: 1 }).withMetadata({ exif: { IFD0: { ImageDescription: tag } } }).toBuffer();
    const up = await call(finance, 'POST', `/assets/${asset.id}/invoices`, {
      dataUrl: `data:image/png;base64,${image.toString('base64')}`,
      fileName: 'ocr.png',
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    await processPendingInvoices(db);
    const meta = await call(finance, 'GET', `/invoices/${up.body.id}`);
    assert.equal(meta.body.extractionState, 'DONE', JSON.stringify(meta.body));
    assert.equal(meta.body.fields.gstin.value, '19AABCA1234F1Z5');
    assert.equal(meta.body.fields.totalAmount.value, '64310.00');
    assert.equal(meta.body.fields.invoiceNumber.value, 'AT/0042');
  });

  describe('extraction robustness', () => {
    const upload = async (label: string) => {
      const bytes = await sharp({
        create: { width: 20, height: 20, channels: 3, background: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) } },
      })
        .png()
        .withMetadata({ exif: { IFD0: { ImageDescription: `${tag}-${label}-${randomUUID()}` } } })
        .toBuffer();
      const up = await call(finance, 'POST', `/assets/${asset.id}/invoices`, {
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        fileName: `${label}.png`,
      });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      return up.body.id as string;
    };
    const row = async (invoice: string) =>
      (await db.query('SELECT * FROM invoices WHERE id=$1', [invoice]))[0];
    // Park every other pending invoice so the loop touches just ours.
    const only = async (invoice: string) => {
      await db.query(
        "UPDATE invoices SET extraction_state='DONE' WHERE extraction_state IN ('PENDING','PROCESSING') AND id<>$1",
        [invoice],
      );
    };

    it('fails an invoice whose extractor keeps throwing after 3 attempts and continues', async () => {
      const bad = await upload('throws');
      await only(bad);
      let calls = 0;
      const boom = async () => {
        calls++;
        throw new Error('boom');
      };
      await processPendingInvoices(db, boom, 1);
      let r = await row(bad);
      assert.equal(r.extraction_state, 'PENDING');
      assert.equal(r.attempts, 1);
      await processPendingInvoices(db, boom, 1);
      await processPendingInvoices(db, boom, 1);
      r = await row(bad);
      assert.equal(r.extraction_state, 'FAILED');
      assert.equal(r.attempts, 3);
      assert.match(r.extraction_error, /could not be read/i);
      assert.equal(await processPendingInvoices(db, boom, 1), 0);
      assert.equal(calls, 3);
      const good = await upload('good');
      await only(good);
      assert.equal(await processPendingInvoices(db, async () => INVOICE_TEXT, 1), 1);
      assert.equal((await row(good)).extraction_state, 'DONE');
    });

    it('marks a hanging extractor attempt failed after the timeout', async () => {
      const slow = await upload('hangs');
      await only(slow);
      const hang = () => new Promise<string>(() => {});
      const started = Date.now();
      await processPendingInvoices(db, hang, 1, 200);
      assert.ok(Date.now() - started < 5000);
      const r = await row(slow);
      assert.equal(r.extraction_state, 'PENDING');
      assert.equal(r.attempts, 1);
      assert.match(r.extraction_error, /too long/i);
    });

    it('retries a stale PROCESSING invoice and fails it once attempts are exhausted', async () => {
      const stuck = await upload('stuck');
      await only(stuck);
      await db.query(
        "UPDATE invoices SET extraction_state='PROCESSING',attempts=1,processing_started_at=now()-interval '11 minutes' WHERE id=$1",
        [stuck],
      );
      assert.equal(await processPendingInvoices(db, async () => INVOICE_TEXT, 1), 1);
      const r = await row(stuck);
      assert.equal(r.extraction_state, 'DONE');
      assert.equal(r.attempts, 2);
      const dead = await upload('dead');
      await only(dead);
      await db.query(
        "UPDATE invoices SET extraction_state='PROCESSING',attempts=3,processing_started_at=now()-interval '11 minutes' WHERE id=$1",
        [dead],
      );
      await processPendingInvoices(db, async () => INVOICE_TEXT, 1);
      assert.equal((await row(dead)).extraction_state, 'FAILED');
      const fresh = await upload('fresh');
      await only(fresh);
      await db.query(
        "UPDATE invoices SET extraction_state='PROCESSING',attempts=1,processing_started_at=now() WHERE id=$1",
        [fresh],
      );
      assert.equal(await processPendingInvoices(db, async () => INVOICE_TEXT, 1), 0);
    });

    it('serves the invoice file frameable by the same origin only', async () => {
      const file = await call(owner, 'GET', `/invoices/${invoiceId}/file`);
      assert.match(file.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
      assert.equal(file.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
  });
});
