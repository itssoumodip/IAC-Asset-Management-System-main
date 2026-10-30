import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID as ADM, IT_TEAM_ID as IT, PRJ_TEAM_ID as PRJ, joinTeam } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Ticket routing integration tests require a database name ending _test');
const tag = `ticketroute-${randomUUID()}`;
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
const status =
  (...codes: number[]) =>
  (error: any) => {
    assert.ok(codes.includes(error.status), `unexpected status ${error.status}`);
    return true;
  };

describe('ticket routing PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: DomainService;
  let superAdmin: any, itMember: any, admMember: any, admLead: any, itLead: any, employee: any;
  const mappedCategory = `${tag}-mapped`;
  const plainCategory = `${tag}-plain`;
  const assetInput = {
    category: 'Ticket Route Category',
    assetType: 'Ticket Route Type',
    description: `${tag} device`,
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
      displayName: 'Synthetic ticket routing test',
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
    await db.query('INSERT INTO approved_emails(email) VALUES($1)', [user.email]);
    for (const role of roles)
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
    return user;
  };
  const report = (reporter: any, extra: Record<string, unknown> = {}) =>
    service.createTicket(request(reporter), {
      subject: `${tag} subject`,
      description: 'Synthetic routing ticket',
      category: plainCategory,
      priority: 'MEDIUM',
      ...extra,
    });
  const deliveries = async (ticketId: string) =>
    (
      await db.query(
        'SELECT d.recipient FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
        [`ticket:${ticketId}:created`],
      )
    ).map((r: any) => r.recipient);

  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    service = new DomainService(db);
    for (const [kind, code] of [
      ['CATEGORY', assetInput.category],
      ['ASSET_TYPE', assetInput.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
      ['STATUS', 'In Store'],
      ['TICKET_CATEGORY', mappedCategory],
      ['TICKET_CATEGORY', plainCategory],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    superAdmin = await make(['SUPER_ADMIN']);
    itMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', IT);
    itLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', IT);
    admMember = await joinTeam(db, await make(['EMPLOYEE']), 'MEMBER', ADM);
    admLead = await joinTeam(db, await make(['EMPLOYEE']), 'LEAD', ADM);
    employee = await make(['EMPLOYEE']);
    await service.setTicketCategoryTeam(request(superAdmin), mappedCategory, {
      teamId: PRJ,
      reason: 'Routing test mapping',
    });
  });
  after(async () => {
    if (db) {
      await db.query('DELETE FROM ticket_category_teams WHERE category_code=ANY($1)', [
        [mappedCategory, plainCategory],
      ]);
      await db.onModuleDestroy();
    }
  });

  it('routes an asset ticket to the asset owning team', async () => {
    const asset = await service.createAsset(request(superAdmin), {
      ...assetInput,
      description: `${tag} adm device`,
    });
    await db.query('UPDATE assets SET owning_team_id=$2 WHERE id=$1', [asset.id, ADM]);
    const ticket = await report(employee, { assetId: asset.id, category: mappedCategory });
    assert.equal(ticket.teamId, ADM);
  });

  it('routes by category mapping, and unmapped categories to IT', async () => {
    assert.equal((await report(employee, { category: mappedCategory })).teamId, PRJ);
    assert.equal((await report(employee)).teamId, IT);
  });

  it('exposes category mappings via references and rejects non-admins', async () => {
    const refs: any = await service.references();
    assert.ok(
      refs.ticketCategoryTeams.some(
        (m: any) => m.categoryCode === mappedCategory && m.teamId === PRJ,
      ),
    );
    await assert.rejects(
      service.setTicketCategoryTeam(request(itLead), mappedCategory, { teamId: IT, reason: 'x' }),
      status(403),
    );
  });

  it('hides other teams tickets from list and detail', async () => {
    const ticket = await report(employee);
    const admList = await service.tickets(request(admMember), { limit: '100' });
    assert.ok(!admList.items.some((t: any) => t.id === ticket.id));
    await assert.rejects(service.ticket(request(admMember), ticket.id), status(403, 404));
    const itList = await service.tickets(request(itMember), { limit: '100' });
    assert.ok(itList.items.some((t: any) => t.id === ticket.id));
    const filtered = await service.tickets(request(superAdmin), { limit: '100', teamId: ADM });
    assert.ok(!filtered.items.some((t: any) => t.id === ticket.id));
    const own = await service.tickets(request(employee), { limit: '100' });
    assert.ok(own.items.some((t: any) => t.id === ticket.id));
  });

  it('team members see tickets they reported even for another team', async () => {
    const ticket = await report(admMember);
    assert.equal(ticket.teamId, IT);
    assert.equal((await service.ticket(request(admMember), ticket.id)).id, ticket.id);
  });

  it('non-members cannot change status, owner or add internal notes', async () => {
    const ticket = await report(employee);
    await assert.rejects(
      service.ticketStatus(request(admMember, ticket.version), ticket.id, {
        status: 'IN_PROGRESS',
      }),
      status(403, 404),
    );
    await assert.rejects(
      service.ticketOwner(request(admMember, ticket.version), ticket.id, {
        ownerId: admMember.id,
      }),
      status(403, 404),
    );
    const own = await report(admMember);
    await assert.rejects(
      service.addUpdate(request(admMember, own.version), own.id, {
        body: 'internal',
        visibility: 'INTERNAL',
      }),
      status(403),
    );
    const moved = await service.ticketStatus(request(itMember, ticket.version), ticket.id, {
      status: 'IN_PROGRESS',
    });
    assert.equal(moved.status, 'IN_PROGRESS');
  });

  it('owner must be a member of the ticket team or a Super Admin', async () => {
    const ticket = await report(employee);
    await assert.rejects(
      service.ticketOwner(request(itMember, ticket.version), ticket.id, {
        ownerId: admMember.id,
      }),
      status(404, 422),
    );
    const a = await service.ticketOwner(request(itMember, ticket.version), ticket.id, {
      ownerId: itLead.id,
    });
    assert.equal(a.ownerId, itLead.id);
    const b = await service.ticketOwner(request(itMember, a.version), ticket.id, {
      ownerId: superAdmin.id,
    });
    assert.equal(b.ownerId, superAdmin.id);
  });

  it('lead of the current team or Super Admin can move a ticket, audited', async () => {
    const ticket = await report(employee);
    await assert.rejects(
      service.moveTicketTeam(request(itMember, ticket.version), ticket.id, {
        teamId: ADM,
        reason: 'member move',
      }),
      status(403),
    );
    await assert.rejects(
      service.moveTicketTeam(request(admLead, ticket.version), ticket.id, {
        teamId: ADM,
        reason: 'wrong team lead',
      }),
      status(403, 404),
    );
    const moved = await service.moveTicketTeam(request(itLead, ticket.version), ticket.id, {
      teamId: ADM,
      reason: 'Belongs to administration',
    });
    assert.equal(moved.teamId, ADM);
    const audit = await db.query(
      "SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='TICKET_TEAM_CHANGED'",
      [ticket.id],
    );
    assert.equal(audit.length, 1);
    await assert.rejects(service.ticket(request(itMember), ticket.id), status(403, 404));
    assert.equal((await service.ticket(request(admMember), ticket.id)).id, ticket.id);
    const back = await service.moveTicketTeam(request(superAdmin, moved.version), ticket.id, {
      teamId: IT,
      reason: 'Back to IT',
    });
    assert.equal(back.teamId, IT);
  });

  it('new-ticket notification goes to verified members of the routed team', async () => {
    const asset = await service.createAsset(request(superAdmin), {
      ...assetInput,
      description: `${tag} notify device`,
    });
    await db.query('UPDATE assets SET owning_team_id=$2 WHERE id=$1', [asset.id, ADM]);
    const ticket = await report(employee, { assetId: asset.id });
    const to = await deliveries(ticket.id);
    assert.ok(to.includes(admMember.email.toLowerCase()));
    assert.ok(to.includes(admLead.email.toLowerCase()));
    assert.ok(!to.includes(itMember.email.toLowerCase()));
  });
  it('moving a ticket to another team clears the owner, audited', async () => {
    const ticket = await report(employee);
    const owned = await service.ticketOwner(request(itMember, ticket.version), ticket.id, {
      ownerId: itMember.id,
    });
    assert.equal(owned.ownerId, itMember.id);
    const moved = await service.moveTicketTeam(request(itLead, owned.version), ticket.id, {
      teamId: ADM,
      reason: 'Belongs to administration',
    });
    assert.equal(moved.teamId, ADM);
    assert.equal(moved.ownerId, null);
    const [audit] = await db.query(
      "SELECT changes FROM audit_events WHERE entity_id=$1 AND action='TICKET_TEAM_CHANGED'",
      [ticket.id],
    );
    assert.ok(JSON.stringify(audit).includes(itMember.id));
  });

  it('a reporter public reply notifies the routed team, not the global IT group', async () => {
    const asset = await service.createAsset(request(superAdmin), {
      ...assetInput,
      description: `${tag} reply device`,
    });
    await db.query('UPDATE assets SET owning_team_id=$2 WHERE id=$1', [asset.id, ADM]);
    const ticket = await report(employee, { assetId: asset.id });
    await db.query(
      "INSERT INTO notification_recipients(group_id,email,verified_at) SELECT id,$1,now() FROM notification_groups WHERE code='IT' ON CONFLICT DO NOTHING",
      [itMember.email.toLowerCase()],
    );
    const reply = await service.addUpdate(request(employee, ticket.version), ticket.id, {
      body: 'Still broken',
      visibility: 'PUBLIC',
    });
    const to = (
      await db.query(
        'SELECT d.recipient FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
        [`ticket-update:${reply.id}`],
      )
    ).map((r: any) => r.recipient);
    assert.ok(to.includes(admMember.email.toLowerCase()));
    assert.ok(!to.includes(itMember.email.toLowerCase()));
    await db.query('DELETE FROM notification_recipients WHERE email=$1', [itMember.email.toLowerCase()]);
  });

  it('owner candidates are active members of the ticket team plus Super Admins', async () => {
    const ticket = await report(employee);
    const list = await service.ticketOwnerCandidates(request(itMember), ticket.id);
    const ids = list.items.map((u: any) => u.id);
    assert.ok(ids.includes(itMember.id));
    assert.ok(ids.includes(itLead.id));
    assert.ok(ids.includes(superAdmin.id));
    assert.ok(!ids.includes(admMember.id));
    assert.ok(!ids.includes(employee.id));
    await assert.rejects(service.ticketOwnerCandidates(request(admMember), ticket.id), status(403, 404));
    await assert.rejects(service.ticketOwnerCandidates(request(employee), ticket.id), status(403, 404));
  });
});
