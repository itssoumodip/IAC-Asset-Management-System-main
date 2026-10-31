import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { CategoryService } from '../src/categories';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID as ADM, IT_TEAM_ID as IT, PRJ_TEAM_ID as PRJ, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Category integration requires a database ending _test');
const tag = `category-${randomUUID()}`;
const request = (user: any, version?: number) =>
  ({
    user,
    get: (name: string) =>
      name.toLowerCase() === 'if-match' && version !== undefined
        ? `"${version}"`
        : name.toLowerCase() === 'idempotency-key'
          ? randomUUID()
          : undefined,
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};

describe('category ownership PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, domain: DomainService, categories: CategoryService;
  let admin: any, itMember: any, admMember: any, projectMember: any, itLead: any, admLead: any;
  let locationId: string, projectId: string;
  const user = async (roles: string[]) => {
    const id = randomUUID();
    const actor = { id, email: `${tag}-${id}@example.org`, displayName: tag, roles, teams: [] };
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [id, actor.email, actor.displayName],
    );
    for (const role of roles) await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
    return actor;
  };

  before(async () => {
    db = new Db();
    domain = new DomainService(db);
    categories = new CategoryService(db);
    admin = await user(['SUPER_ADMIN']);
    itMember = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', IT);
    itLead = await joinTeam(db, await user(['EMPLOYEE']), 'LEAD', IT);
    admMember = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', ADM);
    admLead = await joinTeam(db, await user(['EMPLOYEE']), 'LEAD', ADM);
    projectMember = await joinTeam(db, await user(['EMPLOYEE']), 'MEMBER', PRJ);
    [{ id: locationId }] = await db.query(
      'INSERT INTO locations(code,site,floor,room) VALUES($1,$2,$3,$4) RETURNING id',
      [`${tag}-location`, tag, '1', '1'],
    );
    [{ id: projectId }] = await db.query(
      'INSERT INTO projects(code,name,start_date) VALUES($1,$2,current_date) RETURNING id',
      [`CAT${randomUUID().slice(0, 8).toUpperCase()}`, `${tag} project`],
    );
  });
  after(async () => db?.onModuleDestroy());

  it('rejects IT members using Furniture and rejects Laptop under Furniture', async () => {
    await assert.rejects(
      domain.createAsset(request(itMember), {
        category: 'Furniture',
        assetType: 'Chair',
        description: tag,
        ownershipType: 'Owned',
        status: 'In Store',
        owningTeamId: IT,
        locationId,
        condition: 'Good',
        riskLevel: 'Medium',
        amcApplies: false,
      }),
      (error: any) => {
        const status = error.status ?? error.getStatus?.();
        const response = error.response ?? error.getResponse?.();
        return Boolean(status === 422 && response?.fields?.fieldErrors?.category);
      },
    );
    await assert.rejects(
      domain.createAsset(request(admMember), {
        category: 'Furniture',
        assetType: 'Laptop',
        description: tag,
        ownershipType: 'Owned',
        status: 'In Store',
        condition: 'Good',
        riskLevel: 'Medium',
        amcApplies: false,
        owningTeamId: ADM,
        locationId,
      }),
      (error: any) => {
        const status = error.status ?? error.getStatus?.();
        const response = error.response ?? error.getResponse?.();
        return Boolean(status === 422 && response?.fields?.fieldErrors?.assetType);
      },
    );
  });

  it('allows Admin and Projects members to create Furniture chairs', async () => {
    const chair = await domain.createAsset(request(admMember), {
      category: 'Furniture',
      assetType: 'Chair',
      description: `${tag} chair`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      owningTeamId: ADM,
      locationId,
      projectId,
    });
    assert.equal(chair.category, 'Furniture');
    const projectChair = await domain.createAsset(request(projectMember), {
      category: 'Furniture',
      assetType: 'Chair',
      description: `${tag} project chair`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      owningTeamId: PRJ,
      locationId,
      projectId,
    });
    const ticket = await domain.createTicket(request(projectMember), {
      assetId: projectChair.id,
      subject: `${tag} chair issue`,
      description: 'Synthetic issue',
      category: 'OTHER',
      priority: 'MEDIUM',
    });
    assert.equal(ticket.teamId, ADM);
    assert.ok(chair.id);
  });

  it('returns category policies and allows an owning Team Lead to add a subcategory', async () => {
    const refs: any = await domain.references();
    assert.ok(refs.categoryPolicies.some((row: any) => row.categoryCode === 'Furniture' && row.teamIds.includes(ADM)));
    const code = `${tag}-Chair`;
    const created = await categories.addSubcategory(request(itLead), 'IT Hardware', {
      code,
      label: `${tag} device`,
      requiresCustodian: false,
      reason: 'Synthetic category test',
    });
    assert.equal(created.categoryCode, 'IT Hardware');
    await assert.rejects(
      categories.addSubcategory(request(itLead), 'Furniture', {
        code: `${tag}-bad`,
        label: 'Bad',
        requiresCustodian: false,
        reason: 'Synthetic category test',
      }),
      status(403),
    );
  });

  it('requires and audits a Super Admin category override', async () => {
    const body = {
      category: 'IT Hardware',
      assetType: 'Laptop',
      description: `${tag} override`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      owningTeamId: ADM,
      locationId,
    };
    await assert.rejects(domain.createAsset(request(admin), body), status(422));
    const created = await domain.createAsset(request(admin), {
      ...body,
      overrideReason: 'Temporary cross-team custody during migration',
    });
    const [audit] = await db.query(
      "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='ASSET_CATEGORY_OVERRIDE' ORDER BY occurred_at DESC LIMIT 1",
      [created.id],
    );
    assert.equal(audit.changes.reason, 'Temporary cross-team custody during migration');
  });

  it('keeps legacy mismatches editable until category data changes', async () => {
    const created = await domain.createAsset(request(itMember), {
      category: 'IT Hardware',
      assetType: 'Laptop',
      description: `${tag} legacy`,
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Medium',
      amcApplies: false,
      owningTeamId: IT,
      locationId,
    });
    await db.query('UPDATE assets SET category=$2 WHERE id=$1', [created.id, 'Furniture']);
    const edited = await domain.editAsset(request(itMember, created.version), created.id, {
      description: `${tag} legacy edited`,
      reason: 'Correcting description',
    });
    assert.equal(edited.description, `${tag} legacy edited`);
    await assert.rejects(
      domain.editAsset(request(itMember, edited.version), edited.id, {
        category: 'Office Equipment',
        reason: 'Repairing legacy classification',
      }),
      status(422),
    );
  });

  it('blocks removing a category team while it owns assets and restricts lead management', async () => {
    await assert.rejects(
      categories.addSubcategory(request(admLead), 'IT Hardware', {
        code: `${tag}-forbidden`,
        label: 'Forbidden',
        requiresCustodian: false,
        reason: 'Synthetic category test',
      }),
      status(403),
    );
    await assert.rejects(
      categories.updateTeams(request(admin), 'Furniture', {
        teamIds: [PRJ],
        handlingTeamId: PRJ,
        reason: 'Synthetic category test',
      }),
      (error: any) => error.status === 409,
    );
  });
});
