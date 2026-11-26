import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';
import {
  camel,
  eligibleEmployee,
  found,
  parse,
  patchObject,
  text,
  validateAsset,
} from './domain-helpers';
import { assertNotKitPart, cascadeReturn, lockKitParts } from './asset-kits';

/** Asset status and condition code recorded for each inspected return condition. */
const RETURN_OUTCOMES = {
  Good: { status: 'In Store', condition: 'Good' },
  'Needs repair': { status: 'Under Repair', condition: 'Poor' },
  Damaged: { status: 'Under Repair', condition: 'Damaged' },
} as const;

const receiveReturnInput = z
  .object({
    condition: z.enum(['Good', 'Needs repair', 'Damaged']),
    locationId: z.string().uuid(),
    note: text(1000).optional(),
  })
  .strict();

@Injectable()
export class StoreService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async listStore(req: AuthRequest) {
    assertCan(req.user, 'store.operations');

    const rows = await this.db.query(`
      SELECT
        l.id,
        l.code,
        l.name,
        l.level,
        l.parent_id,
        COUNT(a.id)::int AS asset_count,
        COALESCE(SUM(a.purchase_cost)::float8, 0) AS purchase_value,
        COUNT(*) FILTER (WHERE a.status = 'In Store')::int AS in_store_count,
        COUNT(*) FILTER (WHERE a.status IN ('Assigned','In Use'))::int AS assigned_count
      FROM locations l
      LEFT JOIN assets a ON a.location_id = l.id AND a.removed_at IS NULL
      WHERE l.level = 'STORE' OR l.level = 'RACK'
      GROUP BY l.id, l.code, l.name, l.level, l.parent_id
      ORDER BY l.code
    `);

