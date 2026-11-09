import {
  Controller,
  Get,
  Inject,
  Injectable,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

/** Reports page: fixed asset register, depreciation, verification, assets by location,
 * insurer schedule, maintenance, warranty/AMC expiry, tickets and response times.
 * Each with filters and Excel export. */
@Injectable()
export class ReportsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async fixedAssetRegister(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const rows = await this.db.query(`
      SELECT
        a.id, a.asset_code, a.description, a.category, a.asset_type,
        t.name AS owning_team, l.name AS location, a.status,
        a.purchase_date, a.purchase_cost,
        COALESCE(a.purchase_cost, 0)::float8 AS current_value,
        COALESCE(
          (SELECT ds.accumulated_depreciation
           FROM depreciation_schedules ds
           WHERE ds.asset_id = a.id
           ORDER BY ds.financial_year_start DESC
           LIMIT 1), 0
        )::float8 AS depreciated_value,
        a.serial_number
      FROM assets a
      JOIN teams t ON t.id = a.owning_team_id
      LEFT JOIN locations l ON l.id = a.location_id
      ORDER BY a.asset_code
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      assetCode: r.asset_code,
      description: r.description,
      category: r.category,
      assetType: r.asset_type,
      owningTeam: r.owning_team,
      location: r.location,
      status: r.status,
      purchaseDate: r.purchase_date,
      purchaseCost: r.purchase_cost ? Number(r.purchase_cost) : null,
      currentValue: Number(r.current_value),
      depreciatedValue: Number(r.depreciated_value),
      serialNumber: r.serial_number,
    })) };
  }

  async assetsByLocation(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const rows = await this.db.query(`
      SELECT l.id, l.code, l.name, l.level,
             COUNT(a.id)::int AS asset_count,
             COALESCE(SUM(a.purchase_cost)::float8, 0) AS purchase_value,
             COALESCE(
               (SELECT SUM(ds.accumulated_depreciation)::float8
                FROM depreciation_schedules ds
                JOIN assets a2 ON a2.id = ds.asset_id
                WHERE a2.location_id = l.id
                GROUP BY a2.location_id), 0
             ) AS depreciated_value
      FROM locations l
      LEFT JOIN assets a ON a.location_id = l.id
      GROUP BY l.id, l.code, l.name, l.level
      ORDER BY l.code
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      level: r.level,
      assetCount: r.asset_count,
      purchaseValue: Number(r.purchase_value),
      currentValue: Number(r.purchase_value) - Number(r.depreciated_value),
    })) };
  }

  async warrantyExpiry(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const rows = await this.db.query(`
      SELECT a.id, a.asset_code, a.description, t.name AS owning_team,
             a.warranty_expiry,
             -- date minus date is a whole number of days (date minus now() is an interval).
             (a.warranty_expiry - (now() AT TIME ZONE 'Asia/Kolkata')::date) AS days_remaining
      FROM assets a
      LEFT JOIN teams t ON t.id = a.owning_team_id
      WHERE a.warranty_expiry IS NOT NULL
      ORDER BY a.warranty_expiry
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      assetCode: r.asset_code,
      description: r.description,
      owningTeam: r.owning_team,
      warrantyExpiry: r.warranty_expiry,
      daysRemaining: r.days_remaining,
    })) };
  }

  async ticketResponseTimes(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const rows = await this.db.query(`
      SELECT t.id, t.ticket_number, t.subject, tm.name AS team_name,
             t.status, t.priority, t.created_at, t.completed_at,
             EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600 AS response_time_hours
      FROM tickets t
      JOIN teams tm ON tm.id = t.team_id
      WHERE t.completed_at IS NOT NULL
      ORDER BY t.created_at DESC
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      subject: r.subject,
      teamName: r.team_name,
      status: r.status,
      priority: r.priority,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      responseTimeHours: r.response_time_hours ? Math.round(Number(r.response_time_hours) * 100) / 100 : null,
    })) };
  }

  async verificationReport(req: AuthRequest) {
    assertCan(req.user, 'report.view');
    const rows = await this.db.query(`
      SELECT vc.id, vc.cycle_id, l.name AS location_name, vc.status,
             vc.started_at, vc.completed_at, u.display_name AS auditor_name,
             COUNT(DISTINCT vi.asset_id)::int AS total_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'FOUND')::int AS verified_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'NOT_FOUND')::int AS not_found_items,
             COUNT(*) FILTER (WHERE vi.verification_status = 'WRONG_PLACE')::int AS wrong_place_items
      FROM verification_cycles vc
      JOIN locations l ON l.id = vc.location_id
      JOIN users u ON u.id = vc.auditor_id
      LEFT JOIN verification_items vi ON vi.cycle_id = vc.id
      GROUP BY vc.id, vc.cycle_id, l.name, vc.status, vc.started_at, vc.completed_at, u.display_name
      ORDER BY vc.started_at DESC
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      cycleId: r.cycle_id,
      locationName: r.location_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      auditorName: r.auditor_name,
      totalItems: r.total_items,
      verifiedItems: r.verified_items,
      notFoundItems: r.not_found_items,
      wrongPlaceItems: r.wrong_place_items,
    })) };
  }
}

@Controller('reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly service: ReportsService) {}

  @Get('fixed-asset-register')
  fixedAssetRegister(@Req() req: AuthRequest) {
    return this.service.fixedAssetRegister(req);
  }

  @Get('assets-by-location')
  assetsByLocation(@Req() req: AuthRequest) {
    return this.service.assetsByLocation(req);
  }

  @Get('warranty-expiry')
  warrantyExpiry(@Req() req: AuthRequest) {
    return this.service.warrantyExpiry(req);
  }

  @Get('ticket-response-times')
  ticketResponseTimes(@Req() req: AuthRequest) {
    return this.service.ticketResponseTimes(req);
  }

  @Get('verification')
  verificationReport(@Req() req: AuthRequest) {
    return this.service.verificationReport(req);
  }
}
