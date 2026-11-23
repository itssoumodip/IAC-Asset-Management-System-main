import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { camel, parse, text, uuid } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard, assertVersion } from './security';

// Two category APIs share the category_policies / category_teams tables:
//  * /admin/categories           — Categories page (feature branch)
//  * /categories, /subcategories — subcategory add/edit by owner team leads (main)

const categoryCode = text(100).regex(/^[^\u0000-\u001f\u007f]+$/, 'Invalid category code');

const categoryPatch = z
  .object({
    handlingTeamId: z.string().uuid(),
    teamIds: z.array(z.string().uuid()).min(1).max(20),
    reason: text(1000),
  })
  .strict();

const categoryCreate = z
  .object({
    name: categoryCode,
    handlingTeamId: z.string().uuid(),
    teamIds: z.array(z.string().uuid()).min(1).max(20),
    reason: text(1000),
    // Optional subcategories created with the category.
    subcategories: z
      .array(z.object({ name: text(100), requiresCustodian: z.boolean() }).strict())
      .max(50)
      .optional()
      .default([]),
  })
  .strict();
const categoryDelete = z.object({ reason: text(1000) }).strict();

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
        // Active subcategories only, with their display name and how many assets use them.
        `SELECT at.asset_type_code AS "assetTypeCode", at.category_code AS "categoryCode",
                at.requires_custodian AS "requiresCustodian", at.owning_team_id AS "owningTeamId",
                at.handling_team_id AS "handlingTeamId", coalesce(rv.label, at.asset_type_code) AS label,
                (SELECT count(*)::int FROM assets a WHERE a.asset_type = at.asset_type_code AND a.removed_at IS NULL) AS "assetCount"
         FROM asset_type_policies at
         LEFT JOIN reference_values rv ON rv.kind = 'ASSET_TYPE' AND rv.code = at.asset_type_code
        WHERE coalesce(rv.active, true)
        ORDER BY at.category_code, coalesce(rv.label, at.asset_type_code)`,
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

  /**
   * New category: its name (also the code), the team that handles its problems and the teams
   * that may own its assets. Super Admin only; audited.
   */
  async create(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const input = parse(categoryCreate, body);
    const code = input.name.trim();
    const uniqueTeams = [...new Set(input.teamIds)];
    const active = await this.db.query('SELECT id FROM teams WHERE id = ANY($1::uuid[]) AND active', [
      [...new Set([...uniqueTeams, input.handlingTeamId])],
    ]);
    if (active.length !== new Set([...uniqueTeams, input.handlingTeamId]).size)
      throw new UnprocessableEntityException('Choose active teams only');
    return this.db.tx(async (c) => {
      const [taken] = await this.db.query(
        `SELECT 1 FROM category_policies WHERE lower(category_code) = lower($1)
         UNION ALL SELECT 1 FROM reference_values WHERE kind = 'CATEGORY' AND lower(code) = lower($1) AND active`,
        [code],
        c,
      );
      if (taken) throw new ConflictException('A category with this name already exists');
      await this.db.query(
        `INSERT INTO reference_values(kind, code, label) VALUES('CATEGORY', $1, $1)
         ON CONFLICT(kind, code) DO UPDATE SET active = true, label = excluded.label`,
        [code],
        c,
      );
      await this.db.query('INSERT INTO category_policies(category_code, handling_team_id) VALUES($1, $2)', [
        code,
        input.handlingTeamId,
      ], c);
      for (const teamId of uniqueTeams)
        await this.db.query('INSERT INTO category_teams(category_code, team_id) VALUES($1, $2)', [code, teamId], c);
      const subcategoryCodes: string[] = [];
      for (const sub of input.subcategories) {
        const subCode = sub.name.trim();
        if (subcategoryCodes.some((s) => s.toLowerCase() === subCode.toLowerCase())) continue;
        // A subcategory already used by another category is not taken over silently.
        const [elsewhere] = await this.db.query(
          `SELECT atp.category_code FROM asset_type_policies atp
             JOIN reference_values rv ON rv.kind = 'ASSET_TYPE' AND rv.code = atp.asset_type_code AND rv.active
            WHERE lower(atp.asset_type_code) = lower($1)`,
          [subCode],
          c,
        );
        if (elsewhere)
          throw new ConflictException(`"${subCode}" already belongs to ${elsewhere.category_code}; move it from that category instead`);
        await this.db.query(
          `INSERT INTO reference_values(kind, code, label) VALUES('ASSET_TYPE', $1, $1)
           ON CONFLICT(kind, code) DO UPDATE SET active = true, label = excluded.label`,
          [subCode],
          c,
        );
        await this.db.query(
          `INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code) VALUES($1, $2, $3)
           ON CONFLICT(asset_type_code) DO UPDATE SET requires_custodian = excluded.requires_custodian, category_code = excluded.category_code`,
          [subCode, sub.requiresCustodian, code],
          c,
        );
        subcategoryCodes.push(subCode);
      }
      await this.db.audit(c, req.user, 'category', null, 'CATEGORY_CREATED', {
        categoryCode: code,
        reason: input.reason,
        after: { categoryCode: code, handlingTeamId: input.handlingTeamId, teamIds: uniqueTeams, subcategories: subcategoryCodes },
      });
      return { categoryCode: code, handlingTeamId: input.handlingTeamId, owningTeamIds: uniqueTeams, subcategories: subcategoryCodes };
    });
  }

  /**
   * Deletes a category nobody uses: refused while any asset (including ones removed from the
   * register) is in the category or one of its subcategories, so history stays consistent.
   * Its subcategories are switched off rather than erased. Super Admin only; audited.
   */
  async remove(categoryCodeValue: string, req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const code = parse(categoryCode, categoryCodeValue);
    const { reason } = parse(categoryDelete, body);
    return this.db.tx(async (c) => {
      const [before] = await this.db.query('SELECT * FROM category_policies WHERE category_code=$1 FOR UPDATE', [code], c);
      if (!before) throw new UnprocessableEntityException('Category not found');
      const subcategories = (
        await this.db.query('SELECT asset_type_code FROM asset_type_policies WHERE category_code=$1', [code], c)
      ).map((r) => r.asset_type_code as string);
      const [used] = await this.db.query(
        'SELECT count(*)::int AS n FROM assets WHERE category=$1 OR asset_type = ANY($2::text[])',
        [code, subcategories],
        c,
      );
      if (used.n > 0)
        throw new ConflictException(
          `${used.n} asset${used.n === 1 ? ' uses' : 's use'} this category. Move ${used.n === 1 ? 'it' : 'them'} to another category first.`,
        );
      await this.db.query(
        "UPDATE reference_values SET active=false, version=version+1 WHERE kind='ASSET_TYPE' AND code = ANY($1::text[])",
        [subcategories],
        c,
      );
      await this.db.query(
        "UPDATE reference_values SET active=false, version=version+1 WHERE kind='CATEGORY' AND code=$1",
        [code],
        c,
      );
      await this.db.query('DELETE FROM category_policies WHERE category_code=$1', [code], c);
      await this.db.audit(c, req.user, 'category', null, 'CATEGORY_DELETED', {
        categoryCode: code,
        reason,
        before: { handlingTeamId: before.handling_team_id, subcategories },
      });
      return { categoryCode: code, deleted: true };
    });
  }

  async update(categoryCodeValue: string, req: AuthRequest, body: unknown) {    assertCan(req.user, 'system.admin');
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

      const removedTeamIds = (
        await this.db.query(
          'SELECT team_id FROM category_teams WHERE category_code=$1 AND NOT (team_id = ANY($2::uuid[]))',
          [code, uniqueTeams],
          c,
        )
      ).map((row) => row.team_id);
      if (removedTeamIds.length) {
        const [owned] = await this.db.query(
          'SELECT count(*)::int AS count FROM assets WHERE category=$1 AND owning_team_id=ANY($2::uuid[])',
          [code, removedTeamIds],
          c,
        );
        if (owned?.count > 0)
          throw new ConflictException(
            `Cannot remove a team while it owns ${owned.count} asset${owned.count === 1 ? '' : 's'} in this category`,
          );
      }
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
        // The audit entity id is a uuid; the category is identified in the details.
        null,
        'CATEGORY_UPDATED',
        {
          categoryCode: code,
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

  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }

  @Delete(':categoryCode')
  remove(@Req() req: AuthRequest, @Param('categoryCode') categoryCode: string, @Body() body: unknown) {
    return this.service.remove(categoryCode, req, body);
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
        `UPDATE reference_values SET label=coalesce($2,label),active=coalesce($3,active),version=version+1
         WHERE kind='ASSET_TYPE' AND code=$1 RETURNING code,label,active`,
        [code, input.label ?? null, input.active ?? null],
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
