import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { NotificationsService } from '../src/notifications';
import { register42Headers, resolveImportEmail, sourceHeaders } from '../src/domain-import';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Domain integration tests require a database name ending _test');
const tag = `domain-${randomUUID()}`;
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

describe('domain PostgreSQL integration', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: DomainService, admin: any, employee: any, other: any, itAdmin: any;
  let asset: any, assignment: any, ticket: any;
  const input = {
    category: 'Domain Test Category',
    assetType: 'Domain Test Type',
    description: `${tag} device`,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
    amcApplies: false,
    purchaseCost: '100.00',
    residualValue: '0.00',
    supplier: 'Restricted supplier',
    remarks: 'Private inventory remark',
  };
  before(async () => {
    process.env.DATABASE_URL = connection;
    process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
    db = new Db();
    service = new DomainService(db);
    for (const [kind, code] of [
      ['CATEGORY', input.category],
      ['ASSET_TYPE', input.assetType],
      ['OWNERSHIP', 'Owned'],
      ['CONDITION', 'Good'],
      ['RISK', 'Medium'],
    ])
      await db.query(
        'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
        [kind, code],
      );
    const make = async (roles: string[]) => {
      const user = {
        id: randomUUID(),
        email: `${tag}-${roles[0]!.toLowerCase()}-${randomUUID()}@example.org`,
        displayName: 'Synthetic domain test',
        roles,
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
    admin = await make(['ADMIN']);
    employee = await make(['EMPLOYEE']);
    other = await make(['EMPLOYEE']);
    itAdmin = await make(['IT_ADMIN']);
  });
  after(async () => {
    if (db) await db.onModuleDestroy();
  });
  it('creates immutable asset codes, enforces DTO allowlists and idempotency', async () => {
    const req = request(admin, undefined, `${tag}-create`);
    asset = await service.createAsset(req, input);
    assert.match(asset.assetCode, /^IAC-IT-\d{6}$/);
    assert.equal(asset.financePending, true);
    const repeat = await service.createAsset(req, input);
    assert.equal(repeat.id, asset.id);
    await assert.rejects(
      service.createAsset(req, { ...input, description: 'Different payload' }),
      status(409),
    );
    await assert.rejects(service.createAsset(request(employee), input), status(403));
    await assert.rejects(
      service.editAsset(request(admin, asset.version), asset.id, {
        assetCode: 'IAC-IT-999999',
        reason: 'Try to rename',
      }),
      status(422),
    );
  });
  it('keeps asset details unchanged when Employees or IT staff attempt catalog edits', async () => {
    const [before] = await db.query('SELECT to_jsonb(a) AS snapshot FROM assets a WHERE id=$1', [
      asset.id,
    ]);
    for (const actor of [employee, itAdmin]) {
      await assert.rejects(
        service.editAsset(request(actor, asset.version), asset.id, {
          description: 'Unauthorized replacement',
          serialNumber: 'UNAUTHORIZED',
          reason: 'Attempt unauthorized edit',
        }),
        status(403),
      );
      await assert.rejects(
        service.assign(request(actor, asset.version), asset.id, { userId: actor.id }),
        status(403),
      );
    }
    const [after] = await db.query('SELECT to_jsonb(a) AS snapshot FROM assets a WHERE id=$1', [
      asset.id,
    ]);
    assert.deepEqual(after.snapshot, before.snapshot);
    const [{ count }] = await db.query(
      'SELECT count(*)::int AS count FROM assignments WHERE asset_id=$1',
      [asset.id],
    );
    assert.equal(count, 0);
  });
  it('uses locked/versioned custody and allows exactly one racing assignment', async () => {
    const attempts = await Promise.allSettled([
      service.assign(request(admin, asset.version), asset.id, { userId: employee.id }),
      service.assign(request(admin, asset.version), asset.id, { userId: other.id }),
    ]);
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
    assignment = (attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>)
      .value;
    // Normalize fixture ownership to employee without assuming which race won.
    if (assignment.userId !== employee.id) {
      const result = await service.assign(
        request(admin, assignment.assetVersion),
        asset.id,
        { userId: employee.id, reason: 'Test owner normalization' },
        true,
      );
      assignment = result;
    }
    const [{ count }] = await db.query(
      'SELECT count(*)::int AS count FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
      [asset.id],
    );
    assert.equal(count, 1);
    await assert.rejects(
      service.editAsset(request(admin), asset.id, {
        description: 'Changed',
        reason: 'Missing version',
      }),
      status(428),
    );
    await assert.rejects(
      service.editAsset(request(admin, 1), asset.id, {
        description: 'Changed',
        reason: 'Stale version',
      }),
      status(412),
    );
  });
  it('filters authorization before pages and restricts asset projections', async () => {
    const mine = await service.assets(request(employee), { limit: 1, q: tag });
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].id, asset.id);
    assert.equal(mine.nextCursor, null);
    assert.equal(mine.items[0].currentAssignment.userId, employee.id);
    for (const privateKey of [
      'purchaseCost',
      'residualValue',
      'supplier',
      'remarks',
      'legacyMetadata',
      'assetOwner',
    ])
      assert.equal(privateKey in mine.items[0], false);
    await assert.rejects(service.asset(request(other), asset.id), status(404));
    await assert.rejects(service.asset(request(itAdmin), asset.id), status(404));
    assert.equal((await service.asset(request(admin), asset.id)).purchaseCost, '100.00');
  });
  it('enforces acknowledgement ownership, one decision and independent custody', async () => {
    await assert.rejects(
      service.acknowledge(request(other, assignment.version), assignment.id, {
        decision: 'ACCEPTED',
      }),
      status(404),
    );
    await assert.rejects(
      service.acknowledge(request(employee, assignment.version), assignment.id, {
        decision: 'DISPUTED',
        reason: '  ',
      }),
      status(422),
    );
    const ack = await service.acknowledge(request(employee, assignment.version), assignment.id, {
      decision: 'ACCEPTED',
    });
    assert.equal(ack.acknowledgement, 'ACCEPTED');
    assignment = ack;
    await assert.rejects(
      service.acknowledge(request(employee, ack.version), ack.id, {
        decision: 'DISPUTED',
        reason: 'Second decision',
      }),
      status(409),
    );
    const current = await service.asset(request(employee), asset.id);
    assert.equal(current.status, 'Assigned');
    const inbox = new NotificationsService(db);
    assert(
      (await inbox.workflow(request(admin))).items.some((n) => n.title === 'Assignment accepted'),
    );
    assert(
      (await inbox.workflow(request(employee))).items.some((n) => n.path === '/equipment/mine'),
    );
  });
  it('creates scoped tickets and queues new-ticket emails only to verified Admin recipients', async () => {
    await service.updateGroup(request(admin), 'ADMIN', {
      enabled: true,
      recipients: [admin.email],
    });
    await service.updateGroup(request(admin), 'IT', { enabled: true, recipients: [itAdmin.email] });
    const req = request(employee, undefined, `${tag}-ticket`);
    ticket = await service.createTicket(req, {
      assetId: asset.id,
      subject: `${tag} support`,
      description: 'Synthetic hardware issue',
      category: 'HARDWARE',
      priority: 'MEDIUM',
    });
    assert.equal(ticket.status, 'OPEN');
    assert.equal(ticket.notificationState, 'QUEUED');
    const workflow = await db.query(
      'SELECT user_id,entity_id FROM workflow_notifications WHERE event_key=$1',
      [`ticket:${ticket.id}:created`],
    );
    assert(workflow.some((n) => n.user_id === admin.id));
    assert(!workflow.some((n) => n.user_id === itAdmin.id));
    const inbox = new NotificationsService(db);
    assert(
      (await inbox.workflow(request(admin))).items.some((n) => n.path === `/tickets/${ticket.id}`),
    );

    const notifications = await db.query(
      'SELECT d.recipient FROM email_deliveries d JOIN notification_outbox o ON o.id=d.outbox_id WHERE o.event_key=$1',
      [`ticket:${ticket.id}:created`],
    );
    const expectedAdmins = await db.query(
      `SELECT DISTINCT u.email FROM users u WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='ADMIN')`,
    );
    assert.deepEqual(
      notifications.map((r) => r.recipient).sort(),
      expectedAdmins.map((r) => r.email).sort(),
    );
    assert.ok(notifications.some((r) => r.recipient === admin.email));
    assert.ok(!notifications.some((r) => r.recipient === itAdmin.email));
    const reported = await service.createTicket(request(other), {
      assetId: asset.id,
      subject: 'Non-holder report',
      description: 'Any staff member may report an in-service asset',
      category: 'HARDWARE',
      priority: 'LOW',
    });
    const [link] = await db.query('SELECT assignment_at_creation_id FROM tickets WHERE id=$1', [
      reported.id,
    ]);
    assert.equal(link.assignment_at_creation_id, null);
    await assert.rejects(
      service.createTicket(request(other), {
        assetId: randomUUID(),
        subject: 'Unknown asset',
        description: 'Must not link',
        category: 'HARDWARE',
        priority: 'LOW',
      }),
      status(404),
    );
    await assert.rejects(service.ticket(request(other), ticket.id), status(404));
    const technical = await service.asset(request(itAdmin), asset.id);
    assert.equal(technical.purchaseCost, undefined);
    assert.equal(technical.supplier, undefined);
  });
  it('hides internal notes before pagination and queues no employee email for them', async () => {
    const before = await db.query('SELECT id FROM notification_outbox WHERE event_key LIKE $1', [
      `ticket-update:%`,
    ]);
    const note = await service.addUpdate(request(itAdmin, ticket.version), ticket.id, {
      visibility: 'INTERNAL',
      body: 'Private staff-only investigation',
    });
    ticket.version = note.ticketVersion;
    const after = await db.query('SELECT id FROM notification_outbox WHERE event_key LIKE $1', [
      `ticket-update:%`,
    ]);
    assert.equal(before.length, after.length);
    let next: string | null | undefined;
    const visible: any[] = [];
    do {
      const p = await service.updates(request(employee), ticket.id, {
        limit: 1,
        ...(next ? { cursor: next } : {}),
      });
      visible.push(...p.items);
      next = p.nextCursor;
    } while (next);
    assert.equal(
      visible.some((r) => r.visibility === 'INTERNAL'),
      false,
    );
    assert.equal(JSON.stringify(visible).includes('Private staff-only'), false);
    const privileged = await service.updates(request(itAdmin), ticket.id, {});
    assert.equal(
      privileged.items.some((r) => r.visibility === 'INTERNAL'),
      true,
    );
    await assert.rejects(
      service.addUpdate(request(employee, ticket.version), ticket.id, {
        visibility: 'INTERNAL',
        body: 'Escalate',
      }),
      status(403),
    );
  });
  it('keeps ticket history after return, completes only with resolution and never changes custody', async () => {
    const response = await service.returnAsset(request(admin, assignment.version), assignment.id, {
      condition: 'Good',
      reason: 'Synthetic return',
    });
    assert.equal(response.assetVersion > asset.version, true);
    await assert.rejects(service.asset(request(employee), asset.id), status(404));
    assert.equal((await service.ticket(request(employee), ticket.id)).id, ticket.id);
    const reply = await service.addUpdate(request(employee, ticket.version), ticket.id, {
      visibility: 'PUBLIC',
      body: 'Reply after return',
    });
    ticket.version = reply.ticketVersion;
    await assert.rejects(
      service.ticketStatus(request(employee, ticket.version), ticket.id, {
        status: 'COMPLETED',
        resolution: 'Attempt',
      }),
      status(403),
    );
    await assert.rejects(
      service.ticketStatus(request(itAdmin, ticket.version), ticket.id, {
        status: 'COMPLETED',
        resolution: '   ',
      }),
      status(422),
    );
    ticket = await service.ticketStatus(request(itAdmin, ticket.version), ticket.id, {
      status: 'COMPLETED',
      resolution: 'Synthetic resolution verified',
    });
    assert.equal(ticket.status, 'COMPLETED');
    await assert.rejects(
      service.addUpdate(request(employee, ticket.version), ticket.id, {
        visibility: 'PUBLIC',
        body: 'Try reopening',
      }),
      status(409),
    );
    const [current] = await db.query('SELECT status FROM assets WHERE id=$1', [asset.id]);
    assert.equal(current.status, 'In Store');
  });
  it('rolls back ticket, audit and outbox together if enqueue fails', async () => {
    const subject = `${tag} forced rollback`;
    const original = db.notify;
    db.notify = async (c, ...args) => {
      await original.call(db, c, ...args);
      throw new Error('Synthetic outbox fault');
    };
    try {
      await assert.rejects(
        service.createTicket(request(employee), {
          subject,
          description: 'Rollback proof',
          category: 'OTHER',
          priority: 'LOW',
        }),
        /Synthetic outbox fault/,
      );
    } finally {
      db.notify = original;
    }
    const [{ count }] = await db.query(
      'SELECT count(*)::int AS count FROM tickets WHERE subject=$1',
      [subject],
    );
    assert.equal(count, 0);
    const [orphan] = await db.query(
      "SELECT count(*)::int AS count FROM notification_outbox o WHERE o.event_key LIKE 'ticket:%:created' AND NOT EXISTS(SELECT 1 FROM tickets t WHERE o.event_key='ticket:'||t.id||':created')",
    );
    assert.equal(orphan.count, 0);
  });
  it('preserves all source headers, quarantines invalid manual override, and reconciles import controls', async () => {
    assert.deepEqual(
      resolveImportEmail(
        { 'Custodian Login ID (Manual)': 'not-an-email', 'Custodian Login ID': employee.email },
        other.email,
      ),
      { email: null, issue: 'INVALID_MANUAL_EMAIL' },
    );
    assert.equal(resolveImportEmail({ 'Employee ID': employee.email }).email, null);
    const [{ number }] = await db.query("SELECT nextval('asset_number_seq')::text AS number");
    const code = `IAC-IT-${number.padStart(6, '0')}`;
    const raw = Object.fromEntries(sourceHeaders.map((h) => [h, '']));
    Object.assign(raw, {
      'Asset ID': code,
      'Asset Category': input.category,
      'Asset Type': input.assetType,
      'Asset Description': `${tag} imported`,
      'Ownership Type': 'Owned',
      'Asset Status': 'In Store',
      Condition: 'Good',
      'Risk Level': 'Medium',
      'Purchase Cost': '123.45',
      'Annual Depreciation': 'legacy 5.00',
      'Old Custodian': 'Restricted historical source',
    });
    const batch = await service.stageImport(request(admin), {
      filename: 'synthetic-approved.csv',
      sourceSha256: randomBytes(32).toString('hex'),
      sourceWorkbookSha256: randomBytes(32).toString('hex'),
      exportedAt: new Date(Date.now() - 10000).toISOString(),
      rows: [raw],
    });
    assert.equal(batch.quarantined, 1);
    assert.equal(batch.reconciliation.sourceLayout, 'REGISTER_44');
    assert.deepEqual(batch.rows[0].rawFields, raw);
    await assert.rejects(
      service.reviewImport(request(admin, batch.version), batch.id, {
        reason: 'Bad control',
        acceptFinancePending: true,
        rows: [],
        expectedAssetCodes: [code],
        expectedTotalCost: '123.44',
      }),
      status(409),
    );
    const reviewed = await service.reviewImport(request(admin, batch.version), batch.id, {
      reason: 'Synthetic owner review',
      acceptFinancePending: true,
      rows: [],
      expectedAssetCodes: [code],
      expectedTotalCost: '123.45',
    });
    assert.equal(reviewed.accepted, 1);
    const req = request(admin, reviewed.version, `${tag}-commit`);
    const committed = await service.commitImport(req, batch.id, { reviewed: true });
    assert.equal(committed.state, 'COMMITTED');
    assert.equal(committed.rows[0].state, 'PROMOTED');
    assert.equal((await service.commitImport(req, batch.id, { reviewed: true })).id, batch.id);
    const [imported] = await db.query('SELECT * FROM assets WHERE asset_code=$1', [code]);
    assert.equal(imported.finance_pending, true);
    assert.equal(imported.legacy_metadata.old_custodian, 'Restricted historical source');
    assert.equal(imported.purchase_cost, '123.45');
    await assert.rejects(service.importBatch(request(employee), batch.id), status(403));
  });
  it('requires an exact declared 42-column layout, preserves raw fields and quarantines unresolved custody', async () => {
    const makeRaw = async () => {
      const [{ number }] = await db.query("SELECT nextval('asset_number_seq')::text AS number");
      const raw = Object.fromEntries(register42Headers.map((header) => [header, '']));
      Object.assign(raw, {
        'Asset ID': `IAC-IT-${number.padStart(6, '0')}`,
        'Asset Category': input.category,
        'Asset Type': input.assetType,
        'Asset Description': `${tag} 42-column import`,
        'Ownership Type': 'Owned',
        'Asset Status': 'In Store',
        Condition: 'Good',
        'Risk Level': 'Medium',
        'Purchase Cost': '123.45',
        'Old Custodian': 'Restricted synthetic historical custodian',
      });
      return raw;
    };
    const custody = await makeRaw();
    Object.assign(custody, {
      'Asset Status': 'Assigned',
      Custodian: employee.displayName,
      'Employee ID': employee.email,
    });
    const unmapped = await makeRaw();
    unmapped.Column1 = 'Unmapped synthetic source evidence';
    const payload = {
      filename: 'synthetic-register-42.csv',
      sourceSha256: randomBytes(32).toString('hex'),
      sourceWorkbookSha256: randomBytes(32).toString('hex'),
      exportedAt: new Date(Date.now() - 10000).toISOString(),
      rows: [custody, unmapped],
    };
    await assert.rejects(service.stageImport(request(admin), payload), status(422));
    await assert.rejects(
      service.stageImport(request(admin), {
        ...payload,
        sourceLayout: 'REGISTER_42',
        rows: [{ ...custody, 'Comment Type': '' }],
      }),
      status(422),
    );
    const missingHeader = { ...custody };
    delete missingHeader.Column1;
    await assert.rejects(
      service.stageImport(request(admin), {
        ...payload,
        sourceLayout: 'REGISTER_42',
        rows: [missingHeader],
      }),
      status(422),
    );
    const batch = await service.stageImport(request(admin), {
      ...payload,
      sourceLayout: 'REGISTER_42',
    });
    assert.equal(batch.reconciliation.sourceLayout, 'REGISTER_42');
    assert.deepEqual(
      batch.rows.map((row: any) => row.rawFields),
      payload.rows,
    );
    assert.equal(Object.keys(batch.rows[0].rawFields).length, 42);
    assert.equal('Comment Type' in batch.rows[0].rawFields, false);
    assert.equal('Custodian Login ID' in batch.rows[0].rawFields, false);
    assert.equal('Custodian Login ID (Manual)' in batch.rows[0].rawFields, false);
    const reviewed = await service.reviewImport(request(admin, batch.version), batch.id, {
      reason: 'Synthetic source-layout and identity review',
      acceptFinancePending: true,
      rows: [],
      expectedAssetCodes: payload.rows.map((row) => row['Asset ID']),
      expectedTotalCost: '246.90',
      expectedUnknownPurchaseCost: 0,
    });
    assert.equal(reviewed.accepted, 0);
    assert.equal(reviewed.quarantined, 2);
    assert.deepEqual(
      reviewed.rows[0].issues.map((issue: any) => issue.code),
      ['CUSTODIAN_UNRESOLVED'],
    );
    assert.equal(reviewed.rows[0].normalizedFields.custodianId, null);
    assert.equal('commentType' in reviewed.rows[0].normalizedFields.data, false);
    assert.deepEqual(
      reviewed.rows[1].issues.map((issue: any) => issue.code),
      ['UNMAPPED_SOURCE_FIELD'],
    );
    assert.deepEqual(
      reviewed.rows.map((row: any) => row.rawFields),
      payload.rows,
    );
    await assert.rejects(
      service.commitImport(request(admin, reviewed.version), batch.id, { reviewed: true }),
      status(409),
    );
    const [{ count }] = await db.query(
      'SELECT count(*)::int AS count FROM assets WHERE asset_code=ANY($1::text[])',
      [payload.rows.map((row) => row['Asset ID'])],
    );
    assert.equal(count, 0);
  });
});
