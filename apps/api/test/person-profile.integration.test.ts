import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { PersonProfileService } from '../src/person-profile';
import { SubscriptionService } from '../src/subscriptions';
import { allocateAssetCode } from '../src/domain-assets';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Person profile integration requires a database ending _test');
const tag = `pp-${randomUUID().slice(0, 8)}`;
const person = (roles: string[], teams: any[] = []): any => ({ id: randomUUID(), email: `${tag}@example.org`, roles, teams, requestId: randomUUID() });

describe('person pages and rupee totals', { skip: !connection, concurrency: false }, () => {
  let db: Db, people: PersonProfileService, subs: SubscriptionService;
  const admin = person(['SUPER_ADMIN']);
  const itMember = person(['EMPLOYEE'], [{ teamId: IT_TEAM_ID, teamCode: 'IT', level: 'MEMBER' }]);
  const admMember = person(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
  const holder = person(['EMPLOYEE']);
  const stranger = person(['EMPLOYEE']);
  let assetId = '';
  let subId = '';
  before(async () => {
    db = new Db();
    people = new PersonProfileService(db);
    subs = new SubscriptionService(db);
    for (const u of [admin, itMember, admMember, holder, stranger])
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
        [u.id, `${tag}-${u.id}@example.org`, `${tag} ${u.id.slice(0, 4)}`],
      );
    await db.tx(async (c) => {
      const code = await allocateAssetCode(db, IT_TEAM_ID, c);
      const [a] = await db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,purchase_cost,purchase_date)
         VALUES($1,'IT Hardware','Laptop',$2,'Owned','In Use','Good','Low',$3,50000,current_date) RETURNING id`,
        [code, `${tag} laptop`, IT_TEAM_ID],
        c,
      );
      assetId = a.id;
      await db.query(
        "INSERT INTO assignments(asset_id,user_id,assigned_by,acknowledgement,acknowledged_at) VALUES($1,$2,$3,'ACCEPTED',now())",
        [a.id, holder.id, admin.id],
        c,
      );
    });
    // A fixed rate so the rupee figures are predictable.
    await db.query(
      `INSERT INTO exchange_rates(currency, inr_per_unit, rate_date, fetched_at, source) VALUES('USD', 80, now(), now(), 'test')
       ON CONFLICT (currency) DO UPDATE SET inr_per_unit = 80, fetched_at = now(), source = 'test'`,
    );
    const created = await subs.create({ user: itMember } as any, {
      name: `${tag} Claude Pro`,
      vendor: 'Anthropic',
      category: 'AI tool',
      billingCycle: 'MONTHLY',
      cost: 20,
      currency: 'USD',
      seatsTotal: 1,
      userIds: [holder.id],
    });
    subId = created.id;
  });
  after(async () => db?.onModuleDestroy());

  it('converts foreign costs to rupees at the saved rate', async () => {
    const list = await subs.list({ user: admin } as any, { q: tag });
    const row: any = list.items.find((s) => s.id === subId);
    assert.equal(row.costInr, 1600);
    assert.equal(row.monthlyCostInr, 1600);
  });

  it('shows a person everything they hold, with costs for those allowed', async () => {
    const p = await people.profile({ user: admin } as any, holder.id);
    assert.equal(p.assets.some((a) => a.id === assetId), true);
    assert.equal(p.totals.assetValue, 50000);
    assert.equal(p.subscriptions?.find((s) => s.id === subId)?.via, 'PERSON');
    assert.equal(p.totals.monthlySubscriptionShare, 1600);
  });

  it('limits other teams to their own assets, and lets people open only their own page', async () => {
    const it = await people.profile({ user: itMember } as any, holder.id);
    assert.ok(it.assets.some((a) => a.id === assetId));
    const adm = await people.profile({ user: admMember } as any, holder.id);
    assert.ok(!adm.assets.some((a) => a.id === assetId), 'an Admin team member does not see IT assets');
    assert.equal(adm.subscriptions, null, 'no subscription access');
    const own = await people.profile({ user: holder } as any, holder.id);
    assert.ok(own.assets.some((a) => a.id === assetId));
    assert.ok(own.subscriptions?.some((s) => s.id === subId));
    await assert.rejects(people.profile({ user: stranger } as any, holder.id), /permission/i);
  });

  it('lists people with what they hold', async () => {
    const r = await people.list({ user: admin } as any, { q: tag, holding: 'any' });
    const row = r.items.find((x) => x.id === holder.id);
    assert.equal(row?.assets, 1);
    assert.equal(row?.subscriptions, 1);
    await assert.rejects(people.list({ user: stranger } as any, {}), /permission/i);
  });

  it('counts each tab and filters by department, staff status and assets held', async () => {
    // Our five test people have no department; only the holder holds anything.
    const all = await people.list({ user: admin } as any, { q: tag });
    assert.deepEqual(
      { all: all.counts.all, any: all.counts.any, assets: all.counts.assets, subscriptions: all.counts.subscriptions, held: all.counts.assetsHeld },
      { all: 5, any: 1, assets: 1, subscriptions: 1, held: 1 },
    );
    assert.equal((await people.list({ user: admin } as any, { q: tag, departmentId: 'none' })).counts.all, 5);
    const [dept] = await db.query('SELECT id FROM departments LIMIT 1');
    if (dept) assert.equal((await people.list({ user: admin } as any, { q: tag, departmentId: dept.id })).counts.all, 0);
    assert.equal((await people.list({ user: admin } as any, { q: tag, status: 'left' })).counts.all, 0);
    assert.equal((await people.list({ user: admin } as any, { q: tag, status: 'current' })).counts.all, 5);
    assert.equal((await people.list({ user: admin } as any, { q: tag, status: 'current,left' })).counts.all, 5);
    const many = await people.list({ user: admin } as any, { q: tag, assets: '2-4,5+' });
    assert.equal(many.counts.all, 0);
    assert.equal(many.items.length, 0);
    const one = await people.list({ user: admin } as any, { q: tag, assets: '1', holding: 'assets' });
    assert.deepEqual(one.items.map((x) => x.id), [holder.id]);
    assert.equal((await people.list({ user: admin } as any, { q: tag, assets: '0' })).counts.all, 4);
    assert.equal((await people.list({ user: admin } as any, { q: tag, subscriptions: '1+' })).counts.all, 1);
    assert.equal((await people.list({ user: admin } as any, { q: tag, designation: '__blank__' })).counts.all, 5);
    assert.equal((await people.list({ user: admin } as any, { q: tag, departmentId: `none,${randomUUID()}` })).counts.all, 5);
    await assert.rejects(people.list({ user: admin } as any, { departmentId: 'sales' }), (e: any) => e.status === 400);
    await assert.rejects(people.list({ user: admin } as any, { assets: '7' }), (e: any) => e.status === 400);
  });
});
