import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { TransferService } from '../src/transfers';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, PRJ_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Team transfer tests require a database name ending _test');
const tag = `team-transfers-${randomUUID()}`;
const request = (actor: any) =>
  ({
    user: actor,
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('team transfers PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, transfers: TransferService;
  let itMember: any, admMember: any, prjMember: any, superAdmin: any;
  const input = {
    category: 'Transfer Category',
    assetType: 'Transfer Type',
    description: tag,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
    amcApplies: false,
  };
  const make = async (roles: string[]) => {
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic transfer test',
      roles,
      teams: [],
      state: 'ACTIVE',
      version: 1,
      portalAcceptedAt: new Date().toISOString(),
      emailVerifiedAt: new Date().toISOString(),
      mfaEnrolled: true,
      mfaVerifiedAt: new Date().toISOString(),
      sessionScope: 'APP',
      sessionHash: 'test-only',
    };
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [user.id, user.email, user.displayName],
    );
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    return user;
  };
  const newAsset = async (patch: Record<string, unknown> = {}) =>
    domain.createAsset(request(itMember), {
      ...input,
      description: `${tag} ${randomUUID()}`,
      owningTeamId: IT_TEAM_ID,
      ...patch,
    });
  const owner = async (assetId: string) =>
    (await db.query('SELECT owning_team_id FROM assets WHERE id=$1', [assetId]))[0].owning_team_id;
  const addTicket = async (assetId: string, ownerId: string) =>
    (
      await db.query(
        `INSERT INTO tickets(reporter_id,asset_id,subject,description,category,priority,team_id)
         VALUES($1,$2,'Synthetic','Synthetic','HARDWARE','LOW',$3) RETURNING id`,
        [ownerId, assetId, IT_TEAM_ID],
      )
    )[0].id as string;

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    transfers = new TransferService(db);
    for (const [kind, code] of [
      ['CATEGORY', input.category],
      ['ASSET_TYPE', input.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    admMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', ADM_TEAM_ID);
    prjMember = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', PRJ_TEAM_ID);
    superAdmin = await make(['SUPER_ADMIN']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('owning team requests, receiving team accepts: owner changes and open tickets reroute', async () => {
    const asset = await newAsset();
    const ticketId = await addTicket(asset.id, itMember.id);
    const t = await transfers.request(request(itMember), asset.id, {
      toTeamId: ADM_TEAM_ID,
      reason: 'Moving to admin',
    });
    assert.equal(t.state, 'REQUESTED');
    assert.equal(await owner(asset.id), IT_TEAM_ID);

    const done = await transfers.accept(request(admMember), t.id, { note: 'ok' });
    assert.equal(done.state, 'ACCEPTED');
    assert.equal(await owner(asset.id), ADM_TEAM_ID);
    const [ticket] = await db.query('SELECT team_id FROM tickets WHERE id=$1', [ticketId]);
    assert.equal(ticket.team_id, ADM_TEAM_ID);
    const audits = await db.query(
      "SELECT action FROM audit_events WHERE entity_id=$1 AND action IN ('ASSET_TRANSFER_REQUESTED','ASSET_TRANSFER_ACCEPTED')",
      [asset.id],
    );
    assert.equal(audits.length, 2);
    const incoming = await transfers.list(request(admMember), { direction: 'incoming' });
    assert.ok(incoming.items.some((x: any) => x.id === t.id));
    const outgoing = await transfers.list(request(itMember), { direction: 'outgoing' });
    assert.ok(outgoing.items.some((x: any) => x.id === t.id));
    await assert.rejects(transfers.accept(request(admMember), t.id, {}), status(409));
  });

  it('rejects accept by a team that is not the receiver', async () => {
    const asset = await newAsset();
    const t = await transfers.request(request(itMember), asset.id, {
      toTeamId: ADM_TEAM_ID,
      reason: 'Move',
    });
    await assert.rejects(transfers.accept(request(prjMember), t.id, {}), status(403));
    await assert.rejects(transfers.accept(request(itMember), t.id, {}), status(403));
    await assert.rejects(
      transfers.request(request(admMember), asset.id, { toTeamId: PRJ_TEAM_ID, reason: 'x' }),
      status(403),
    );
    assert.equal(await owner(asset.id), IT_TEAM_ID);
  });

  it('rejects a second open request with 409', async () => {
    const asset = await newAsset();
    await transfers.request(request(itMember), asset.id, { toTeamId: ADM_TEAM_ID, reason: 'a' });
    await assert.rejects(
      transfers.request(request(itMember), asset.id, { toTeamId: PRJ_TEAM_ID, reason: 'b' }),
      status(409),
    );
  });

  it('decline leaves the owner unchanged; cancel by requester closes the request', async () => {
    const asset = await newAsset();
    const t = await transfers.request(request(itMember), asset.id, {
      toTeamId: ADM_TEAM_ID,
      reason: 'a',
    });
    await assert.rejects(transfers.decline(request(admMember), t.id, {}), status(422));
    const declined = await transfers.decline(request(admMember), t.id, { note: 'no room' });
    assert.equal(declined.state, 'DECLINED');
    assert.equal(declined.decisionNote, 'no room');
    assert.equal(await owner(asset.id), IT_TEAM_ID);

    const t2 = await transfers.request(request(itMember), asset.id, {
      toTeamId: PRJ_TEAM_ID,
      reason: 'b',
    });
    await assert.rejects(transfers.cancel(request(admMember), t2.id, {}), status(403));
    const cancelled = await transfers.cancel(request(itMember), t2.id, {});
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(await owner(asset.id), IT_TEAM_ID);
  });

  it('super admin can force a transfer; others cannot', async () => {
    const asset = await newAsset();
    await assert.rejects(
      transfers.force(request(itMember), asset.id, { toTeamId: ADM_TEAM_ID, reason: 'x' }),
      status(403),
    );
    const pending = await transfers.request(request(itMember), asset.id, {
      toTeamId: PRJ_TEAM_ID,
      reason: 'pending',
    });
    const forced = await transfers.force(request(superAdmin), asset.id, {
      toTeamId: ADM_TEAM_ID,
      reason: 'Admin decision',
    });
    assert.equal(forced.state, 'FORCED');
    assert.equal(await owner(asset.id), ADM_TEAM_ID);
    const [old] = await db.query('SELECT state FROM asset_team_transfers WHERE id=$1', [pending.id]);
    assert.equal(old.state, 'CANCELLED');
    const all = await transfers.list(request(superAdmin), { state: 'FORCED' });
    assert.ok(all.items.some((x: any) => x.id === forced.id));
  });

  it('rejects same-team and retired-asset transfers with 422', async () => {
    const asset = await newAsset();
    await assert.rejects(
      transfers.request(request(itMember), asset.id, { toTeamId: IT_TEAM_ID, reason: 'same' }),
      status(422),
    );
    await db.query("UPDATE assets SET status='Retired',disposal_date=current_date,disposal_reference='synthetic' WHERE id=$1", [asset.id]);
    await assert.rejects(
      transfers.request(request(itMember), asset.id, { toTeamId: ADM_TEAM_ID, reason: 'gone' }),
      status(422),
    );
  });
});
