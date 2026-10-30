import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '../src/config';
import { Db } from '../src/db';
import { DataTransferService } from '../src/data-transfers';
import { DomainService } from '../src/domain';
import { reconcileAssetCounters } from '../src/domain-assets';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Team import integration tests require a database name ending _test');
const tag = `teamimport-${randomUUID()}`;
const request = (actor: any) =>
  ({ user: actor, get: () => undefined, res: { getHeader: () => '' } }) as unknown as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('team-scoped imports PostgreSQL integration', { skip: !connection }, () => {
  let db: Db, domain: DomainService, transfers: DataTransferService;
  let superAdmin: any, itLead: any;
  const asset = {
    category: 'Import Team Category',
    assetType: 'Import Team Type',
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
  };
  const make = async (roles: string[]) => {
    const token = randomBytes(32).toString('hex');
    const user: any = {
      id: randomUUID(),
      email: `${tag}-${randomUUID()}@example.org`,
      displayName: 'Synthetic team import user',
      roles,
      teams: [],
      state: 'ACTIVE',
      version: 1,
      portalAcceptedAt: new Date().toISOString(),
      emailVerifiedAt: new Date().toISOString(),
      mfaEnrolled: true,
      mfaVerifiedAt: new Date().toISOString(),
      sessionScope: 'APP',
      sessionHash: hash(token),
    };
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [user.id, user.email, user.displayName],
    );
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    await db.query(
      "INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,'synthetic',now()+interval '1 hour',now())",
      [user.sessionHash, user.id],
    );
    return user;
  };

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    domain = new DomainService(db);
    transfers = new DataTransferService(db, domain, {} as any);
    for (const [kind, code] of [
      ['CATEGORY', asset.category],
      ['ASSET_TYPE', asset.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    superAdmin = await make(['SUPER_ADMIN']);
    itLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', IT_TEAM_ID);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('IT lead bulk import with an ADM row fails validation on that row with code TEAM_NOT_PERMITTED', async () => {
    const batch: any = await transfers.preview(request(itLead), {
      module: 'assets',
      filename: 'team-rows.csv',
      sha256: 'b'.repeat(64),
      reason: 'Synthetic team-scoped import',
      rows: [
        { action: 'CREATE', owningTeamCode: 'IT', description: `${tag} IT row`, ...asset },
        { action: 'CREATE', owningTeamCode: 'ADM', description: `${tag} ADM row`, ...asset },
      ],
    });
    assert.equal(batch.rows[0].valid, true, JSON.stringify(batch.rows[0].errors));
    assert.equal(batch.rows[1].valid, false);
    assert.match(batch.rows[1].errors.join(' '), /TEAM_NOT_PERMITTED/);
  });
  it('register row IAC-ADM-nnnnnn promotes into the ADM team', async () => {
    const code = `IAC-ADM-${String(900000 + Math.floor(Math.random() * 99999)).padStart(6, '0')}`;
    const result = await db.tx((c) => domain.normalizeImport({ 'Asset ID': code }, {}, c));
    assert.equal(result.assetCode, code);
    assert.equal(result.data.owningTeamId, ADM_TEAM_ID);
    assert.equal(
      result.issues.some((i: any) => ['INVALID_ASSET_ID', 'UNKNOWN_TEAM_PREFIX'].includes(i.code)),
      false,
    );
  });
  it('code counters reconcile with 4-5 letter prefixes and jump past imported codes', async () => {
    await db.tx(async (c) => {
      const prefix =
        'Q' + Array.from(randomBytes(4), (b) => String.fromCharCode(65 + (b % 26))).join('');
      const [team] = (
        await c.query(
          'INSERT INTO teams(code,name,asset_code_prefix) VALUES($1,$2,$1) RETURNING id',
          [prefix, `${tag} ${prefix}`],
        )
      ).rows;
      await c.query('INSERT INTO team_asset_counters(team_id,next_value) VALUES($1,1)', [team.id]);
      await c.query(
        "INSERT INTO assets(asset_code,owning_team_id,category,asset_type,description,ownership_type,status,condition,risk_level) VALUES($1,$2,$3,$4,'Imported','Owned','In Store','Good','Medium')",
        [`IAC-${prefix}-000777`, team.id, asset.category, asset.assetType],
      );
      await reconcileAssetCounters(db, c as any);
      const [counter] = (
        await c.query('SELECT next_value FROM team_asset_counters WHERE team_id=$1', [team.id])
      ).rows;
      assert.equal(Number(counter.next_value), 778);
    });
  });
  it('unknown prefix row is quarantined with UNKNOWN_TEAM_PREFIX', async () => {
    const result = await db.tx((c) =>
      domain.normalizeImport({ 'Asset ID': 'IAC-ZZQ-000001' }, {}, c),
    );
    assert.ok(result.issues.some((i: any) => i.code === 'UNKNOWN_TEAM_PREFIX'));
  });
  it('register review (which approves pending Finance metadata) is refused to a team lead', async () => {
    await assert.rejects(domain.reviewImport(request(itLead), randomUUID(), {}), status(403));
    assert.ok(superAdmin);
  });
});
