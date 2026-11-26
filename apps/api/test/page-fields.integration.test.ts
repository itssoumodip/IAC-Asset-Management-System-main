import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { SubscriptionService } from '../src/subscriptions';
import { VendorService } from '../src/vendors';
import { PersonProfileService } from '../src/person-profile';
import { IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Page field tests require a database ending _test');
const tag = `pf-${randomUUID().slice(0, 8)}`;

describe('field permissions on subscriptions, vendors and people', { skip: !connection, concurrency: false }, () => {
  let db: Db, subs: SubscriptionService, vendors: VendorService, people: PersonProfileService;
  const executive: any = { id: randomUUID(), roles: ['EXECUTIVE'], teams: [] };
  // An IT team member (Employee role + Team Member level) who may manage vendors.
  const member: any = { id: randomUUID(), roles: ['EMPLOYEE'], teams: [{ teamId: IT_TEAM_ID, level: 'MEMBER' }] };
  const admin: any = { id: randomUUID(), roles: ['SUPER_ADMIN'], teams: [] };
  let subscriptionId: string, vendorId: string;
  const rules: [string, string, boolean, boolean][] = [
    ['EXECUTIVE', 'subscription_cost', false, false],
    ['EXECUTIVE', 'vendor_phone', false, false],
    ['EXECUTIVE', 'person_email', false, false],
    ['EMPLOYEE', 'vendor_phone', true, false],
    ['TEAM_MEMBER', 'vendor_phone', true, false],
  ];

  before(async () => {
    db = new Db();
    subs = new SubscriptionService(db);
    vendors = new VendorService(db);
    people = new PersonProfileService(db);
    for (const u of [executive, member, admin])
      await db.query("INSERT INTO users(id,email,display_name,state) VALUES($1,$2,$3,'ACTIVE')", [u.id, `${tag}-${u.id}@example.org`, `${tag} user`]);
    for (const [role, field, view, edit] of rules)
      await db.query(
        `INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit) VALUES($1,$2,$3,$4)
         ON CONFLICT (role_code, field_name) DO UPDATE SET can_view=EXCLUDED.can_view, can_edit=EXCLUDED.can_edit`,
        [role, field, view, edit],
      );
    await db.query(
      "INSERT INTO reference_values(kind, code, label) VALUES('SUBSCRIPTION_CATEGORY', $1, $1) ON CONFLICT DO NOTHING",
      [`${tag} type`],
    );
    subscriptionId = (await subs.create({ user: admin } as any, {
      name: `${tag} plan`, category: `${tag} type`, billingCycle: 'MONTHLY', cost: 1000,
    })).id;
    vendorId = (await vendors.create({ user: admin } as any, { name: `${tag} vendor`, phone: '111' })).id;
  });
  after(async () => {
    for (const [role, field] of rules)
      await db.query('DELETE FROM role_field_permissions WHERE role_code=$1 AND field_name=$2', [role, field]);
    await db?.onModuleDestroy();
  });

  it('hides fields a role may not see, on every page', async () => {
    const list = await subs.list({ user: executive } as any, { q: tag });
    const mine = list.items.find((s: any) => s.id === subscriptionId)!;
    assert.equal(mine.cost, null);
    assert.equal(mine.monthlyCostInr, null);
    assert.equal(mine.name, `${tag} plan`);
    const summary = await subs.summary({ user: executive } as any);
    assert.equal(summary.monthlySpend, null);

    assert.equal((await vendors.detail({ user: executive } as any, vendorId)).phone, null);
    const found = await people.list({ user: executive } as any, { q: tag });
    assert.ok(found.items.length && found.items.every((p: any) => p.email === null));

    // Super Admin is never limited.
    assert.equal((await vendors.detail({ user: admin } as any, vendorId)).phone, '111');
  });

  it('keeps a locked field when the form sends a change', async () => {
    const v = await vendors.detail({ user: member } as any, vendorId);
    assert.equal(v.phone, '111');
    assert.deepEqual(v.lockedFields, ['phone']);
    await vendors.update({ user: member } as any, vendorId, {
      name: `${tag} vendor`, phone: '999', notes: 'changed', version: v.version,
    });
    const after = await vendors.detail({ user: admin } as any, vendorId);
    assert.equal(after.phone, '111');
    assert.equal(after.notes, 'changed');
  });
});
