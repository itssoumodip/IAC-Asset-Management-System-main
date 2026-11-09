import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse } from './domain-helpers';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const flag = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

const listInput = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(200).optional(),
    owningTeamId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    status: z.enum(['all', 'low', 'out']).default('all'),
    allTeams: flag.default(false),
  })
  .strict();

const minStockInput = z
  .object({
    category: z.string().trim().min(1).max(200),
    assetType: z.string().trim().max(200).default(''),
    owningTeamId: z.string().uuid().nullish(),
    minInStore: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const GLOBAL_VIEW_ROLES = ['SUPER_ADMIN', 'FINANCE', 'EXECUTIVE'];

export function stockStatus(inStore: number, ready: number, min: number): string {
  if (inStore + ready === 0) return 'Out of stock';
  if (min > 0 && inStore + ready < min) return 'Low stock';
  return 'In Stock';
}

@Injectable()
export class InventoryService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest, query: unknown = {}) {
    assertCan(req.user, 'asset.view_all');
    const input = parse(listInput, query ?? {});
    const user = req.user;

    // Global roles see every team by default; team members see their own teams
    // unless they pick a team or ask for all teams.
    const globalView = user.roles.some((r: string) => GLOBAL_VIEW_ROLES.includes(r));
    const ownTeamIds: string[] = (user.teams ?? []).map((t: any) => t.teamId);
    const scopedToOwn = !globalView && !input.owningTeamId && !input.allTeams;

    const values: any[] = [];
    const where: string[] = [];
    const bind = (v: any) => {
      values.push(v);
      return `$${values.length}`;
    };
    if (input.q) {
      const p = bind(`%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(a.category ILIKE ${p} OR a.asset_type ILIKE ${p})`);
    }
    if (input.category) where.push(`a.category = ${bind(input.category)}`);
    if (input.owningTeamId) where.push(`a.owning_team_id = ${bind(input.owningTeamId)}`);
    else if (scopedToOwn) where.push(`a.owning_team_id = ANY(${bind(ownTeamIds)}::uuid[])`);
    if (input.locationId)
      where.push(
        `a.location_id IN (WITH RECURSIVE tree AS (
           SELECT id FROM locations WHERE id = ${bind(input.locationId)}
           UNION ALL
           SELECT l.id FROM locations l JOIN tree t ON l.parent_id = t.id
         ) SELECT id FROM tree)`,
      );

    const rows = await this.db.query(
      `SELECT a.category, a.asset_type, a.owning_team_id, t.code AS team_code, t.name AS team_name,
        count(*)::int AS total_count,
        count(*) FILTER (WHERE a.status = 'In Store')::int AS in_store_count,
        count(*) FILTER (WHERE a.status = 'Assigned')::int AS assigned_count,
        count(*) FILTER (WHERE a.status = 'Ready to Assign')::int AS ready_count,
        count(*) FILTER (WHERE a.status NOT IN ('In Store', 'Assigned', 'Ready to Assign'))::int AS other_count,
        COALESCE(own.min_in_store, dflt.min_in_store, 0)::int AS min_in_store
      FROM assets a
      JOIN teams t ON t.id = a.owning_team_id
      LEFT JOIN inventory_min_stock own
        ON own.category = a.category AND own.asset_type = a.asset_type AND own.owning_team_id = a.owning_team_id
      LEFT JOIN inventory_min_stock dflt
        ON dflt.category = a.category AND dflt.asset_type = a.asset_type AND dflt.owning_team_id IS NULL
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY a.category, a.asset_type, a.owning_team_id, t.code, t.name, own.min_in_store, dflt.min_in_store
      ORDER BY a.category, a.asset_type, t.code`,
      values,
    );

    const all = rows.map((r: any) => ({
      ...r,
      stock_status: stockStatus(r.in_store_count, r.ready_count, r.min_in_store),
    }));
    const summary = {
      productTypes: new Set(all.map((r: any) => `${r.category}\u0000${r.asset_type}`)).size,
      low: all.filter((r: any) => r.stock_status === 'Low stock').length,
      out: all.filter((r: any) => r.stock_status === 'Out of stock').length,
    };
    const wanted = input.status === 'low' ? 'Low stock' : input.status === 'out' ? 'Out of stock' : null;
    return {
      items: wanted ? all.filter((r: any) => r.stock_status === wanted) : all,
      summary,
      scope: scopedToOwn ? 'own' : 'all',
      defaultScope: globalView ? 'all' : 'own',
    };
  }

  async setMinStock(req: AuthRequest, body: unknown) {
    const input = parse(minStockInput, body);
    const teamId = input.owningTeamId ?? null;
    // A team's level needs edit rights on that team; the cross-team default is admin-only.
    if (teamId) assertCan(req.user, 'asset.edit', teamId);
    else assertCan(req.user, 'system.admin');

    return this.db.tx(async (c) => {
      if (teamId && !(await this.db.query('SELECT 1 FROM teams WHERE id=$1', [teamId], c)).length)
        throw new UnprocessableEntityException('Unknown team');
      const [before] = await this.db.query(
        `SELECT min_in_store FROM inventory_min_stock
         WHERE category=$1 AND asset_type=$2 AND COALESCE(owning_team_id,'${NIL_UUID}'::uuid)=COALESCE($3::uuid,'${NIL_UUID}'::uuid)`,
        [input.category, input.assetType, teamId],
        c,
      );
      await this.db.query(
        `INSERT INTO inventory_min_stock(category,asset_type,owning_team_id,min_in_store,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT (category, asset_type, COALESCE(owning_team_id,'${NIL_UUID}'::uuid))
         DO UPDATE SET min_in_store=excluded.min_in_store, updated_by=excluded.updated_by, updated_at=now()`,
        [input.category, input.assetType, teamId, input.minInStore, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'inventory_min_stock', null, 'INVENTORY_MIN_STOCK_SET', {
        category: input.category,
        assetType: input.assetType,
        owningTeamId: teamId,
        from: before?.min_in_store ?? null,
        to: input.minInStore,
      });
      return {
        category: input.category,
        assetType: input.assetType,
        owningTeamId: teamId,
        minInStore: input.minInStore,
      };
    });
  }
}

@Controller('inventory')
@UseGuards(SessionGuard)
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly service: InventoryService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req, query);
  }

  @Put('min-stock')
  setMinStock(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.setMinStock(req, body);
  }
}
