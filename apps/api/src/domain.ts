import {
  Controller,
  Get,
  Header,
  Post,
  Patch,
  Put,
  Body,
  Param,
  Query,
  Req,
  Res,
  Injectable,
  Inject,
  UseGuards,
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole } from './security';
import { ImportDomain } from './domain-import';
import {
  admin,
  assetScope,
  camel,
  page,
  parse,
  requestPage,
  staff,
  ticketScope,
} from './domain-helpers';

@Injectable()
export class DomainService extends ImportDomain {
  constructor(@Inject(Db) db: Db) {
    super(db);
  }
  async dashboard(req: AuthRequest) {
    const assetValues: any[] = [];
    const assetWhere = assetScope(req.user, assetValues);
    const [assets] = await this.db.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE a.status='Assigned')::int AS assigned,count(*) FILTER(WHERE a.warranty_expiry BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date AND (now() AT TIME ZONE 'Asia/Kolkata')::date+30)::int AS warranty_expiring,count(*) FILTER(WHERE a.warranty_expiry IS NULL)::int AS unknown_warranty,count(*) FILTER(WHERE a.amc_applies AND a.amc_expiry IS NULL)::int AS unknown_amc${admin(req.user) ? ',count(*) FILTER(WHERE a.finance_pending)::int AS finance_pending' : ''} FROM assets a WHERE ${assetWhere}`,
      assetValues,
    );
    const pendingValues: any[] = [req.user.id];
    const [{ pending }] = await this.db.query(
      `SELECT count(*)::int AS pending FROM assignments WHERE ended_at IS NULL AND acknowledgement='PENDING' ${admin(req.user) ? '' : 'AND user_id=$1'}`,
      admin(req.user) ? [] : pendingValues,
    );
    const ticketValues: any[] = [];
    const ticketWhere = ticketScope(req.user, ticketValues);
    const [tickets] = await this.db.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE t.status='OPEN')::int AS open,count(*) FILTER(WHERE t.status='IN_PROGRESS')::int AS in_progress,count(*) FILTER(WHERE t.status='COMPLETED')::int AS completed,count(*) FILTER(WHERE t.owner_id IS NULL AND t.status<>'COMPLETED')::int AS unassigned FROM tickets t WHERE ${ticketWhere}`,
      ticketValues,
    );
    const imports = admin(req.user)
      ? (
          await this.db.query(
            "SELECT count(*)::int AS quarantined FROM import_rows WHERE state='QUARANTINED'",
          )
        )[0]
      : { quarantined: null };
    return {
      role: admin(req.user) ? 'ADMIN' : staff(req.user) ? 'IT_ADMIN' : 'EMPLOYEE',
      assets: {
        total: assets.total,
        assigned: assets.assigned,
        pendingAcknowledgements: pending,
        warrantyExpiring: assets.warranty_expiring,
      },
      tickets: camel(tickets),
      unknownCounts: {
        warrantyExpiry: assets.unknown_warranty,
        amcExpiry: assets.unknown_amc,
        financePending: assets.finance_pending ?? null,
      },
      imports,
    };
  }
  async auditEvents(req: AuthRequest, query: any) {
    requireRole(req, 'ADMIN');
    const p = requestPage(query, ['occurred_at', 'id']);
    const values: any[] = [];
    const where = ['TRUE'];
    for (const [key, col] of [
      ['entityType', 'entity_type'],
      ['entityId', 'entity_id'],
    ] as const)
      if (p[key]) {
        values.push(p[key]);
        where.push(`${col}=$${values.length}`);
      }
    if (p.after) {
      values.push(...p.after);
      where.push(`(occurred_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
    }
    values.push(p.limit + 1);
    return page(
      await this.db.query(
        `SELECT id,actor_id,actor_kind,entity_type,entity_id,action,changes,request_id,occurred_at,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_occurred_at FROM audit_events WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC,id DESC LIMIT $${values.length}`,
        values,
      ),
      p.limit,
      ['occurred_at', 'id'],
    );
  }
  async groups(req: AuthRequest) {
    requireRole(req, 'ADMIN');
    const rows = await this.db.query(
      `SELECT g.id,g.code,g.enabled,coalesce(jsonb_agg(jsonb_build_object('email',r.email,'verifiedAt',r.verified_at)) FILTER(WHERE r.email IS NOT NULL),'[]') AS recipients FROM notification_groups g LEFT JOIN notification_recipients r ON r.group_id=g.id GROUP BY g.id ORDER BY g.code`,
    );
    return { items: rows, nextCursor: null };
  }
  async updateGroup(req: AuthRequest, code: string, body: unknown) {
    requireRole(req, 'ADMIN');
    parse(z.enum(['ADMIN', 'IT']), code);
    const input = parse(
      z
        .object({
          enabled: z.boolean(),
          recipients: z
            .array(
              z
                .string()
                .email()
                .transform((e) => e.trim().toLowerCase()),
            )
            .max(50),
        })
        .strict(),
      body,
    );
    if (new Set(input.recipients).size !== input.recipients.length)
      throw new UnprocessableEntityException('Duplicate recipient');
    return this.db.tx(async (c) => {
      const [group] = await this.db.query(
        'INSERT INTO notification_groups(code,enabled) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled RETURNING *',
        [code, input.enabled],
        c,
      );
      for (const email of input.recipients) {
        const [user] = await this.db.query(
          "SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.email=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND r.role_code=$2 FOR SHARE OF u",
          [email, code === 'ADMIN' ? 'ADMIN' : 'IT_ADMIN'],
          c,
        );
        if (!user)
          throw new UnprocessableEntityException(
            'Recipients must be active verified users holding the corresponding group role',
          );
      }
      await this.db.query('DELETE FROM notification_recipients WHERE group_id=$1', [group.id], c);
      for (const email of input.recipients)
        await this.db.query(
          'INSERT INTO notification_recipients(group_id,email,verified_at) VALUES($1,$2,now())',
          [group.id, email],
          c,
        );
      await this.db.audit(
        c,
        req.user,
        'notification_group',
        group.id,
        'NOTIFICATION_GROUP_UPDATED',
        { code, enabled: input.enabled, recipientCount: input.recipients.length },
      );
      return { ...group, recipients: input.recipients.map((email) => ({ email })) };
    });
  }
}

function etag(res: Response, value: any) {
  const version = value.version ?? value.ticketVersion;
  if (version) res.setHeader('ETag', `"${version}"`);
  return value;
}
@Controller()
@UseGuards(SessionGuard)
export class DomainController {
  constructor(@Inject(DomainService) private readonly service: DomainService) {}
  @Get('references') references() {
    return this.service.references();
  }
  @Put('references/:kind/:code') reference(
    @Req() req: AuthRequest,
    @Param('kind') kind: string,
    @Param('code') code: string,
    @Body() body: unknown,
  ) {
    return this.service.referenceUpdate(req, kind, code, body);
  }
  @Get('master-data') masterData(@Req() req: AuthRequest) {
    return this.service.masterData(req);
  }
  @Post('master-data/:kind') async createMaster(
    @Req() req: AuthRequest,
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.createMaster(req, kind, body));
  }
  @Patch('master-data/:kind/:code') async updateMaster(
    @Req() req: AuthRequest,
    @Param('kind') kind: string,
    @Param('code') code: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.updateMaster(req, kind, code, body));
  }
  @Get('assets') assets(@Req() req: AuthRequest, @Query() query: any) {
    return this.service.assets(req, query);
  }
  @Get('assets/:id') async asset(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.asset(req, id));
  }
  @Post('assets') async createAsset(
    @Req() req: AuthRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.createAsset(req, body));
  }
  @Patch('assets/:id') async editAsset(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.editAsset(req, id, body));
  }
  @Post('assets/:id/assignments') async assign(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.assign(req, id, body));
  }
  @Post('assets/:id/reassign') async reassign(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.assign(req, id, body, true));
  }
  @Post('assignments/:id/return') async returnAsset(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.returnAsset(req, id, body));
  }
  @Post('assignments/:id/acknowledgement') async acknowledge(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.acknowledge(req, id, body));
  }
  @Get('tickets') tickets(@Req() req: AuthRequest, @Query() query: any) {
    return this.service.tickets(req, query);
  }
  @Get('tickets/:id') async ticket(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.ticket(req, id));
  }
  @Post('tickets') async createTicket(
    @Req() req: AuthRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.createTicket(req, body));
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('tickets/:id/photos/:position')
  ticketPhoto(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('position') position: string,
  ) {
    if (!/^[1-3]$/.test(position)) throw new NotFoundException();
    return this.service.ticketPhoto(req, id, Number(position));
  }
  @Get('tickets/:id/updates') updates(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query() query: any,
  ) {
    return this.service.updates(req, id, query);
  }
  @Post('tickets/:id/updates') async update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.addUpdate(req, id, body));
  }
  @Patch('tickets/:id/owner') async owner(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.ticketOwner(req, id, body));
  }
  @Patch('tickets/:id/status') async status(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.ticketStatus(req, id, body));
  }
  @Get('dashboard') dashboard(@Req() req: AuthRequest) {
    return this.service.dashboard(req);
  }
  @Get('audit-events') audit(@Req() req: AuthRequest, @Query() query: any) {
    return this.service.auditEvents(req, query);
  }
  @Get('notification-groups') groups(@Req() req: AuthRequest) {
    return this.service.groups(req);
  }
  @Put('notification-groups/:code') group(
    @Req() req: AuthRequest,
    @Param('code') code: string,
    @Body() body: unknown,
  ) {
    return this.service.updateGroup(req, code, body);
  }
  @Post('imports') async stage(
    @Req() req: AuthRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.stageImport(req, body));
  }
  @Get('imports/:id') async batch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.importBatch(req, id));
  }
  @Post('imports/:id/review') async review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.reviewImport(req, id, body));
  }
  @Post('imports/:id/commit') async commit(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.service.commitImport(req, id, body));
  }
}
