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

  /**
   * Snapshot for the verification page: cycles open and finished, results of every check in the
   * last 12 months (found / not found / wrong place), checks per month, how many live assets have
   * been checked this year or never, and the places with the most assets not checked in a year.
   */
  async insights(req: AuthRequest) {
    assertCan(req.user, 'verification.perform');
    const live = `a.removed_at IS NULL AND a.status NOT IN ('Retired','Disposed','Sold','Scrapped','Lost','Stolen')`;
    const [[t], months, stale] = await Promise.all([
      this.db.query(`
        WITH last_check AS (
          SELECT asset_id, max(verified_at) AS at FROM verification_items
           WHERE verification_status <> 'PENDING' GROUP BY asset_id)
        SELECT (SELECT count(*) FROM verification_cycles WHERE status = 'ACTIVE')::int AS active_cycles,
               (SELECT count(*) FROM verification_cycles WHERE status = 'COMPLETED'
                  AND completed_at >= now() - interval '12 months')::int AS completed_cycles,
               (SELECT count(*) FROM verification_items WHERE verification_status = 'FOUND' AND verified_at >= now() - interval '12 months')::int AS found,
               (SELECT count(*) FROM verification_items WHERE verification_status = 'NOT_FOUND' AND verified_at >= now() - interval '12 months')::int AS not_found,
               (SELECT count(*) FROM verification_items WHERE verification_status = 'WRONG_PLACE' AND verified_at >= now() - interval '12 months')::int AS wrong_place,
               count(*)::int AS live_assets,
               count(*) FILTER (WHERE lc.at >= now() - interval '12 months')::int AS checked_this_year,
               count(*) FILTER (WHERE lc.at IS NULL)::int AS never_checked
          FROM assets a LEFT JOIN last_check lc ON lc.asset_id = a.id
         WHERE ${live}`),
      this.db.query(`
        WITH m AS (SELECT generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS month)
        SELECT m.month,
               count(vi.id) FILTER (WHERE vi.verification_status = 'FOUND')::int AS found,
               count(vi.id) FILTER (WHERE vi.verification_status IN ('NOT_FOUND','WRONG_PLACE'))::int AS problems
          FROM m LEFT JOIN verification_items vi
            ON vi.verified_at >= m.month AND vi.verified_at < m.month + interval '1 month'
           AND vi.verification_status <> 'PENDING'
         GROUP BY m.month ORDER BY m.month`),
      this.db.query(`
        WITH last_check AS (
          SELECT asset_id, max(verified_at) AS at FROM verification_items
           WHERE verification_status <> 'PENDING' GROUP BY asset_id)
        SELECT l.id, l.name, count(*)::int AS assets
          FROM assets a JOIN locations l ON l.id = a.location_id
          LEFT JOIN last_check lc ON lc.asset_id = a.id
         WHERE ${live} AND (lc.at IS NULL OR lc.at < now() - interval '12 months')
         GROUP BY l.id, l.name ORDER BY 3 DESC, 2 LIMIT 8`),
    ]);
    return {
      activeCycles: t.active_cycles,
      completedCycles: t.completed_cycles,
      results: { found: t.found, notFound: t.not_found, wrongPlace: t.wrong_place },
      liveAssets: t.live_assets,
      checkedThisYear: t.checked_this_year,
      neverChecked: t.never_checked,
      months: months.map((m: any) => ({ month: m.month, found: m.found, problems: m.problems })),
      staleLocations: stale.map((r: any) => ({ locationId: r.id, name: r.name, assets: r.assets })),
    };
  }

  async listCycles(req: AuthRequest) {
    assertCan(req.user, 'verification.perform');
    const rows = await this.db.query(`
      WITH RECURSIVE cycle_locations AS (
        SELECT vc.id AS cycle_id,vc.location_id FROM verification_cycles vc
        UNION ALL
        SELECT cl.cycle_id,l.id FROM cycle_locations cl JOIN locations l ON l.parent_id=cl.location_id
      ), targets AS (
        SELECT cl.cycle_id,COUNT(DISTINCT a.id)::int AS target_count
        FROM cycle_locations cl JOIN assets a ON a.location_id=cl.location_id
        WHERE a.status NOT IN ('Retired','Disposed','Sold','Scrapped') GROUP BY cl.cycle_id
      )
      SELECT vc.id, vc.cycle_id, vc.location_id, l.name AS location_name,
             vc.status, vc.started_at, vc.completed_at, vc.auditor_id,
             u.display_name AS auditor_name,
             COALESCE(targets.target_count,0)::int AS total_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'FOUND')::int AS verified_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'NOT_FOUND')::int AS not_found_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'WRONG_PLACE')::int AS wrong_place_items
      FROM verification_cycles vc
      JOIN locations l ON l.id = vc.location_id
      JOIN users u ON u.id = vc.auditor_id
      LEFT JOIN verification_items vi ON vi.cycle_id = vc.id
      LEFT JOIN targets ON targets.cycle_id=vc.id
      GROUP BY vc.id, vc.cycle_id, vc.location_id, l.name, vc.status, vc.started_at, vc.completed_at, vc.auditor_id, u.display_name,targets.target_count
      ORDER BY vc.started_at DESC
    `);
    return {
      items: rows.map((r: any) => ({
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
      })),
    };
  }

  async listItems(req: AuthRequest, cycleId: string) {
    assertCan(req.user, 'verification.perform');
    const [cycle] = await this.db.query(
      'SELECT id,location_id FROM verification_cycles WHERE id=$1',
      [cycleId],
    );
    found(cycle);
    const rows = await this.db.query(
      `
      WITH RECURSIVE scope AS (
        SELECT id FROM locations WHERE id=$2
        UNION ALL SELECT l.id FROM locations l JOIN scope s ON l.parent_id=s.id
      )
      SELECT a.id AS asset_id,a.asset_code,a.description,a.status AS asset_status,
             l.code AS location_code,l.name AS location_name,
             COALESCE(vi.verification_status,'PENDING') AS verification_status,
             vi.actual_location_id,actual.name AS actual_location,vi.verified_at
      FROM assets a JOIN scope s ON s.id=a.location_id
      JOIN locations l ON l.id=a.location_id
      LEFT JOIN verification_items vi ON vi.cycle_id=$1 AND vi.asset_id=a.id
      LEFT JOIN locations actual ON actual.id=vi.actual_location_id
      WHERE a.status NOT IN ('Retired','Disposed','Sold','Scrapped')
      ORDER BY a.asset_code
    `,
      [cycleId, cycle.location_id],
    );
    return {
      items: rows.map((r: any) => ({
        id: r.asset_id,
        assetId: r.asset_id,
        assetCode: r.asset_code,
        assetDescription: r.description,
        locationPath: r.location_name,
        status: r.asset_status,
        expectedLocation: r.location_name,
        actualLocation: r.actual_location,
        actualLocationId: r.actual_location_id,
        verified: r.verification_status === 'FOUND',
        verificationStatus: r.verification_status,
        verifiedAt: r.verified_at,
      })),
    };
  }

  async startCycle(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'verification.perform');
    const b = body as { locationId?: string; reason?: string };
    const locationId = parse(z.string().uuid(), b.locationId) as string;
    const reason = parse(text(1000), b.reason) as string;
    const [location] = await this.db.query('SELECT id FROM locations WHERE id=$1 AND active', [
      locationId,
    ]);
    found(location);

    const [cycle] = await this.db.query(
      `
      INSERT INTO verification_cycles(cycle_id, location_id, auditor_id, status, started_at, reason)
      SELECT gen_random_uuid(), $1, $2, 'ACTIVE', now(), $3
      RETURNING id, cycle_id
    `,
      [locationId, req.user.id, reason],
    );

    return { id: cycle.id, cycleId: cycle.cycle_id };
  }

  async recordItem(req: AuthRequest, cycleId: string, body: unknown) {
    assertCan(req.user, 'verification.perform');
    const { assetId, verificationStatus, reason, actualLocationId } = parse(
      z
        .object({
          assetId: z.string().uuid(),
          verificationStatus: z.enum(['FOUND', 'NOT_FOUND', 'WRONG_PLACE']),
          reason: text(1000),
          actualLocationId: z.string().uuid().optional(),
        })
        .strict()
        .superRefine((input, ctx) => {
          if (input.verificationStatus === 'WRONG_PLACE' && !input.actualLocationId)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['actualLocationId'],
              message: 'Choose where the asset was found',
            });
          if (input.verificationStatus !== 'WRONG_PLACE' && input.actualLocationId)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['actualLocationId'],
              message: 'Actual location only applies to wrong-place results',
            });
        }),
      body,
    );

    // Verify the cycle exists and is active
    const [cycle] = await this.db.query(
      'SELECT id, location_id, status FROM verification_cycles WHERE id=$1 FOR UPDATE',
      [cycleId],
    );
    found(cycle);
    if (cycle.status !== 'ACTIVE')
      throw new UnprocessableEntityException('Verification cycle is not active');

    // Verify the asset exists
    const [asset] = await this.db.query(
      `
      WITH RECURSIVE scope AS (
        SELECT id FROM locations WHERE id=$2
        UNION ALL SELECT l.id FROM locations l JOIN scope s ON l.parent_id=s.id
      )
      SELECT a.id,a.location_id FROM assets a JOIN scope s ON s.id=a.location_id
      WHERE a.id=$1 AND a.status NOT IN ('Retired','Disposed','Sold','Scrapped') FOR UPDATE OF a
    `,
      [assetId, cycle.location_id],
    );
    found(asset);

    let actualLocation: string | null = null;
    if (verificationStatus === 'WRONG_PLACE') {
      const [location] = await this.db.query('SELECT id FROM locations WHERE id=$1 AND active', [
        actualLocationId,
      ]);
      found(location);
      actualLocation = actualLocationId!;
      if (actualLocation === asset.location_id)
        throw new UnprocessableEntityException(
          'The actual location must differ from the expected location',
        );
    }
    const expectedLocation = asset.location_id;

    await this.db.query(
      `
      INSERT INTO verification_items(cycle_id, asset_id, expected_location_id, actual_location_id, verification_status, reason, verified_by, verified_at)
      VALUES($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT(cycle_id, asset_id) DO UPDATE SET
        expected_location_id = EXCLUDED.expected_location_id,
        actual_location_id = EXCLUDED.actual_location_id,
        verification_status = EXCLUDED.verification_status,
        reason = EXCLUDED.reason,
        verified_by = EXCLUDED.verified_by,
        verified_at = now()
    `,
      [cycleId, assetId, expectedLocation, actualLocation, verificationStatus, reason, req.user.id],
    );

    return { assetId, verificationStatus, verifiedAt: new Date().toISOString() };
  }

  async completeCycle(req: AuthRequest, cycleId: string) {
    assertCan(req.user, 'verification.perform');
    return this.db.tx(async (client) => {
      const [cycle] = await this.db.query(
        'SELECT id,location_id,status FROM verification_cycles WHERE id=$1 FOR UPDATE',
        [cycleId],
        client,
      );
      found(cycle);
      if (cycle.status !== 'ACTIVE')
        throw new UnprocessableEntityException('Verification cycle is not active');
      const [{ pending }] = await this.db.query(
        `WITH RECURSIVE scope AS (
           SELECT id FROM locations WHERE id=$1
           UNION ALL SELECT l.id FROM locations l JOIN scope s ON l.parent_id=s.id
         )
         SELECT COUNT(a.id)::int AS pending FROM assets a JOIN scope s ON s.id=a.location_id
         LEFT JOIN verification_items vi ON vi.cycle_id=$2 AND vi.asset_id=a.id
         WHERE a.status NOT IN ('Retired','Disposed','Sold','Scrapped')
           AND (vi.id IS NULL OR vi.verification_status='PENDING')`,
        [cycle.location_id, cycleId],
        client,
      );
      if (pending)
        throw new UnprocessableEntityException(
          `${pending} asset${pending === 1 ? '' : 's'} still need a verification result`,
        );
      await this.db.query(
        "UPDATE verification_cycles SET status='COMPLETED',completed_at=now() WHERE id=$1",
        [cycleId],
        client,
      );
      return { cycleId, status: 'COMPLETED' };
    });
  }
}

@Controller('verification')
@UseGuards(SessionGuard)
export class VerificationController {
  constructor(@Inject(VerificationService) private readonly service: VerificationService) {}

  @Get('insights')
  insights(@Req() req: AuthRequest) {
    return this.service.insights(req);
  }

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
