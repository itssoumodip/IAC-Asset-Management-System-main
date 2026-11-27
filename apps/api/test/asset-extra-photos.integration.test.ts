import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { AssetExtraPhotoService, MAX_EXTRA_PHOTOS } from '../src/asset-photos';
import type { AuthRequest } from '../src/security';
import { IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Extra asset photo tests require a database name ending _test');
const tag = `xphoto-${randomUUID().slice(0, 8)}`;
const req = (user: any) =>
  ({
    user,
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
  }) as AuthRequest;

describe('more pictures of one asset', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, photos: AssetExtraPhotoService;
  let admin: any, outsider: any, asset: any, jpeg: string;

  before(async () => {
    db = new Db();
    domain = new DomainService(db);
    photos = new AssetExtraPhotoService(db);
    const mk = async (roles: string[]) => {
      const id = randomUUID();
      await db.query("INSERT INTO users(id,email,display_name,state) VALUES($1,$2,$3,'ACTIVE')", [id, `${tag}-${id}@example.org`, tag]);
      for (const r of roles) await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, r]);
      return { id, roles, teams: [] as any[] } as any;
    };
    admin = await mk(['SUPER_ADMIN']);
    outsider = await mk(['EMPLOYEE']);
    asset = await domain.createAsset(req(admin), {
      category: 'IT Hardware', assetType: 'Laptop', description: `${tag} laptop`, ownershipType: 'Owned',
      status: 'In Store', condition: 'Good', riskLevel: 'Low', owningTeamId: IT_TEAM_ID, amcApplies: false,
    } as any);
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#335577' } })
      .jpeg()
      .toBuffer();
    jpeg = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  });
  after(async () => db?.onModuleDestroy());

  it('adds labelled pictures, lists them in order and removes one with a reason', async () => {
    await photos.add(req(admin), asset.id, { dataUrl: jpeg, label: 'Front', reason: 'Condition check' });
    const back = await photos.add(req(admin), asset.id, { dataUrl: jpeg, label: 'Back', reason: 'Condition check' });
    const list = await photos.list(req(admin), asset.id);
    assert.deepEqual(list.items.map((p) => p.label), ['Front', 'Back']);
    assert.ok(list.items.every((p) => p.dataUrl.startsWith('data:image/jpeg;base64,')));
    await photos.remove(req(admin), asset.id, back.id, { reason: 'Blurred' });
    assert.deepEqual((await photos.list(req(admin), asset.id)).items.map((p) => p.label), ['Front']);
    const audit = await db.query(
      "SELECT action FROM audit_events WHERE entity_id=$1 AND action LIKE 'ASSET_EXTRA_PHOTO%' ORDER BY occurred_at",
      [asset.id],
    );
    assert.deepEqual(audit.map((a: any) => a.action), ['ASSET_EXTRA_PHOTO_ADDED', 'ASSET_EXTRA_PHOTO_ADDED', 'ASSET_EXTRA_PHOTO_REMOVED']);
    // Removing again finds nothing.
    await assert.rejects(photos.remove(req(admin), asset.id, back.id, { reason: 'x' }), (e: any) => e.status === 404);
  });

  it(`stops at ${MAX_EXTRA_PHOTOS} pictures and rejects unknown labels`, async () => {
    const have = (await photos.list(req(admin), asset.id)).items.length;
    for (let i = have; i < MAX_EXTRA_PHOTOS; i++)
      await photos.add(req(admin), asset.id, { dataUrl: jpeg, label: 'Other', reason: 'More angles' });
    await assert.rejects(
      photos.add(req(admin), asset.id, { dataUrl: jpeg, label: 'Other', reason: 'One too many' }),
      (e: any) => e.status === 409,
    );
    await assert.rejects(
      photos.add(req(admin), asset.id, { dataUrl: jpeg, label: 'Selfie', reason: 'x' } as any),
      (e: any) => e.status === 422 || e.status === 400,
    );
  });

  it('hides pictures from people who cannot see the asset and lets only photo managers add', async () => {
    await assert.rejects(photos.list(req(outsider), asset.id), (e: any) => e.status === 404);
    await assert.rejects(
      photos.add(req(outsider), asset.id, { dataUrl: jpeg, label: 'Front', reason: 'x' }),
      (e: any) => e.status === 403 || e.status === 404,
    );
    // An IT member sees IT's asset and its pictures.
    const member = await joinTeam(db, { id: admin.id, roles: ['EMPLOYEE'], teams: [] } as any, 'MEMBER', IT_TEAM_ID);
    assert.ok((await photos.list(req(member), asset.id)).items.length > 0);
  });
});
