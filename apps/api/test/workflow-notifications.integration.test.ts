import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { NotificationsService } from '../src/notifications';
import { configuration } from '../src/config';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Workflow tests require _test DB');
process.env.DATABASE_URL = url;
const db = new Db(),
  service = new NotificationsService(db);
after(() => db.onModuleDestroy());
test('workflow inbox is persistent, scoped, idempotent, paginated and independent of SMTP', async () => {
  const make = async (role: string) => {
    const id = randomUUID(),
      email = `workflow-${id}@example.org`;
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version)VALUES($1,$2,'Workflow recipient','ACTIVE',now(),now(),$3)",
      [id, email, configuration().noticeVersion],
    );
    await db.query('INSERT INTO user_roles(user_id,role_code)VALUES($1,$2)', [id, role]);
    return { id, email, roles: [role] };
  };
  const finance = await make('FINANCE'),
    other = await make('FINANCE'),
    employee = await make('EMPLOYEE'),
    admin = await make('ADMIN');
  const req = (u: any) => ({ user: u }) as AuthRequest;
  const [asset] = await db.query(
    "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Workflow evidence','Owned','In Store','Good','Low',$1)RETURNING id",
    [admin.id],
  );
  const entity = asset.id,
    key = randomUUID();
  await db.tx(async (c) => {
    await db.workflowNotify(
      c,
      key,
      'FINANCE_REVIEW',
      entity,
      [finance.email],
      'Finance review requested',
      'Review independently',
    );
    await db.workflowNotify(
      c,
      key,
      'FINANCE_REVIEW',
      entity,
      [finance.email],
      'Finance review requested',
      'Review independently',
    );
  });
  const first = await service.workflow(req(finance));
  assert.equal(first.total, 1);
  assert.equal(first.unreadCount, 1);
  assert.equal(first.items[0].path, `/finance/${entity}`);
  assert.equal((await service.workflow(req(other))).total, 0);
  assert.equal((await service.workflow(req(employee))).total, 0);
  assert.equal((await service.workflow(req(admin))).total, 0);
  await assert.rejects(() => service.workflowRead(req(other), first.items[0].id), /not found/);
  await service.workflowRead(req(finance), first.items[0].id);
  await service.workflowRead(req(finance), first.items[0].id);
  assert.equal((await service.workflow(req(finance), { filter: 'UNREAD' })).total, 1);
  assert.equal((await service.workflow(req(finance), { filter: 'UNREAD' })).items.length, 0);
  await db.query('DELETE FROM user_roles WHERE user_id=$1', [finance.id]);
  assert.equal((await service.workflow(req(finance))).total, 0);
  await assert.rejects(() => service.workflowRead(req(finance), first.items[0].id), /not found/);
  await db.query("INSERT INTO user_roles(user_id,role_code)VALUES($1,'FINANCE')", [finance.id]);
  await assert.rejects(
    () =>
      db.tx(async (c) => {
        await db.workflowNotify(
          c,
          randomUUID(),
          'FINANCE_REVIEW',
          entity,
          [other.email],
          'Rolled back',
          'Not committed',
        );
        throw Error('rollback');
      }),
    /rollback/,
  );
  assert.equal((await service.workflow(req(other))).total, 0);
  await db.tx(async (c) => {
    for (let i = 0; i < 5; i++)
      await db.workflowNotify(
        c,
        randomUUID(),
        'FINANCE_REVIEW',
        entity,
        [finance.email],
        `Review ${i}`,
        'Pending',
      );
  });
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await service.workflow(req(finance), { limit: 2, ...(cursor ? { cursor } : {}) });
    for (const n of page.items) {
      assert(!seen.has(n.id));
      seen.add(n.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 6);
  await service.workflowRead(req(finance));
  assert.equal((await service.workflow(req(finance))).unreadCount, 0);
  const [assignment] = await db.query(
    'INSERT INTO assignments(asset_id,user_id,assigned_by)VALUES($1,$2,$3)RETURNING id',
    [entity, employee.id, admin.id],
  );
  await db.tx((c) =>
    db.workflowNotify(
      c,
      randomUUID(),
      'ASSIGNMENT',
      assignment.id,
      [employee.email],
      'Equipment assigned',
      'Review equipment',
    ),
  );
  assert.equal((await service.workflow(req(employee))).items[0].path, '/equipment/mine');
  await db.query('UPDATE assignments SET ended_at=now() WHERE id=$1', [assignment.id]);
  assert.equal((await service.workflow(req(employee))).total, 1);
  const support = await make('IT_ADMIN');
  const [ticket] = await db.query(
    "INSERT INTO tickets(reporter_id,subject,description,category,priority)VALUES($1,'Workflow support','Private issue','HARDWARE','MEDIUM')RETURNING id",
    [employee.id],
  );
  await db.tx((c) =>
    db.workflowNotify(
      c,
      randomUUID(),
      'TICKET',
      ticket.id,
      [support.email, employee.email],
      'Support update',
      'Open the ticket',
    ),
  );
  assert(
    (await service.workflow(req(support))).items.some((n) => n.path === `/tickets/${ticket.id}`),
  );
  assert(
    (await service.workflow(req(employee))).items.some((n) => n.path === `/tickets/${ticket.id}`),
  );
  await db.query('DELETE FROM user_roles WHERE user_id=$1', [support.id]);
  assert.equal((await service.workflow(req(support))).total, 0);
  await db.tx((c) =>
    db.notify(
      c,
      randomUUID(),
      'FINANCE_SUBMITTED',
      [other.email],
      { subject: 'Synthetic finance message', text: 'No SMTP send required' },
      {
        kind: 'FINANCE_REVIEW',
        entityId: entity,
        title: 'Pending email independently visible',
        message: 'Review',
      },
    ),
  );
  assert.equal((await service.workflow(req(other))).unreadCount, 1);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE d.recipient=$1 AND d.state='PENDING'",
        [other.email],
      )
    )[0].n,
    1,
  );
  const [ownNotice] = await db.query(
    'SELECT id FROM workflow_notifications WHERE user_id=$1 LIMIT 1',
    [employee.id],
  );
  await assert.rejects(
    () =>
      db.query('INSERT INTO workflow_notification_reads(notification_id,user_id)VALUES($1,$2)', [
        ownNotice.id,
        other.id,
      ]),
    (e: any) => e.code === '23503',
  );
  await db.query(
    "UPDATE users SET state='INVITED',email_verified_at=NULL,portal_accepted_at=NULL WHERE id=$1",
    [employee.id],
  );
  await db.tx((c) =>
    db.workflowNotify(
      c,
      randomUUID(),
      'ASSIGNMENT',
      assignment.id,
      [employee.email],
      'Imported custody pending',
      'Review after activation',
    ),
  );
  assert.equal((await service.workflow(req(employee))).total, 0);
  await db.query(
    "UPDATE users SET state='ACTIVE',email_verified_at=now(),portal_accepted_at=now() WHERE id=$1",
    [employee.id],
  );
  assert(
    (await service.workflow(req(employee))).items.some(
      (n) => n.title === 'Imported custody pending',
    ),
  );
  await db.tx(async (c) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    await c.query(await readFile(resolve(__dirname, '../../../infra/runtime-grants.sql'), 'utf8'));
    await c.query('SET LOCAL ROLE iac_runtime');
    await db.workflowNotify(
      c,
      randomUUID(),
      'FINANCE_REVIEW',
      entity,
      [finance.email],
      'Runtime notification',
      'Least privilege',
    );
    await service.workflowRead(req(finance));
    await c.query('SAVEPOINT immutability');
    await assert.rejects(
      () => c.query('DELETE FROM workflow_notifications WHERE user_id=$1', [finance.id]),
      (e: any) => e.code === '42501',
    );
    await c.query('ROLLBACK TO SAVEPOINT immutability');
  });
  await db.query("UPDATE users SET state='DISABLED' WHERE id=$1", [finance.id]);
  assert.equal((await service.workflow(req(finance))).total, 0);
});
