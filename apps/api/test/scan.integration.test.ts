import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { configuration, hash, signedCsrf, token } from '../src/config';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Scan integration requires a database name ending _test');
const tag = `scan-${randomUUID()}`;
const viewKeys = [
  'assetCode',
  'assetType',
  'canViewFull',
  'category',
  'department',
  'custodian',
  'hasPhoto',
  'id',
  'location',
  'manufacturer',
  'model',
  'reportable',
  'status',
];

describe('scan API integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, holder: any, other: any, itAdmin: any;
  let asset: any, disposed: any, lost: any;
  const serial = `SN-${tag}`;
  const barcode = `BC-${tag}`;
  const req = (user: any, currentVersion?: number) =>
    ({
      user,
      get: (name: string) =>
        name.toLowerCase() === 'if-match'
          ? currentVersion === undefined
            ? undefined
            : `"${currentVersion}"`
          : name.toLowerCase() === 'idempotency-key'
            ? randomUUID()
            : undefined,
    }) as AuthRequest;
  const headers = (user: any) => ({
    Origin: configuration().origin,
    ...(user
      ? {
          Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
          'X-CSRF-Token': user.csrf,
        }
      : {}),
  });
  const get = async (user: any, path: string) => {
    const response = await fetch(`${base}${path}`, { headers: headers(user) });
    return { status: response.status, body: await response.json() };
  };
  const scan = (user: any, code = asset.assetCode, suffix = '') =>
    get(user, `/scan/${encodeURIComponent(code)}${suffix}`);

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[], displayName: string) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName,
        roles,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [result.id, result.email, result.displayName, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [
          result.id,
          role,
        ]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(result.session), result.id, hash(result.csrf)],
      );
      return result;
    };
    admin = await user(['SUPER_ADMIN'], `${tag} Admin`);
    holder = await user(['EMPLOYEE'], `${tag} Holder Person`);
    other = await user(['EMPLOYEE'], `${tag} Other Person`);
    itAdmin = await user(['EMPLOYEE'], `${tag} IT Person`);
    await joinTeam(db, itAdmin, 'MEMBER', ADM_TEAM_ID);
    const references = {
      CATEGORY: `${tag} category`,
      ASSET_TYPE: `${tag} type`,
      OWNERSHIP: `${tag} ownership`,
      CONDITION: `${tag} condition`,
      RISK: `${tag} risk`,
    };
    for (const [kind, code] of Object.entries(references))
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [
        kind,
        code,
      ]);
    const [department] = await db.query(
      'INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id',
      [`${tag}-dept`],
    );
    await db.query('UPDATE users SET department_id=$2,designation=$3 WHERE id=$1', [
      holder.id,
      department.id,
      'Speech Therapist',
    ]);
    const [location] = await db.query(
      'INSERT INTO locations(code,site,floor,room) VALUES($1,$2,$3,$4) RETURNING id',
      [`${tag}-loc`, `${tag} site`, '2', '204'],
    );
    const create = (extra: Record<string, unknown> = {}) =>
      domain.createAsset(req(admin), {
        category: references.CATEGORY,
        assetType: references.ASSET_TYPE,
        description: `${tag} synthetic laptop`,
        manufacturer: 'Acme',
        model: 'X1',
        serialNumber: serial,
        barcode,
        ownershipType: references.OWNERSHIP,
        departmentId: department.id,
        locationId: location.id,
        status: 'In Store',
        condition: references.CONDITION,
        riskLevel: references.RISK,
        amcApplies: false,
        ...extra,
      });
    asset = await create();
    await domain.assign(req(admin, asset.version), asset.id, { userId: holder.id });
    disposed = await create();
    lost = await create();
    await db.query(
      "UPDATE assets SET status='Disposed',disposal_date=current_date,disposal_reference='SYN-REF' WHERE id=$1",
      [disposed.id],
    );
    await db.query("UPDATE assets SET status='Lost' WHERE id=$1", [lost.id]);
  });

  after(async () => {
    if (app) await app.close();
  });

  it('staff sees basic view', async () => {
    const result = await scan(other);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), [...viewKeys].sort());
    assert.equal(result.body.id, asset.id);
    assert.equal(result.body.canViewFull, false);
    assert.equal(result.body.reportable, true);
    assert.equal(result.body.hasPhoto, false);
    assert.equal(result.body.department, `${tag}-dept`);
    assert.equal(result.body.custodian.name, holder.displayName);
    assert.equal(result.body.custodian.designation, 'Speech Therapist');
    assert.equal(result.body.custodian.department, `${tag}-dept`);
    assert.equal(result.body.custodian.acknowledgement, 'PENDING');
    assert.deepEqual(result.body.location, {
      site: `${tag} site`,
      floor: '2',
      room: '204',
      path: `${tag} site › 2 › 204`,
    });
    assert.equal((await scan(itAdmin)).status, 200);
  });

  it('scan shows current custodian identity without exposing private account or asset fields', async () => {
    for (const user of [other, itAdmin, holder, admin]) {
      const json = JSON.stringify((await scan(user)).body);
      assert.equal(json.includes(holder.displayName), true);
      assert.equal(json.includes('Speech Therapist'), true);
      for (const secret of [serial, barcode, holder.email, holder.id])
        assert.equal(json.includes(secret), false);
    }
  });

  it('holder and admin canViewFull', async () => {
    assert.equal((await scan(holder)).body.canViewFull, true);
    assert.equal((await scan(admin)).body.canViewFull, true);
  });

  it('non-reportable statuses', async () => {
    for (const a of [disposed, lost]) {
      const result = await scan(other, a.assetCode);
      assert.equal(result.status, 200);
      assert.equal(result.body.reportable, false);
    }
  });

  it('scan lookup is case-insensitive and trims', async () => {
    const result = await scan(other, ` ${asset.assetCode.toLowerCase()} `);
    assert.equal(result.status, 200);
    assert.equal(result.body.id, asset.id);
  });

  it('scans a custom QR identifier and returns identifiers on the full asset view', async () => {
    await db.query(
      "INSERT INTO asset_identifiers(asset_id,kind,value,created_by) VALUES($1,'QR',$2,$3)",
      [asset.id, `QR-${tag}`, admin.id],
    );
    const result = await scan(other, ` QR-${tag} `);
    assert.equal(result.status, 200);
    assert.equal(result.body.id, asset.id);
    const detail = await get(admin, `/assets/${asset.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.identifiers.some((item: any) => item.kind === 'QR' && item.value === `QR-${tag}`));
    const add = await fetch(`${base}/assets/${asset.id}/identifiers`, {
      method: 'POST',
      headers: { ...headers(admin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'NFC', value: `NFC-${tag}`, reason: 'Attach NFC tag' }),
    });
    assert.equal(add.status, 201);
    const added = await add.json();
    const remove = await fetch(`${base}/assets/${asset.id}/identifiers/${added.id}`, {
      method: 'DELETE',
      headers: { ...headers(admin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Replace NFC tag' }),
    });
    assert.equal(remove.status, 200);
  });

  it('unknown code 404, unauthenticated 401', async () => {
    assert.equal((await scan(other, 'IAC-IT-999999')).status, 404);
    assert.equal((await scan(other, 'IAC-IT-999999', '/photo')).status, 404);
    assert.equal((await scan(null)).status, 401);
    assert.equal((await scan(null, asset.assetCode, '/photo')).status, 401);
  });

  it('photo for non-holder', async () => {
    assert.deepEqual((await scan(other, asset.assetCode, '/photo')).body, { dataUrl: null });
    const bytes = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#2563eb' },
    })
      .jpeg()
      .toBuffer();
    const [{ version }] = await db.query('SELECT version FROM assets WHERE id=$1', [asset.id]);
    const put = await fetch(`${base}/assets/${asset.id}/photo`, {
      method: 'PUT',
      headers: {
        ...headers(admin),
        'Content-Type': 'application/json',
        'If-Match': `"${version}"`,
      },
      body: JSON.stringify({
        dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        reason: 'Synthetic scan photo',
      }),
    });
    assert.equal(put.status, 200);
    const result = await scan(other, asset.assetCode, '/photo');
    assert.equal(result.status, 200);
    assert.match(result.body.dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal((await scan(other)).body.hasPhoto, true);
    assert.equal((await get(other, `/assets/${asset.id}/photo`)).status, 404);
  });
});
