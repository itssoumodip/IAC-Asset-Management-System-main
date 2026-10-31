import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';
import { camel, parse, text, uuid } from './domain-helpers';

const reason = text(1000);
const teamsInput = z.object({ teamIds: z.array(uuid).min(1), handlingTeamId: uuid, reason }).strict();
const subcategoryInput = z
  .object({ code: text(100), label: text(150), requiresCustodian: z.boolean(), reason })
  .strict();
const subcategoryPatch = z
  .object({
    label: text(150).optional(),
    active: z.boolean().optional(),
    requiresCustodian: z.boolean().optional(),
    categoryCode: text(100).optional(),
    reason,
  })
  .strict();

@Injectable()
export class CategoryService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list() {
    const categories = await this.db.query(
      `SELECT p.category_code,p.handling_team_id,p.version,
              coalesce(array_agg(DISTINCT ct.team_id) FILTER (WHERE ct.team_id IS NOT NULL),'{}') AS team_ids,
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                'code',rv.code,'label',rv.label,'active',rv.active,
                'requiresCustodian',atp.requires_custodian,
                'assetCount',(SELECT count(*)::int FROM assets a WHERE a.asset_type=rv.code AND a.category=p.category_code)))
                FROM asset_type_policies atp
                JOIN reference_values rv ON rv.kind='ASSET_TYPE' AND rv.code=atp.asset_type_code
                WHERE atp.category_code=p.category_code),'[]') AS subcategories,
              (SELECT count(*)::int FROM assets a WHERE a.category=p.category_code) AS asset_count
       FROM category_policies p LEFT JOIN category_teams ct USING(category_code)
       GROUP BY p.category_code,p.handling_team_id,p.version
       ORDER BY p.category_code`,
    );
    return categories.map((row) => ({
      categoryCode: row.category_code,
      handlingTeamId: row.handling_team_id,
      teamIds: row.team_ids,
      version: row.version,
      subcategories: row.subcategories,
      assetCount: row.asset_count,
    }));
  }

  private canManageCategory(req: AuthRequest, categoryCode: string) {
    if (req.user.roles.includes('SUPER_ADMIN')) return;
    const teamIds = new Set((req.user.teams ?? []).filter((team) => team.level === 'LEAD').map((team) => team.teamId));
    if (!teamIds.size) throw new ForbiddenException('Only a category owner team lead may manage subcategories');
    return this.db.query(
      'SELECT 1 FROM category_teams WHERE category_code=$1 AND team_id=ANY($2::uuid[])',
      [categoryCode, [...teamIds]],
    ).then((rows) => {
      if (!rows[0]) throw new ForbiddenException('Only a category owner team lead may manage subcategories');
    });
  }

  async updateTeams(req: AuthRequest, categoryCode: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    const input = parse(teamsInput, body);
    return this.db.tx(async (c) => {
      const before = (await this.db.query('SELECT * FROM category_policies WHERE category_code=$1 FOR UPDATE', [categoryCode], c))[0];
      if (!before) throw new UnprocessableEntityException('Unknown category');
      const removedTeamIds = (await this.db.query(
        'SELECT team_id FROM category_teams WHERE category_code=$1 AND NOT (team_id = ANY($2::uuid[]))',
        [categoryCode, input.teamIds],
        c,
      )).map((row) => row.team_id);
      if (removedTeamIds.length) {
        const [owned] = await this.db.query(
          'SELECT count(*)::int AS count FROM assets WHERE category=$1 AND owning_team_id=ANY($2::uuid[])',
          [categoryCode, removedTeamIds],
          c,
        );
        if (owned?.count > 0)
          throw new ConflictException(
            `Cannot remove a team while it owns ${owned.count} asset${owned.count === 1 ? '' : 's'} in this category`,
          );
      }
      await this.db.query('DELETE FROM category_teams WHERE category_code=$1', [categoryCode], c);
      for (const teamId of input.teamIds)
        await this.db.query('INSERT INTO category_teams(category_code,team_id) VALUES($1,$2)', [categoryCode, teamId], c);
      const [after] = await this.db.query(
        'UPDATE category_policies SET handling_team_id=$2,version=version+1 WHERE category_code=$1 RETURNING *',
        [categoryCode, input.handlingTeamId],
        c,
      );
      await this.db.audit(c, req.user, 'category_policy', null, 'CATEGORY_TEAMS_UPDATED', {
        before,
        after,
        categoryCode,
        reason: input.reason,
      });
      return camel(after);
    });
  }

  async addSubcategory(req: AuthRequest, categoryCode: string, body: unknown) {
    await this.canManageCategory(req, categoryCode);
    const input = parse(subcategoryInput, body);
    return this.db.tx(async (c) => {
      const [category] = await this.db.query('SELECT 1 FROM category_policies WHERE category_code=$1', [categoryCode], c);
      if (!category) throw new UnprocessableEntityException('Unknown category');
      const [row] = await this.db.query(
        `INSERT INTO reference_values(kind,code,label)
         VALUES('ASSET_TYPE',$1,$2) ON CONFLICT(kind,code) DO UPDATE SET label=excluded.label,active=true
         RETURNING code,label,active`,
        [input.code, input.label],
        c,
      );
      await this.db.query(
        `INSERT INTO asset_type_policies(asset_type_code,requires_custodian,category_code)
         VALUES($1,$2,$3)
         ON CONFLICT(asset_type_code) DO UPDATE SET requires_custodian=excluded.requires_custodian,category_code=excluded.category_code`,
        [input.code, input.requiresCustodian, categoryCode],
        c,
      );
      await this.db.audit(c, req.user, 'asset_type_policy', null, 'SUBCATEGORY_CREATED', {
        categoryCode,
        reason: input.reason,
      });
      return { ...camel(row), categoryCode, requiresCustodian: input.requiresCustodian };
    });
  }

  async patchSubcategory(req: AuthRequest, code: string, body: unknown) {
    const input = parse(subcategoryPatch, body);
    const [current] = await this.db.query(
      `SELECT atp.asset_type_code,atp.category_code,atp.requires_custodian,rv.label,rv.active
       FROM asset_type_policies atp JOIN reference_values rv ON rv.kind='ASSET_TYPE' AND rv.code=atp.asset_type_code
       WHERE atp.asset_type_code=$1`,
      [code],
    );
    if (!current) throw new UnprocessableEntityException('Unknown subcategory');
    await this.canManageCategory(req, input.categoryCode ?? current.category_code);
    if (input.categoryCode && input.categoryCode !== current.category_code && !req.user.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException('Only Super Admin may move a subcategory');
    return this.db.tx(async (c) => {
      const [row] = await this.db.query(
        `UPDATE reference_values SET label=coalesce($3,label),active=coalesce($4,active),version=version+1
         WHERE kind='ASSET_TYPE' AND code=$1 RETURNING code,label,active`,
        [code, null, input.label ?? null, input.active ?? null],
        c,
      );
      const [policy] = await this.db.query(
        `UPDATE asset_type_policies SET requires_custodian=coalesce($2,requires_custodian),category_code=coalesce($3,category_code)
         WHERE asset_type_code=$1 RETURNING asset_type_code,requires_custodian,category_code`,
        [code, input.requiresCustodian ?? null, input.categoryCode ?? null],
        c,
      );
      await this.db.audit(c, req.user, 'asset_type_policy', null, 'SUBCATEGORY_UPDATED', {
        before: current,
        after: policy,
        reason: input.reason,
      });
      return { ...camel(row), ...camel(policy) };
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class CategoryController {
  constructor(@Inject(CategoryService) private readonly service: CategoryService) {}
  @Get('categories') list() { return this.service.list(); }
  @Put('categories/:code/teams') updateTeams(@Req() req: AuthRequest, @Param('code') code: string, @Body() body: unknown) {
    return this.service.updateTeams(req, code, body);
  }
  @Post('categories/:code/subcategories') addSubcategory(@Req() req: AuthRequest, @Param('code') code: string, @Body() body: unknown) {
    return this.service.addSubcategory(req, code, body);
  }
  @Patch('subcategories/:code') patchSubcategory(@Req() req: AuthRequest, @Param('code') code: string, @Body() body: unknown) {
    return this.service.patchSubcategory(req, code, body);
  }
}
