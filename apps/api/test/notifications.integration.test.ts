import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { NotificationsService } from '../src/notifications';
import { configuration } from '../src/config';
import type { AuthRequest } from '../src/security';
const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Notifications tests require isolated _test database');
describe(
  'notification history and unread pagination',
  { skip: !connection, concurrency: false },
  () => {
    let app: INestApplication,
      db: Db,
      service: NotificationsService,
      user: any,
      other: any,
      admin: any,
      department: string;
    const tag = `notice-${randomUUID()}`,
      created: string[] = [];
    const req = (u: any) => ({ user: u }) as AuthRequest;
    before(async () => {
      process.env.DATABASE_URL = connection;
      app = await createApp();
      db = app.get(Db);
      service = app.get(NotificationsService);
      const [d] = await db.query('INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id', [
        tag,
      ]);
      department = d.id;
      const make = async (roles: string[], dept?: string) => {
        const u = { id: randomUUID(), roles };
        await db.query(
          `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,department_id) VALUES($1,$2,'Synthetic notification user','ACTIVE',now(),now(),$3,$4)`,
          [u.id, `${tag}-${u.id}@example.org`, configuration().noticeVersion, dept ?? null],
        );
        for (const r of roles)
          await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, r]);
        return u;
      };
      user = await make(['EMPLOYEE'], department);
      other = await make(['EMPLOYEE']);
      admin = await make(['ADMIN']);
      for (let n = 0; n < 125; n++) {
        const [row] = await db.query(
          `INSERT INTO in_app_announcements(title,message,path,audience,department_id,created_at) VALUES($1,$2,'/notifications','DEPARTMENT',$3,'2020-01-01'::timestamptz+($4*interval '1 minute')) RETURNING id`,
          [`${tag}-${n}`, 'Synthetic notice', department, n],
        );
        created.push(row.id);
      }
      // Oldest 5 are unread, beyond the old newest-100 cutoff.
      await db.query(
        'INSERT INTO in_app_announcement_reads(announcement_id,user_id) SELECT unnest($1::uuid[]),$2',
        [created.slice(5), user.id],
      );
    });
    after(async () => {
      if (db) {
        await db.query('DELETE FROM in_app_announcements WHERE title LIKE $1', [`${tag}%`]);
      }
      await app?.close();
    });
    it('server unread filter reaches old unread notices beyond the first 100 newest records', async () => {
      const result = await service.inbox(req(user), { filter: 'UNREAD', limit: 100 });
      const own = result.items.filter((i: any) => i.title.startsWith(tag));
      assert.equal(own.length, 5);
      assert.deepEqual(new Set(own.map((i: any) => i.id)), new Set(created.slice(0, 5)));
      assert.ok(result.total >= 125);
      assert.ok(result.unreadCount >= 5);
    });
    it('pages tied chronological IDs with no duplicates or omissions and preserves counts', async () => {
      let cursor: string | null = null;
      const ids: string[] = [];
      let total: number | undefined;
      do {
        const p = await service.inbox(req(user), { limit: 17, ...(cursor ? { cursor } : {}) });
        if (total === undefined) total = p.total;
        assert.equal(p.total, total);
        ids.push(...p.items.filter((i: any) => i.title.startsWith(tag)).map((i: any) => i.id));
        cursor = p.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 125);
      assert.equal(new Set(ids).size, 125);
      assert.deepEqual(ids, created.slice().reverse());
    });
    it('keeps department history and attachment endpoints private', async () => {
      const p = await service.inbox(req(other), { limit: 100 });
      assert.ok(!p.items.some((i: any) => i.title.startsWith(tag)));
      await assert.rejects(service.markRead(req(other), created[0]), /not found/);
      await assert.rejects(service.attachment(req(other), created[0]), /not found/);
      const [notice] = await db.query(
        `INSERT INTO in_app_announcements(title,message,path,audience) VALUES($1,'Admin only','/notifications','ADMIN') RETURNING id`,
        [`${tag}-admin`],
      );
      assert.ok(
        !(await service.inbox(req(user), { limit: 100 })).items.some(
          (i: any) => i.id === notice.id,
        ),
      );
      assert.ok(
        (await service.inbox(req(admin), { limit: 100 })).items.some(
          (i: any) => i.id === notice.id,
        ),
      );
    });
    it('announcement cursors retain PostgreSQL microseconds within one millisecond', async () => {
      const expected: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const [row] = await db.query(
          "INSERT INTO in_app_announcements(title,message,path,audience,department_id,created_at)VALUES($1,'Precision check','/notifications','DEPARTMENT',$2,'2030-01-01 00:00:00.123000+00'::timestamptz+$3*interval '1 microsecond')RETURNING id",
          [`${tag}-precision-${i}`, department, i],
        );
        expected.unshift(row.id);
      }
      let cursor: string | undefined;
      const seen: string[] = [];
      do {
        const page = await service.inbox(req(user), { limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.filter((x: any) => expected.includes(x.id)).map((x: any) => x.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen, expected);
    });
    it('validates cursors/limits and supports idempotent read/read-all', async () => {
      await assert.rejects(service.inbox(req(user), { cursor: 'garbage' }));
      await assert.rejects(service.inbox(req(user), { limit: 101 }));
      await service.markRead(req(user), created[0]);
      await service.markRead(req(user), created[0]);
      assert.equal(
        (
          await db.query(
            'SELECT * FROM in_app_announcement_reads WHERE announcement_id=$1 AND user_id=$2',
            [created[0], user.id],
          )
        ).length,
        1,
      );
      await service.markAllRead(req(user));
      assert.equal((await service.inbox(req(user), { filter: 'UNREAD' })).items.length, 0);
      assert.equal((await service.unreadCount(req(user))).unreadCount, 0);
    });
  },
);
