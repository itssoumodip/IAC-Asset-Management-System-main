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

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Ticket photos integration requires a database name ending _test');
const tag = `ticketphotos-${randomUUID()}`;

describe('ticket photos integration', { skip: !connection, concurrency: false }, () => {
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
    admin = await user(['ADMIN'], `${tag} Admin`);
    holder = await user(['EMPLOYEE'], `${tag} Holder Person`);
    other = await user(['EMPLOYEE'], `${tag} Other Person`);
    itAdmin = await user(['IT_ADMIN'], `${tag} IT Person`);
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

  const jpeg = async (seed: number, withExif = false) => {
    const width = 500;
    const raw = Buffer.alloc(width * width * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + seed * 31 + ((i * i) % 251)) & 255;
    let image = sharp(raw, { raw: { width, height: width, channels: 3 } });
    if (withExif) image = image.withExif({ IFD0: { Copyright: 'synthetic-exif' } });
    const bytes = await image.jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  };
  const post = async (user: any, body: unknown, key: string = randomUUID(), raw?: string) => {
    const response = await fetch(`${base}/tickets`, {
      method: 'POST',
      headers: { ...headers(user), 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: raw ?? JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const ticketBody = (assetId: string, extra: Record<string, unknown> = {}) => ({
    assetId,
    subject: `${tag} subject`,
    description: `${tag} description`,
    category: 'HARDWARE',
    priority: 'MEDIUM',
    ...extra,
  });
  const ticketCount = async () =>
    (
      await db.query('SELECT count(*)::int AS n FROM tickets WHERE subject=$1', [`${tag} subject`])
    )[0].n;
  const photoRows = async () =>
    (
      await db.query(
        'SELECT count(*)::int AS n FROM ticket_photos p JOIN tickets t ON t.id=p.ticket_id WHERE t.subject=$1',
        [`${tag} subject`],
      )
    )[0].n;

  it('non-holder can report on an active asset', async () => {
    const result = await post(other, ticketBody(asset.id));
    assert.equal(result.status, 201);
    const [row] = await db.query('SELECT assignment_at_creation_id FROM tickets WHERE id=$1', [
      result.body.id,
    ]);
    assert.equal(row.assignment_at_creation_id, null);
    assert.equal(result.body.photoCount, 0);
  });

  it('holder report records assignment', async () => {
    const result = await post(holder, ticketBody(asset.id));
    assert.equal(result.status, 201);
    const [current] = await db.query(
      'SELECT id FROM assignments WHERE asset_id=$1 AND user_id=$2 AND ended_at IS NULL',
      [asset.id, holder.id],
    );
    const [row] = await db.query('SELECT assignment_at_creation_id FROM tickets WHERE id=$1', [
      result.body.id,
    ]);
    assert.equal(row.assignment_at_creation_id, current.id);
  });

  it('non-reportable asset rejected', async () => {
    for (const a of [disposed, lost]) {
      const result = await post(other, ticketBody(a.id));
      assert.equal(result.status, 422);
      assert.match(result.body.error.message, /not in service/);
    }
  });

  it('ticket with 3 photos', async () => {
    const photos = [await jpeg(1, true), await jpeg(2), await jpeg(3)];
    for (const p of photos) assert.ok(p.length > 100 * 1024);
    const result = await post(other, ticketBody(asset.id, { photos }));
    assert.equal(result.status, 201);
    assert.equal(result.body.photoCount, 3);
    for (const n of [1, 2, 3]) {
      const photo = await get(other, `/tickets/${result.body.id}/photos/${n}`);
      assert.equal(photo.status, 200);
      assert.match(photo.body.dataUrl, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(photo.body.dataUrl.split(',')[1], 'base64');
      const meta = await sharp(bytes).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.equal(meta.exif, undefined);
    }
    assert.equal((await get(other, `/tickets/${result.body.id}/photos/4`)).status, 404);
    const shown = await get(other, `/tickets/${result.body.id}`);
    assert.equal(shown.body.photoCount, 3);
  });

  it('4 photos rejected', async () => {
    const before = await ticketCount();
    const photos = [await jpeg(1), await jpeg(2), await jpeg(3), await jpeg(4)];
    const result = await post(other, ticketBody(asset.id, { photos }));
    assert.equal(result.status, 422);
    assert.equal(await ticketCount(), before);
  });

  it('one bad photo rejects whole ticket', async () => {
    const before = [await ticketCount(), await photoRows()];
    const fake = `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`;
    const result = await post(
      other,
      ticketBody(asset.id, { photos: [await jpeg(1), await jpeg(2), fake] }),
    );
    assert.equal(result.status, 422);
    assert.deepEqual([await ticketCount(), await photoRows()], before);
  });

  it('same idempotency key with photos returns the first ticket', async () => {
    const key = randomUUID();
    const body = ticketBody(asset.id, { subject: `${tag} idem`, photos: [await jpeg(5)] });
    const first = await post(other, body, key);
    const second = await post(other, body, key);
    assert.equal(first.status, 201);
    assert.equal(second.body.id, first.body.id);
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM tickets WHERE subject=$1', [
      `${tag} idem`,
    ]);
    assert.equal(n, 1);
    const [{ photos: stored }] = await db.query(
      'SELECT count(*)::int AS photos FROM ticket_photos WHERE ticket_id=$1',
      [first.body.id],
    );
    assert.equal(stored, 1);
  });

  it('photo access follows ticketScope', async () => {
    const created = await post(other, ticketBody(asset.id, { photos: [await jpeg(6)] }));
    const path = `/tickets/${created.body.id}/photos/1`;
    const ok = await fetch(`${base}${path}`, { headers: headers(other) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'private, no-store');
    assert.equal((await get(admin, path)).status, 200);
    assert.equal((await get(itAdmin, path)).status, 200);
    assert.equal((await get(holder, path)).status, 404);
    assert.equal((await get(other, `/tickets/${created.body.id}/photos/2`)).status, 404);
  });

  it('invoice JSON budget reports its actual limit and does not trust a cookie-name substring', async () => {
    const path = `${base}/finance/assets/${asset.id}/invoices`;
    const oversized = await fetch(path, {
      method: 'POST',
      headers: { ...headers(admin), 'Content-Type': 'application/json', 'If-Match': '"1"' },
      body: JSON.stringify({ pad: 'y'.repeat(6 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      (await oversized.json()).error.message,
      'Request exceeds the 6 MB JSON upload limit',
    );
    const misleading = await fetch(path, {
      method: 'POST',
      headers: {
        Origin: configuration().origin,
        Cookie: `other_${configuration().sessionCookie}=not-a-session`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pad: 'y'.repeat(100000) }),
    });
    assert.equal(misleading.status, 413);
    assert.equal((await misleading.json()).error.message, 'Request exceeds the 64 KB limit');
    const within = await fetch(path, {
      method: 'POST',
      headers: { ...headers(admin), 'Content-Type': 'application/json', 'If-Match': '"1"' },
      body: JSON.stringify({ pad: 'y'.repeat(5_700_000) }),
    });
    assert.equal(within.status, 422);
  });

  it('body limit', async () => {
    const big = JSON.stringify(
      ticketBody(asset.id, { description: 'x'.repeat(10), pad: 'y'.repeat(1_400_000) }),
    );
    const accepted = await post(other, null, randomUUID(), big);
    assert.equal(accepted.status, 422);
    assert.notEqual(accepted.status, 413);
    const tooBig = await post(
      other,
      null,
      randomUUID(),
      JSON.stringify({ pad: 'y'.repeat(1_600_000) }),
    );
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.body.error.message, /1\.5 MB/);
    const anonymous = await fetch(`${base}/tickets`, {
      method: 'POST',
      headers: { Origin: configuration().origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'y'.repeat(100_000) }),
    });
    assert.equal(anonymous.status, 413);
    assert.equal((await anonymous.json()).error.message, 'Request exceeds the 64 KB limit');
    const reordered = await fetch(`${base}/tickets`, {
      method: 'POST',
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().csrfCookie}=${other.csrf}; ${configuration().sessionCookie}=${other.session}`,
        'X-CSRF-Token': other.csrf,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ pad: 'y'.repeat(150_000) }),
    });
    assert.equal(reordered.status, 422);
    const response = await fetch(`${base}/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { ...headers(admin), 'Content-Type': 'application/json', 'If-Match': '"1"' },
      body: JSON.stringify({ reason: 'z'.repeat(70_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.message, 'Request exceeds the 64 KB limit');
  });
});
