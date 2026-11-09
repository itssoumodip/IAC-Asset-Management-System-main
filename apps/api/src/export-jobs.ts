import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, loadTeams, type Actor } from './security';
import { assetColumns, assetScope, parse, uuid } from './domain-helpers';

const BATCH = 2000;
const MAX_ACTIVE_PER_USER = 3;
const CSV = 'text/csv; charset=utf-8';

const filtersInput = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.string().max(100).optional(),
    category: z.string().max(100).optional(),
    assetType: z.string().max(100).optional(),
    departmentId: uuid.optional(),
    owningTeamId: uuid.optional(),
  })
  .strict();
const createInput = z
  .object({
    kind: z.literal('assets'),
    filters: filtersInput.default({}),
    format: z.literal('csv').default('csv'),
  })
  .strict();
const idInput = uuid;
export type AssetExportFilters = z.infer<typeof filtersInput>;

/** Spreadsheet apps run text starting with these characters as formulas. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadActor(db: Db, userId: string): Promise<Actor | null> {
  const [row] = await db.query(
    `SELECT u.id,u.email,u.display_name,u.state,
       coalesce(array_agg(ur.role_code) FILTER(WHERE ur.role_code IS NOT NULL),'{}') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id WHERE u.id=$1 GROUP BY u.id`,
    [userId],
  );
  if (!row || row.state !== 'ACTIVE') return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    roles: row.roles,
    teams: await loadTeams(db, row.id),
    state: row.state,
  } as Actor;
}

/**
 * Builds the CSV for an asset export using the same visibility scope and filters as
 * GET /assets, reading with keyset pagination so memory and query cost stay flat.
 */
export async function buildAssetCsv(
  db: Db,
  actor: Actor,
  filters: AssetExportFilters,
): Promise<{ content: Buffer; rowCount: number }> {
  const select = assetColumns(actor);
  const header = select.split(',').map((c) => c.replace(/^a\./, ''));
  const values: any[] = [];
  const where = [assetScope(actor, values)];
  for (const [key, column] of [
    ['status', 'status'],
    ['category', 'category'],
    ['assetType', 'asset_type'],
    ['departmentId', 'department_id'],
    ['owningTeamId', 'owning_team_id'],
  ] as const)
    if (filters[key]) {
      values.push(filters[key]);
      where.push(`a.${column}=$${values.length}`);
    }
  if (filters.q) {
    values.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
    const n = values.length;
    where.push(
      `(a.asset_code ILIKE $${n} OR a.description ILIKE $${n} OR a.serial_number ILIKE $${n})`,
    );
  }
  const base = values.length;
  const sql = `SELECT ${select} FROM assets a WHERE ${where.join(' AND ')} AND (a.asset_code,a.id)>($${base + 1},$${base + 2}::uuid) ORDER BY a.asset_code,a.id LIMIT ${BATCH}`;
  const chunks: string[] = [header.join(',') + '\r\n'];
  let rowCount = 0;
  let lastCode = '';
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.query(sql, [...values, lastCode, lastId]);
    if (!rows.length) break;
    chunks.push(rows.map((r) => header.map((h) => cell(r[h])).join(',')).join('\r\n') + '\r\n');
    rowCount += rows.length;
    const last = rows[rows.length - 1];
    lastCode = last.asset_code;
    lastId = last.id;
    if (rows.length < BATCH) break;
  }
  return { content: Buffer.from(chunks.join(''), 'utf8'), rowCount };
}

