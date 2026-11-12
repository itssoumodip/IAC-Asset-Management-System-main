import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { assetScope, camel, id, parse, text, terminal, uuid } from './domain-helpers';
import { assertCan, can } from './policy';
import { AuthRequest, SessionGuard } from './security';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const createInput = z
  .object({
    // Either one asset (by its code) or every asset of a subcategory.
    assetCode: text(40).optional(),
    assetType: text(100).optional(),
    title: text(200),
    intervalDays: z.number().int().min(1).max(3650),
    firstDue: isoDate,
    assignedTo: uuid.nullable().optional(),
    reason: text(1000),
  })
  .strict()
  .refine((v) => !!v.assetCode !== !!v.assetType, {
    message: 'Choose one asset or one subcategory',
    path: ['assetCode'],
  });
const completeInput = z.object({ notes: text(2000).nullable().optional() }).strict();
const stopInput = z.object({ reason: text(1000) }).strict();
const listQuery = z
  .object({ view: z.enum(['upcoming', 'overdue', 'all']).default('upcoming') })
  .strict();

const TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

/**
 * Preventive maintenance: repeating service tasks per asset. Completing a task records who did
 * it and moves the next due date forward by the schedule's interval from the completion day.
 */
@Injectable()
export class MaintenanceService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest, raw: unknown) {
    assertCan(req.user, 'ticket.work');
    const { view } = parse(listQuery, raw ?? {});
    const values: any[] = [];
    const where = [assetScope(req.user, values), 's.active'];
    if (view === 'upcoming') where.push(`s.next_due <= ${TODAY} + 30`);
    if (view === 'overdue') where.push(`s.next_due < ${TODAY}`);
    const rows = await this.db.query(
      `SELECT s.id,s.title,s.interval_days,s.next_due,s.version,s.asset_id,
              a.asset_code,a.description AS asset_description,a.asset_type,a.owning_team_id,
              t.code AS team_code,u.id AS assigned_to,u.display_name AS assigned_name,
              u.email AS assigned_email,
              EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id=u.id) AS assigned_has_photo,
              (s.next_due - ${TODAY}) AS days_until_due,
              (SELECT max(r.completed_at) FROM maintenance_records r WHERE r.schedule_id=s.id) AS last_done
         FROM maintenance_schedules s
         JOIN assets a ON a.id=s.asset_id
         LEFT JOIN teams t ON t.id=a.owning_team_id
         LEFT JOIN users u ON u.id=s.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY s.next_due, a.asset_code
        LIMIT 500`,
      values,
    );
    // Fresh parameter list: assetScope appends its own parameters.
    const countValues: any[] = [];
    const scopeA = assetScope(req.user, countValues);
    const scopeB = assetScope(req.user, countValues);
    const [counts] = await this.db.query(
      `SELECT count(*) FILTER (WHERE s.next_due < ${TODAY})::int AS overdue,
              count(*) FILTER (WHERE s.next_due BETWEEN ${TODAY} AND ${TODAY} + 7)::int AS due_this_week,
              count(*)::int AS active,
              (SELECT count(*)::int FROM maintenance_records r JOIN assets a ON a.id=r.asset_id
                WHERE r.completed_at >= date_trunc('month', now()) AND ${scopeA}) AS done_this_month
         FROM maintenance_schedules s JOIN assets a ON a.id=s.asset_id
        WHERE ${scopeB} AND s.active`,
      countValues,
    );
    return { items: rows.map(camel), summary: camel(counts) };
  }

  async create(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'ticket.work');
    const input = parse(createInput, body);
    return this.db.tx(async (c) => {
      const values: any[] = [];
      const scope = assetScope(req.user, values);
      const filter = input.assetCode
        ? `a.asset_code=$${values.push(input.assetCode)}`
        : `a.asset_type=$${values.push(input.assetType)}`;
      const assets: {
        id: string;
        asset_code: string;
        status: string;
        owning_team_id: string | null;
      }[] = await this.db.query(
        `SELECT a.id,a.asset_code,a.status,a.owning_team_id FROM assets a WHERE ${filter} AND ${scope}`,
        values,
        c,
      );
      // Only assets still in service, and only within teams this user works for.
      const targets = assets.filter(
        (a) =>
          !terminal.has(a.status) && can(req.user, 'ticket.work', a.owning_team_id ?? undefined),
      );
      if (!targets.length)
        throw new UnprocessableEntityException(
          input.assetCode
            ? 'No asset in service with that code in your teams'
            : 'No assets in service of that subcategory in your teams',
        );
      if (input.assignedTo) {
        const [person] = await this.db.query(
          "SELECT 1 FROM users WHERE id=$1 AND state IN ('ACTIVE','DIRECTORY') AND left_at IS NULL",
          [input.assignedTo],
          c,
        );
        if (!person) throw new UnprocessableEntityException('Assigned person is not available');
      }
      const created: string[] = [];
      for (const asset of targets) {
        const [row] = await this.db.query(
          `INSERT INTO maintenance_schedules(asset_id,title,interval_days,next_due,assigned_to,created_by)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            asset.id,
            input.title.trim(),
            input.intervalDays,
            input.firstDue,
            input.assignedTo ?? null,
            req.user.id,
          ],
          c,
        );
        created.push(row.id);
        await this.db.audit(c, req.user, 'asset', asset.id, 'MAINTENANCE_SCHEDULED', {
          title: input.title.trim(),
          intervalDays: input.intervalDays,
          firstDue: input.firstDue,
          reason: input.reason,
        });
      }
      return { created: created.length, ids: created };
    });
  }

  private async scheduleFor(req: AuthRequest, scheduleId: string, c: any) {
    id(scheduleId);
    const values: any[] = [scheduleId];
    const [row] = await this.db.query(
      `SELECT s.*,a.owning_team_id,a.status AS asset_status FROM maintenance_schedules s
         JOIN assets a ON a.id=s.asset_id
        WHERE s.id=$1 AND ${assetScope(req.user, values)} FOR UPDATE OF s`,
      values,
      c,
    );
    if (!row) throw new NotFoundException();
    assertCan(req.user, 'ticket.work', row.owning_team_id ?? undefined);
    return row;
  }

  async complete(req: AuthRequest, scheduleId: string, body: unknown) {
    const { notes } = parse(completeInput, body ?? {});
    return this.db.tx(async (c) => {
      const s = await this.scheduleFor(req, scheduleId, c);
      if (!s.active) throw new ConflictException('This schedule has been stopped');
      await this.db.query(
        `INSERT INTO maintenance_records(schedule_id,asset_id,due_date,completed_by,notes)
         VALUES($1,$2,$3,$4,$5)`,
        [s.id, s.asset_id, s.next_due, req.user.id, notes?.trim() || null],
        c,
      );
      // Next service counts from the day the work was actually done.
      const [next] = await this.db.query(
        `UPDATE maintenance_schedules SET next_due=${TODAY}+interval_days, version=version+1
          WHERE id=$1 RETURNING next_due`,
        [s.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', s.asset_id, 'MAINTENANCE_COMPLETED', {
        title: s.title,
        dueDate: s.next_due,
        notes: notes?.trim() || null,
      });
      return { nextDue: next.next_due };
    });
  }

  async stop(req: AuthRequest, scheduleId: string, body: unknown) {
    const { reason } = parse(stopInput, body);
    return this.db.tx(async (c) => {
      const s = await this.scheduleFor(req, scheduleId, c);
      if (!s.active) return { stopped: true };
      await this.db.query(
        'UPDATE maintenance_schedules SET active=false, version=version+1 WHERE id=$1',
        [s.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', s.asset_id, 'MAINTENANCE_STOPPED', {
        title: s.title,
        reason,
      });
      return { stopped: true };
    });
  }

  async history(req: AuthRequest, scheduleId: string) {
    const s = await this.db.tx((c) => this.scheduleFor(req, scheduleId, c));
    const rows = await this.db.query(
      `SELECT r.id,r.due_date,r.completed_at,r.notes,u.display_name AS completed_by_name
         FROM maintenance_records r LEFT JOIN users u ON u.id=r.completed_by
        WHERE r.schedule_id=$1 ORDER BY r.completed_at DESC LIMIT 50`,
      [s.id],
    );
    return { items: rows.map(camel) };
  }
}

@Controller('maintenance')
@UseGuards(SessionGuard)
export class MaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly service: MaintenanceService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() q: unknown) {
    return this.service.list(req, q);
  }
  @Post('schedules')
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
  @Post('schedules/:id/complete')
  complete(@Req() req: AuthRequest, @Param('id') scheduleId: string, @Body() body: unknown) {
    return this.service.complete(req, scheduleId, body);
  }
  @Post('schedules/:id/stop')
  stop(@Req() req: AuthRequest, @Param('id') scheduleId: string, @Body() body: unknown) {
    return this.service.stop(req, scheduleId, body);
  }
  @Get('schedules/:id/history')
  history(@Req() req: AuthRequest, @Param('id') scheduleId: string) {
    return this.service.history(req, scheduleId);
  }
}
