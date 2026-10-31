import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
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

const reason = text(1000);
const createInput = z
  .object({
    name: text(150),
    level: z.string().regex(/^[A-Z][A-Z_]{1,29}$/),
    parentId: z.string().uuid().nullable().optional(),
    code: text(100).optional(),
    reason,
  })
  .strict();
const patchInput = z
  .object({
    name: text(150).optional(),
    parentId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
    reason,
  })
  .strict();
// Assets in these states no longer occupy a place.
const GONE = ['Retired', 'Disposed', 'Sold', 'Lost', 'Stolen'];

/** Tree rule violations from the database trigger become a clear 422. */
function treeError(error: any): never {
  if (error?.code === '23514' && /location|level|loop|parent/i.test(error.message ?? ''))
    throw new UnprocessableEntityException(error.message);
  throw error;
}

@Injectable()
export class LocationService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async tree(_req: AuthRequest) {
    const [levels, items] = await Promise.all([
      this.db.query(
        'SELECT code,label,sort_order,active FROM location_levels ORDER BY sort_order',
      ),
      this.db.query(
        `${LOCATION_PATHS_SQL}
         SELECT l.id,l.code,l.name,l.level,l.parent_id,l.active,l.version,tree.path,
                (SELECT count(*)::int FROM assets a WHERE a.location_id=l.id AND a.status<>ALL($1)) AS asset_count
         FROM locations l LEFT JOIN tree ON tree.id=l.id
         ORDER BY tree.path NULLS LAST, l.code`,
        [GONE],
      ),
    ]);
    return { levels: levels.map(camel), items: items.map(camel) };
  }

  async create(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const data = parse(createInput, body);
    if (data.parentId) id(data.parentId);
    return this.db.tx(async (c) => {
      const [level] = await this.db.query(
        'SELECT code FROM location_levels WHERE code=$1 AND active',
        [data.level],
        c,
      );
      if (!level) throw new UnprocessableEntityException('Unknown location level');
      if (data.parentId)
        found((await this.db.query('SELECT id FROM locations WHERE id=$1 AND active', [data.parentId], c))[0]);
      const code = data.code ?? `LOC-${randomBytes(4).toString('hex').toUpperCase()}`;
      if ((await this.db.query('SELECT 1 FROM locations WHERE lower(code)=lower($1)', [code], c)).length)
        throw new ConflictException('This location code already exists');
      const [row] = await this.db
        .query(
          'INSERT INTO locations(code,name,level,parent_id) VALUES($1,$2,$3,$4) RETURNING *',
          [code, data.name, data.level, data.parentId ?? null],
          c,
        )
        .catch(treeError);
      await this.db.audit(c, req.user, 'location', row.id, 'MASTER_CREATED', {
        reason: data.reason,
        after: camel(row),
      });
      return camel(row);
    });
  }

  async update(req: AuthRequest, locationId: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    id(locationId);
    const { reason: why, ...changes } = parse(patchInput, body);
    if (!Object.keys(changes).length) throw new UnprocessableEntityException('Supply a change');
    if (changes.parentId) id(changes.parentId);
    return this.db.tx(async (c) => {
      const before = found(
        (await this.db.query('SELECT * FROM locations WHERE id=$1 FOR UPDATE', [locationId], c))[0],
      );
      assertVersion(req, before.version);
      if (changes.active === false && before.active) await this.assertEmpty(locationId, c);
      if (changes.parentId)
        found((await this.db.query('SELECT id FROM locations WHERE id=$1 AND active', [changes.parentId], c))[0]);
      const [after] = await this.db
        .query(
          `UPDATE locations SET name=$2,parent_id=$3,active=$4,version=version+1,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            locationId,
            changes.name ?? before.name,
            changes.parentId === undefined ? before.parent_id : changes.parentId,
            changes.active ?? before.active,
          ],
          c,
        )
        .catch(treeError);
      await this.db.audit(c, req.user, 'location', locationId, 'MASTER_UPDATED', {
        reason: why,
        before: camel(before),
        after: camel(after),
      });
      return camel(after);
    });
  }

  /** A place cannot close while active children or assets still sit in it or below it. */
  private async assertEmpty(locationId: string, c: PoolClient) {
    const [usage] = await this.db.query(
      `WITH RECURSIVE sub AS (
         SELECT id FROM locations WHERE id=$1
         UNION ALL SELECT l.id FROM locations l JOIN sub ON l.parent_id=sub.id)
       SELECT (SELECT count(*)::int FROM locations WHERE parent_id=$1 AND active) AS children,
              (SELECT count(*)::int FROM assets WHERE location_id IN (SELECT id FROM sub) AND status<>ALL($2)) AS assets`,
      [locationId, GONE],
      c,
    );
    if (usage.children)
      throw new ConflictException(`Close the ${usage.children} active location(s) inside it first`);
    if (usage.assets)
      throw new ConflictException(`${usage.assets} asset(s) are still here; move them first`);
  }
}

@Controller('locations')
@UseGuards(SessionGuard)
export class LocationController {
  constructor(@Inject(LocationService) private readonly service: LocationService) {}

  @Get('tree')
  tree(@Req() req: AuthRequest) {
    return this.service.tree(req);
  }

  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }

  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id') locationId: string, @Body() body: unknown) {
    return this.service.update(req, locationId, body);
  }
}
