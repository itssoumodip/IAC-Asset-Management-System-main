import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { EquipmentService } from '../src/equipment';
import { configuration } from '../src/config';
import type { AuthRequest } from '../src/security';
const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Isolated _test DB required');
describe(
  'one person multiple equipment role views',
  { skip: !connection, concurrency: false },
  () => {
    let app: INestApplication,
      db: Db,
      domain: DomainService,
      equipment: EquipmentService,
      admin: any,
      employee: any,
      other: any,
      finance: any,
      executive: any,
      itAdmin: any;
    const assets: any[] = [],
      tag = `equipment-${randomUUID()}`;
    const req = (user: any, version?: number) =>
      ({
        user,
        get: (n: string) =>
          n.toLowerCase() === 'if-match' && version !== undefined
            ? `"${version}"`
            : n.toLowerCase() === 'idempotency-key'
              ? randomUUID()
              : undefined,
      }) as AuthRequest;
    before(async () => {
      process.env.DATABASE_URL = connection;
      app = await createApp();
      db = app.get(Db);
      domain = app.get(DomainService);
      equipment = app.get(EquipmentService);
      const make = async (roles: string[]) => {
        const u = { id: randomUUID(), roles };
        await db.query(
          `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),$4)`,
          [u.id, `${tag}-${u.id}@example.org`, `${tag} ${roles[0]}`, configuration().noticeVersion],
        );
        for (const r of roles)
          await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, r]);
        return u;
      };
      admin = await make(['ADMIN']);
      employee = await make(['EMPLOYEE']);
      other = await make(['EMPLOYEE']);
      finance = await make(['FINANCE']);
      executive = await make(['EXECUTIVE']);
      itAdmin = await make(['IT_ADMIN']);
      for (const [i, type] of ['Laptop', 'Mouse', 'Keyboard'].entries()) {
        const [a] = await db.query(
          `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by,purchase_cost) VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',$1,$2,'Owned','In Store','Good','Low',$3,1000) RETURNING *`,
          [type, `${tag} item ${i}`, admin.id],
        );
        assets.push(a);
        await domain.assign(req(admin, a.version), a.id, {
          userId: employee.id,
          note: 'Synthetic equipment set',
        });
      }
    });
    after(async () => {
      await app?.close();
    });
    it('Admin sees one person with three distinct assets and full current equipment counts', async () => {
      const list = await equipment.people(req(admin), { q: tag });
      const p = list.items.find((u: any) => u.id === employee.id);
      assert.equal(p.equipmentCount, 3);
      assert.equal(p.pendingAcknowledgements, 3);
      const record = await equipment.person(req(admin), employee.id, {});
      assert.equal(record.items.length, 3);
      assert.equal(record.summary.total, 3);
      assert.equal(new Set(record.items.map((a: any) => a.id)).size, 3);
      assert.deepEqual(record.items.map((a: any) => a.assetType).sort(), [
        'Keyboard',
        'Laptop',
        'Mouse',
      ]);
    });
    it('employees see only their own equipment without costs, Finance gets reviewed cost fields without custody writes', async () => {
      const own = await equipment.person(req(employee), employee.id, {});
      assert.equal(own.items.length, 3);
      assert.ok(!('purchaseCost' in own.items[0]));
      assert.ok(!('approvedCost' in own.items[0]));
      await assert.rejects(equipment.person(req(other), employee.id, {}), /own equipment/);
      await assert.rejects(equipment.people(req(employee), {}), /permission/);
      const f = await equipment.person(req(finance), employee.id, {});
      assert.equal(f.items[0].purchaseCost, '1000.00');
      assert.equal(f.items[0].approvedCost, null);
      assert.equal(f.items[0].financeState, null);
      await assert.rejects(
        domain.returnAsset(req(finance, 1), f.items[0].assignmentId, {
          reason: 'Forbidden Finance custody move',
          condition: 'Good',
        }),
        /permission/,
      );
      for (const u of [executive, itAdmin])
        await assert.rejects(equipment.person(req(u), employee.id, {}), /own equipment/);
    });
    it('pages all equipment and one-item return leaves the rest mapped with history preserved', async () => {
      let p = await equipment.person(req(admin), employee.id, { limit: 1 });
      const ids = p.items.map((a: any) => a.id);
      while (p.nextCursor) {
        p = await equipment.person(req(admin), employee.id, { limit: 1, after: p.nextCursor });
        ids.push(...p.items.map((a: any) => a.id));
      }
      assert.equal(new Set(ids).size, 3);
      const record = await equipment.person(req(admin), employee.id, {}),
        first = record.items[0];
      await domain.returnAsset(req(admin, first.assignmentVersion), first.assignmentId, {
        reason: 'Return only the laptop-like item',
        condition: 'Good',
      });
      const after = await equipment.person(req(employee), employee.id, {});
      assert.equal(after.summary.total, 2);
      assert.equal(after.items.length, 2);
      assert.ok(!after.items.some((a: any) => a.id === first.id));
      const [closed] = await db.query('SELECT ended_at FROM assignments WHERE id=$1', [
        first.assignmentId,
      ]);
      assert.ok(closed.ended_at);
      assert.equal(
        (
          await db.query(
            "SELECT id FROM assignment_events WHERE assignment_id=$1 AND kind='RETURNED'",
            [first.assignmentId],
          )
        ).length,
        1,
      );
    });
    it('person counts and equipment share a snapshot across a concurrent return', async () => {
      const original = db.query.bind(db);
      let changed = false;
      const before = await equipment.person(req(admin), employee.id, {});
      const item = before.items[0];
      db.query = async (sql: string, values: any[] = [], client?: any) => {
        const rows = await original(sql, values, client);
        if (!changed && sql.includes('AS pending_acknowledgements') && values[0] === employee.id) {
          changed = true;
          const writer = await db.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'UPDATE assignments SET ended_at=now(),version=version+1 WHERE id=$1',
              [item.assignmentId],
            );
            await writer.query(
              "UPDATE assets SET status='In Store',version=version+1 WHERE id=$1",
              [item.id],
            );
            await writer.query('COMMIT');
          } catch (e) {
            await writer.query('ROLLBACK');
            throw e;
          } finally {
            writer.release();
          }
        }
        return rows;
      };
      let snapshot: any;
      try {
        snapshot = await equipment.person(req(admin), employee.id, {});
      } finally {
        db.query = original;
      }
      assert.equal(changed, true);
      assert.equal(snapshot.summary.total, before.summary.total);
      assert.equal(snapshot.items.length, before.items.length);
      assert(snapshot.items.some((x: any) => x.id === item.id));
      const after = await equipment.person(req(admin), employee.id, {});
      assert.equal(after.summary.total, before.summary.total - 1);
      assert.equal(after.items.length, after.summary.total);
    });
    it('new custody rejects obsolete portal acceptance and succeeds after current acceptance', async () => {
      const [asset] = await db.query(
        "INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Mouse','Portal version custody check','Owned','In Store','Good','Low')RETURNING id,version",
      );
      await db.query("UPDATE users SET portal_notice_version='obsolete' WHERE id=$1", [other.id]);
      await assert.rejects(() =>
        domain.assign(req(admin, asset.version), asset.id, { userId: other.id }),
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM assignments WHERE asset_id=$1', [asset.id]))[0]
          .n,
        0,
      );
      await db.query('UPDATE users SET portal_notice_version=$2 WHERE id=$1', [
        other.id,
        configuration().noticeVersion,
      ]);
      const assigned = await domain.assign(req(admin, asset.version), asset.id, {
        userId: other.id,
      });
      assert.equal(assigned.userId, other.id);
      await domain.returnAsset(req(admin, assigned.version), assigned.id, {
        condition: 'Good',
        reason: 'Finish synthetic portal eligibility check',
      });
    });
    it('validates paging and includes people without assigned equipment', async () => {
      const p = await equipment.people(req(finance), { q: tag });
      assert.equal(p.items.find((u: any) => u.id === other.id).equipmentCount, 0);
      assert.equal((await equipment.person(req(other), other.id, {})).items.length, 0);
      await assert.rejects(equipment.person(req(admin), employee.id, { limit: 101 }));
      await assert.rejects(equipment.people(req(admin), { after: 'bad-id' }));
    });
  },
);
