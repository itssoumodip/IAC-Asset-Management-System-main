import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from './db';
import type { Actor } from './security';
import { assertCan } from './policy';
import { camel, eligibleEmployee, patchObject, terminal, text, uuid, validateAsset } from './domain-helpers';

export const attachKitInput = z.object({ partAssetId: uuid, reason: text() }).strict();
export const detachKitInput = z.object({ reason: text() }).strict();

/** Kit parts and parent for the asset detail page. */
export async function kitView(db: Db, assetId: string, c?: PoolClient) {
  const kitParts = (
    await db.query(
      'SELECT id,asset_code,description,asset_type FROM assets WHERE parent_asset_id=$1 ORDER BY asset_code,id',
      [assetId],
      c,
    )
  ).map(camel);
  const [parent] = await db.query(
    'SELECT p.id,p.asset_code FROM assets a JOIN assets p ON p.id=a.parent_asset_id WHERE a.id=$1',
    [assetId],
    c,
  );
  return { kitParts, kitParent: parent ? camel(parent) : null };
}

/** Direct custody commands on an attached part are refused; the kit parent moves it. */
export async function assertNotKitPart(db: Db, asset: any, c: PoolClient) {
  if (!asset.parent_asset_id) return;
  const [parent] = await db.query(
    'SELECT asset_code FROM assets WHERE id=$1',
    [asset.parent_asset_id],
    c,
  );
  throw new ConflictException(
    `This item is part of kit ${parent?.asset_code ?? 'another asset'}; detach it first`,
  );
}

/** Guards for edits that would break kit invariants (retire, team change). */
export async function assertKitEditAllowed(
  db: Db,
  before: any,
  changes: Record<string, unknown>,
  c: PoolClient,
) {
  const retiring = typeof changes.status === 'string' && terminal.has(changes.status);
  const teamChange =
    changes.owningTeamId !== undefined && changes.owningTeamId !== before.owning_team_id;
  if (!retiring && !teamChange) return;
  if (before.parent_asset_id)
    throw new ConflictException(
      retiring
        ? 'This item is part of a kit; detach it before retiring it'
        : 'This item is part of a kit; detach it before changing its team',
    );
  const [part] = await db.query(
    'SELECT 1 FROM assets WHERE parent_asset_id=$1 LIMIT 1',
    [before.id],
    c,
  );
  if (part)
    throw new ConflictException(
      retiring
        ? 'This kit still has attached parts; detach them before retiring it'
        : 'This kit still has attached parts; detach them before changing its team',
    );
}

/** Locks the kit's parts after the parent, in id order, so concurrent kit commands cannot deadlock. */
export async function lockKitParts(db: Db, parentId: string, c: PoolClient) {
  return db.query(
    'SELECT * FROM assets WHERE parent_asset_id=$1 ORDER BY id FOR UPDATE',
    [parentId],
    c,
  );
}

/** Applies a parent's assign/reassign to every part: own assignment row, movement, audit. */
export async function cascadeAssign(
  db: Db,
  c: PoolClient,
  actor: Actor,
  parts: any[],
  userId: string,
  kind: 'ASSIGN' | 'REASSIGN',
  reason: string,
  parent: any,
) {
  if (!parts.some((p) => !terminal.has(p.status))) return;
  // The holder may have left or been disabled since the kit was assigned.
  try {
    await eligibleEmployee(db, userId, c, true);
  } catch (error) {
    if (error instanceof NotFoundException)
      throw new UnprocessableEntityException('The kit holder is no longer eligible to hold assets');
    throw error;
  }
  for (const part of parts) {
    if (terminal.has(part.status)) continue; // retired parts stay out of custody
    const [old] = await db.query(
      'SELECT * FROM assignments WHERE asset_id=$1 AND ended_at IS NULL FOR UPDATE',
      [part.id],
      c,
    );
    if (old) {
      await db.query(
        'UPDATE assignments SET ended_at=now(),ended_by=$2,version=version+1 WHERE id=$1',
        [old.id, actor.id],
        c,
      );
      await db.query(
        "INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,'REASSIGNED_OUT',$3)",
        [old.id, actor.id, JSON.stringify({ reason, kit: parent.asset_code })],
        c,
      );
    }
    const [row] = await db.query(
      'INSERT INTO assignments(asset_id,user_id,assigned_by,handover_note) VALUES($1,$2,$3,$4) RETURNING *',
      [part.id, userId, actor.id, `Kit ${parent.asset_code}`],
      c,
    );
    await db.query(
      "UPDATE assets SET status='Assigned',version=version+1,updated_at=now() WHERE id=$1",
      [part.id],
      c,
    );
    await db.query(
      'INSERT INTO asset_movements(asset_id,kind,from_assignment_id,to_assignment_id,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [part.id, old ? 'REASSIGN' : kind, old?.id || null, row.id, reason, actor.id],
      c,
    );
    await db.query(
      "INSERT INTO assignment_events(assignment_id,actor_id,kind) VALUES($1,$2,'ASSIGNED')",
      [row.id, actor.id],
      c,
    );
    await db.audit(c, actor, 'assignment', row.id, old ? 'ASSET_REASSIGNED' : 'ASSET_ASSIGNED', {
      assetId: part.id,
      userId,
      priorAssignmentId: old?.id || null,
      kitParentId: parent.id,
    });
  }
}

