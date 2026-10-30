import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Db } from './db';
import { MasterDomain } from './domain-masters';
import {
  assertKitEditAllowed,
  assertNotKitPart,
  attachKitInput,
  attachPart,
  cascadeAssign,
  cascadeReturn,
  detachKitInput,
  detachPart,
  kitView,
  lockKitParts,
} from './asset-kits';
import { Actor, AuthRequest, assertVersion, requireRole } from './security';
import { FINANCE_FIELDS, WRITE_OFF_STATUSES, assertCan, can } from './policy';
import {
  IT_TEAM_ID,
  assertCanSomewhere,
  canSomewhere,
  assetColumns,
  assetInput,
  assetPatch,
  assetScope,
  assignInput,
  reassignInput,
  returnInput,
  ackInput,
  camel,
  eligibleEmployee,
  found,
  id,
  idempotent,
  insertObject,
  page,
  parse,
  patchObject,
  requestPage,
  terminal,
  validateAsset,
} from './domain-helpers';

/**
 * After imported codes land, move every counter past them: the legacy IT sequence from
 * IAC-IT- codes only, and each team's counter from codes with that team's prefix. This
 * keeps the next create from walking thousands of taken numbers under the counter lock.
 */
export async function reconcileAssetCounters(db: Db, c: PoolClient): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence',0))", [], c);
  await db.query(
    `SELECT setval('asset_number_seq',greatest((SELECT last_value FROM asset_number_seq),
       (SELECT coalesce(max(substring(asset_code from 8)::bigint),1) FROM assets WHERE asset_code ~ '^IAC-IT-[0-9]{6}$')),true)`,
    [],
    c,
  );
  await db.query(
    `UPDATE team_asset_counters k SET next_value=greatest(k.next_value,m.top+1)
     FROM (SELECT t.id,max(right(a.asset_code,6)::bigint) AS top FROM teams t
           JOIN assets a ON a.asset_code ~ ('^IAC-'||t.asset_code_prefix||'-[0-9]{6}$')
           GROUP BY t.id) m
     WHERE k.team_id=m.id`,
    [],
    c,
  );
}

/**
 * Next free code for the team, e.g. IAC-ADM-000042. The counter row lock serialises
 * concurrent creates, and it is updated in the caller's transaction so a rolled-back
 * create does not consume a number. Codes already taken (imports) are skipped.
 */
export async function allocateAssetCode(db: Db, teamId: string, c: PoolClient): Promise<string> {
  // Shared with register-import reconciliation so a create waits instead of colliding.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence',0))", [], c);
  const [counter] = await db.query(
    'SELECT k.next_value,t.asset_code_prefix FROM team_asset_counters k JOIN teams t ON t.id=k.team_id WHERE k.team_id=$1 FOR UPDATE OF k',
    [teamId],
    c,
  );
  if (!counter) throw new ConflictException('Owning team has no asset code counter');
  let start = Number(counter.next_value);
  // Seeds, scripts and older tooling still number IT assets from asset_number_seq.
  if (teamId === IT_TEAM_ID)
    start = Math.max(
      start,
      Number((await db.query("SELECT nextval('asset_number_seq') AS n", [], c))[0].n),
    );
  for (let next = start; ; next++) {
    if (next > 999999) throw new ConflictException('Asset code range exhausted');
    const code = `IAC-${counter.asset_code_prefix}-${String(next).padStart(6, '0')}`;
    if (!(await db.query('SELECT 1 FROM assets WHERE asset_code=$1', [code], c))[0]) {
      await db.query(
        'UPDATE team_asset_counters SET next_value=$2 WHERE team_id=$1',
        [teamId, next + 1],
        c,
      );
      return code;
    }
  }
}

/** Finance fields need Finance; other fields need team edit; write-offs need team retire. */
function assertEditAllowed(actor: Actor, before: any, changes: Record<string, unknown>) {
  const keys = Object.keys(changes);
  // Approval and rejection carry an audit trail and reviewer; they must go through Finance review.
  if (changes.financePending !== undefined)
    throw new ConflictException('Use Finance review to approve or reject');
  if (keys.some((k) => FINANCE_FIELDS.includes(k))) assertCan(actor, 'asset.finance_edit');
  if (keys.some((k) => !FINANCE_FIELDS.includes(k)))
    assertCan(actor, 'asset.edit', before.owning_team_id);
  if (changes.owningTeamId !== undefined && changes.owningTeamId !== before.owning_team_id)
    assertCan(actor, 'asset.change_team');
  const status = changes.status as string | undefined;
  if (status && status !== before.status && WRITE_OFF_STATUSES.has(status))
    assertCan(actor, 'asset.retire', before.owning_team_id);
}

