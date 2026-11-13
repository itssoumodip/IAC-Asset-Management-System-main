import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { camel, found, id, parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard, assertVersion } from './security';

/** Every location with its full path ("Site › Building › Floor"), built root-first. */
export const LOCATION_PATHS_SQL = `
  WITH RECURSIVE tree AS (
    SELECT id, name::text AS path, 1 AS depth FROM locations WHERE parent_id IS NULL
    UNION ALL
    SELECT l.id, tree.path || ' › ' || l.name, tree.depth + 1
    FROM locations l JOIN tree ON l.parent_id = tree.id WHERE tree.depth < 50
  )`;


const levels = ['SITE', 'ZONE', 'BUILDING', 'FLOOR', 'UNIT', 'STORE', 'RACK'] as const;
// Same rules as Master Control: Admin only, reason required, audited, advisory-locked.
const locationCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{1,49}$/, 'Code must be 2-50 letters, digits, _ . -'),
  );
const locationCreate = z
  .object({
    code: locationCode,
    name: text(150),
    level: z.enum(levels),
    parentId: z.string().uuid().nullable().optional(),
    reason: text(1000),
  })
  .strict();
const locationPatch = z
  .object({
    name: text(150).optional(),
    parentId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
    reason: text(1000),
  })
  .strict();
// Assets in these states have left the location for good and do not block deactivation.
const GONE = "('Retired','Disposed','Sold','Scrapped')";

const treeInput = z
  .object({
    includeInactive: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
      .default(false),
    level: z.enum(['SITE', 'ZONE', 'BUILDING', 'FLOOR', 'UNIT', 'STORE', 'RACK']).optional(),
  })
  .strict();

