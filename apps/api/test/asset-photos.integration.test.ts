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
  throw new Error('Asset photo integration requires a database name ending _test');
const tag = `photo-${randomUUID()}`;
const dataUrl = (bytes: Buffer, format = 'jpeg') =>
  `data:image/${format};base64,${bytes.toString('base64')}`;

describe('private asset photo HTTP integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, employee: any, other: any, itAdmin: any;
  let asset: any, assignment: any, photo: string;
  let version: number;
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
  const request = async (
    user: any,
    method = 'GET',
    body?: unknown,
    currentVersion?: number,
    overrides: Record<string, string> = {},
  ) => {
    const response = await fetch(`${base}/assets/${asset.id}/photo`, {
      method,
      headers: {
        Origin: configuration().origin,
        ...(user
          ? {
              Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
              'X-CSRF-Token': user.csrf,
            }
          : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(currentVersion === undefined ? {} : { 'If-Match': `"${currentVersion}"` }),
        ...overrides,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[]) => {
      const result = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Synthetic picture test',
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
    admin = await user(['SUPER_ADMIN']);
    employee = await user(['EMPLOYEE']);
    other = await user(['EMPLOYEE']);
    itAdmin = await user(['EMPLOYEE']);
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
    asset = await domain.createAsset(req(admin), {
      category: references.CATEGORY,
      assetType: references.ASSET_TYPE,
      description: `${tag} synthetic laptop`,
      ownershipType: references.OWNERSHIP,
      status: 'In Store',
      condition: references.CONDITION,
      riskLevel: references.RISK,
      amcApplies: false,
    });
    assignment = await domain.assign(req(admin, asset.version), asset.id, {
      userId: employee.id,
    });
    version = assignment.assetVersion;
    const bytes = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#2563eb' },
    })
      .withMetadata({ orientation: 1 })
      .jpeg()
      .toBuffer();
    assert.ok((await sharp(bytes).metadata()).exif);
    assert.ok(bytes.length <= 40 * 1024);
    photo = dataUrl(bytes);
  });

  after(async () => {
    if (app) await app.close();
  });

  it('uses current asset visibility for missing pictures and denies anonymous or unrelated reads', async () => {
    for (const user of [admin, employee]) {
      const result = await request(user);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { dataUrl: null, updatedAt: null });
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal((await request(other)).status, 404);
    assert.equal((await request(itAdmin)).status, 404); // other team's asset is hidden
    assert.equal((await request(null)).status, 401);
  });

  it('allows only Admin uploads with the existing Origin and CSRF protections', async () => {
    const input = { dataUrl: photo, reason: 'Synthetic picture approval' };
    assert.equal((await request(employee, 'PUT', input, version)).status, 403);
    assert.equal((await request(itAdmin, 'PUT', input, version)).status, 403);
    assert.equal(
      (await request(admin, 'PUT', input, version, { 'X-CSRF-Token': 'invalid' })).status,
      403,
    );
    assert.equal(
      (await request(admin, 'PUT', input, version, { Origin: 'https://untrusted.invalid' })).status,
      403,
    );
    assert.equal(
      (await db.query('SELECT asset_id FROM asset_photos WHERE asset_id=$1', [asset.id])).length,
      0,
    );
  });

  it('stores a bounded metadata-free JPEG and scopes IT access through the asset ticket policy', async () => {
    const result = await request(
      admin,
      'PUT',
      { dataUrl: photo, reason: 'Synthetic laptop picture approved' },
      version,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.assetVersion, version + 1);
    version = result.body.assetVersion;
    assert.equal(result.headers.get('ETag'), `"${version}"`);
    assert.match(result.body.dataUrl, /^data:image\/jpeg;base64,/);
    const output = Buffer.from(result.body.dataUrl.split(',')[1], 'base64');
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.ok(metadata.width! <= 640 && metadata.height! <= 480);
    assert.ok(output.length <= 80 * 1024);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.notEqual(result.body.dataUrl, photo);
    assert.equal((await request(employee)).body.dataUrl, result.body.dataUrl);
    assert.equal((await request(other)).status, 404);
    assert.equal((await request(itAdmin)).status, 404); // other team's asset is hidden
    await domain.createTicket(req(employee), {
      assetId: asset.id,
      subject: 'Synthetic picture test support',
      description: 'Synthetic test establishes IT technical access.',
      category: 'HARDWARE',
      priority: 'LOW',
    });
  });

  it('rejects unsafe formats, malformed base64, oversized input and decoded pixel bombs', async () => {
    const png = await sharp({
      create: { width: 12, height: 12, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const bomb = await sharp({
      create: { width: 2100, height: 2000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    assert.ok(bomb.length <= 40 * 1024);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    for (const invalid of [
      dataUrl(svg, 'svg+xml'),
      dataUrl(svg),
      dataUrl(png),
      dataUrl(bomb, 'png'),
      dataUrl(Buffer.alloc(40 * 1024 + 1)),
      'data:image/jpeg;base64,/w',
      'data:image/jpeg;base64,/x==',
      photo + '\n',
    ]) {
      const result = await request(
        admin,
        'PUT',
        { dataUrl: invalid, reason: 'Reject synthetic invalid picture' },
        version,
      );
      assert.equal(result.status, 422);
    }
    const [row] = await db.query('SELECT version FROM assets WHERE id=$1', [asset.id]);
    assert.equal(row.version, version);
  });

  it('requires the current asset version and reason, replaces atomically and redacts photo audit', async () => {
    assert.equal(
      (await request(admin, 'PUT', { dataUrl: photo, reason: 'Missing version' })).status,
      428,
    );
    assert.equal(
      (await request(admin, 'PUT', { dataUrl: photo, reason: 'Stale version' }, version - 1))
        .status,
      412,
    );
    assert.equal((await request(admin, 'PUT', { dataUrl: photo }, version)).status, 422);
    assert.equal(
      (await request(admin, 'PUT', { dataUrl: photo, reason: ' ' }, version)).status,
      422,
    );
    assert.equal(
      (
        await request(
          admin,
          'PUT',
          { dataUrl: photo, reason: 'Unknown field', filename: 'x' },
          version,
        )
      ).status,
      422,
    );
    const replacement = dataUrl(
      await sharp({ create: { width: 32, height: 24, channels: 3, background: '#15803d' } })
        .png()
        .toBuffer(),
      'png',
    );
    const before = await request(employee);
    const result = await request(
      admin,
      'PUT',
      { dataUrl: replacement, reason: 'Approved synthetic replacement' },
      version,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.assetVersion, version + 1);
    version = result.body.assetVersion;
    assert.notEqual(result.body.dataUrl, before.body.dataUrl);
    assert.equal((await request(employee)).body.dataUrl, result.body.dataUrl);
    const rows = await db.query('SELECT content,sha256 FROM asset_photos WHERE asset_id=$1', [
      asset.id,
    ]);
    assert.equal(rows.length, 1);
    const audits = await db.query(
      "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='ASSET_PHOTO_UPDATED' ORDER BY occurred_at",
      [asset.id],
    );
    assert.equal(audits.length, 2);
    for (const { changes } of audits) {
      assert.deepEqual(Object.keys(changes).sort(), ['byteSize', 'reason', 'sha256']);
      assert.match(changes.sha256, /^[a-f0-9]{64}$/);
      assert.ok(changes.byteSize > 0 && changes.byteSize <= 80 * 1024);
      assert.equal(JSON.stringify(changes).includes('data:image'), false);
    }
    assert.equal(audits[1].changes.sha256, rows[0].sha256);
  });

  it('re-checks custody after a concurrent return lock and denies the former employee', async () => {
    const client = await db.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE', [asset.id]);
      await client.query('UPDATE assignments SET ended_at=now(),ended_by=$2 WHERE id=$1', [
        assignment.id,
        admin.id,
      ]);
      await client.query("UPDATE assets SET status='In Store',version=version+1 WHERE id=$1", [
        asset.id,
      ]);
      const pending = request(employee);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const rows = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM assets WHERE id=$1 FOR SHARE'",
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'Photo read should wait for the custody transaction');
      await client.query('COMMIT');
      committed = true;
      assert.equal((await pending).status, 404);
      assert.equal((await request(employee)).status, 404);
      assert.equal((await request(admin)).status, 200);
      assert.equal((await request(itAdmin)).status, 404);
    } finally {
      if (!committed) await client.query('ROLLBACK');
      client.release();
    }
  });
});