    return { items: rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      level: r.level,
      parentId: r.parent_id,
      assetCount: r.asset_count,
      inStoreCount: r.in_store_count,
      assignedCount: r.assigned_count,
      purchaseValue: Number(r.purchase_value || 0),
    })) };
  }

  async receive(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'store.operations');
    const b = body as { assetId?: string; locationId?: string; reason?: string };
    const assetId = parse(z.string().uuid(), b.assetId) as string;
    const locationId = parse(z.string().uuid(), b.locationId) as string;
    const reason = parse(text(1000), b.reason) as string;

    return this.db.tx(async (c) => {
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );

      if (asset.status !== 'In Store' && asset.status !== 'Ready to Assign') {
        throw new UnprocessableEntityException('Asset must be In Store or Ready to Assign to receive');
      }

      const [updated] = await this.db.query(
        'UPDATE assets SET location_id=$1, status=\'In Store\', version=version+1, updated_at=now() WHERE id=$2 RETURNING id, asset_code, location_id',
        [locationId, assetId],
        c,
      );

      await this.db.query(
        'INSERT INTO asset_movements(asset_id,kind,from_location_id,to_location_id,reason,actor_id) VALUES($1,\'RELOCATE\',$2,$3,$4,$5)',
        [assetId, asset.location_id, locationId, reason, req.user.id],
        c,
      );

      await this.db.audit(c, req.user, 'asset', assetId, 'ASSET_RECEIVED', {
        reason,
        locationId,
      });

      return { id: updated.id, assetCode: updated.asset_code, locationId: updated.location_id };
    });
  }

  async issue(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'store.operations');
    const b = body as { assetId?: string; userId?: string; reason?: string };
    const assetId = parse(z.string().uuid(), b.assetId) as string;
    const userId = parse(z.string().uuid(), b.userId) as string;
    const reason = parse(text(1000), b.reason) as string;

    return this.db.tx(async (c) => {
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );

      if (asset.status !== 'In Store' && asset.status !== 'Ready to Assign') {
        throw new UnprocessableEntityException('Asset must be In Store or Ready to Assign to issue');
      }

      // Same eligibility rule as assigning from the asset page (includes directory-only people).
      const user = await eligibleEmployee(this.db, userId, c).catch(() => {
        throw new UnprocessableEntityException('Eligible employee not found');
      });

      await this.db.query(
        'UPDATE assets SET status=\'Assigned\', version=version+1, updated_at=now() WHERE id=$1 RETURNING *',
        [assetId],
        c,
      );

      const [assignment] = await this.db.query(
        'INSERT INTO assignments(asset_id,user_id,assigned_by,handover_note,version) VALUES($1,$2,$3,$4,1) RETURNING *',
        [assetId, userId, req.user.id, reason || null],
        c,
      );

      await this.db.query(
        'INSERT INTO asset_movements(asset_id,kind,from_assignment_id,to_assignment_id,reason,actor_id) VALUES($1,\'ASSIGN\',NULL,$2,$3,$4)',
        [assetId, assignment.id, reason, req.user.id],
        c,
      );

      await this.db.audit(c, req.user, 'asset', assetId, 'ASSET_ISSUED', {
        reason,
        userId,
        locationId: asset.location_id,
      });

      return { id: assignment.id, assetId: asset.id, userId: user.id };
    });
  }

  async listReturns(req: AuthRequest) {
    assertCan(req.user, 'store.operations');
    const rows = await this.db.query(`
      SELECT a.id, a.asset_id, ast.asset_code, ast.description, ast.status,
        u.id as user_id, u.display_name as user_name, u.email as user_email,
        u.designation AS user_designation, (u.left_at IS NOT NULL) AS user_left,
        EXISTS(SELECT 1 FROM user_photos up WHERE up.user_id = u.id) AS user_has_photo,
        a.assigned_by, a.assigned_at
      FROM assignments a
      JOIN assets ast ON ast.id = a.asset_id
      JOIN users u ON u.id = a.user_id
      WHERE a.ended_at IS NULL AND ast.removed_at IS NULL
      ORDER BY a.assigned_at DESC
    `);

    return { items: rows.map((r: any) => ({
      id: r.id,
      assetId: r.asset_id,
      assetCode: r.asset_code,
      description: r.description,
      status: r.status,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      userDesignation: r.user_designation,
      userLeft: r.user_left,
      userHasPhoto: r.user_has_photo,
      assignedAt: r.assigned_at,
    })) };
  }

  /** Closes custody like returnAsset (same locks, movement, events, kit cascade) and applies the inspected condition. */
  async receiveReturn(req: AuthRequest, assignmentId: string, body: unknown) {
    assertCan(req.user, 'store.operations');
    parse(z.string().uuid(), assignmentId);
    const data = parse(receiveReturnInput, body);
    const outcome = RETURN_OUTCOMES[data.condition];
    const note = data.note?.trim() || null;
    const reason = note || `Returned to store (${data.condition})`;

    return this.db.tx(async (c) => {
      // Lock the asset before the assignment, as every custody command does.
      const hint = found(
        (await this.db.query('SELECT asset_id FROM assignments WHERE id=$1', [assignmentId], c))[0],
      );
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [hint.asset_id], c))[0],
      );
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
      if (row.ended_at) throw new ConflictException('Assignment already ended');

      // Any active location: returned items may go back to an ordinary room, not only a Store/Rack.
      const [location] = await this.db.query(
        'SELECT id FROM locations WHERE id=$1 AND active',
        [data.locationId],
        c,
      );
      if (!location) throw new UnprocessableEntityException('Choose an active location');

      await validateAsset(
        this.db,
        {
          ...camel(asset),
          condition: outcome.condition,
          locationId: data.locationId,
          status: outcome.status,
        },
        c,
        camel(asset),
      );
      await this.db.query(
        'UPDATE assignments SET ended_at=now(),ended_by=$2,version=version+1 WHERE id=$1',
        [assignmentId, req.user.id],
        c,
      );
      const updated = await patchObject(
        this.db,
        'assets',
        asset.id,
        { status: outcome.status, condition: outcome.condition, locationId: data.locationId },
        c,
      );
      await this.db.query(
        "INSERT INTO asset_movements(asset_id,kind,from_assignment_id,from_location_id,to_location_id,reason,actor_id) VALUES($1,'RETURN',$2,$3,$4,$5,$6)",
        [asset.id, assignmentId, asset.location_id, data.locationId, reason, req.user.id],
        c,
      );
      await this.db.query(
        "INSERT INTO assignment_events(assignment_id,actor_id,kind,details) VALUES($1,$2,'RETURNED',$3)",
        [assignmentId, req.user.id, JSON.stringify({ reason, condition: data.condition })],
        c,
      );
      await this.db.audit(c, req.user, 'assignment', assignmentId, 'ASSET_RETURNED', {
        assetId: asset.id,
        reason,
      });
      await this.db.audit(c, req.user, 'asset', asset.id, 'STORE_RETURN_RECEIVED', {
        assignmentId,
        condition: data.condition,
        status: outcome.status,
        locationId: data.locationId,
        note,
      });
      await cascadeReturn(
        this.db,
        c,
        req.user,
        await lockKitParts(this.db, asset.id, c),
        { reason, condition: outcome.condition, locationId: data.locationId },
        asset,
      );
      await this.db.notify(
        c,
        `assignment:${assignmentId}:ended`,
        'ASSIGNMENT_ENDED',
        row.holder_state === 'DIRECTORY' ? [] : [row.email],
        {
          subject: `Asset ${asset.asset_code} returned`,
          text: 'Your custody record was closed. Sign in to review your assigned assets.',
        },
      );
      return {
        assignmentId,
        assetId: asset.id,
        assetCode: asset.asset_code,
        status: updated.status,
        condition: updated.condition,
        locationId: updated.location_id,
      };
    });
  }

  /**
   * Store snapshot: what can be issued now, what is with staff or in repair, the value sitting in
   * store, stock by product type and condition, and receive/issue/return counts for 8 weeks.
   */
  async summary(req: AuthRequest) {
    assertCan(req.user, 'store.operations');
    const live = 'a.removed_at IS NULL';
    const [[counts], byType, byCondition, weeks] = await Promise.all([
      this.db.query(`
        SELECT count(*) FILTER (WHERE a.status IN ('In Store','Ready to Assign'))::int AS ready,
               count(*) FILTER (WHERE a.status = 'Under Repair')::int AS repair,
               count(*) FILTER (WHERE EXISTS(SELECT 1 FROM assignments g WHERE g.asset_id=a.id AND g.ended_at IS NULL))::int AS with_staff,
               coalesce(sum(a.purchase_cost) FILTER (WHERE a.status IN ('In Store','Ready to Assign')),0)::float8 AS store_value,
               count(*)::int AS total
          FROM assets a WHERE ${live}`),
      this.db.query(`
        SELECT coalesce(nullif(a.asset_type,''),'Unspecified') AS label, count(*)::int AS value
          FROM assets a WHERE ${live} AND a.status IN ('In Store','Ready to Assign')
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`),
      this.db.query(`
        SELECT coalesce(a.condition,'Unknown') AS label, count(*)::int AS value
          FROM assets a WHERE ${live} AND a.status IN ('In Store','Ready to Assign','Under Repair')
         GROUP BY 1 ORDER BY 2 DESC`),
      this.db.query(`
        WITH w AS (
          SELECT generate_series(date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') - interval '7 weeks',
                                 date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata'), interval '1 week') AS week_start)
        SELECT w.week_start,
               count(e.id) FILTER (WHERE e.action IN ('ASSET_RECEIVED','STORE_RETURN_RECEIVED'))::int AS received,
               count(e.id) FILTER (WHERE e.action = 'ASSET_ISSUED')::int AS issued
          FROM w LEFT JOIN audit_events e
            ON e.entity_type = 'asset'
           AND e.action IN ('ASSET_RECEIVED','ASSET_ISSUED','STORE_RETURN_RECEIVED')
           AND e.occurred_at AT TIME ZONE 'Asia/Kolkata' >= w.week_start
           AND e.occurred_at AT TIME ZONE 'Asia/Kolkata' < w.week_start + interval '1 week'
         GROUP BY w.week_start ORDER BY w.week_start`),
    ]);
    const sum = (key: 'received' | 'issued', last: number) =>
      weeks.slice(-last).reduce((s: number, w: any) => s + w[key], 0);
    return {
      readyToIssue: counts.ready,
      underRepair: counts.repair,
      withStaff: counts.with_staff,
      storeValue: Number(counts.store_value),
      totalAssets: counts.total,
      receivedLast4Weeks: sum('received', 4),
      issuedLast4Weeks: sum('issued', 4),
      byType,
      byCondition,
      weeks: weeks.map((w: any) => ({ weekStart: w.week_start, received: w.received, issued: w.issued })),
    };
  }

  async listActivity(req: AuthRequest) {    assertCan(req.user, 'store.operations');
    const rows = await this.db.query(`
      SELECT e.id, e.occurred_at, e.action, ast.asset_code,
        u.display_name AS actor_name, l.code AS location_code, l.name AS location_name
      FROM audit_events e
      JOIN assets ast ON ast.id = e.entity_id
      LEFT JOIN users u ON u.id = e.actor_id
      LEFT JOIN locations l ON l.id::text = e.changes->>'locationId'
      WHERE e.entity_type = 'asset'
        AND e.action IN ('ASSET_RECEIVED','ASSET_ISSUED','STORE_RETURN_RECEIVED')
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 20
    `);

    return { items: rows.map((r: any) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      action: r.action,
      assetCode: r.asset_code,
      actorName: r.actor_name,
      locationName: r.location_name || r.location_code || null,
    })) };
  }
}

@Controller('store')
@UseGuards(SessionGuard)
export class StoreController {
  constructor(@Inject(StoreService) private readonly service: StoreService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.service.listStore(req);
  }

  @Post('receive')
  receive(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.receive(req, body);
  }

  @Post('issue')
  issue(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.issue(req, body);
  }

  @Get('returns')
  returns(@Req() req: AuthRequest) {
    return this.service.listReturns(req);
  }

  @Post('returns/:assignmentId/receive')
  receiveReturn(
    @Req() req: AuthRequest,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
  ) {
    return this.service.receiveReturn(req, assignmentId, body);
  }

  @Get('summary')
  summary(@Req() req: AuthRequest) {
    return this.service.summary(req);
  }

  @Get('activity')
  activity(@Req() req: AuthRequest) {
    return this.service.listActivity(req);
  }
}
