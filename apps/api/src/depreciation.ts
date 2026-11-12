import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { withFieldPermissions } from './role-field';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';
import { parse } from './domain-helpers';

/** Depreciation page: per-asset purchase date, capitalisation date, method, rate,
 * current value, depreciated value. Run by period; Companies Act and Income Tax views. */
@Injectable()
export class DepreciationService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest) {
    assertCan(req.user, 'asset.finance_edit');
    const rows = await this.db.query(`
      SELECT
        a.id, a.asset_code, a.description, a.asset_type, a.category,
        a.owning_team_id, t.name AS team_name, a.status,
        a.purchase_date, a.purchase_cost, a.residual_value,
        a.depreciation_method, a.useful_life_years, a.capitalisation_date,
        COALESCE(a.purchase_cost, 0)::float8 AS current_value,
        COALESCE(
          (SELECT ds.accumulated_depreciation
           FROM depreciation_schedules ds
           WHERE ds.asset_id = a.id
           ORDER BY ds.financial_year_start DESC
           LIMIT 1), 0
        )::float8 AS depreciated_value
      FROM assets a
      JOIN teams t ON t.id = a.owning_team_id
      WHERE a.purchase_cost IS NOT NULL
      ORDER BY a.asset_code
    `);
    return withFieldPermissions(this.db, req.user, {
      items: rows.map((r: any) => ({
        id: r.id,
        assetCode: r.asset_code,
        description: r.description,
        assetType: r.asset_type,
        category: r.category,
        owningTeamId: r.owning_team_id,
        teamName: r.team_name,
        status: r.status,
        purchaseDate: r.purchase_date,
        purchaseCost: r.purchase_cost ? Number(r.purchase_cost) : null,
        residualValue: r.residual_value ? Number(r.residual_value) : null,
        depreciationMethod: r.depreciation_method,
        usefulLifeYears: r.useful_life_years,
        capitalisationDate: r.capitalisation_date,
        currentValue: Number(r.current_value),
        depreciatedValue: Number(r.depreciated_value),
      })),
    });
  }

  async schedules(req: AuthRequest, financialYearStart: number) {
    assertCan(req.user, 'asset.finance_edit');
    const rows = await this.db.query(
      `
      SELECT ds.id, a.asset_code, ds.financial_year_start, ds.method, ds.rate,
             ds.purchase_cost, ds.opening_value, ds.depreciation_charge,
             ds.closing_value, ds.accumulated_depreciation
      FROM depreciation_schedules ds
      JOIN assets a ON a.id = ds.asset_id
      WHERE ds.financial_year_start = $1
      ORDER BY a.asset_code
    `,
      [financialYearStart],
    );
    return {
      items: rows.map((r: any) => ({
        id: r.id,
        assetCode: r.asset_code,
        financialYearStart: r.financial_year_start,
        method: r.method,
        rate: Number(r.rate),
        purchaseCost: Number(r.purchase_cost),
        openingValue: Number(r.opening_value),
        depreciationCharge: Number(r.depreciation_charge),
        closingValue: Number(r.closing_value),
        accumulatedDepreciation: Number(r.accumulated_depreciation),
      })),
    };
  }

  async run(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'asset.finance_edit');
    const b = body as { financialYearStart?: number; method?: string };
    const fyStart = parse(z.number().int().min(1900).max(2100), b.financialYearStart) as number;
    const method = parse(z.enum(['SLM', 'WDV']), b.method) as string;

    // Get all assets with purchase cost but no capitalisation date yet
    const assets = await this.db.query(`
      SELECT a.id, a.purchase_cost, a.residual_value, a.depreciation_method,
             a.useful_life_years, a.capitalisation_date, a.purchase_date
      FROM assets a
      WHERE a.purchase_cost IS NOT NULL
    `);

    const results: any[] = [];
    for (const asset of assets) {
      const purchaseCost = Number(asset.purchase_cost);
      const residualValue = Number(asset.residual_value || 0);
      const depMethod = asset.depreciation_method || method;
      const usefulLife = Number(asset.useful_life_years || 5);

      // Determine opening value from last schedule
      const [lastSchedule] = await this.db.query(
        `
        SELECT closing_value FROM depreciation_schedules
        WHERE asset_id = $1 AND financial_year_start < $2
        ORDER BY financial_year_start DESC LIMIT 1
      `,
        [asset.id, fyStart],
      );
      const openingValue = lastSchedule
        ? Number(lastSchedule.closing_value)
        : purchaseCost - residualValue;

      if (openingValue <= 0) continue;

      let depreciationCharge: number;
      if (depMethod === 'SLM') {
        depreciationCharge = (purchaseCost - residualValue) / usefulLife;
      } else {
        // WDV: rate% of opening value
        const rate = Number(asset.depreciation_method ? 15 : 15); // default 15% WDV
        depreciationCharge = openingValue * (rate / 100);
      }
      const closingValue = Math.max(0, openingValue - depreciationCharge);
      const accumulatedDepreciation = purchaseCost - residualValue - closingValue;

      await this.db.query(
        `
        INSERT INTO depreciation_schedules
          (asset_id, financial_year_start, method, rate, purchase_cost,
           opening_value, depreciation_charge, closing_value, accumulated_depreciation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (asset_id, financial_year_start) DO UPDATE SET
          method = EXCLUDED.method,
          rate = EXCLUDED.rate,
          purchase_cost = EXCLUDED.purchase_cost,
          opening_value = EXCLUDED.opening_value,
          depreciation_charge = EXCLUDED.depreciation_charge,
          closing_value = EXCLUDED.closing_value,
          accumulated_depreciation = EXCLUDED.accumulated_depreciation
      `,
        [
          asset.id,
          fyStart,
          depMethod,
          15,
          purchaseCost,
          openingValue,
          depreciationCharge,
          closingValue,
          accumulatedDepreciation,
        ],
      );

      results.push({
        assetId: asset.id,
        method: depMethod,
        openingValue,
        depreciationCharge,
        closingValue,
        accumulatedDepreciation,
      });
    }

    return { financialYearStart: fyStart, method, processed: results.length, results };
  }
}

@Controller('depreciation')
@UseGuards(SessionGuard)
export class DepreciationController {
  constructor(@Inject(DepreciationService) private readonly service: DepreciationService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.service.list(req);
  }

  @Get('schedules')
  schedules(@Req() req: AuthRequest, @Query('fy') fy: string) {
    return this.service.schedules(req, fy ? parseInt(fy, 10) : new Date().getFullYear());
  }

  @Post('run')
  run(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.run(req, body);
  }
}
