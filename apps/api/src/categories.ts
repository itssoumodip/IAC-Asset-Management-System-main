import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard, assertVersion } from './security';

const categoryCode = text(100).regex(/^[^\u0000-\u001f\u007f]+$/, 'Invalid category code');

const categoryPatch = z
  .object({
    handlingTeamId: z.string().uuid(),
    teamIds: z.array(z.string().uuid()).min(1).max(20),
    reason: text(1000),
  })
  .strict();

export class CategoriesService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list() {
    const [categories, categoryTeams, assetTypes] = await Promise.all([
      this.db.query(
        `SELECT cp.category_code AS "categoryCode", cp.handling_team_id AS "handlingTeamId", cp.version AS version
         FROM category_policies cp ORDER BY cp.category_code`,
      ),
      this.db.query(
        `SELECT ct.category_code AS "categoryCode", ct.team_id AS team_id
         FROM category_teams ct ORDER BY ct.category_code, ct.team_id`,
      ),
      this.db.query(
        `SELECT at.asset_type_code AS "assetTypeCode", at.category_code AS "categoryCode",
                at.requires_custodian AS "requiresCustodian", at.owning_team_id AS "owningTeamId",
                at.handling_team_id AS "handlingTeamId"
         FROM asset_type_policies at ORDER BY at.category_code, at.asset_type_code`,
      ),
    ]);

    const teamsByCategory = new Map<string, string[]>();
    for (const row of categoryTeams) {
      const set = teamsByCategory.get(row.categoryCode) ?? [];
      set.push(row.team_id);
      teamsByCategory.set(row.categoryCode, set);
    }

    const typesByCategory = new Map<string, any[]>();
    for (const row of assetTypes) {
      const list = typesByCategory.get(row.categoryCode) ?? [];
      list.push(row);
      typesByCategory.set(row.categoryCode, list);
    }

    return categories.map((row) => ({
      categoryCode: row.categoryCode,
      handlingTeamId: row.handlingTeamId,
      version: row.version,
      owningTeamIds: teamsByCategory.get(row.categoryCode) ?? [],
      subcategories: typesByCategory.get(row.categoryCode) ?? [],
    }));
  }

  async update(categoryCodeValue: string, req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const code = parse(categoryCode, categoryCodeValue);
    const { handlingTeamId, teamIds, reason } = parse(categoryPatch, body);

    const [existing] = await this.db.query(
      'SELECT category_code FROM category_policies WHERE category_code=$1',
      [code],
    );
    if (!existing) throw new UnprocessableEntityException('Category not found');

    const [team] = await this.db.query(
      'SELECT id,active FROM teams WHERE id=$1',
      [handlingTeamId],
    );
    if (!team || !team.active) throw new UnprocessableEntityException('Handling team is not active');

    const uniqueTeams = [...new Set(teamIds)];
    for (const teamId of uniqueTeams) {
      const [t] = await this.db.query(
        'SELECT active FROM teams WHERE id=$1',
        [teamId],
      );
      if (!t || !t.active) throw new UnprocessableEntityException(`Team ${teamId} is not active`);
    }

    return this.db.tx(async (c) => {
      const [before] = await this.db.query(
        'SELECT handling_team_id,version FROM category_policies WHERE category_code=$1',
        [code],
        c,
      );
      assertVersion(req, before.version);

      await this.db.query(
        'UPDATE category_policies SET handling_team_id=$1,version=version+1 WHERE category_code=$2 RETURNING *',
        [handlingTeamId, code],
        c,
      );

      await this.db.query('DELETE FROM category_teams WHERE category_code=$1', [code], c);
      for (const teamId of uniqueTeams) {
        await this.db.query(
          'INSERT INTO category_teams(category_code,team_id) VALUES($1,$2)',
          [code, teamId],
          c,
        );
      }

      await this.db.audit(
        c,
        req.user,
        'category',
        code,
        'CATEGORY_UPDATED',
        {
          reason,
          before: { handlingTeamId: before.handling_team_id },
          after: { handlingTeamId, teamIds: uniqueTeams },
        },
      );

      return { categoryCode: code, handlingTeamId, owningTeamIds: uniqueTeams };
    });
  }
}

@Controller('admin/categories')
@UseGuards(SessionGuard)
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly service: CategoriesService) {}

  @Get()
  list(@Req() _req: AuthRequest) {
    return this.service.list();
  }

  @Put(':categoryCode')
  update(
    @Req() req: AuthRequest,
    @Param('categoryCode') categoryCode: string,
    @Body() body: unknown,
  ) {
    return this.service.update(categoryCode, req, body);
  }
}
