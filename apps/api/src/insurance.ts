import { Controller, Get, Inject, Injectable, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { withFieldPermissions } from './role-field';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

/** Insurance view: insurer-only list — asset name, photo, purchase price, purchase date,
 * repair history; totals by location; export. */
@Injectable()
export class InsuranceService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async assets(req: AuthRequest) {
    assertCan(req.user, 'insurer.view');
    const rows = await this.db.query(`
      SELECT
        a.id, a.asset_code, a.description, a.category, a.asset_type,
        a.purchase_date, a.purchase_cost, l.name AS location,
        a.status,
        COUNT(wo.id)::int AS repair_count
      FROM assets a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN tickets wo ON wo.asset_id = a.id AND wo.category = 'HARDWARE' AND wo.status <> 'OPEN'
      GROUP BY a.id, a.asset_code, a.description, a.category, a.asset_type,
               a.purchase_date, a.purchase_cost, l.name, a.status
      ORDER BY a.asset_code
    `);
    return withFieldPermissions(this.db, req.user, {
      items: rows.map((r: any) => ({
        id: r.id,
        assetCode: r.asset_code,
        description: r.description,
        category: r.category,
        assetType: r.asset_type,
        purchaseDate: r.purchase_date,
        purchaseCost: r.purchase_cost ? Number(r.purchase_cost) : null,
        location: r.location,
        status: r.status,
        repairCount: r.repair_count,
      })),
    });
  }

  async locationTotals(req: AuthRequest) {
    assertCan(req.user, 'insurer.view');
    const rows = await this.db.query(`
      SELECT l.id, l.code, l.name,
             COUNT(a.id)::int AS asset_count,
             COALESCE(SUM(a.purchase_cost)::float8, 0) AS total_purchase_price
      FROM locations l
      LEFT JOIN assets a ON a.location_id = l.id
      GROUP BY l.id, l.code, l.name
      ORDER BY l.code
    `);
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        assetCount: r.asset_count,
        totalPurchasePrice: Number(r.total_purchase_price),
      })),
    };
  }
}

@Controller('insurance')
@UseGuards(SessionGuard)
export class InsuranceController {
  constructor(@Inject(InsuranceService) private readonly service: InsuranceService) {}

  @Get()
  assets(@Req() req: AuthRequest) {
    return this.service.assets(req);
  }

  @Get('locations')
  locationTotals(@Req() req: AuthRequest) {
    return this.service.locationTotals(req);
  }
}
