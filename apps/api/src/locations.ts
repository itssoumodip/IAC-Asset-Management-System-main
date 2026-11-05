import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { camel, id, parse } from './domain-helpers';
import { AuthRequest, SessionGuard } from './security';

const treeInput = z
  .object({
    includeInactive: z.boolean().default(false),
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

  @Get(':id/assets')
  assets(@Req() req: AuthRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.service.assets(req, id, query);
  }
}
