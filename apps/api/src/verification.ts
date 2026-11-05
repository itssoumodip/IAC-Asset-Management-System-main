import {
  Body,
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
import { found, parse, text } from './domain-helpers';

@Injectable()
export class VerificationService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async listCycles(req: AuthRequest) {
    assertCan(req.user, 'verification.perform');
    const rows = await this.db.query(`
      SELECT vc.id, vc.cycle_id, vc.location_id, l.name AS location_name,
             vc.status, vc.started_at, vc.completed_at, vc.auditor_id,
             u.display_name AS auditor_name,
             COUNT(DISTINCT vi.asset_id)::int AS total_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'FOUND')::int AS verified_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'NOT_FOUND')::int AS not_found_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'WRONG_PLACE')::int AS wrong_place_items
      FROM verification_cycles vc
      JOIN locations l ON l.id = vc.location_id
      JOIN users u ON u.id = vc.auditor_id
      LEFT JOIN verification_items vi ON vi.cycle_id = vc.id
      GROUP BY vc.id, vc.cycle_id, vc.location_id, l.name, vc.status, vc.started_at, vc.completed_at, vc.auditor_id, u.display_name
      ORDER BY vc.started_at DESC
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      cycleId: r.cycle_id,
      locationId: r.location_id,
      locationName: r.location_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      auditorId: r.auditor_id,
      auditorName: r.auditor_name,
      totalItems: r.total_items,
      verifiedItems: r.verified_items,
      notFoundItems: r.not_found_items,
      wrongPlaceItems: r.wrong_place_items,
    })) };
  }

  async listItems(req: AuthRequest, cycleId: string) {
    assertCan(req.user, 'verification.perform');
    const rows = await this.db.query(`
      SELECT vi.id, a.asset_code, a.description, l.code AS location_code,
             a.status, vi.expected_location, vi.actual_location,
             vi.verification_status, vi.verified_at
      FROM verification_items vi
      JOIN assets a ON a.id = vi.asset_id
      JOIN locations l ON l.id = vi.expected_location_id
      WHERE vi.cycle_id = $1
      ORDER BY a.asset_code
    `, [cycleId]);
    return { items: rows.map((r: any) => ({
      id: r.id,
      assetCode: r.asset_code,
      assetDescription: r.description,
      locationPath: r.location_code,
      status: r.status,
      expectedLocation: r.expected_location,
      actualLocation: r.actual_location,
      verified: r.verification_status === 'FOUND',
      verificationStatus: r.verification_status,
      verifiedAt: r.verified_at,
    })) };
  }

  async startCycle(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'verification.perform');
    const b = body as { locationId?: string; reason?: string };
    const locationId = parse(z.string().uuid(), b.locationId) as string;
    const reason = parse(text(1000), b.reason) as string;

    const [cycle] = await this.db.query(`
      INSERT INTO verification_cycles(cycle_id, location_id, auditor_id, status, started_at, reason)
      SELECT gen_random_uuid(), $1, $2, 'ACTIVE', now(), $3
      RETURNING id, cycle_id
    `, [locationId, req.user.id, reason]);

    return { id: cycle.id, cycleId: cycle.cycle_id };
  }

  async recordItem(req: AuthRequest, cycleId: string, body: unknown) {
    assertCan(req.user, 'verification.perform');
    const b = body as { assetId?: string; verificationStatus?: string; reason?: string };
    const assetId = parse(z.string().uuid(), b.assetId) as string;
    const verificationStatus = parse(
      z.enum(['FOUND', 'NOT_FOUND', 'WRONG_PLACE']),
      b.verificationStatus,
    ) as string;
    const reason = parse(text(1000), b.reason) as string;

    // Verify the cycle exists and is active
    const [cycle] = await this.db.query(
      'SELECT id, status FROM verification_cycles WHERE id=$1 FOR UPDATE',
      [cycleId],
    );
    found(cycle);
    if (cycle.status !== 'ACTIVE')
      throw new UnprocessableEntityException('Verification cycle is not active');

    // Verify the asset exists
    const [asset] = await this.db.query(
      'SELECT id, location_id FROM assets WHERE id=$1 FOR UPDATE',
      [assetId],
    );
    found(asset);

    const actualLocation = verificationStatus === 'WRONG_PLACE' ? asset.location_id : null;
    const expectedLocation = asset.location_id;

    await this.db.query(`
      INSERT INTO verification_items(cycle_id, asset_id, expected_location_id, actual_location_id, verification_status, reason, verified_by, verified_at)
      VALUES($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT(cycle_id, asset_id) DO UPDATE SET
        expected_location_id = EXCLUDED.expected_location_id,
        actual_location_id = EXCLUDED.actual_location_id,
        verification_status = EXCLUDED.verification_status,
        reason = EXCLUDED.reason,
        verified_by = EXCLUDED.verified_by,
        verified_at = now()
    `, [cycleId, assetId, expectedLocation, actualLocation, verificationStatus, reason, req.user.id]);

    return { assetId, verificationStatus, verifiedAt: new Date().toISOString() };
  }

  async completeCycle(req: AuthRequest, cycleId: string) {
    assertCan(req.user, 'verification.perform');
    await this.db.query(
      'UPDATE verification_cycles SET status=\'COMPLETED\', completed_at=now() WHERE id=$1 AND status=\'ACTIVE\'',
      [cycleId],
    );
    return { cycleId, status: 'COMPLETED' };
  }
}

@Controller('verification')
@UseGuards(SessionGuard)
export class VerificationController {
  constructor(@Inject(VerificationService) private readonly service: VerificationService) {}

  @Get('cycles')
  listCycles(@Req() req: AuthRequest) {
    return this.service.listCycles(req);
  }

  @Get('cycles/:id/items')
  listItems(@Req() req: AuthRequest, @Param('id') cycleId: string) {
    return this.service.listItems(req, cycleId);
  }

  @Post('cycles')
  startCycle(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.startCycle(req, body);
  }

  @Post('cycles/:id/items')
  recordItem(@Req() req: AuthRequest, @Param('id') cycleId: string, @Body() body: unknown) {
    return this.service.recordItem(req, cycleId, body);
  }

  @Post('cycles/:id/complete')
  completeCycle(@Req() req: AuthRequest, @Param('id') cycleId: string) {
    return this.service.completeCycle(req, cycleId);
  }
}
