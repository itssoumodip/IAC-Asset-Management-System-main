import {
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { withFieldPermissions } from './role-field';
import { AuthRequest, SessionGuard, assertVersion } from './security';
import { assertCan } from './policy';
import { parse } from './domain-helpers';

export function calculateDepreciationCharge(input: {
  calculationType: 'SLM' | 'WDV';
  purchaseCost: number;
  residualValue: number;
  openingValue: number;
  usefulLifeYears: number;
  ratePercent: number;
}): number {
  return input.calculationType === 'SLM'
    ? (input.purchaseCost - input.residualValue) / input.usefulLifeYears
    : input.openingValue * (input.ratePercent / 100);
}

/** Depreciation page: per-asset purchase date, capitalisation date, method, rate,
 * current value, depreciated value. Run by period; Companies Act and Income Tax views. */
@Injectable()
export class DepreciationService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async methods(req: AuthRequest) {
    assertCan(req.user, 'asset.finance_edit');
    const rows = await this.db.query(`
      SELECT rv.code, rv.label, rv.active, rv.version,
             COALESCE(rule.calculation_type, 'WDV') AS "calculationType",
             rule.rate_percent AS "ratePercent", rule.team_id AS "teamId",
             t.name AS "teamName", rule.category_code AS "categoryCode",
             category.label AS "categoryLabel"
      FROM reference_values rv
      LEFT JOIN depreciation_method_rules rule ON rule.method_code=rv.code
      LEFT JOIN teams t ON t.id=rule.team_id
      LEFT JOIN reference_values category
        ON category.kind='CATEGORY' AND category.code=rule.category_code
      WHERE rv.kind='DEPRECIATION_METHOD'
      ORDER BY rv.active DESC, rv.label, rv.code
    `);
    return { items: rows.map((row: any) => ({
      code: row.code,
      label: row.label,
      active: row.active,
      version: row.version,
      calculationType: row.calculationType,
      ratePercent: row.ratePercent == null ? null : Number(row.ratePercent),
      teamId: row.teamId,
      teamName: row.teamName,
      categoryCode: row.categoryCode,
      categoryLabel: row.categoryLabel,
    })) };
  }

  async createMethod(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'depreciation.manage_methods');
    const input = parse(z.object({
      label: z.string().trim().min(1).max(150),
      calculationType: z.enum(['SLM', 'WDV']),
      ratePercent: z.number().positive().max(100).nullable().optional(),
      teamId: z.string().uuid().nullable().optional(),
      categoryCode: z.string().trim().min(1).max(100).nullable().optional(),
      reason: z.string().trim().min(1).max(1000),
    }).strict(), body);
    if (input.calculationType === 'WDV' && !input.ratePercent)
      throw new UnprocessableEntityException('WDV methods need an annual rate above 0%');
    return this.db.tx(async (c) => {
      await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('iac-depreciation-methods',0))", [], c);
      const baseCode = input.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 75) || 'METHOD';
      if (input.teamId) {
        const [team] = await this.db.query('SELECT id FROM teams WHERE id=$1 AND active FOR SHARE', [input.teamId], c);
        if (!team) throw new UnprocessableEntityException('Choose an active team');
      }
      if (input.categoryCode) {
        const [category] = await this.db.query(
          `SELECT code FROM reference_values WHERE kind='CATEGORY' AND code=$1 AND active FOR SHARE`,
          [input.categoryCode], c,
        );
        if (!category) throw new UnprocessableEntityException('Choose an active asset category');
      }
      const duplicate = await this.db.query(
        `SELECT rv.code FROM reference_values rv JOIN depreciation_method_rules rule ON rule.method_code=rv.code
         WHERE rv.kind='DEPRECIATION_METHOD' AND lower(rv.label)=lower($1)
           AND rule.team_id IS NOT DISTINCT FROM $2::uuid
           AND rule.category_code IS NOT DISTINCT FROM $3::text`,
        [input.label, input.teamId ?? null, input.categoryCode ?? null], c,
      );
      if (duplicate.length) throw new ConflictException('A method with this name already exists for that team and category');
      let code = baseCode;
      let suffix = 2;
      while ((await this.db.query(
        `SELECT code FROM reference_values WHERE kind='DEPRECIATION_METHOD' AND code=$1`, [code], c,
      )).length) {
        code = `${baseCode.slice(0, 75 - String(suffix).length)}_${suffix++}`;
      }
      await this.db.query(
        `INSERT INTO reference_values(kind,code,label,active)
         VALUES('DEPRECIATION_METHOD',$1,$2,true)`, [code, input.label], c,
      );
      const [row] = await this.db.query(
        `INSERT INTO depreciation_method_rules(method_code,calculation_type,rate_percent,team_id,category_code)
         VALUES($1,$2,$3,$4,$5) RETURNING method_code AS code, calculation_type AS "calculationType",
         rate_percent AS "ratePercent",team_id AS "teamId",category_code AS "categoryCode"`,
        [code, input.calculationType, input.calculationType === 'WDV' ? input.ratePercent : null,
          input.teamId ?? null, input.categoryCode ?? null], c,
      );
      await this.db.audit(c, req.user, 'depreciation_method', null, 'METHOD_CREATED', {
        ...row, label: input.label, reason: input.reason,
      });
      return { ...row, label: input.label, active: true };
    });
  }

  async updateMethod(req: AuthRequest, code: string, body: unknown) {
    assertCan(req.user, 'depreciation.manage_methods');
    const input = parse(z.object({
      label: z.string().trim().min(1).max(150),
      calculationType: z.enum(['SLM', 'WDV']),
      ratePercent: z.number().positive().max(100).nullable().optional(),
      teamId: z.string().uuid().nullable().optional(),
      categoryCode: z.string().trim().min(1).max(100).nullable().optional(),
      active: z.boolean(),
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(1000),
    }).strict(), body);
    if (input.calculationType === 'WDV' && !input.ratePercent)
      throw new UnprocessableEntityException('WDV methods need an annual rate above 0%');
    return this.db.tx(async (c) => {
      const [before] = await this.db.query(
        `SELECT code,label,active,version FROM reference_values
         WHERE kind='DEPRECIATION_METHOD' AND code=$1 FOR UPDATE`, [code], c,
      );
      if (!before) throw new UnprocessableEntityException('Depreciation method not found');
      assertVersion(req, before.version);
      if (input.teamId) {
        const [team] = await this.db.query('SELECT id FROM teams WHERE id=$1 AND active FOR SHARE', [input.teamId], c);
        if (!team) throw new UnprocessableEntityException('Choose an active team');
      }
      if (input.categoryCode) {
        const [category] = await this.db.query(
          `SELECT code FROM reference_values WHERE kind='CATEGORY' AND code=$1 AND active FOR SHARE`,
          [input.categoryCode], c,
        );
        if (!category) throw new UnprocessableEntityException('Choose an active asset category');
      }
      const duplicate = await this.db.query(
        `SELECT rv.code FROM reference_values rv JOIN depreciation_method_rules rule ON rule.method_code=rv.code
         WHERE rv.kind='DEPRECIATION_METHOD' AND rv.code<>$1 AND lower(rv.label)=lower($2)
           AND rule.team_id IS NOT DISTINCT FROM $3::uuid
           AND rule.category_code IS NOT DISTINCT FROM $4::text`,
        [code, input.label, input.teamId ?? null, input.categoryCode ?? null], c,
      );
      if (duplicate.length) throw new ConflictException('Another method already uses this name for that team and category');
      const [after] = await this.db.query(
        `UPDATE reference_values SET label=$2,active=$3,version=version+1,updated_at=now()
         WHERE kind='DEPRECIATION_METHOD' AND code=$1
         RETURNING code,label,active,version`, [code, input.label, input.active], c,
      );
      await this.db.query(
        `INSERT INTO depreciation_method_rules(method_code,calculation_type,rate_percent,team_id,category_code)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(method_code) DO UPDATE SET
         calculation_type=EXCLUDED.calculation_type,rate_percent=EXCLUDED.rate_percent,
         team_id=EXCLUDED.team_id,category_code=EXCLUDED.category_code,updated_at=now()`,
        [code, input.calculationType, input.calculationType === 'WDV' ? input.ratePercent : null,
          input.teamId ?? null, input.categoryCode ?? null], c,
      );
      await this.db.audit(c, req.user, 'depreciation_method', null, 'METHOD_UPDATED', {
        code, reason: input.reason, before, after,
        calculationType: input.calculationType,
        ratePercent: input.calculationType === 'WDV' ? input.ratePercent : null,
        teamId: input.teamId ?? null,
        categoryCode: input.categoryCode ?? null,
      });
      return { ...after, calculationType: input.calculationType,
        ratePercent: input.calculationType === 'WDV' ? input.ratePercent : null,
        teamId: input.teamId ?? null, categoryCode: input.categoryCode ?? null };
    });
  }

  async deleteMethod(req: AuthRequest, code: string) {
    assertCan(req.user, 'depreciation.manage_methods');
    return this.db.tx(async (c) => {
      const [before] = await this.db.query(
        `SELECT code,label,active,version FROM reference_values
         WHERE kind='DEPRECIATION_METHOD' AND code=$1 FOR UPDATE`, [code], c,
      );
      if (!before) throw new UnprocessableEntityException('Depreciation method not found');
      if (before.active) throw new ConflictException('Deactivate the method before deleting it');
      const usage = await this.db.query(
        `SELECT EXISTS(SELECT 1 FROM assets WHERE depreciation_method=$1) AS used_by_asset,
                EXISTS(SELECT 1 FROM depreciation_schedules WHERE method=$1) AS used_by_schedule`,
        [code], c,
      );
      if (usage[0]?.used_by_asset || usage[0]?.used_by_schedule)
        throw new ConflictException('This method is used by assets or depreciation schedules. Keep it inactive for history.');
      await this.db.query('DELETE FROM depreciation_method_rules WHERE method_code=$1', [code], c);
      await this.db.query(`DELETE FROM reference_values WHERE kind='DEPRECIATION_METHOD' AND code=$1`, [code], c);
      await this.db.audit(c, req.user, 'depreciation_method', null, 'METHOD_DELETED', { before });
      return { deleted: true, code };
    });
  }

  async list(req: AuthRequest) {
    assertCan(req.user, 'asset.finance_edit');
    const rows = await this.db.query(`
      SELECT
        a.id, a.asset_code, a.description, a.asset_type, a.category,
        a.owning_team_id, t.name AS team_name, a.status,
        a.purchase_date, a.purchase_cost, a.residual_value,
        COALESCE(method_ref.label, a.depreciation_method) AS depreciation_method,
        a.useful_life_years, a.capitalisation_date,
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
      LEFT JOIN reference_values method_ref
        ON method_ref.kind='DEPRECIATION_METHOD' AND method_ref.code=a.depreciation_method
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
    const methodCode = parse(z.string().trim().min(1).max(100), b.method) as string;
    const [defaultMethod] = await this.db.query(`
      SELECT rv.code, COALESCE(rule.calculation_type, 'WDV') AS calculation_type,
             COALESCE(rule.rate_percent, 15)::float8 AS rate_percent
      FROM reference_values rv LEFT JOIN depreciation_method_rules rule ON rule.method_code=rv.code
      WHERE rv.kind='DEPRECIATION_METHOD' AND rv.code=$1 AND rv.active`, [methodCode]);
    if (!defaultMethod) throw new UnprocessableEntityException('Choose an active depreciation method');

    // One statement for the whole register (fast at tens of thousands of assets, and all or
    // nothing): opening value is last year's closing value, or cost less residual for a first
    // year; assets already written down to zero are skipped. SLM charges (cost − residual) /
    // useful life; WDV charges the method's rate on the opening value. Useful life defaults to 5.
    const results = await this.db.query(
      `
      WITH last AS MATERIALIZED (
        -- Each asset's most recent earlier closing value, read once before anything is written
        -- (a per-asset lookup would rescan the table as it grows during the insert).
        SELECT DISTINCT ON (ds.asset_id) ds.asset_id, ds.closing_value
          FROM depreciation_schedules ds
         WHERE ds.financial_year_start < $2
         ORDER BY ds.asset_id, ds.financial_year_start DESC
      ),
      base AS (
        SELECT a.id,
               a.purchase_cost AS cost,
               coalesce(a.residual_value, 0) AS residual,
               coalesce(nullif(a.useful_life_years, 0), 5) AS life,
               COALESCE(asset_rule.calculation_type, default_rule.calculation_type, 'WDV') AS calculation_type,
               COALESCE(asset_rule.rate_percent, default_rule.rate_percent, 15) AS rate_percent,
               last.closing_value AS last_closing
          FROM assets a
          LEFT JOIN last ON last.asset_id = a.id
          LEFT JOIN depreciation_method_rules asset_rule ON asset_rule.method_code = a.depreciation_method
          LEFT JOIN depreciation_method_rules default_rule ON default_rule.method_code = $1
         WHERE a.purchase_cost IS NOT NULL AND a.removed_at IS NULL
      ),
      opened AS (
        SELECT *, coalesce(last_closing, cost - residual) AS opening FROM base
      ),
      charged AS (
        SELECT *,
               CASE WHEN calculation_type = 'SLM' THEN (cost - residual) / life
                    ELSE opening * (rate_percent / 100) END AS charge
          FROM opened WHERE opening > 0
      )
      INSERT INTO depreciation_schedules
        (asset_id, financial_year_start, method, rate, purchase_cost,
         opening_value, depreciation_charge, closing_value, accumulated_depreciation)
      SELECT id, $2, calculation_type,
             CASE WHEN calculation_type = 'SLM' THEN round(100.0 / life, 2) ELSE rate_percent END,
             cost, opening, charge, greatest(0, opening - charge),
             cost - residual - greatest(0, opening - charge)
        FROM charged
      ON CONFLICT (asset_id, financial_year_start) DO UPDATE SET
        method = EXCLUDED.method,
        rate = EXCLUDED.rate,
        purchase_cost = EXCLUDED.purchase_cost,
        opening_value = EXCLUDED.opening_value,
        depreciation_charge = EXCLUDED.depreciation_charge,
        closing_value = EXCLUDED.closing_value,
        accumulated_depreciation = EXCLUDED.accumulated_depreciation
      RETURNING asset_id AS "assetId", method,
                opening_value::float8 AS "openingValue", depreciation_charge::float8 AS "depreciationCharge",
                closing_value::float8 AS "closingValue", accumulated_depreciation::float8 AS "accumulatedDepreciation"
      `,
      [methodCode, fyStart],
    );
    return { financialYearStart: fyStart, method: methodCode, processed: results.length, results };
  }
}

@Controller('depreciation')
@UseGuards(SessionGuard)
export class DepreciationController {
  constructor(@Inject(DepreciationService) private readonly service: DepreciationService) {}

  @Get('methods')
  methods(@Req() req: AuthRequest) {
    return this.service.methods(req);
  }

  @Post('methods')
  createMethod(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.createMethod(req, body);
  }

  @Patch('methods/:code')
  updateMethod(@Req() req: AuthRequest, @Param('code') code: string, @Body() body: unknown) {
    return this.service.updateMethod(req, code, body);
  }

  @Delete('methods/:code')
  deleteMethod(@Req() req: AuthRequest, @Param('code') code: string) {
    return this.service.deleteMethod(req, code);
  }

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
