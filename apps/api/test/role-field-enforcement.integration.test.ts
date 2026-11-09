import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { Db } from '../src/db';
import { assetFieldRestrictions, stripHiddenFields } from '../src/role-field';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Role field enforcement test requires isolated _test DB');
process.env.DATABASE_URL = url;
const db = new Db();
after(async () => db.onModuleDestroy());

class Rollback extends Error {}
// Every test runs in a transaction that is rolled back, so saved settings never leak.
async function scratch(fn: (c: PoolClient) => Promise<void>) {
  await assert.rejects(
    db.tx(async (c) => {
      await c.query('DELETE FROM role_field_permissions');
      await fn(c);
      throw new Rollback('rollback');
    }),
    (e) => e instanceof Rollback,
  );
}
const deny = (c: PoolClient, role: string, field: string, view: boolean, edit: boolean) =>
  c.query(
    `INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit) VALUES($1,$2,$3,$4)`,
    [role, field, view, edit],
  );

test('no saved settings keeps every field visible and editable', async () => {
  await scratch(async (c) => {
    const r = await assetFieldRestrictions(db, { roles: ['EMPLOYEE'] }, c);
    assert.equal(r.hidden.size, 0);
    assert.equal(r.locked.size, 0);
  });
});

test('a field is hidden only when every role of the user denies it', async () => {
  await scratch(async (c) => {
    await deny(c, 'EMPLOYEE', 'purchaseCost', false, false);
    const employee = await assetFieldRestrictions(db, { roles: ['EMPLOYEE'] }, c);
    assert.ok(employee.hidden.has('purchaseCost'));
    assert.ok(employee.locked.has('purchaseCost'));
    // FINANCE has no row for the field, so a user holding both roles still sees it.
    const both = await assetFieldRestrictions(db, { roles: ['EMPLOYEE', 'FINANCE'] }, c);
    assert.equal(both.hidden.has('purchaseCost'), false);
  });
});

test('view without edit locks the field but keeps it visible', async () => {
  await scratch(async (c) => {
    await deny(c, 'EMPLOYEE', 'supplier', true, false);
    const r = await assetFieldRestrictions(db, { roles: ['EMPLOYEE'] }, c);
    assert.equal(r.hidden.has('supplier'), false);
    assert.ok(r.locked.has('supplier'));
  });
});

test('Super Admin and essential fields are never restricted', async () => {
  await scratch(async (c) => {
    await deny(c, 'SUPER_ADMIN', 'purchaseCost', false, false);
    await deny(c, 'EMPLOYEE', 'assetCode', false, false);
    const admin = await assetFieldRestrictions(db, { roles: ['SUPER_ADMIN'] }, c);
    assert.equal(admin.hidden.size, 0);
    const employee = await assetFieldRestrictions(db, { roles: ['EMPLOYEE'] }, c);
    assert.equal(employee.hidden.has('assetCode'), false);
  });
});

test('stripHiddenFields removes only the hidden keys', () => {
  const items = [{ id: '1', assetCode: 'IAC-IT-000001', purchaseCost: 100, model: 'X' }];
  stripHiddenFields(items, new Set(['purchaseCost']));
  assert.deepEqual(items, [{ id: '1', assetCode: 'IAC-IT-000001', model: 'X' }]);
});
