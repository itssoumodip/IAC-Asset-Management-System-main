import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { FieldPermissionService } from '../src/field-permissions';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Field permission tests require a database name ending _test');

describe('field permissions integration', { skip: !connection, concurrency: false }, () => {
  let db: Db;
  let service: FieldPermissionService;
  const admin = {
    id: randomUUID(),
    roles: ['SUPER_ADMIN'],
    teams: [],
  } as any;
  const request = { user: admin } as AuthRequest;

  before(async () => {
    process.env.DATABASE_URL = connection;
    db = new Db();
    await db.query(
      "INSERT INTO users(id,email,display_name,state) VALUES($1,$2,'Field permission test admin','ACTIVE')",
      [admin.id, `${admin.id}@example.org`],
    );
    service = new FieldPermissionService(db);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('lists and updates role field visibility with an audit reason', async () => {
    const listed = await service.list(request);
    assert.ok(listed.roles.includes('INSURER'));
    assert.ok(listed.fields.includes('purchase_cost'));

    const result = await service.update(request, 'INSURER', {
      fields: [
        { name: 'description', view: true, edit: false },
        { name: 'purchase_date', view: true, edit: false },
      ],
      reason: `test ${randomUUID()}`,
    });
    assert.equal(result.role, 'INSURER');
    assert.deepEqual(result.fields.map((field) => field.name), ['description', 'purchase_date']);
    await service.update(request, 'INSURER', {
      fields: [
        { name: 'description', view: true, edit: false },
        { name: 'purchase_cost', view: true, edit: false },
        { name: 'purchase_date', view: true, edit: false },
      ],
      reason: `restore ${randomUUID()}`,
    });
  });
});
