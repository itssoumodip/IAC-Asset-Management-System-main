import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Excel from 'exceljs';
import { Db } from '../src/db';
import { InvoiceEvidenceService } from '../src/invoice-evidence';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Invoice tests require isolated _test DB');
process.env.DATABASE_URL = url;
const db = new Db(),
  service = new InvoiceEvidenceService(db);
after(() => db.onModuleDestroy());
const req = (id: string, roles: string[], version = 1) =>
  ({
    user: { id, roles },
    get: (name: string) => (name.toLowerCase() === 'if-match' ? `"${version}"` : undefined),
  }) as AuthRequest;
test('invoice evidence is private, immutable, duplicate-safe, versioned and never approves or changes asset fields', async () => {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,display_name)VALUES($1,$2,'Invoice owner')", [
    id,
    `invoice-${id}@example.org`,
  ]);
  const [asset] = await db.query(
    "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Invoice test','Owned','In Store','Good','Low',$1)RETURNING id",
    [id],
  );
  const wb = new Excel.Workbook(),
    ws = wb.addWorksheet('Invoice');
  ws.addRow(['Supplier', 'Example Systems']);
  ws.addRow(['Invoice Number', 'INV-1042']);
  ws.addRow(['Invoice Date', '2026-10-28']);
  ws.addRow(['Grand Total', 'INR 65000.00']);
  const body = {
    filename: 'Invoice.xlsx',
    data: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'),
  };
  for (const role of ['EMPLOYEE', 'IT_ADMIN', 'EXECUTIVE']) {
    await assert.rejects(() => service.upload(req(id, [role]), asset.id, body), /permission/);
    await assert.rejects(() => service.list(req(id, [role]), asset.id), /permission/);
  }
  const first = await service.upload(req(id, ['FINANCE']), asset.id, body);
  assert.equal(first.suggestions.purchaseCost?.value, '65000.00');
  assert.equal((await service.upload(req(id, ['ADMIN']), asset.id, body)).id, first.id);
  assert.equal((await service.list(req(id, ['FINANCE']), asset.id)).items.length, 1);
  const download: any = {
    headers: {} as Record<string, string>,
    body: undefined,
    setHeader(name: string, v: string) {
      this.headers[name] = v;
    },
    send(bytes: Buffer) {
      this.body = bytes;
    },
  };
  await service.download(req(id, ['FINANCE']), asset.id, first.id, download);
  assert.deepEqual(download.body, Buffer.from(body.data, 'base64'));
  assert.match(download.headers['Content-Disposition'], /^attachment;/);
  assert.equal(download.headers['Cache-Control'], 'private, no-store');
  await assert.rejects(
    () => service.download(req(id, ['EMPLOYEE']), asset.id, first.id, download),
    /permission/,
  );
  await assert.rejects(
    () => service.download(req(id, ['FINANCE']), randomUUID(), first.id, download),
    /not found/,
  );
  const [stored] = await db.query(
    'SELECT version,purchase_cost,finance_pending FROM assets WHERE id=$1',
    [asset.id],
  );
  assert.deepEqual(stored, { version: 1, purchase_cost: null, finance_pending: true });
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM asset_finance WHERE asset_id=$1', [asset.id]))[0]
      .n,
    0,
  );
  await assert.rejects(
    () =>
      db.query('UPDATE finance_invoice_evidence SET filename=$2 WHERE id=$1', [
        first.id,
        'bad.xlsx',
      ]),
    /append only/,
  );
  await assert.rejects(() => service.upload(req(id, ['FINANCE'], 99), asset.id, body), /changed/);
  await assert.rejects(() =>
    service.upload(req(id, ['FINANCE']), asset.id, { filename: 'evil.exe', data: body.data }),
  );
  await assert.rejects(
    () =>
      service.upload(req(id, ['FINANCE']), asset.id, {
        filename: 'bad.pdf',
        data: Buffer.from('not pdf').toString('base64'),
      }),
    /signature/,
  );
  await db.query(
    `INSERT INTO finance_invoice_evidence(asset_id,uploaded_by,filename,mime_type,content,sha256,extraction) SELECT $1,$2,'retained.pdf','application/pdf',convert_to('%PDF-'||n::text,'UTF8'),encode(sha256(convert_to('%PDF-'||n::text,'UTF8')),'hex'),'{}'::jsonb FROM generate_series(1,49)n`,
    [asset.id, id],
  );
  const other = new Excel.Workbook();
  other.addWorksheet('Invoice').addRow(['Invoice Number', 'LIMIT-2']);
  const excess = {
    filename: 'another.xlsx',
    data: Buffer.from(await other.xlsx.writeBuffer()).toString('base64'),
  };
  await assert.rejects(
    () => service.upload(req(id, ['FINANCE']), asset.id, excess),
    /50 invoice file limit/,
  );
  assert.equal((await service.upload(req(id, ['FINANCE']), asset.id, body)).id, first.id);
  await db.tx(async (c) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    await c.query(await readFile(resolve(__dirname, '../../../infra/runtime-grants.sql'), 'utf8'));
    await c.query('SET LOCAL ROLE iac_runtime');
    const duplicate = await service.upload(req(id, ['FINANCE']), asset.id, body);
    assert.equal(duplicate.id, first.id);
    await c.query('SAVEPOINT immutable');
    await assert.rejects(
      () => c.query('DELETE FROM finance_invoice_evidence WHERE id=$1', [first.id]),
      (e: any) => e.code === '42501',
    );
    await c.query('ROLLBACK TO SAVEPOINT immutable');
  });
});
