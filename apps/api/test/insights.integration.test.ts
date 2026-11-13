import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { InsightsService } from '../src/insights';
import { allocateAssetCode } from '../src/domain-assets';
import { IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Insights integration requires a database ending _test');
const tag = `insights-${randomUUID()}`;
const actor = (roles: string[]): any => ({ id: randomUUID(), email: `${tag}@example.org`, roles, teams: [] });

describe('dashboard insights and holder filter', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, insights: InsightsService;
  const admin = actor(['SUPER_ADMIN']);
  let holder: string;
  before(async () => {
    db = new Db();
    domain = new DomainService(db);
    insights = new InsightsService(db);
    holder = randomUUID();
    for (const id of [admin.id, holder])
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
        [id, `${tag}-${id}@example.org`, `${tag} person`],
      );
    // The same person holds two assets.
    for (let i = 0; i < 2; i++)
      await db.tx(async (c) => {
        const code = await allocateAssetCode(db, IT_TEAM_ID, c);
        const [asset] = await db.query(
          `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,purchase_cost,purchase_date)
           VALUES($1,'IT Hardware','Laptop',$2,'Owned','In Use','Good','Low',$3,50000,current_date) RETURNING id`,
          [code, `${tag} laptop ${i}`, IT_TEAM_ID],
          c,
        );
        await db.query(
          "INSERT INTO assignments(asset_id,user_id,assigned_by,acknowledgement,acknowledged_at) VALUES($1,$2,$3,'ACCEPTED',now())",
          [asset.id, holder, admin.id],
          c,
        );
      });
  });
  after(async () => db?.onModuleDestroy());

  it('lists people with how many assets they hold', async () => {
    const people = await insights.holders({ user: admin } as any);
    const row = people.find((p) => p.userId === holder);
    assert.equal(row?.count, 2);
  });

  it('filters the catalog to everything one person holds', async () => {
    const result = await domain.assets({ user: admin } as any, { holderId: holder, limit: 50 });
    assert.equal(result.items.length, 2);
  });

  it('accepts several values per filter (any of them matches)', async () => {
    const both = await domain.assets({ user: admin } as any, {
      holderId: `${holder},${randomUUID()}`,
      assetType: 'Laptop,Tablet',
      status: 'In Use,In Store',
      limit: 50,
    });
    assert.equal(both.items.length, 2);
    const none = await domain.assets({ user: admin } as any, { holderId: holder, assetType: 'Tablet', limit: 50 });
    assert.equal(none.items.length, 0);
    await assert.rejects(domain.assets({ user: admin } as any, { holderId: 'not-an-id' }));
  });

  it('filters by brand ignoring case, and lists brands', async () => {
    await db.query(
      `UPDATE assets SET manufacturer = CASE WHEN description LIKE '%0' THEN 'HP' ELSE 'hp' END WHERE description LIKE $1`,
      [`${tag} laptop %`],
    );
    const hp = await domain.assets({ user: admin } as any, { holderId: holder, manufacturer: 'Hp,Dell', limit: 50 });
    assert.equal(hp.items.length, 2);
    const brands = await insights.brands({ user: admin } as any);
    assert.ok(brands.some((b) => b.name.toLowerCase() === 'hp' && b.count >= 2));
  });

  it('gives money totals only to people who may see costs', async () => {
    const full = await insights.insights({ user: admin } as any);
    assert.equal(full.money, true);
    assert.ok((full.liveValue ?? 0) >= 100000);
    assert.ok(full.topHolders.length > 0);
    const store = await insights.insights({ user: actor(['STORE']) } as any);
    assert.equal(store.money, false);
    assert.equal(store.liveValue, null);
    assert.ok(store.byDepartment.every((s: any) => !('value' in s)));
  });
});