export class LocationsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async tree(req: AuthRequest, query: unknown) {
    const input = parse(treeInput, query ?? {});
    const values: any[] = [];
    let where = 'l.parent_id IS NULL';
    if (!input.includeInactive) {
      where += ` AND l.active`;
    }
    if (input.level) {
      values.push(input.level);
      where += ` AND l.level = $${values.length}`;
    }
    const rows = await this.db.query(
      `WITH RECURSIVE loc_tree AS (
        SELECT l.id, l.code, l.level, l.name, l.parent_id, l.active, l.version,
               1 AS depth, l.id AS root_id
        FROM locations l
        WHERE ${where}
        UNION ALL
        SELECT l.id, l.code, l.level, l.name, l.parent_id, l.active, l.version,
               lt.depth + 1, lt.root_id
        FROM locations l
        JOIN loc_tree lt ON lt.id = l.parent_id
        ${input.includeInactive ? '' : 'WHERE l.active'}
      )
      SELECT lt.id, lt.code, lt.level, lt.name, lt.parent_id, lt.active, lt.version, lt.depth,
             lt.root_id,
             count(a.id)::int AS asset_count,
             coalesce(sum(a.purchase_cost)::float8, 0) AS purchase_value
      FROM loc_tree lt
      LEFT JOIN assets a ON a.location_id = lt.id
      GROUP BY lt.id, lt.code, lt.level, lt.name, lt.parent_id, lt.active, lt.version, lt.depth, lt.root_id
      ORDER BY lt.root_id, lt.depth, lt.name`,
      values,
    );
    return { locations: rows.map(camel) };
  }

  private async lock(c: any) {
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('iac-master-data',0))",
      [],
      c,
    );
  }

  // Parent must exist, be active, and sort before the child's level.
  private async checkParent(c: any, parentId: string, level: string) {
    const [parent] = await this.db.query(
      `SELECT l.active,l.level,pl.sort_order AS parent_order,cl.sort_order AS child_order
       FROM locations l JOIN location_levels pl ON pl.code=l.level
       CROSS JOIN location_levels cl WHERE l.id=$1 AND cl.code=$2`,
      [parentId, level],
      c,
    );
    if (!parent) throw new UnprocessableEntityException('Parent location not found');
    if (!parent.active) throw new ConflictException('Parent location is inactive');
    if (parent.parent_order >= parent.child_order)
      throw new UnprocessableEntityException(
        `A ${level} location cannot sit under a ${parent.level} location`,
      );
  }

  async create(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const { reason, ...data } = parse(locationCreate, body);
    return this.db.tx(async (c) => {
      await this.lock(c);
      const dup = await this.db.query(
        'SELECT 1 FROM locations WHERE lower(btrim(code))=lower($1)',
        [data.code],
        c,
      );
      if (dup.length)
        throw new ConflictException(
          'This location code already exists; reactivate the existing record if needed',
        );
      if (data.parentId) await this.checkParent(c, data.parentId, data.level);
      const [row] = await this.db.query(
        'INSERT INTO locations(code,site,name,level,parent_id) VALUES($1,$2,$2,$3,$4) RETURNING *',
        [data.code, data.name, data.level, data.parentId ?? null],
        c,
      );
      await this.db.audit(c, req.user, 'location', row.id, 'MASTER_CREATED', {
        reason,
        after: camel(row),
      });
      return camel(row);
    });
  }

  async update(req: AuthRequest, locationId: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    id(locationId);
    const { reason, ...changes } = parse(locationPatch, body);
    if (!Object.keys(changes).length)
      throw new UnprocessableEntityException('Supply a location change');
    return this.db.tx(async (c) => {
      await this.lock(c);
      const before = found(
        (await this.db.query('SELECT * FROM locations WHERE id=$1 FOR UPDATE', [locationId], c))[0],
      );
      assertVersion(req, before.version);
      const name = changes.name ?? before.name;
      const parentId = changes.parentId === undefined ? before.parent_id : changes.parentId;
      const active = changes.active ?? before.active;
      if (parentId && parentId !== before.parent_id) {
        const [cycle] = await this.db.query(
          `WITH RECURSIVE sub AS (
             SELECT id FROM locations WHERE id=$1
             UNION ALL SELECT l.id FROM locations l JOIN sub s ON l.parent_id=s.id
           ) SELECT 1 FROM sub WHERE id=$2`,
          [locationId, parentId],
          c,
        );
        if (cycle)
          throw new UnprocessableEntityException(
            'A location cannot be moved under itself or one of its own sub-locations',
          );
        await this.checkParent(c, parentId, before.level);
      }
      if (before.active && !active) {
        const [{ assets }] = await this.db.query(
          `SELECT count(*)::int AS assets FROM assets WHERE location_id=$1 AND status NOT IN ${GONE}`,
          [locationId],
          c,
        );
        if (assets)
          throw new ConflictException(`Move the ${assets} asset${assets === 1 ? '' : 's'} first`);
        const [{ kids }] = await this.db.query(
          'SELECT count(*)::int AS kids FROM locations WHERE parent_id=$1 AND active',
          [locationId],
          c,
        );
        if (kids)
          throw new ConflictException(
            `Deactivate the ${kids} active sub-location${kids === 1 ? '' : 's'} first`,
          );
      }
      if (!before.active && active && parentId) {
        const [parent] = await this.db.query(
          'SELECT active FROM locations WHERE id=$1',
          [parentId],
          c,
        );
        if (parent && !parent.active)
          throw new ConflictException('Reactivate the parent location first');
      }
      const [after] = await this.db.query(
        `UPDATE locations SET name=$2,
           site=CASE WHEN site IS NULL OR site=$5 THEN $2 ELSE site END,
           parent_id=$3,active=$4,version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [locationId, name, parentId, active, before.name],
        c,
      );
      await this.db.audit(c, req.user, 'location', before.id, 'MASTER_UPDATED', {
        reason,
        before: camel(before),
        after: camel(after),
      });
      return camel(after);
    });
  }

  async assets(req: AuthRequest, locationId: string, query: unknown) {
    id(locationId);
    const [location] = await this.db.query(
      'SELECT id, code, level, name, parent_id FROM locations WHERE id=$1',
      [locationId],
    );
    if (!location) throw new UnprocessableEntityException('Location not found');
    const p = parse(
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(1000).optional(),
          q: z.string().trim().max(100).optional(),
          status: z.string().max(100).optional(),
        })
        .strict(),
      query ?? {},
    );
    let after: [string, string] | null = null;
    if (p.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(p.cursor, 'base64url').toString());
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          decoded.some((x) => typeof x !== 'string' || x.length > 100)
        )
          throw Error();
        after = decoded as [string, string];
      } catch {
        throw new UnprocessableEntityException('Invalid cursor');
      }
    }
    const values: any[] = [locationId];
    const where = ['a.location_id=$1'];
    if (p.q) {
      values.push(p.q);
      where.push(`(a.asset_code ILIKE $${values.length} OR a.description ILIKE $${values.length})`);
    }
    if (p.status) {
      values.push(p.status);
      where.push(`a.status=$${values.length}`);
    }
    if (after) {
      values.push(after[0], after[1]);
      where.push(`(a.asset_code,a.id)>($${values.length - 1}::text,$${values.length}::uuid)`);
    }
    values.push(p.limit + 1);
    const rows = await this.db.query(
      `SELECT a.id,a.asset_code,a.asset_type,a.description,a.manufacturer,a.model,a.serial_number,
              a.barcode,a.status,a.condition,a.purchase_date,a.purchase_cost,a.currency,
              a.warranty_expiry,a.amc_expiry,a.version,a.owning_team_id
       FROM assets a
       WHERE ${where.join(' AND ')}
       ORDER BY a.asset_code,a.id
       LIMIT $${values.length}`,
      values,
    );
    const more = rows.length > p.limit;
    const items = rows.slice(0, p.limit);
    const last = items.at(-1);
    return {
      location: camel(location),
      items: items.map(camel),
      nextCursor: more
        ? Buffer.from(JSON.stringify([last.asset_code, last.id])).toString('base64url')
        : null,
    };
  }
}

@Controller('locations')
@UseGuards(SessionGuard)
export class LocationsController {
  constructor(@Inject(LocationsService) private readonly service: LocationsService) {}

  @Get('tree')
  tree(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.tree(req, query);
  }

  @Post() async create(
    @Req() req: AuthRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.etag(res, await this.service.create(req, body));
  }

  @Patch(':id') async update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.etag(res, await this.service.update(req, id, body));
  }

  private etag(res: Response, value: any) {
    if (value.version) res.setHeader('ETag', `"${value.version}"`);
    return value;
  }

  @Get(':id/assets')
  assets(@Req() req: AuthRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.service.assets(req, id, query);
  }
}
