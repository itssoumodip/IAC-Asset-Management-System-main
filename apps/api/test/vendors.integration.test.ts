import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { VendorService } from '../src/vendors';
import { allocateAssetCode } from '../src/domain-assets';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Vendor integration requires a database ending _test');
const tag = `ven-${randomUUID().slice(0, 8)}`;
const person = (roles: string[], teams: any[] = []): any => ({ id: randomUUID(), email: `${tag}@example.org`, roles, teams, requestId: randomUUID() });

describe('vendors', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: VendorService;
  const itMember = person(['EMPLOYEE'], [{ teamId: IT_TEAM_ID, teamCode: 'IT', level: 'MEMBER' }]);
  const admMember = person(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
  const finance = person(['FINANCE']);
  const employee = person(['EMPLOYEE']);
  const name = `${tag} Optima Infotech`;
  let vendorId = '';
  let assetId = '';
  before(async () => {
    db = new Db();
    service = new VendorService(db);
    for (const u of [itMember, admMember, finance, employee])
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
        [u.id, `${tag}-${u.id}@example.org`, `${tag} ${u.id.slice(0, 4)}`],
      );
    // An IT asset whose supplier is written with different case and spaces.
    await db.tx(async (c) => {
      const code = await allocateAssetCode(db, IT_TEAM_ID, c);
      const [a] = await db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,purchase_cost,purchase_date,supplier)
         VALUES($1,'IT Hardware','Laptop',$2,'Owned','In Store','Good','Low',$3,42000,current_date,$4) RETURNING id`,
        [code, `${tag} laptop`, IT_TEAM_ID, `  ${name.toUpperCase()} `],
        c,
      );
      assetId = a.id;
    });
  });
  after(async () => db?.onModuleDestroy());

  it('lets team members add a vendor once, with reference people and a VEN- code', async () => {
    await assert.rejects(service.create({ user: employee } as any, { name }), /Only team members/);
    const created = await service.create({ user: itMember } as any, {
      name,
      services: 'All IT and others services',
      contactPerson: 'Anil Bader',
      phone: '9830040965',
      score: 10,
      referenceUserIds: [itMember.id, finance.id],
    });
    assert.match(created.code, /^VEN-\d{4,}$/);
    vendorId = created.id;
    await assert.rejects(service.create({ user: finance } as any, { name: name.toLowerCase() }), /already exists/);
    await assert.rejects(service.create({ user: itMember } as any, { name: `${tag} Bad`, score: 11 }), /Invalid fields/);
  });

  it('links assets by supplier name, within the viewer’s asset scope', async () => {
    const it = await service.detail({ user: itMember } as any, vendorId);
    assert.ok(it.assets.some((a) => a.id === assetId), 'case and spaces are ignored');
    assert.equal(it.referencePeople.length, 2);
    const adm = await service.detail({ user: admMember } as any, vendorId);
    assert.ok(!adm.assets.some((a) => a.id === assetId), 'Admin team does not see IT assets');
    const list = await service.list({ user: finance } as any, { q: tag });
    assert.equal(list.items[0].assetCount, 1);
    assert.equal(list.items[0].assetValue, 42000);
    const lookup = await service.lookup({ user: employee } as any, ` ${name.toLowerCase()} `);
    assert.equal(lookup.vendor?.id, vendorId);
    // Dashes, extra spaces and "and" for "&" still match.
    const loose = await service.lookup({ user: employee } as any, name.replace(' Optima', '-Optima ').replace('Infotech', 'Info tech'));
    assert.equal(loose.vendor?.id, vendorId);
  });

  it('edits with a version check and replaces reference people', async () => {
    const d = await service.detail({ user: itMember } as any, vendorId);
    await service.update({ user: finance } as any, vendorId, { name, score: 7.5, referenceUserIds: [itMember.id], version: d.version });
    await assert.rejects(service.update({ user: finance } as any, vendorId, { name, version: d.version }), /changed this vendor/);
    const after = await service.detail({ user: finance } as any, vendorId);
    assert.equal(after.score, 7.5);
    assert.deepEqual(after.referencePeople.map((p: any) => p.userId), [itMember.id]);
    await assert.rejects(service.list({ user: employee } as any, {}), /permission/i);
  });
});
