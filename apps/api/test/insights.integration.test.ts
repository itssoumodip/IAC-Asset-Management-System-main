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

  it('finds assets by the name of the person holding them', async () => {
    const result = await domain.assets({ user: admin } as any, { q: `${tag} person`, limit: 50 });
    assert.equal(result.items.length, 2);
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

  it('filters to assets held by nobody, or with no department, alone or with others', async () => {
    const mine = { q: tag, limit: 50 };
    const nobody = await domain.assets({ user: admin } as any, { ...mine, holderId: 'none' });
    assert.ok(nobody.items.every((a: any) => !a.currentAssignment));
    assert.ok(!nobody.items.some((a: any) => a.description?.startsWith(`${tag} laptop`)));
    const either = await domain.assets({ user: admin } as any, { ...mine, holderId: `none,${holder}` });
    assert.ok(either.items.filter((a: any) => a.description?.startsWith(`${tag} laptop`)).length === 2);
    // The test laptops have no department.
    const noDept = await domain.assets({ user: admin } as any, { holderId: holder, departmentId: 'none', limit: 50 });
    assert.equal(noDept.items.length, 2);
    const { buildAssetCsv } = await import('../src/export-jobs');
    const csv = await buildAssetCsv(db, admin, { holderId: holder, departmentId: 'none' } as any);
    assert.equal(csv.rowCount, 2);
    await assert.rejects(domain.assets({ user: admin } as any, { holderId: 'nobody' }));
    // The test laptops have no brand, location, model or serial yet, but do have a cost.
    const theirs = async (extra: any) =>
      (await domain.assets({ user: admin } as any, { holderId: holder, limit: 50, ...extra })).items.length;
    assert.equal(await theirs({ manufacturer: 'none' }), 2);
    assert.equal(await theirs({ manufacturer: 'none,Dell' }), 2);
    assert.equal(await theirs({ locationId: 'none' }), 2);
    assert.equal(await theirs({ model: '__blank__' }), 2);
    assert.equal(await theirs({ serialNumber: '__blank__' }), 2);
    assert.equal(await theirs({ warrantyExpiry: '__blank__' }), 2);
    assert.equal(await theirs({ purchaseCost: '__blank__' }), 0);
    assert.equal(await theirs({ purchaseDate: '__blank__' }), 0);
  });

  it('sorts by newest Asset ID and recently added, paging without gaps or repeats', async () => {
    const sorted = (items: any[], key: (a: any) => string, desc: boolean) =>
      items.every((a, i) => i === 0 || (desc ? key(items[i - 1]) >= key(a) : key(items[i - 1]) <= key(a)));
    for (const sort of ['code', 'code_desc', 'added', 'updated']) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < 3; pageNo++) {
        const r = await domain.assets({ user: admin } as any, { sort, limit: 5, ...(cursor ? { cursor } : {}) });
        seen.push(...r.items.map((a: any) => a.id));
        if (sort.startsWith('code')) assert.ok(sorted(r.items, (a) => a.assetCode, sort === 'code_desc'), sort);
        assert.ok(r.items.every((a: any) => !('sortKey' in a)));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      assert.equal(new Set(seen).size, seen.length, `no repeats for ${sort}`);
    }
    const newest = await domain.assets({ user: admin } as any, { sort: 'added', limit: 1 });
    const [latest] = await db.query('SELECT id FROM assets ORDER BY created_at DESC, id DESC LIMIT 1');
    assert.equal(newest.items[0].id, latest.id);
  });

  it('background export accepts the catalog sort and location filters', async () => {
    const { buildAssetCsv } = await import('../src/export-jobs');
    const csv = await buildAssetCsv(db, admin, { holderId: holder, sort: 'added' } as any);
    assert.equal(csv.rowCount, 2);
  });

  it('removes an asset from the register (hidden everywhere, history kept) and restores it', async () => {
    const withVersion = (who: any, version: number) =>
      ({ user: who, get: (h: string) => (h.toLowerCase() === 'if-match' ? `"${version}"` : undefined) }) as any;
    const [free] = await db.tx(async (c) => {
      const code = await allocateAssetCode(db, IT_TEAM_ID, c);
      return db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id)
         VALUES($1,'IT Hardware','Laptop',$2,'Owned','In Store','Good','Low',$3) RETURNING id,version`,
        [code, `${tag} spare`, IT_TEAM_ID],
        c,
      );
    });
    const inList = async (extra: any = {}) =>
      (await domain.assets({ user: admin } as any, { q: `${tag} spare`, limit: 10, ...extra })).items.some((a: any) => a.id === free.id);
    assert.equal(await inList(), true);
    // Only a Super Admin, with a reason; someone holding it blocks removal.
    await assert.rejects(domain.removeFromRegister(withVersion(actor(['FINANCE']), free.version), free.id, { reason: 'x' }));
    const [held] = await db.query("SELECT a.id,a.version FROM assets a JOIN assignments s ON s.asset_id=a.id AND s.ended_at IS NULL WHERE a.description LIKE $1 LIMIT 1", [`${tag} laptop %`]);
    await assert.rejects(domain.removeFromRegister(withVersion(admin, held.version), held.id, { reason: 'x' }), (e: any) => e.status === 409);

    const removed = await domain.removeFromRegister(withVersion(admin, free.version), free.id, { reason: 'Duplicate entry' });
    assert.ok(removed.removedAt);
    assert.equal(await inList(), false);
    assert.equal(await inList({ removed: 'only' }), true);
    const [moved] = await db.query("SELECT reason FROM asset_movements WHERE asset_id=$1 ORDER BY occurred_at DESC LIMIT 1", [free.id]);
    assert.match(moved.reason, /Removed from the register: Duplicate entry/);
    // Still openable by id (to see why, or restore).
    assert.equal((await domain.asset({ user: admin } as any, free.id)).id, free.id);

    const restored = await domain.restoreToRegister(withVersion(admin, removed.version), free.id, { reason: 'Found it' });
    assert.equal(restored.removedAt ?? null, null);
    assert.equal(await inList(), true);
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

  it('narrows every chart to one team and lists the teams to choose from', async () => {
    const all = await insights.insights({ user: admin } as any);
    const it = await insights.insights({ user: admin } as any, IT_TEAM_ID);
    assert.equal(it.teamId, IT_TEAM_ID);
    assert.deepEqual(it.teams, all.teams);
    assert.ok(all.teams.some((t: any) => t.id === IT_TEAM_ID));
    const [count] = await db.query(
      'SELECT count(*)::int AS n FROM assets WHERE owning_team_id=$1 AND removed_at IS NULL',
      [IT_TEAM_ID],
    );
    assert.equal(it.total, count.n);
    assert.ok(it.byCategory.some((c: any) => c.label === 'IT Hardware'));
    // Our holder's laptops are IT's, so they still count; another team's view has none of them.
    const itHolders = await insights.holders({ user: admin } as any, IT_TEAM_ID);
    assert.equal(itHolders.find((h) => h.userId === holder)?.count, 2);
    const other = await insights.insights({ user: admin } as any, randomUUID());
    assert.equal(other.total, 0);
    await assert.rejects(insights.insights({ user: admin } as any, 'not-a-team'), (e: any) => e.status === 400);
  });
});