/** Applies a parent's return to every part that is currently held. */
export async function cascadeReturn(
  db: Db,
  c: PoolClient,
  actor: Actor,
  parts: any[],
  data: { reason: string; condition: string; locationId?: string | null },
  parent: any,
) {
  for (const part of parts) {
    const [open] = await db.query(
      'SELECT * FROM assignments WHERE asset_id=$1 AND ended_at IS NULL FOR UPDATE',
      [part.id],
      c,
    );
    if (!open) continue;
    const locationId = data.locationId === undefined ? part.location_id : data.locationId;
    await validateAsset(
      db,
      { ...camel(part), condition: data.condition, locationId, status: 'In Store' },
      c,
      camel(part),
    );
    await db.query(
      'UPDATE assignments SET ended_at=now(),ended_by=$2,version=version+1 WHERE id=$1',
      [open.id, actor.id],
      c,
    );
    const updated = await patchObject(
      db,
      'assets',
      part.id,
      { status: 'In Store', condition: data.condition, locationId },
      c,
    );
    await db.query(
      "INSERT INTO asset_movements(asset_id,kind,from_assignment_id,from_location_id,to_location_id,reason,actor_id) VALUES($1,'RETURN',$2,$3,$4,$5,$6)",
      [part.id, open.id, part.location_id, updated.location_id, data.reason, actor.id],
      c,
    );
    await db.query(
      "INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,'RETURNED',$3)",
      [open.id, actor.id, JSON.stringify({ reason: data.reason, kit: parent.asset_code })],
      c,
    );
    await db.audit(c, actor, 'assignment', open.id, 'ASSET_RETURNED', {
      assetId: part.id,
      reason: data.reason,
      kitParentId: parent.id,
    });
  }
}

/** Attach a part to a parent inside the caller's transaction. */
export async function attachPart(
  db: Db,
  c: PoolClient,
  actor: Actor,
  parentId: string,
  data: { partAssetId: string; reason: string },
) {
  if (parentId === data.partAssetId)
    throw new UnprocessableEntityException('An asset cannot be part of itself');
  // Lock both rows in id order whatever the roles, so opposing attaches cannot deadlock.
  const locked = await db.query(
    'SELECT * FROM assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[parentId, data.partAssetId]],
    c,
  );
  const parent = locked.find((a: any) => a.id === parentId);
  const part = locked.find((a: any) => a.id === data.partAssetId);
  if (!parent || !part) {
    throw new NotFoundException();
  }
  assertCan(actor, 'asset.custody', parent.owning_team_id);
  assertCan(actor, 'asset.custody', part.owning_team_id);
  if (parent.owning_team_id !== part.owning_team_id)
    throw new UnprocessableEntityException('Kit parts must belong to the same team as the parent');
  if (parent.parent_asset_id)
    throw new UnprocessableEntityException('A kit part cannot be a kit parent');
  const [hasParts] = await db.query(
    'SELECT 1 FROM assets WHERE parent_asset_id=$1 LIMIT 1',
    [part.id],
    c,
  );
  if (hasParts) throw new UnprocessableEntityException('A kit parent cannot become a part');
  if (part.parent_asset_id) throw new ConflictException('This item is already part of a kit');
  if (terminal.has(parent.status) || terminal.has(part.status))
    throw new ConflictException('Retired assets cannot be in a kit');
  const [partCustody] = await db.query(
    'SELECT user_id FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
    [part.id],
    c,
  );
  const [parentCustody] = await db.query(
    'SELECT user_id FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
    [parent.id],
    c,
  );
  if (partCustody && partCustody.user_id !== parentCustody?.user_id)
    throw new ConflictException(
      'The part must be unassigned or held by the same person as the kit',
    );
  await db.query(
    'UPDATE assets SET parent_asset_id=$2,version=version+1,updated_at=now() WHERE id=$1',
    [part.id, parent.id],
    c,
  );
  await db.query(
    'UPDATE assets SET version=version+1,updated_at=now() WHERE id=$1',
    [parent.id],
    c,
  );
  // A kit is never split between a person and the store.
  if (parentCustody && !partCustody)
    await cascadeAssign(db, c, actor, [part], parentCustody.user_id, 'ASSIGN', data.reason, parent);
  await db.audit(c, actor, 'asset', parent.id, 'KIT_PART_ATTACHED', {
    partAssetId: part.id,
    partAssetCode: part.asset_code,
    reason: data.reason,
  });
}

export async function detachPart(
  db: Db,
  c: PoolClient,
  actor: Actor,
  parentId: string,
  partId: string,
  data: { reason: string },
) {
  // Parent first, then the part: the same order parent assign/return use (lockKitParts).
  const [parent] = await db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [parentId], c);
  if (!parent) throw new NotFoundException();
  const [part] = await db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [partId], c);
  if (!part) throw new NotFoundException();
  assertCan(actor, 'asset.custody', parent.owning_team_id);
  if (part.parent_asset_id !== parent.id)
    throw new ConflictException('This item is not part of that kit');
  await db.query(
    'UPDATE assets SET parent_asset_id=NULL,version=version+1,updated_at=now() WHERE id=$1',
    [part.id],
    c,
  );
  await db.query(
    'UPDATE assets SET version=version+1,updated_at=now() WHERE id=$1',
    [parent.id],
    c,
  );
  await db.audit(c, actor, 'asset', parent.id, 'KIT_PART_DETACHED', {
    partAssetId: part.id,
    partAssetCode: part.asset_code,
    reason: data.reason,
  });
}