export class AssetDomain extends MasterDomain {
  async assets(req: AuthRequest, query: any) {
    const p = requestPage(query, ['asset_code', 'id']);
    const values: any[] = [];
    const where = [assetScope(req.user, values)];
    for (const [key, column] of [
      ['status', 'status'],
      ['category', 'category'],
      ['departmentId', 'department_id'],
      ['owningTeamId', 'owning_team_id'],
      ['projectId', 'project_id'],
    ] as const)
      if (p[key]) {
        values.push(p[key]);
        where.push(`a.${column}=$${values.length}`);
      }
    if (p.labelPrinted && canSomewhere(req.user, 'asset.label'))
      where.push('NOT EXISTS(SELECT 1 FROM asset_label_prints lp WHERE lp.asset_id=a.id)');
    if (p.q) {
      values.push(p.q);
      where.push(
        `(strpos(lower(a.asset_code),lower($${values.length}))>0 OR strpos(lower(a.description),lower($${values.length}))>0 OR strpos(lower(coalesce(a.serial_number,'')),lower($${values.length}))>0)`,
      );
    }
    if (p.after) {
      values.push(...p.after);
      where.push(`(a.asset_code,a.id)>($${values.length - 1},$${values.length}::uuid)`);
    }
    values.push(p.limit + 1);
    const rows = await this.db.query(
      `SELECT ${assetColumns(req.user)}${canSomewhere(req.user, 'asset.label') ? `,(SELECT max(lp.printed_at) FROM asset_label_prints lp WHERE lp.asset_id=a.id) AS last_label_printed_at` : ''} FROM assets a WHERE ${where.join(' AND ')} ORDER BY a.asset_code,a.id LIMIT $${values.length}`,
      values,
    );
    const result = page(rows, p.limit, ['asset_code', 'id']);
    await this.attachCurrentAssignments(req.user, result.items);
    return result;
  }
  async attachCurrentAssignments(actor: Actor, items: any[], client?: PoolClient) {
    if (!items.length) return;
    const values: any[] = [items.map((a) => a.id)];
    const all = can(actor, 'asset.view_all');
    const own = all ? '' : ' AND s.user_id=$2';
    if (!all) values.push(actor.id);
    const assignments = await this.db.query(
      `SELECT s.id,s.asset_id,s.user_id,s.acknowledgement,s.acknowledged_at,s.dispute_reason,s.assigned_at,s.version,
              u.display_name AS employee_name,u.designation AS employee_designation,ud.name AS employee_department
       FROM assignments s
       JOIN users u ON u.id=s.user_id
       LEFT JOIN departments ud ON ud.id=u.department_id
       WHERE s.ended_at IS NULL AND s.asset_id=ANY($1::uuid[])${own}`,
      values,
      client,
    );
    for (const asset of items)
      asset.currentAssignment = assignments.find((a) => a.asset_id === asset.id)
        ? camel(assignments.find((a) => a.asset_id === asset.id))
        : null;
  }
  async asset(req: AuthRequest, assetId: string, client?: PoolClient) {
    const values: any[] = [id(assetId)];
    const scope = assetScope(req.user, values);
    const row = found(
      (
        await this.db.query(
          `SELECT ${assetColumns(req.user)} FROM assets a WHERE a.id=$1 AND ${scope}`,
          values,
          client,
        )
      )[0],
    );
    const result = camel(row);
    Object.assign(result, await kitView(this.db, assetId, client));
    await this.attachCurrentAssignments(req.user, [result], client);
    // Custody evidence is for private-column viewers or the employee's own currently
    // open assignment. Never expose previous custodians or notes.
    if (can(req.user, 'asset.view_private'))
      result.timeline = (
        await this.db.query(
          'SELECT id,occurred_at AS created_at,kind,reason AS body FROM asset_movements WHERE asset_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 50',
          [assetId],
          client,
        )
      ).map(camel);
    else if (req.user.roles.includes('EMPLOYEE'))
      result.timeline = (
        await this.db.query(
          "SELECT e.id,e.occurred_at AS created_at,e.kind,CASE e.kind WHEN 'ACCEPTED' THEN 'You confirmed these asset details.' WHEN 'DISPUTED' THEN 'You reported a discrepancy.' ELSE 'Your assignment record was updated.' END AS body FROM assignment_events e JOIN assignments a ON a.id=e.assignment_id WHERE a.asset_id=$1 AND a.user_id=$2 AND a.ended_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC LIMIT 50",
          [assetId, req.user.id],
          client,
        )
      ).map(camel);
    else result.timeline = [];
    return result;
  }
  async createAsset(req: AuthRequest, body: unknown) {
    assertCanSomewhere(req.user, 'asset.create');
    const parsed = parse(assetInput, body);
    // Callers that predate team ownership create IT assets.
    const data = { ...parsed, owningTeamId: parsed.owningTeamId ?? IT_TEAM_ID };
    assertCan(req.user, 'asset.create', data.owningTeamId);
    if (
      FINANCE_FIELDS.some((f) => (data as any)[f] != null) &&
      !can(req.user, 'asset.finance_edit')
    )
      throw new ForbiddenException('Finance fields are set by Finance');
    if (data.status === 'Assigned')
      throw new ConflictException('Assign custody using the assignment workflow');
    return idempotent(this.db, req, 'POST /assets', data, async (c) => {
      await validateAsset(this.db, data, c, undefined, req.user);
      const assetCode = await allocateAssetCode(this.db, data.owningTeamId, c);
      const asset = await insertObject(
        this.db,
        'assets',
        { ...data, assetCode, createdBy: req.user.id, financePending: true },
        c,
      );
      await this.db.audit(c, req.user, 'asset', asset.id, 'ASSET_CREATED', {
        assetCode,
        fields: Object.keys(data),
      });
      return this.asset(req, asset.id, c);
    });
  }
  async editAsset(req: AuthRequest, assetId: string, body: unknown) {
    if (!canSomewhere(req.user, 'asset.edit') && !can(req.user, 'asset.finance_edit'))
      throw new ForbiddenException('Insufficient permission');
    id(assetId);
    const { reason, ...changes } = parse(assetPatch, body);
    if (!Object.keys(changes).length) throw new ConflictException('No catalog changes supplied');
    return this.db.tx(async (c) => {
      const before = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );
      assertEditAllowed(req.user, before, changes);
      assertVersion(req, before.version);
      await assertKitEditAllowed(this.db, before, changes, c);
      const merged = { ...camel(before), ...changes };
      await validateAsset(this.db, merged, c, camel(before), req.user);
      const [custody] = await this.db.query(
        'SELECT id FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
        [assetId],
        c,
      );
      if (terminal.has(before.status) && changes.status && changes.status !== before.status)
        throw new ConflictException('Terminal assets cannot return to active inventory');
      if (merged.status === 'Assigned' && !custody)
        throw new ConflictException('Assigned status requires assignment workflow');
      if (custody && (terminal.has(merged.status) || merged.status === 'In Store'))
        throw new ConflictException('Return custody before changing this status');
      const after = await patchObject(this.db, 'assets', assetId, changes, c);
      const kind =
        changes.locationId !== undefined && changes.locationId !== before.location_id
          ? 'RELOCATE'
          : changes.status && changes.status !== before.status
            ? 'STATUS_CHANGE'
            : null;
      if (kind)
        await this.db.query(
          'INSERT INTO asset_movements(asset_id,kind,from_location_id,to_location_id,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
          [assetId, kind, before.location_id, after.location_id, reason, req.user.id],
          c,
        );
      await this.db.audit(c, req.user, 'asset', assetId, 'ASSET_UPDATED', {
        fields: Object.keys(changes),
        reason,
      });
      if (changes.owningTeamId !== undefined && changes.owningTeamId !== before.owning_team_id)
        await this.db.audit(c, req.user, 'asset', assetId, 'ASSET_TEAM_CHANGED', {
          from: before.owning_team_id,
          to: changes.owningTeamId,
          reason,
        });
      return this.asset(req, assetId, c);
    });
  }
  async assign(
    req: AuthRequest,
    assetId: string,
    body: unknown,
    reassign = false,
    options: { sendEmail?: boolean; allowInvited?: boolean } = {},
  ) {
    assertCanSomewhere(req.user, 'asset.custody');
    id(assetId);
    const data: any = parse(reassign ? reassignInput : assignInput, body);
    return idempotent(
      this.db,
      req,
      `POST /assets/${assetId}/${reassign ? 'reassign' : 'assignments'}`,
      data,
      async (c) => {
        const asset = found(
          (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
        );
        assertCan(req.user, 'asset.custody', asset.owning_team_id);
        await assertNotKitPart(this.db, asset, c);
        assertVersion(req, asset.version);
        const [old] = await this.db.query(
          'SELECT a.*,u.email,u.state AS holder_state FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.asset_id=$1 AND a.ended_at IS NULL FOR UPDATE OF a',
          [assetId],
          c,
        );
        if (terminal.has(asset.status))
          throw new ConflictException('Terminal asset cannot be assigned');
        if (reassign) {
          if (!old) throw new ConflictException('There is no current custody to reassign');
          if (old.user_id === data.userId)
            throw new ConflictException('Employee already holds this asset');
        } else if (old || asset.status !== 'In Store')
          throw new ConflictException('Asset must be In Store without current custody');
        const user = await eligibleEmployee(this.db, data.userId, c, options.allowInvited === true);
        if (old) {
          await this.db.query(
            'UPDATE assignments SET ended_at=now(),ended_by=$2,version=version+1 WHERE id=$1',
            [old.id, req.user.id],
            c,
          );
          await this.db.query(
            "INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,'REASSIGNED_OUT',$3)",
            [old.id, req.user.id, JSON.stringify({ reason: data.reason })],
            c,
          );
          if (options.sendEmail !== false)
            await this.db.notify(c, `assignment:${old.id}:ended`, 'ASSIGNMENT_ENDED', old.holder_state === 'DIRECTORY' ? [] : [old.email], {
              subject: `Asset ${asset.asset_code} returned`,
              text: 'Your custody record was closed. Sign in to review your assigned assets.',
            });
        }
        const row = await insertObject(
          this.db,
          'assignments',
          { assetId, userId: user.id, assignedBy: req.user.id, handoverNote: data.note },
          c,
        );
        const [updated] = await this.db.query(
          "UPDATE assets SET status='Assigned',version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
          [assetId],
          c,
        );
        await this.db.query(
          'INSERT INTO asset_movements(asset_id,kind,from_assignment_id,to_assignment_id,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            assetId,
            reassign ? 'REASSIGN' : 'ASSIGN',
            old?.id || null,
            row.id,
            data.reason || data.note || 'Assigned by administrator',
            req.user.id,
          ],
          c,
        );
        await this.db.query(
          "INSERT INTO assignment_events(assignment_id,actor_id,kind) VALUES($1,$2,'ASSIGNED')",
          [row.id, req.user.id],
          c,
        );
        await this.db.audit(
          c,
          req.user,
          'assignment',
          row.id,
          reassign ? 'ASSET_REASSIGNED' : 'ASSET_ASSIGNED',
          { assetId, userId: user.id, priorAssignmentId: old?.id || null },
        );
        await cascadeAssign(
          this.db,
          c,
          req.user,
          await lockKitParts(this.db, assetId, c),
          user.id,
          reassign ? 'REASSIGN' : 'ASSIGN',
          data.reason || data.note || 'Assigned by administrator',
          asset,
        );
        if (options.sendEmail !== false && user.state !== 'DIRECTORY')
          await this.db.notify(
            c,
            `assignment:${row.id}:created`,
            'ASSIGNMENT_CREATED',
            [user.email],
            {
              subject: `Asset ${asset.asset_code} assigned`,
              text: 'An asset has been assigned to you. Sign in to verify its details and accept or dispute the assignment.',
            },
          );
        return {
          ...camel(row),
          assetVersion: updated.version,
          previousAssignmentVersion: old ? old.version + 1 : null,
        };
      },
    );
  }
  async returnAsset(req: AuthRequest, assignmentId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.custody');
    id(assignmentId);
    const data = parse(returnInput, body);
    return idempotent(this.db, req, `POST /assignments/${assignmentId}/return`, data, async (c) => {
      // All custody commands lock the asset before the assignment to avoid lock inversion.
      const hint = found(
        (await this.db.query('SELECT asset_id FROM assignments WHERE id=$1', [assignmentId], c))[0],
      );
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [hint.asset_id], c))[0],
      );
      assertCan(req.user, 'asset.custody', asset.owning_team_id);
      await assertNotKitPart(this.db, asset, c);
      const row = found(
        (
          await this.db.query(
            'SELECT a.*,u.email,u.state AS holder_state FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.id=$1 FOR UPDATE OF a',
            [assignmentId],
            c,
          )
        )[0],
      );
      assertVersion(req, row.version);
      if (row.ended_at) throw new ConflictException('Assignment already ended');
      const merged = {
        ...camel(asset),
        condition: data.condition,
        locationId: data.locationId === undefined ? asset.location_id : data.locationId,
        status: 'In Store',
      };
      await validateAsset(this.db, merged, c, camel(asset));
      const [ended] = await this.db.query(
        'UPDATE assignments SET ended_at=now(),ended_by=$2,version=version+1 WHERE id=$1 RETURNING *',
        [assignmentId, req.user.id],
        c,
      );
      const updated = await patchObject(
        this.db,
        'assets',
        asset.id,
        { status: 'In Store', condition: data.condition, locationId: merged.locationId },
        c,
      );
      await this.db.query(
        "INSERT INTO asset_movements(asset_id,kind,from_assignment_id,from_location_id,to_location_id,reason,actor_id) VALUES($1,'RETURN',$2,$3,$4,$5,$6)",
        [asset.id, assignmentId, asset.location_id, updated.location_id, data.reason, req.user.id],
        c,
      );
      await this.db.query(
        "INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,'RETURNED',$3)",
        [assignmentId, req.user.id, JSON.stringify({ reason: data.reason })],
        c,
      );
      await this.db.audit(c, req.user, 'assignment', assignmentId, 'ASSET_RETURNED', {
        assetId: asset.id,
        reason: data.reason,
      });
      await cascadeReturn(
        this.db,
        c,
        req.user,
        await lockKitParts(this.db, asset.id, c),
        data,
        asset,
      );
      await this.db.notify(c, `assignment:${assignmentId}:ended`, 'ASSIGNMENT_ENDED', row.holder_state === 'DIRECTORY' ? [] : [row.email], {
        subject: `Asset ${asset.asset_code} returned`,
        text: 'Your custody record was closed. Sign in to review your assigned assets.',
      });
      return { ...camel(ended), assetVersion: updated.version };
    });
  }
  async attachKitPart(req: AuthRequest, parentId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.custody');
    id(parentId);
    const data = parse(attachKitInput, body);
    return idempotent(this.db, req, `POST /assets/${parentId}/kit`, data, async (c) => {
      await attachPart(this.db, c, req.user, parentId, data);
      return this.asset(req, parentId, c);
    });
  }
  async detachKitPart(req: AuthRequest, parentId: string, partId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.custody');
    id(parentId);
    id(partId);
    const data = parse(detachKitInput, body);
    return idempotent(this.db, req, `DELETE /assets/${parentId}/kit/${partId}`, data, async (c) => {
      await detachPart(this.db, c, req.user, parentId, partId, data);
      return this.asset(req, parentId, c);
    });
  }
  async acknowledge(req: AuthRequest, assignmentId: string, body: unknown) {
    requireRole(req, 'EMPLOYEE');
    id(assignmentId);
    const data = parse(ackInput, body);
    return this.db.tx(async (c) => {
      const hint = found(
        (
          await this.db.query(
            'SELECT asset_id FROM assignments WHERE id=$1 AND user_id=$2 AND ended_at IS NULL',
            [assignmentId, req.user.id],
            c,
          )
        )[0],
      );
      await this.db.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE', [hint.asset_id], c);
      const row = found(
        (
          await this.db.query(
            'SELECT * FROM assignments WHERE id=$1 AND user_id=$2 AND ended_at IS NULL FOR UPDATE',
            [assignmentId, req.user.id],
            c,
          )
        )[0],
      );
      assertVersion(req, row.version);
      if (row.acknowledgement !== 'PENDING')
        throw new ConflictException('Assignment has already been acknowledged');
      const [after] = await this.db.query(
        'UPDATE assignments SET acknowledgement=$2,acknowledged_at=now(),dispute_reason=$3,version=version+1 WHERE id=$1 RETURNING *',
        [assignmentId, data.decision, data.decision === 'DISPUTED' ? data.reason : null],
        c,
      );
      await this.db.query(
        'INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,$3,$4)',
        [assignmentId, req.user.id, data.decision, JSON.stringify({ reason: data.reason || null })],
        c,
      );
      await this.db.audit(c, req.user, 'assignment', assignmentId, 'ASSIGNMENT_ACKNOWLEDGED', {
        decision: data.decision,
      });
      return camel(after);
    });
  }
}
