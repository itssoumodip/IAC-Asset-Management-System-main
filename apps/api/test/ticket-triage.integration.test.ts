import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('Isolated test DB required');
process.env.DATABASE_URL = url;
const db = new Db(),
  service = new DomainService(db);
after(() => db.onModuleDestroy());
test('triage ownership combines category/search/paging and cannot expand employee scope', async () => {
  const users = [];
  for (const role of ['ADMIN', 'IT_ADMIN', 'EMPLOYEE', 'EMPLOYEE']) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Synthetic triage')", [
      id,
      `${id}@example.org`,
    ]);
    users.push({ id, roles: [role] });
  }
  const [admin, it, employee, other] = users,
    tag = `triage-${randomUUID()}`;
  const expected = [];
  for (let i = 0; i < 8; i++) {
    const [r] = await db.query(
      "INSERT INTO tickets(reporter_id,owner_id,subject,description,category,priority,created_at) VALUES($1,$2,$3,'Synthetic triage body','HARDWARE','HIGH','2010-01-01'::timestamptz+$4*interval '1 second') RETURNING id",
      [i === 7 ? other.id : employee.id, i < 3 ? null : i < 6 ? it.id : admin.id, tag, i],
    );
    if (i < 3) expected.unshift(r.id);
  }
  const req = (u: any) => ({ user: u }) as AuthRequest;
  const page = await service.tickets(req(it), {
    ownership: 'UNASSIGNED',
    q: tag,
    category: 'HARDWARE',
    priority: 'HIGH',
    limit: 2,
  });
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const next = await service.tickets(req(it), {
    ownership: 'UNASSIGNED',
    q: tag,
    category: 'HARDWARE',
    priority: 'HIGH',
    limit: 2,
    cursor: page.nextCursor,
  });
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(
    [...page.items, ...next.items].map((x: any) => x.id),
    expected,
  );
  assert.equal((await service.tickets(req(it), { ownership: 'MINE', q: tag })).items.length, 3);
  assert.equal((await service.tickets(req(admin), { ownership: 'MINE', q: tag })).items.length, 2);
  assert.equal((await service.tickets(req(employee), { q: tag })).items.length, 7);
  await assert.rejects(
    service.tickets(req(employee), { ownership: 'UNASSIGNED', q: tag }),
    /support access/,
  );
  await assert.rejects(
    service.tickets(req(it), { ownership: 'MINE', ownerId: admin.id }),
    /not both/,
  );
  await assert.rejects(service.tickets(req(it), { ownership: 'INVALID' }));
});

test('ticket, ascending discussion and audit cursors preserve sub-millisecond order', async () => {
  const user = randomUUID(),
    tag = `precision-${randomUUID()}`;
  await db.query("INSERT INTO users(id,email,display_name)VALUES($1,$2,'Precision fixture')", [
    user,
    `${user}@example.org`,
  ]);
  const req = { user: { id: user, roles: ['ADMIN'] } } as AuthRequest;
  const tickets: string[] = [],
    updates: string[] = [],
    audits: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const [t] = await db.query(
      "INSERT INTO tickets(reporter_id,subject,description,category,priority,created_at)VALUES($1,$2,'Synthetic','HARDWARE','LOW','2031-01-01 00:00:00.123000+00'::timestamptz+$3*interval '1 microsecond')RETURNING id",
      [user, tag, i],
    );
    tickets.unshift(t.id);
  }
  const ticket = tickets[0];
  for (let i = 1; i <= 5; i++) {
    const [u] = await db.query(
      "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility,body,created_at)VALUES($1,$2,'COMMENT','PUBLIC','Synthetic','2031-01-01 00:00:00.123000+00'::timestamptz+$3*interval '1 microsecond')RETURNING id",
      [ticket, user, i],
    );
    updates.push(u.id);
    const [a] = await db.query(
      "INSERT INTO audit_events(actor_id,actor_kind,entity_type,entity_id,action,request_id,occurred_at)VALUES($1,'USER','PRECISION',$2,'SYNTHETIC',$3,'2031-01-01 00:00:00.123000+00'::timestamptz+$4*interval '1 microsecond')RETURNING id",
      [user, ticket, randomUUID(), i],
    );
    audits.unshift(a.id);
  }
  async function collect(load: (cursor?: string) => Promise<any>) {
    let cursor: string | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await load(cursor);
      ids.push(...p.items.map((x: any) => x.id));
      cursor = p.nextCursor ?? undefined;
      if (!cursor) return ids;
    }
    throw Error('Cursor failed to advance');
  }
  assert.deepEqual(
    await collect((cursor) =>
      service.tickets(req, { q: tag, limit: 2, ...(cursor ? { cursor } : {}) }),
    ),
    tickets,
  );
  assert.deepEqual(
    await collect((cursor) =>
      service.updates(req, ticket, { limit: 2, ...(cursor ? { cursor } : {}) }),
    ),
    updates,
  );
  assert.deepEqual(
    await collect((cursor) =>
      service.auditEvents(req, {
        entityType: 'PRECISION',
        entityId: ticket,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      }),
    ),
    audits,
  );
});

test('staff directory cursor preserves original microsecond timestamps', async () => {
  const { AuthService } = await import('../src/auth');
  const auth = new AuthService(db),
    tag = `users-precision-${randomUUID()}`,
    expected: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const [u] = await db.query(
      "INSERT INTO users(email,display_name,created_at)VALUES($1,$2,'2031-01-01 00:00:00.123000+00'::timestamptz+$3*interval '1 microsecond')RETURNING id",
      [`${tag}-${i}@example.org`, tag, i],
    );
    expected.unshift(u.id);
  }
  const req = { user: { roles: ['ADMIN'] } } as AuthRequest;
  let cursor: string | undefined;
  const seen: string[] = [];
  do {
    const p = await auth.users(req, { q: tag, limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...p.items.map((x) => x.id));
    assert(p.items.every((x) => !('cursor_time' in x)));
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, expected);
});
