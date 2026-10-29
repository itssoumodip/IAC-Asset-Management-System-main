import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Inject,
  Injectable,
  UseGuards,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole, assertVersion } from './security';
import { camel } from './domain-helpers';
const uuid = z.string().uuid();
@Injectable()
export class StocktakeService {
  constructor(@Inject(Db) private readonly db: Db) {}
  async list(req: AuthRequest) {
    requireRole(req, 'ADMIN');
    return {
      items: (
        await this.db.query(
          'SELECT id,name,scope,created_at,closed_at,version FROM stocktake_runs ORDER BY created_at DESC,id DESC LIMIT 50',
        )
      ).map(camel),
    };
  }
  async create(req: AuthRequest, body: unknown) {
    requireRole(req, 'ADMIN');
    const p = z
      .object({
        name: z.string().trim().min(1).max(160),
        departmentId: uuid.optional(),
        locationId: uuid.optional(),
      })
      .strict()
      .parse(body);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.tx(async (c) => {
          await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], c);
          for (const [table, value] of [
            ['departments', p.departmentId],
            ['locations', p.locationId],
          ])
            if (
              value &&
              !(await this.db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [value], c)).length
            )
              throw new NotFoundException('Scope reference not found');
          const [run] = await this.db.query(
            'INSERT INTO stocktake_runs(name,scope,created_by)VALUES($1,$2,$3)RETURNING *',
            [
              p.name,
              {
                departmentId: p.departmentId ?? null,
                locationId: p.locationId ?? null,
                definition:
                  'All asset statuses at creation; current custody and versions frozen as evidence.',
              },
              req.user.id,
            ],
            c,
          );
          await this.db.query(
            `INSERT INTO stocktake_expected(run_id,asset_id,asset_code,asset_version,snapshot) SELECT $1,a.id,a.asset_code,a.version,jsonb_build_object('description',a.description,'status',a.status,'serialNumber',a.serial_number,'departmentId',a.department_id,'locationId',a.location_id,'custodianId',x.user_id,'custodianName',u.display_name) FROM assets a LEFT JOIN assignments x ON x.asset_id=a.id AND x.ended_at IS NULL LEFT JOIN users u ON u.id=x.user_id WHERE ($2::uuid IS NULL OR a.department_id=$2) AND ($3::uuid IS NULL OR a.location_id=$3)`,
            [run.id, p.departmentId ?? null, p.locationId ?? null],
            c,
          );
          await this.db.audit(c, req.user, 'STOCKTAKE', run.id, 'STOCKTAKE_CREATED', {
            name: p.name,
            scope: run.scope,
          });
          return camel(run);
        });
      } catch (error) {
        if ((error as { code?: string }).code !== '40001') throw error;
        if (attempt >= 2)
          throw new ConflictException(
            'Inventory changed repeatedly during snapshot creation. No count was saved. Retry when activity settles.',
          );
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  async detail(req: AuthRequest, value: string, query: unknown = {}) {
    requireRole(req, 'ADMIN');
    const id = uuid.parse(value),
      p = z
        .object({
          after: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(query);
    return this.db.tx(async (c) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], c);
      const [run] = await this.db.query('SELECT * FROM stocktake_runs WHERE id=$1', [id], c);
      if (!run) throw new NotFoundException('Stocktake not found');
      const latest = `SELECT DISTINCT ON(asset_id) asset_id,outcome,note,observed_at,observed_by,asset_version FROM stocktake_observations WHERE run_id=$1 ORDER BY asset_id,sequence_no DESC`;
      const [summary] = await this.db.query(
        `WITH latest AS(${latest}) SELECT (SELECT count(*)::int FROM stocktake_expected WHERE run_id=$1) expected,count(*) FILTER(WHERE e.asset_id IS NOT NULL AND l.outcome='SEEN')::int seen,count(*) FILTER(WHERE e.asset_id IS NOT NULL AND l.outcome='NOT_FOUND')::int not_found,count(*) FILTER(WHERE e.asset_id IS NOT NULL AND l.outcome='MISMATCH')::int mismatch,count(*) FILTER(WHERE e.asset_id IS NULL)::int extra,(SELECT count(*)::int FROM stocktake_expected e WHERE run_id=$1 AND NOT EXISTS(SELECT 1 FROM latest l WHERE l.asset_id=e.asset_id)) unobserved FROM latest l LEFT JOIN stocktake_expected e ON e.run_id=$1 AND e.asset_id=l.asset_id`,
        [id],
        c,
      );
      const rows = await this.db.query(
        `WITH latest AS(${latest}),ids AS(SELECT asset_id FROM stocktake_expected WHERE run_id=$1 UNION SELECT asset_id FROM latest) SELECT a.id,a.asset_code,e.snapshot,e.asset_version AS expected_version,a.version AS current_version,l.outcome,l.note,l.observed_at,l.asset_version AS observed_version,(e.asset_id IS NULL) AS extra FROM ids i JOIN assets a ON a.id=i.asset_id LEFT JOIN stocktake_expected e ON e.run_id=$1 AND e.asset_id=a.id LEFT JOIN latest l ON l.asset_id=a.id WHERE ($2::text IS NULL OR a.asset_code>$2) ORDER BY a.asset_code LIMIT $3`,
        [id, p.after ?? null, p.limit + 1],
        c,
      );
      const items = rows.slice(0, p.limit).map(camel);
      return {
        run: camel(run),
        summary: camel(summary),
        items,
        nextCursor: rows.length > p.limit ? items.at(-1)!.assetCode : null,
        definition:
          'Recorded observations only, not independent physical verification. Missing/unobserved/extra/mismatch never changes custody, status or Finance values. Compare versions before separately authorized corrections.',
      };
    });
  }
  async observe(req: AuthRequest, value: string, body: unknown) {
    requireRole(req, 'ADMIN');
    const id = uuid.parse(value),
      p = z
        .object({
          assetCode: z.string().trim().min(1).max(100),
          outcome: z.enum(['SEEN', 'NOT_FOUND', 'MISMATCH']),
          note: z.string().trim().min(1).max(2000),
          requestKey: uuid,
        })
        .strict()
        .parse(body);
    return this.db.tx(async (c) => {
      const [run] = await this.db.query(
        'SELECT * FROM stocktake_runs WHERE id=$1 FOR UPDATE',
        [id],
        c,
      );
      if (!run) throw new NotFoundException('Stocktake not found');
      const [prior] = await this.db.query(
        'SELECT o.*,a.asset_code FROM stocktake_observations o JOIN assets a ON a.id=o.asset_id WHERE run_id=$1 AND request_key=$2',
        [id, p.requestKey],
        c,
      );
      if (prior) {
        if (
          prior.asset_code !== p.assetCode ||
          prior.outcome !== p.outcome ||
          prior.note !== p.note
        )
          throw new ConflictException('Request key already used for a different observation');
        return camel(prior);
      }
      assertVersion(req, run.version);
      if (run.closed_at) throw new ConflictException('Stocktake is closed');
      const [asset] = await this.db.query(
        'SELECT id,version FROM assets WHERE asset_code=$1',
        [p.assetCode],
        c,
      );
      if (!asset)
        throw new NotFoundException(
          'Registered asset not found. Register unknown equipment separately before recording an extra item.',
        );
      const [row] = await this.db.query(
        'INSERT INTO stocktake_observations(run_id,asset_id,outcome,note,observed_by,asset_version,request_key)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',
        [id, asset.id, p.outcome, p.note, req.user.id, asset.version, p.requestKey],
        c,
      );
      await this.db.audit(c, req.user, 'STOCKTAKE', id, 'STOCKTAKE_OBSERVED', {
        assetId: asset.id,
        outcome: p.outcome,
        observationId: row.id,
      });
      return camel(row);
    });
  }
  async history(req: AuthRequest, value: string, assetValue: string, query: unknown = {}) {
    requireRole(req, 'ADMIN');
    const run = uuid.parse(value),
      asset = uuid.parse(assetValue),
      p = z
        .object({
          after: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .parse(query);
    if (!(await this.db.query('SELECT 1 FROM stocktake_runs WHERE id=$1', [run])).length)
      throw new NotFoundException('Stocktake not found');
    const rows = await this.db.query(
      `SELECT o.id,o.outcome,o.note,o.observed_at,o.asset_version,u.display_name AS actor FROM stocktake_observations o JOIN users u ON u.id=o.observed_by WHERE o.run_id=$1 AND o.asset_id=$2 AND ($3::uuid IS NULL OR o.sequence_no<(SELECT sequence_no FROM stocktake_observations WHERE id=$3 AND run_id=$1 AND asset_id=$2)) ORDER BY o.sequence_no DESC LIMIT $4`,
      [run, asset, p.after ?? null, p.limit + 1],
    );
    const items = rows.slice(0, p.limit).map(camel);
    return { items, nextCursor: rows.length > p.limit ? items.at(-1)!.id : null };
  }
  async close(req: AuthRequest, value: string, body: unknown) {
    requireRole(req, 'ADMIN');
    const id = uuid.parse(value),
      p = z
        .object({ reason: z.string().trim().min(1).max(2000) })
        .strict()
        .parse(body);
    return this.db.tx(async (c) => {
      const [run] = await this.db.query(
        'SELECT * FROM stocktake_runs WHERE id=$1 FOR UPDATE',
        [id],
        c,
      );
      if (!run) throw new NotFoundException('Stocktake not found');
      assertVersion(req, run.version);
      if (run.closed_at) throw new ConflictException('Stocktake is already closed');
      const [row] = await this.db.query(
        'UPDATE stocktake_runs SET closed_at=now(),closed_by=$2,version=version+1 WHERE id=$1 RETURNING *',
        [id, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'STOCKTAKE', id, 'STOCKTAKE_CLOSED', { reason: p.reason });
      return camel(row);
    });
  }
}
@Controller('stocktake')
@UseGuards(SessionGuard)
export class StocktakeController {
  constructor(@Inject(StocktakeService) private readonly service: StocktakeService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r);
  }
  @Post() create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.service.create(r, b);
  }
  @Get(':id') detail(@Req() r: AuthRequest, @Param('id') id: string, @Query() q: unknown) {
    return this.service.detail(r, id, q);
  }
  @Get(':id/assets/:asset/history') history(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('asset') asset: string,
    @Query() q: unknown,
  ) {
    return this.service.history(r, id, asset, q);
  }
  @Post(':id/observations') observe(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.service.observe(r, id, b);
  }
  @Post(':id/close') close(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.service.close(r, id, b);
  }
}