/** Claims and runs one queued job; returns false when there was nothing to do. */
export async function processNextExport(db: Db): Promise<boolean> {
  const [job] = await db.query(
    `UPDATE export_jobs SET state='RUNNING',started_at=now() WHERE id=(
       SELECT id FROM export_jobs
       WHERE state='QUEUED' OR (state='RUNNING' AND started_at<now()-interval '30 minutes')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,requested_by,kind,filters`,
  );
  if (!job) return false;
  try {
    const actor = await loadActor(db, job.requested_by);
    if (!actor) throw new Error('REQUESTER_INACTIVE');
    const { content, rowCount } = await buildAssetCsv(db, actor, filtersInput.parse(job.filters));
    await db.tx(async (c) => {
      await db.query(
        `UPDATE export_jobs SET state='READY',content=$2,content_type=$3,row_count=$4,finished_at=now(),error_code=NULL WHERE id=$1`,
        [job.id, content, CSV, rowCount],
        c,
      );
      await db.audit(c, null, 'EXPORT_JOB', job.id, 'EXPORT_READY', { kind: job.kind, rowCount });
    });
  } catch (error) {
    const code = error instanceof Error && error.message === 'REQUESTER_INACTIVE' ? 'REQUESTER_INACTIVE' : 'EXPORT_FAILED';
    await db.query(
      `UPDATE export_jobs SET state='FAILED',error_code=$2,finished_at=now() WHERE id=$1`,
      [job.id, code],
    );
  }
  return true;
}

/** Removes finished files after their 7-day retention. */
export async function purgeExpiredExports(db: Db): Promise<number> {
  const rows = await db.query('DELETE FROM export_jobs WHERE expires_at<now() RETURNING id');
  return rows.length;
}

@Injectable()
export class ExportJobsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async create(req: AuthRequest, body: unknown) {
    const input = parse(createInput, body);
    return this.db.tx(async (c) => {
      const [{ n }] = await this.db.query(
        `SELECT count(*)::int AS n FROM export_jobs WHERE requested_by=$1 AND state IN ('QUEUED','RUNNING')`,
        [req.user.id],
        c,
      );
      if (n >= MAX_ACTIVE_PER_USER)
        throw new HttpException('Too many exports in progress. Wait for one to finish.', 429);
      const [job] = await this.db.query(
        `INSERT INTO export_jobs(requested_by,kind,filters) VALUES($1,$2,$3) RETURNING id`,
        [req.user.id, input.kind, JSON.stringify(input.filters)],
        c,
      );
      await this.db.audit(c, req.user, 'EXPORT_JOB', job.id, 'EXPORT_REQUESTED', {
        kind: input.kind,
        filters: input.filters,
      });
      return { id: job.id as string };
    });
  }

  private async owned(req: AuthRequest, rawId: string, columns: string) {
    const id = parse(idInput, rawId);
    const [job] = await this.db.query(
      `SELECT requested_by,${columns} FROM export_jobs WHERE id=$1 AND expires_at>now()`,
      [id],
    );
    if (!job) throw new NotFoundException('Export not found');
    if (job.requested_by !== req.user.id && !req.user.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException('Insufficient permission');
    return job;
  }

  async status(req: AuthRequest, rawId: string) {
    const job = await this.owned(
      req,
      rawId,
      'id,kind,state,row_count,error_code,created_at,finished_at,expires_at',
    );
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      rowCount: job.row_count,
      errorCode: job.error_code,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      expiresAt: job.expires_at,
    };
  }

  async file(req: AuthRequest, rawId: string) {
    const job = await this.owned(req, rawId, 'id,state,content,content_type');
    if (job.state !== 'READY' || !job.content)
      throw new HttpException('Export is not ready', 409);
    return { id: job.id as string, content: job.content as Buffer, type: job.content_type as string };
  }
}

@Controller('exports')
@UseGuards(SessionGuard)
export class ExportJobsController {
  constructor(@Inject(ExportJobsService) private readonly service: ExportJobsService) {}

  @Post() create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
  @Get(':id') status(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.status(req, id);
  }
  @Get(':id/file') async file(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const file = await this.service.file(req, id);
    res
      .status(200)
      .set({
        'Content-Type': file.type,
        'Content-Disposition': `attachment; filename="assets-${file.id}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.content);
  }
}

