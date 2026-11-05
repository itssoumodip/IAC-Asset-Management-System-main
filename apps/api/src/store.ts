import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';
import { found, parse, text } from './domain-helpers';

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
        COUNT(*) FILTER (WHERE a.status = 'Assigned')::int AS assigned_count
      FROM locations l
      LEFT JOIN assets a ON a.location_id = l.id
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

      const [user] = await this.db.query(
        'SELECT u.id,u.display_name,u.email FROM users u WHERE u.id=$1 AND u.state=\'ACTIVE\' AND u.email_verified_at IS NOT NULL FOR UPDATE',
        [userId],
        c,
      );
      if (!user) throw new UnprocessableEntityException('Eligible employee not found');

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
        'INSERT INTO asset_movements(asset_id,kind,from_assignment_id,to_assignment_id,reason,actor_id) VALUES($1,\'ASSIGN\',NULL,$2,$5,$6)',
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

  async listReturns() {
    const rows = await this.db.query(`
      SELECT a.id, a.asset_code, a.description, a.status,
        u.id as user_id, u.display_name as user_name, u.email as user_email,
        a.assigned_by, a.assigned_at
      FROM assignments a
      JOIN assets ast ON ast.id = a.asset_id
      JOIN users u ON u.id = a.user_id
      WHERE a.ended_at IS NULL
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
      assignedAt: r.assigned_at,
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
  returns() {
    return this.service.listReturns();
  }
}
