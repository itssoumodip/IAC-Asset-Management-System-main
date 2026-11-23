import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { CategoriesService, CategoryService } from '../src/categories';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';
import { allocateAssetCode } from '../src/domain-assets';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Category integration requires a database ending _test');
const admin: any = { id: randomUUID(), email: 'a@example.org', roles: ['SUPER_ADMIN'], teams: [], requestId: randomUUID() };

describe('creating categories and subcategories', { skip: !connection, concurrency: false }, () => {
  let db: Db, categories: CategoriesService, subcategories: CategoryService;
  const name = `Test Category ${randomUUID().slice(0, 8)}`;
  before(async () => {
    db = new Db();
    // Audit entries need a real actor.
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,'Category test admin','ACTIVE',now(),now(),'1')",
      [admin.id, `cat-${admin.id}@example.org`],
    );
    categories = new CategoriesService(db);
    subcategories = new CategoryService(db);
  });
  after(async () => db?.onModuleDestroy());

  it('creates a category with its handling and owning teams, once', async () => {
    const created = await categories.create({ user: admin } as any, {
      name,
      handlingTeamId: ADM_TEAM_ID,
      teamIds: [ADM_TEAM_ID, IT_TEAM_ID],
      reason: 'test',
    });
    assert.equal(created.categoryCode, name);
    const listed = (await categories.list()).find((c) => c.categoryCode === name)!;
    assert.equal(listed.handlingTeamId, ADM_TEAM_ID);
    assert.deepEqual([...listed.owningTeamIds].sort(), [ADM_TEAM_ID, IT_TEAM_ID].sort());
    await assert.rejects(
      categories.create({ user: admin } as any, { name: name.toUpperCase(), handlingTeamId: ADM_TEAM_ID, teamIds: [ADM_TEAM_ID], reason: 'dup' }),
      /already exists/,
    );
    await assert.rejects(
      categories.create({ user: { ...admin, roles: ['EMPLOYEE'] } } as any, { name: 'x', handlingTeamId: ADM_TEAM_ID, teamIds: [ADM_TEAM_ID], reason: 'x' }),
      /permission/i,
    );
  });

  it('creates subcategories with the category, and deletes a category only while unused', async () => {
    const other = `Spare Category ${randomUUID().slice(0, 8)}`;
    const sub = `${other} Ball`;
    const created = await categories.create({ user: admin } as any, {
      name: other,
      handlingTeamId: ADM_TEAM_ID,
      teamIds: [ADM_TEAM_ID],
      reason: 'test',
      subcategories: [{ name: sub, requiresCustodian: false }],
    });
    assert.deepEqual(created.subcategories, [sub]);
    let listed = (await categories.list()).find((c) => c.categoryCode === other)!;
    assert.equal(listed.subcategories[0].assetTypeCode, sub);
    assert.equal(listed.subcategories[0].requiresCustodian, false);

    // In use: refused.
    const [asset] = await db.tx(async (tx) => db.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id)
       VALUES($1,$2,$3,'category delete test','Owned','In Store','Good','Low',$4) RETURNING id`,
      [await allocateAssetCode(db, ADM_TEAM_ID, tx), other, sub, ADM_TEAM_ID],
      tx,
    ));
    await assert.rejects(categories.remove(other, { user: admin } as any, { reason: 'test' }), /Move it/);
    await db.query('DELETE FROM assets WHERE id=$1', [asset.id]);

    // Unused: deleted, and its subcategory switched off.
    await categories.remove(other, { user: admin } as any, { reason: 'test' });
    listed = (await categories.list()).find((c) => c.categoryCode === other)!;
    assert.equal(listed, undefined);
    const [ref] = await db.query("SELECT active FROM reference_values WHERE kind='ASSET_TYPE' AND code=$1", [sub]);
    assert.equal(ref.active, false);
  });

  it('adds a subcategory with its name, and hides it once switched off', async () => {
    const code = `${name} Item`;
    await subcategories.addSubcategory({ user: admin } as any, name, { code, label: code, requiresCustodian: false, reason: 'test' });
    let listed = (await categories.list()).find((c) => c.categoryCode === name)!;
    const item = listed.subcategories.find((s: any) => s.assetTypeCode === code);
    assert.equal(item?.label, code);
    assert.equal(item?.assetCount, 0);
    await subcategories.patchSubcategory({ user: admin } as any, code, { active: false, reason: 'test' });
    listed = (await categories.list()).find((c) => c.categoryCode === name)!;
    assert.ok(!listed.subcategories.some((s: any) => s.assetTypeCode === code));
  });
});
