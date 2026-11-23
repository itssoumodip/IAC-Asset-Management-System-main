import { Controller, Get, Inject, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assetCarePage, assetCareSummary } from './asset-care';

const INSURANCE_VIEWERS = ['insurer.view', 'asset.finance_edit', 'report.view'] as const;
import { assertCan } from './policy';

/** Insurance view: insurer-only list — asset name, photo, purchase price, purchase date,
 * repair history; totals by location; export. */
@Injectable()
export class InsuranceService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /**
   * Insurance register: every live asset in scope with its policy, cover end date, value,
   * location, custodian and repair count. Insurer, Finance, leadership and auditors see all
   * assets; team leads and members see their own team's (see asset-care.ts).
   */
  async assets(req: AuthRequest, query: unknown) {
    return assetCarePage(this.db, req.user, [...INSURANCE_VIEWERS], query, 'insurance');
  }

  /** Cover counts, value insured and at risk, biggest gaps (worked out in the database). */
  async summary(req: AuthRequest) {
    return assetCareSummary(this.db, req.user, [...INSURANCE_VIEWERS]);
  }

  async locationTotals(req: AuthRequest) {
    assertCan(req.user, 'insurer.view');
    const rows = await this.db.query(`
      SELECT l.id, l.code, l.name,
             COUNT(a.id)::int AS asset_count,
             COALESCE(SUM(a.purchase_cost)::float8, 0) AS total_purchase_price
      FROM locations l
      LEFT JOIN assets a ON a.location_id = l.id AND a.removed_at IS NULL
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
  assets(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.assets(req, query);
  }

  @Get('summary')
  summary(@Req() req: AuthRequest) {
    return this.service.summary(req);
  }

  @Get('locations')
  locationTotals(@Req() req: AuthRequest) {
    return this.service.locationTotals(req);
  }
}
