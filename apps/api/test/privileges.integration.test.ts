import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Db } from '../src/db';
import { FinanceService } from '../src/finance';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Privileges test requires isolated _test DB');
process.env.DATABASE_URL = url;
const db = new Db();
after(async () => db.onModuleDestroy());
test('runtime role can read application data but cannot erase inventory, mutate evidence or create schema objects', async () => {
  const grants = await readFile(resolve(__dirname, '../../../infra/runtime-grants.sql'), 'utf8');
  await db.tx(async (c) => {
    await c.query(grants);
    await c.query('SET LOCAL ROLE iac_runtime');
    await c.query('SELECT id FROM assets LIMIT 1');
    const code = `GRANT_TEST_${randomUUID()}`;
    await c.query(
      "INSERT INTO reference_values(kind,code,label) VALUES('CATEGORY',$1,'Runtime insert') ON CONFLICT(kind,code) DO UPDATE SET label=excluded.label",
      [code],
    );
    await c.query(
      "UPDATE reference_values SET label='Runtime update' WHERE kind='CATEGORY' AND code=$1",
      [code],
    );
    const [{ id: departmentId }] = (
      await c.query('INSERT INTO departments(code,name) VALUES($1,$2) RETURNING id', [
        code,
        `Runtime department ${code}`,
      ])
    ).rows;
    await c.query('UPDATE departments SET name=$2,version=version+1 WHERE id=$1', [
      departmentId,
      `Updated department ${code}`,
    ]);
    const [{ id: locationId }] = (
      await c.query("INSERT INTO locations(code,site) VALUES($1,'Runtime site') RETURNING id", [
        code,
      ])
    ).rows;
    await c.query("UPDATE locations SET room='Updated room',version=version+1 WHERE id=$1", [
      locationId,
    ]);
    const [{ id: photoUserId }] = (
      await c.query(
        "INSERT INTO users(email,display_name) VALUES($1,'Synthetic runtime photo test') RETURNING id",
        [`runtime-photo-${randomUUID()}@example.test`],
      )
    ).rows;
    const [{ id: photoAssetId }] = (
      await c.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)
         VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Synthetic runtime photo asset','Owned','In Store','Good','Low',$1) RETURNING id`,
        [photoUserId],
      )
    ).rows;
    await c.query(
      `INSERT INTO asset_photos(asset_id,content,sha256,updated_by)
       VALUES($1,decode('ffd8ff00','hex'),repeat('0',64),$2)`,
      [photoAssetId, photoUserId],
    );
    await c.query(
      "UPDATE asset_photos SET content=decode('ffd8ff01','hex'),sha256=repeat('1',64) WHERE asset_id=$1",
      [photoAssetId],
    );
    const [{ size: photoSize }] = (
      await c.query('SELECT octet_length(content) AS size FROM asset_photos WHERE asset_id=$1', [
        photoAssetId,
      ])
    ).rows;
    assert.equal(photoSize, 4);
    const [{ id: transferId }] = (
      await c.query(
        `INSERT INTO data_transfers(actor_id,module,source_filename,source_sha256,raw_rows,reason,preview)
         VALUES($1,'masters:departments','synthetic-runtime.csv',repeat('0',64),'[{"code":"SYNTHETIC"}]','Synthetic runtime permission check','{"valid":true}') RETURNING id`,
        [photoUserId],
      )
    ).rows;
    await c.query(
      `UPDATE data_transfers SET state='COMMITTED',committed_at=now(),receipt='{"rowCount":1}' WHERE id=$1`,
      [transferId],
    );
    const [{ state: transferState }] = (
      await c.query('SELECT state FROM data_transfers WHERE id=$1', [transferId])
    ).rows;
    assert.equal(transferState, 'COMMITTED');
    const [{ id: qrTicketId }] = (
      await c.query(
        `INSERT INTO tickets(reporter_id,subject,description,category,priority)
         VALUES($1,'Synthetic QR ticket','Synthetic runtime permission check','HARDWARE','LOW') RETURNING id`,
        [photoUserId],
      )
    ).rows;
    await c.query(
      `INSERT INTO ticket_photos(ticket_id,position,content,sha256,width,height,created_by)
       VALUES($1,1,decode('ffd8ff00','hex'),repeat('a',64),10,10,$2)`,
      [qrTicketId, photoUserId],
    );
    await c.query(
      "INSERT INTO asset_label_prints(asset_id,layout,printed_by) VALUES($1,'A4_24',$2)",
      [photoAssetId, photoUserId],
    );
    // Run the actual Finance service inside the restricted-role transaction.
    // Nested service transactions must keep this connection and its role.
    const [{ id: reviewerId }] = (
      await c.query(
        "INSERT INTO users(email,display_name) VALUES($1,'Synthetic independent reviewer') RETURNING id",
        [`runtime-finance-${randomUUID()}@example.test`],
      )
    ).rows;
    await c.query(
      "UPDATE users SET state='ACTIVE',email_verified_at=now() WHERE id=ANY($1::uuid[])",
      [[photoUserId, reviewerId]],
    );
    await c.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'ADMIN'),($2,'FINANCE')", [
      photoUserId,
      reviewerId,
    ]);
    const service = new FinanceService(db);
    const request = (id: string, roles: string[], version: number) =>
      ({
        user: { id, roles },
        get: (name: string) => (name.toLowerCase() === 'if-match' ? `"${version}"` : undefined),
      }) as AuthRequest;
    const submitted = await service.submit(request(photoUserId, ['ADMIN'], 1), photoAssetId, {
      reason: 'Synthetic runtime-role submission',
    });
    assert.equal(submitted.state, 'SUBMITTED');
    const approved = await service.review(
      request(reviewerId, ['FINANCE'], submitted.financeVersion),
      photoAssetId,
      {
        decision: 'APPROVE',
        reason: 'Synthetic independent invoice check',
        purchaseCost: '1500.00',
        purchaseDate: '2026-01-05',
        invoiceNumber: 'RUNTIME-SYNTHETIC-1',
        supplier: 'Synthetic Supplier',
      },
    );
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.approvedCost, '1500.00');
    assert.equal(approved.history.length, 2);
    const queued = (
      await c.query(
        `SELECT o.template,d.recipient FROM notification_outbox o JOIN email_deliveries d ON d.outbox_id=o.id WHERE o.event_key LIKE $1 ORDER BY o.template`,
        [`finance:${photoAssetId}:%`],
      )
    ).rows;
    assert.ok(
      queued.some(
        (r) => r.template === 'FINANCE_SUBMITTED' && r.recipient.startsWith('runtime-finance-'),
      ),
    );
    assert.ok(
      queued.some(
        (r) => r.template === 'FINANCE_APPROVED' && r.recipient.startsWith('runtime-photo-'),
      ),
    );

    const [{ count: evidenceCount }] = (
      await c.query(
        "SELECT count(*) FROM audit_events WHERE entity_id=$1 AND action IN ('FINANCE_SUBMITTED','FINANCE_APPROVED')",
        [photoAssetId],
      )
    ).rows;
    assert.equal(evidenceCount, '2');
    for (const sql of [
      'UPDATE asset_finance_events SET reason=reason WHERE false',
      'DELETE FROM asset_finance_events WHERE false',
      'DELETE FROM asset_finance WHERE false',
      'UPDATE ticket_photos SET position=1',
      'DELETE FROM ticket_photos',
      "UPDATE asset_label_prints SET layout='A4_14'",
      'DELETE FROM asset_label_prints',
      'DELETE FROM assets WHERE false',
      'DELETE FROM data_transfers WHERE false',
      'DELETE FROM asset_photos WHERE false',
      'DELETE FROM departments WHERE false',
      'DELETE FROM locations WHERE false',
      'DELETE FROM reference_values WHERE false',
      'UPDATE audit_events SET action=action WHERE false',
      'DELETE FROM ticket_updates WHERE false',
      'CREATE TABLE forbidden_test_table(id int)',
    ]) {
      await c.query('SAVEPOINT denied');
      await assert.rejects(c.query(sql), (e: any) => e.code === '42501');
      await c.query('ROLLBACK TO SAVEPOINT denied');
    }
  });
});
