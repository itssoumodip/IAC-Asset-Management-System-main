import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Team finance edit tests require a database ending _test');
const tag = `tfe-${randomUUID().slice(0, 8)}`;
const request = (actor: any, version?: number) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match' ? (version === undefined ? undefined : `"${version}"`)
        : name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined,
  }) as AuthRequest;

describe('team members edit finance fields of their own team only', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService;
  let itMember: any, admMember: any, finance: any;
  let itAsset: any;
  before(async () => {
    db = new Db();
    domain = new DomainService(db);
    const mk = async (roles: string[]) => {
      const id = randomUUID();
      await db.query("INSERT INTO users(id,email,display_name,state) VALUES($1,$2,$3,'ACTIVE')", [id, `${tag}-${id}@example.org`, tag]);
      for (const r of roles) await db.query('INSERT INTO user_roles(user_id, role_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, r]);
      return { id, roles, teams: [] as any[] } as any;
    };
    itMember = await joinTeam(db, await mk(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
    admMember = await joinTeam(db, await mk(['EMPLOYEE']), 'MEMBER', ADM_TEAM_ID);
    finance = await mk(['FINANCE', 'EMPLOYEE']);
    // An IT team member creates it with a purchase cost (the create path checks the same rule).
    const created = await domain.createAsset(request(itMember), {
      category: 'IT Hardware', assetType: 'Laptop', description: `${tag} laptop`, ownershipType: 'Owned',
      status: 'In Store', condition: 'Good', riskLevel: 'Low', owningTeamId: IT_TEAM_ID,
      amcApplies: false, purchaseCost: '1000',
    } as any);
    itAsset = created;
  });
  // Field permissions may switch purchase cost off for team roles; this test allows it and puts
  // the saved settings back afterwards.
  let savedRules: any[] = [];
  before(async () => {
    savedRules = await db.query(
      "SELECT role_code, field_name, can_view, can_edit FROM role_field_permissions WHERE role_code IN ('EMPLOYEE','TEAM_MEMBER') AND field_name='purchaseCost'",
    );
    await db.query(
      `INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit) VALUES('TEAM_MEMBER','purchaseCost',true,true)
       ON CONFLICT (role_code, field_name) DO UPDATE SET can_view=true, can_edit=true`,
    );
  });
  after(async () => {
    await db.query("DELETE FROM role_field_permissions WHERE role_code='TEAM_MEMBER' AND field_name='purchaseCost'");
    for (const r of savedRules)
      await db.query(
        'INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit) VALUES($1,$2,$3,$4) ON CONFLICT (role_code, field_name) DO UPDATE SET can_view=EXCLUDED.can_view, can_edit=EXCLUDED.can_edit',
        [r.role_code, r.field_name, r.can_view, r.can_edit],
      );
    await db?.onModuleDestroy();
  });

  it('lets an IT team member change the purchase cost and supplier of an IT asset', async () => {
    const fresh = await domain.asset(request(itMember), itAsset.id);
    const updated = await domain.editAsset(request(itMember, fresh.version), itAsset.id, {
      purchaseCost: '1234', supplier: 'Test supplier', reason: 'Corrected from invoice',
    });
    assert.equal(Number(updated.purchaseCost), 1234);
    assert.equal(updated.supplier, 'Test supplier');
  });

  it('refuses a member of another team, and keeps finance approval with Finance', async () => {
    const fresh = await domain.asset(request(finance), itAsset.id);
    const statusOf = (p: Promise<unknown>) => p.then(() => 'saved', (e: any) => e.status ?? e.message);
    assert.equal(
      await statusOf(domain.editAsset(request(admMember, fresh.version), itAsset.id, { purchaseCost: '1', reason: 'x' })),
      403,
    );
    // The edit form has no finance-approval field, so this is refused as invalid input.
    assert.equal(
      await statusOf(domain.editAsset(request(itMember, fresh.version), itAsset.id, { financePending: true, reason: 'x' } as any)),
      422,
    );
    // Still 1234: nothing above changed it.
    assert.equal(Number((await domain.asset(request(finance), itAsset.id)).purchaseCost), 1234);
  });
});
