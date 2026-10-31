import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID, IT_TEAM_ID, PRJ_TEAM_ID, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Asset ownership integration tests require a database name ending _test');
const tag = `ownership-${randomUUID()}`;
const request = (actor: any, version?: number, key = randomUUID()) =>
  ({
    user: actor,
    get: (name: string) =>
      name.toLowerCase() === 'if-match'
        ? version === undefined
          ? undefined
          : `"${version}"`
        : name.toLowerCase() === 'idempotency-key'
          ? key
          : undefined,
  }) as AuthRequest;
const status = (code: number) => (error: any) => {
  assert.equal(error.status, code);
  return true;
};
const fieldError = (field: string) => (error: any) => {
  assert.equal(error.status, 422);
  assert.ok(error.response?.fields?.fieldErrors?.[field], `expected a ${field} field error`);
  return true;
};
const number = (code: string) => Number(code.slice(code.lastIndexOf('-') + 1));

describe(
  'asset ownership PostgreSQL integration',
  { skip: !connection, concurrency: false },
  () => {
    let db: Db, service: DomainService;
    let superAdmin: any, admLead: any, prjLead: any, itMember: any, employee: any;
    let locationId: string, activeProject: string, inactiveProject: string;
    const input = {
      category: 'Ownership Category',
      assetType: 'Ownership Type',
      description: `${tag} item`,
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
        displayName: 'Synthetic ownership test',
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
    const create = (actor: any, extra: Record<string, unknown> = {}) =>
      service.createAsset(request(actor), {
        ...input,
        description: `${tag} item ${randomUUID()}`,
        ...extra,
      });

    before(async () => {
      process.env.DATABASE_URL = connection;
      process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
      db = new Db();
      service = new DomainService(db);
      for (const [kind, code] of [
        ['CATEGORY', input.category],
        ['ASSET_TYPE', input.assetType],
        ['ASSET_TYPE', 'Printer'],
        ['OWNERSHIP', 'Owned'],
        ['CONDITION', 'Good'],
        ['RISK', 'Medium'],
        ['STATUS', 'In Store'],
      ])
        await db.query(
          'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
          [kind, code],
        );
      [{ id: locationId }] = await db.query(
        "INSERT INTO locations(code,site) VALUES($1,'Synthetic site') RETURNING id",
        [`${tag}-room`],
      );
      [{ id: activeProject }] = await db.query(
        "INSERT INTO projects(code,name,start_date) VALUES($1,'Synthetic grant','2026-01-01') RETURNING id",
        [`P1-${randomUUID().slice(0, 8)}`],
      );
      [{ id: inactiveProject }] = await db.query(
        "INSERT INTO projects(code,name,start_date,active) VALUES($1,'Closed grant','2025-01-01',false) RETURNING id",
        [`P0-${randomUUID().slice(0, 8)}`],
      );
      superAdmin = await make(['SUPER_ADMIN']);
      admLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', ADM_TEAM_ID);
      prjLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', PRJ_TEAM_ID);
      itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT_TEAM_ID);
      employee = await make(['EMPLOYEE']);
    });
    after(async () => {
      if (db) await db.onModuleDestroy();
    });

    it('ADM lead creates consecutive IAC-ADM codes', async () => {
      const first = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      const second = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      assert.match(first.assetCode, /^IAC-ADM-\d{6}$/);
      assert.equal(number(second.assetCode), number(first.assetCode) + 1);
      assert.equal(first.owningTeamId, ADM_TEAM_ID);
    });
    it('concurrent creates in one team get distinct codes', async () => {
      const created = await Promise.all(
        Array.from({ length: 5 }, () => create(admLead, { owningTeamId: ADM_TEAM_ID })),
      );
      const codes = new Set(created.map((a) => a.assetCode));
      assert.equal(codes.size, 5);
      for (const code of codes) assert.match(code, /^IAC-ADM-\d{6}$/);
    });
    it('failed create does not consume a code', async () => {
      const before = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      await assert.rejects(
        create(admLead, { owningTeamId: ADM_TEAM_ID, category: `${tag}-missing` }),
        status(422),
      );
      const after = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      assert.equal(number(after.assetCode), number(before.assetCode) + 1);
    });
    it('PRJ asset without projectId is 422 with field projectId', async () => {
      await assert.rejects(create(prjLead, { owningTeamId: PRJ_TEAM_ID }), fieldError('projectId'));
      const tagged = await create(prjLead, { owningTeamId: PRJ_TEAM_ID, projectId: activeProject });
      assert.match(tagged.assetCode, /^IAC-PRJ-\d{6}$/);
      assert.equal(tagged.projectId, activeProject);
    });
    it('inactive project cannot be tagged', async () => {
      await assert.rejects(
        create(admLead, { owningTeamId: ADM_TEAM_ID, projectId: inactiveProject }),
        fieldError('projectId'),
      );
    });
    it('Printer without locationId is 422 on create and on edit-to-null', async () => {
      await assert.rejects(
        create(itMember, { owningTeamId: IT_TEAM_ID, assetType: 'Printer' }),
        fieldError('locationId'),
      );
      const printer = await create(itMember, {
        owningTeamId: IT_TEAM_ID,
        assetType: 'Printer',
        locationId,
      });
      await assert.rejects(
        service.editAsset(request(itMember, printer.version), printer.id, {
          locationId: null,
          reason: 'Synthetic move out',
        }),
        fieldError('locationId'),
      );
    });
    it('legacy room-held asset without a location can still be edited', async () => {
      const printer = await create(itMember, {
        owningTeamId: IT_TEAM_ID,
        assetType: 'Printer',
        locationId,
      });
      // Simulate pre-policy legacy data: a Printer that never had a location.
      await db.query('UPDATE assets SET location_id=NULL WHERE id=$1', [printer.id]);
      const edited = await service.editAsset(request(itMember, printer.version), printer.id, {
        description: `${tag} legacy printer edit`,
        reason: 'Synthetic description fix',
      });
      assert.equal(edited.description, `${tag} legacy printer edit`);
      // Changing the location rule's input is still enforced.
      const located = await create(itMember, {
        owningTeamId: IT_TEAM_ID,
        assetType: 'Printer',
        locationId,
      });
      await assert.rejects(
        service.editAsset(request(itMember, located.version), located.id, {
          locationId: null,
          reason: 'Synthetic move out',
        }),
        fieldError('locationId'),
      );
    });
    it('untagged asset stays editable after its team starts requiring a project', async () => {
      const asset = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      await db.query('UPDATE teams SET requires_project=true WHERE id=$1', [ADM_TEAM_ID]);
      try {
        const edited = await service.editAsset(request(admLead, asset.version), asset.id, {
          description: `${tag} untagged edit`,
          reason: 'Synthetic description fix',
        });
        assert.equal(edited.description, `${tag} untagged edit`);
        await assert.rejects(
          create(admLead, { owningTeamId: ADM_TEAM_ID }),
          fieldError('projectId'),
        );
      } finally {
        await db.query('UPDATE teams SET requires_project=false WHERE id=$1', [ADM_TEAM_ID]);
      }
    });
    it('Printer at a location may also be assigned to a person', async () => {
      const printer = await create(itMember, {
        owningTeamId: IT_TEAM_ID,
        assetType: 'Printer',
        locationId,
      });
      await service.assign(request(itMember, printer.version), printer.id, {
        userId: employee.id,
      });
      const assigned = await service.asset(request(superAdmin), printer.id);
      assert.equal(assigned.status, 'In Use');
      assert.equal(assigned.locationId, locationId);
      assert.equal(assigned.currentAssignment.userId, employee.id);
    });
    it('only SUPER_ADMIN changes owningTeamId, reason audited, code unchanged', async () => {
      const asset = await create(admLead, { owningTeamId: ADM_TEAM_ID });
      await assert.rejects(
        service.editAsset(request(admLead, asset.version), asset.id, {
          owningTeamId: IT_TEAM_ID,
          reason: 'Lead tries to hand over',
        }),
        status(403),
      );
      const moved = await service.editAsset(request(superAdmin, asset.version), asset.id, {
        owningTeamId: IT_TEAM_ID,
        reason: 'Handed to IT',
      });
      assert.equal(moved.owningTeamId, IT_TEAM_ID);
      assert.equal(moved.assetCode, asset.assetCode);
      const [audit] = await db.query(
        "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='ASSET_TEAM_CHANGED'",
        [asset.id],
      );
      assert.deepEqual(audit.changes, {
        from: ADM_TEAM_ID,
        to: IT_TEAM_ID,
        reason: 'Handed to IT',
      });
    });
    it('member cannot create in another team', async () => {
      await assert.rejects(create(itMember, { owningTeamId: ADM_TEAM_ID }), status(403));
    });
    it('omitted owning team defaults to IT', async () => {
      const legacy = await create(itMember);
      assert.equal(legacy.owningTeamId, IT_TEAM_ID);
      assert.match(legacy.assetCode, /^IAC-IT-\d{6}$/);
    });
    it('catalog filters by owning team and project', async () => {
      const tagged = await create(prjLead, { owningTeamId: PRJ_TEAM_ID, projectId: activeProject });
      const byProject = await service.assets(request(superAdmin), { projectId: activeProject });
      assert.ok(byProject.items.some((a: any) => a.id === tagged.id));
      assert.ok(byProject.items.every((a: any) => a.projectId === activeProject));
      const byTeam = await service.assets(request(superAdmin), {
        owningTeamId: ADM_TEAM_ID,
        limit: '100',
      });
      assert.ok(byTeam.items.length > 0);
      assert.ok(byTeam.items.every((a: any) => a.owningTeamId === ADM_TEAM_ID));
    });
  },
);
