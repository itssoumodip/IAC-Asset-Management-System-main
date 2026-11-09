import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { configuration, hash, signedCsrf, token } from '../src/config';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Inventory integration requires a database name ending _test');
const tag = `inv-${randomUUID()}`;

describe('inventory HTTP integration', { skip: !connection, concurrency: false }, () => {
  let app: INestApplication, db: Db, base: string, domain: DomainService;
  let admin: any, itLead: any, admMember: any, itMember: any;
  let parentLoc: string, childLoc: string;
  const refs = {
    CATEGORY: `${tag} cat`,
    CATEGORY2: `${tag} other`,
    ASSET_TYPE: `${tag} type`,
    ASSET_TYPE2: `${tag} type2`,
    OWNERSHIP: `${tag} ownership`,
    CONDITION: `${tag} condition`,
    RISK: `${tag} risk`,
  };
  const req = (user: any) =>
    ({
      user,
      get: (n: string) => (n.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
    }) as AuthRequest;
  const call = async (user: any, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: configuration().origin,
        Cookie: `${configuration().sessionCookie}=${user.session}; ${configuration().csrfCookie}=${user.csrf}`,
        'X-CSRF-Token': user.csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const list = (user: any, qs = '') =>
    call(user, 'GET', `/inventory?category=${encodeURIComponent(refs.CATEGORY)}${qs}`);
  const row = (res: any, type = refs.ASSET_TYPE, team = IT_TEAM_ID) =>
    res.body.items.find((i: any) => i.asset_type === type && i.owning_team_id === team);
  // Create in store, then set the target status directly: custody and some statuses
  // can only be reached through their own workflows, which these counts don't need.
  const make = async (type: string, teamId: string, status: string, category = refs.CATEGORY) => {
    const asset = await domain.createAsset(req(admin), {
      category,
      assetType: type,
      description: `${tag} item`,
      ownershipType: refs.OWNERSHIP,
      status: 'In Store',
      condition: refs.CONDITION,
      riskLevel: refs.RISK,
      amcApplies: false,
      owningTeamId: teamId,
    });
    if (status !== 'In Store')
      await db.query('UPDATE assets SET status=$2 WHERE id=$1', [asset.id, status]);
    return asset;
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    db = app.get(Db);
    domain = app.get(DomainService);
    const user = async (roles: string[]) => {
      const u = {
        id: randomUUID(),
        email: `${tag}-${randomUUID()}@example.org`,
        displayName: 'Inventory test',
        roles,
        csrf: signedCsrf(),
        session: token(),
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),$4,now())`,
        [u.id, u.email, u.displayName, configuration().noticeVersion],
      );
      for (const role of roles)
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, role]);
      await db.query(
        `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now())`,
        [hash(u.session), u.id, hash(u.csrf)],
      );
      return u;
    };
    admin = await user(['SUPER_ADMIN']);
    itLead = await joinTeam(db, await user(['EMPLOYEE']), 'LEAD', IT_TEAM_ID);
    itMember = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    admMember = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', ADM_TEAM_ID);
    for (const [kind, code] of Object.entries(refs)) {
      const k = kind.startsWith('CATEGORY')
        ? 'CATEGORY'
        : kind.startsWith('ASSET_TYPE')
          ? 'ASSET_TYPE'
          : kind;
      await db.query('INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2)', [k, code]);
    }
    const parent = await db.query(
      "INSERT INTO locations(code,site,level) VALUES($1,'Synthetic parent','BUILDING') RETURNING id",
      [`${tag}-p`],
    );
    parentLoc = parent[0].id;
    const child = await db.query(
      "INSERT INTO locations(code,site,level) VALUES($1,'Synthetic child','FLOOR') RETURNING id",
      [`${tag}-c`],
    );
    childLoc = child[0].id;
    await db.query('UPDATE locations SET parent_id=$1 WHERE id=$2', [parentLoc, childLoc]);

    // IT type A: 1 In Store + 1 Ready + 1 Assigned. IT type B: only Assigned (out of stock).
    const a1 = await make(refs.ASSET_TYPE, IT_TEAM_ID, 'In Store');
    await make(refs.ASSET_TYPE, IT_TEAM_ID, 'Ready to Assign');
    await make(refs.ASSET_TYPE, IT_TEAM_ID, 'Assigned');
    await make(refs.ASSET_TYPE2, IT_TEAM_ID, 'Assigned');
    await make(refs.ASSET_TYPE, ADM_TEAM_ID, 'In Store');
    await make(refs.ASSET_TYPE, IT_TEAM_ID, 'In Store', refs.CATEGORY2);
    await db.query('UPDATE assets SET location_id=$1 WHERE id=$2', [childLoc, a1.id]);
  });

  after(async () => {
    if (app) await app.close();
  });

  it('computes counts and out-of-stock status, and supports status views', async () => {
    const res = await list(admin, `&owningTeamId=${IT_TEAM_ID}`);
    assert.equal(res.status, 200);
    assert.equal(row(res).in_store_count, 1);
    assert.equal(row(res).stock_status, 'In Stock');
    assert.equal(row(res, refs.ASSET_TYPE2).stock_status, 'Out of stock');
    const out = await list(admin, `&owningTeamId=${IT_TEAM_ID}&status=out`);
    assert.deepEqual(
      out.body.items.map((i: any) => i.asset_type),
      [refs.ASSET_TYPE2],
    );
    assert.equal(out.body.summary.out, 1);
  });

  it('filters by q, category, team and location (including children)', async () => {
    const q = (v: string) => call(admin, 'GET', `/inventory?q=${encodeURIComponent(v)}`);
    assert.equal((await q(refs.CATEGORY2)).body.items.length, 1);
    assert.equal((await q(refs.ASSET_TYPE2)).body.items.length, 1);
    const both = await list(admin);
    assert.ok(row(both, refs.ASSET_TYPE, ADM_TEAM_ID));
    assert.ok(!both.body.items.some((i: any) => i.category === refs.CATEGORY2));
    const loc = await list(admin, `&locationId=${parentLoc}`);
    assert.equal(loc.body.items.length, 1);
    assert.equal(row(loc).total_count, 1);
    assert.equal((await list(admin, `&locationId=${childLoc}`)).body.items.length, 1);
    assert.equal((await list(admin, '&locationId=not-a-uuid')).status, 422);
    assert.equal((await list(admin, '&bogus=1')).status, 422);
  });

  it('scopes team members to their own teams unless they ask for all', async () => {
    const own = await list(itMember);
    assert.equal(own.body.scope, 'own');
    assert.ok(row(own));
    assert.ok(!row(own, refs.ASSET_TYPE, ADM_TEAM_ID));
    const all = await list(itMember, '&allTeams=true');
    assert.equal(all.body.scope, 'all');
    assert.ok(row(all, refs.ASSET_TYPE, ADM_TEAM_ID));
    assert.equal((await list(admin)).body.scope, 'all');
  });

  it('only lets users who manage the team (or super admin) set min stock', async () => {
    const body = {
      category: refs.CATEGORY,
      assetType: refs.ASSET_TYPE,
      owningTeamId: IT_TEAM_ID,
      minInStore: 5,
    };
    assert.equal((await call(admMember, 'PUT', '/inventory/min-stock', body)).status, 403);
    assert.equal((await call(itLead, 'PUT', '/inventory/min-stock', body)).status, 200);
    assert.equal(
      (await call(admin, 'PUT', '/inventory/min-stock', { ...body, minInStore: 4 })).status,
      200,
    );
    assert.equal(
      (await call(itLead, 'PUT', '/inventory/min-stock', { ...body, owningTeamId: null })).status,
      403,
    );
    assert.equal(
      (await call(admin, 'PUT', '/inventory/min-stock', { ...body, minInStore: -1 })).status,
      422,
    );
    const audit = await db.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='INVENTORY_MIN_STOCK_SET' AND actor_id=ANY($1)",
      [[itLead.id, admin.id]],
    );
    assert.equal(audit[0].n, 2);
  });

  it('flags low stock when in-store plus ready is below the minimum', async () => {
    const res = await list(admin, `&owningTeamId=${IT_TEAM_ID}`);
    assert.equal(row(res).min_in_store, 4);
    assert.equal(row(res).stock_status, 'Low stock');
    assert.equal(res.body.summary.low, 1);
    const low = await list(admin, `&owningTeamId=${IT_TEAM_ID}&status=low`);
    assert.deepEqual(
      low.body.items.map((i: any) => i.asset_type),
      [refs.ASSET_TYPE],
    );
    await call(admin, 'PUT', '/inventory/min-stock', {
      category: refs.CATEGORY,
      assetType: refs.ASSET_TYPE,
      owningTeamId: IT_TEAM_ID,
      minInStore: 2,
    });
    assert.equal(row(await list(admin, `&owningTeamId=${IT_TEAM_ID}`)).stock_status, 'In Stock');
  });
});
