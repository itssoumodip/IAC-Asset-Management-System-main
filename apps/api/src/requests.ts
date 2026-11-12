import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, id, parse, text } from './domain-helpers';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const createInput = z
  .object({
    items: z
      .array(z.object({ assetType: text(100), quantity: z.number().int().min(1).max(50) }).strict())
      .min(1)
      .max(20),
    neededBy: isoDate.nullable().optional(),
    remarks: text(1000).nullable().optional(),
  })
  .strict();
const fulfilInput = z.object({ assetIds: z.array(z.string().uuid()).max(50).optional() }).strict();
export const requestDecisionInput = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), reason: text(1000) })
  .strict();

const IN_STOCK = "('In Store','Ready to Assign')";
const isSuper = (req: AuthRequest) => req.user.roles.includes('SUPER_ADMIN');
const leadOf = (req: AuthRequest, teamId: string | null) =>
  !!teamId && (req.user.teams ?? []).some((t) => t.teamId === teamId && t.level === 'LEAD');
const memberOf = (req: AuthRequest, teamId: string | null) =>
  !!teamId && (req.user.teams ?? []).some((t) => t.teamId === teamId);

/** Overall request status from its lines. */
const STATUS_SQL = `CASE
  WHEN r.cancelled_at IS NOT NULL THEN 'CANCELLED'
  WHEN bool_and(i.status='REJECTED') THEN 'REJECTED'
  WHEN bool_and(i.status IN ('FULFILLED','REJECTED')) THEN 'FULFILLED'
  WHEN bool_or(i.status='PENDING') THEN 'PENDING'
  ELSE 'APPROVED' END`;

/**
 * Item requests: browse subcategories with live stock, ask for quantities, and let the handling
 * team's lead approve or reject each line before the team hands items over.
 */
@Injectable()
export class RequestsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** What can be requested: every active subcategory with how many are free in store. */
  async catalog() {
    const rows = await this.db.query(
      `SELECT p.asset_type_code, p.category_code, coalesce(p.handling_team_id,cp.handling_team_id) AS team_id,
              t.code AS team_code,
              (SELECT count(*)::int FROM assets a WHERE a.asset_type=p.asset_type_code AND a.status IN ${IN_STOCK}) AS in_stock
         FROM asset_type_policies p
         JOIN reference_values v ON v.kind='ASSET_TYPE' AND v.code=p.asset_type_code AND v.active
         LEFT JOIN category_policies cp ON cp.category_code=p.category_code
         LEFT JOIN teams t ON t.id=coalesce(p.handling_team_id,cp.handling_team_id)
        ORDER BY p.category_code, p.asset_type_code`,
    );
    return { items: rows.map(camel) };
  }

  async create(req: AuthRequest, body: unknown) {
    const input = parse(createInput, body);
    const types = [...new Set(input.items.map((i) => i.assetType))];
    if (types.length !== input.items.length)
      throw new UnprocessableEntityException(
        'Each subcategory can appear once; change its quantity instead',
      );
    return this.db.tx(async (c) => {
      const known: { code: string; category: string; team_id: string | null }[] =
        await this.db.query(
          `SELECT p.asset_type_code AS code, p.category_code AS category,
                coalesce(p.handling_team_id,cp.handling_team_id) AS team_id
           FROM asset_type_policies p
           JOIN reference_values v ON v.kind='ASSET_TYPE' AND v.code=p.asset_type_code AND v.active
           LEFT JOIN category_policies cp ON cp.category_code=p.category_code
          WHERE p.asset_type_code=ANY($1::text[])`,
          [types],
          c,
        );
      const missing = types.filter((t) => !known.some((k) => k.code === t));
      if (missing.length)
        throw new UnprocessableEntityException(`Not available to request: ${missing.join(', ')}`);
      const [request] = await this.db.query(
        `INSERT INTO asset_requests(requester_id,needed_by,remarks) VALUES($1,$2,$3)
         RETURNING id,request_number`,
        [req.user.id, input.neededBy ?? null, input.remarks?.trim() || null],
        c,
      );
      for (const item of input.items) {
        const k = known.find((x) => x.code === item.assetType)!;
        await this.db.query(
          `INSERT INTO asset_request_items(request_id,asset_type_code,category_code,handling_team_id,quantity)
           VALUES($1,$2,$3,$4,$5)`,
          [request.id, k.code, k.category, k.team_id, item.quantity],
          c,
        );
      }
      await this.db.audit(c, req.user, 'asset_request', request.id, 'REQUEST_CREATED', {
        items: input.items,
        neededBy: input.neededBy ?? null,
      });
      await this.notifyLeads(c, request.id, Number(request.request_number), req.user.displayName);
      return { id: request.id, requestNumber: Number(request.request_number) };
    });
  }

  /** Emails the leads of every team that has to decide a line of this request. */
  private async notifyLeads(c: PoolClient, requestId: string, number: number, requester: string) {
    const leads = (
      await this.db.query(
        `SELECT DISTINCT u.email FROM asset_request_items i
           JOIN team_memberships m ON m.team_id=i.handling_team_id AND m.level='LEAD'
           JOIN users u ON u.id=m.user_id AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
          WHERE i.request_id=$1`,
        [requestId],
        c,
      )
    ).map((r) => r.email);
    if (leads.length)
      await this.db.notify(c, `request-created:${requestId}`, 'request_created', leads, {
        subject: `Request #${number} from ${requester} needs your decision`,
        text: `${requester} has requested items from your team.\n\nOpen Approvals in the portal to approve or reject each item.`,
      });
  }

  async mine(req: AuthRequest) {
    const rows = await this.db.query(
      `SELECT r.id,r.request_number,r.needed_by,r.remarks,r.created_at,r.cancelled_at,${STATUS_SQL} AS status,
              json_agg(json_build_object('id',i.id,'assetType',i.asset_type_code,'category',i.category_code,
                'quantity',i.quantity,'status',i.status,'decisionNote',i.decision_note,'teamCode',t.code)
                ORDER BY i.asset_type_code) AS items
         FROM asset_requests r JOIN asset_request_items i ON i.request_id=r.id
         LEFT JOIN teams t ON t.id=i.handling_team_id
        WHERE r.requester_id=$1
        GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`,
      [req.user.id],
    );
    return {
      items: rows.map((r: any) => ({ ...camel(r), requestNumber: Number(r.request_number) })),
    };
  }

  /** Lines this person can act on: to decide (leads / Super Admin) and to hand over (team). */
  async queue(req: AuthRequest) {
    const teamIds = (req.user.teams ?? []).map((t) => t.teamId);
    const leadIds = (req.user.teams ?? []).filter((t) => t.level === 'LEAD').map((t) => t.teamId);
    const superAdmin = isSuper(req);
    if (!superAdmin && !teamIds.length) return { toDecide: [], toFulfil: [] };
    const select = `SELECT i.id,i.asset_type_code,i.category_code,i.quantity,i.status,i.decision_note,
        i.handling_team_id,t.code AS team_code,r.id AS request_id,r.request_number,r.needed_by,r.remarks,
        r.created_at,u.id AS requester_id,u.display_name AS requester_name,u.email AS requester_email,
        EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id=u.id) AS requester_has_photo,
        (SELECT count(*)::int FROM assets a WHERE a.asset_type=i.asset_type_code AND a.status IN ${IN_STOCK}) AS in_stock
      FROM asset_request_items i JOIN asset_requests r ON r.id=i.request_id
      JOIN users u ON u.id=r.requester_id LEFT JOIN teams t ON t.id=i.handling_team_id`;
    const map = (r: any) => ({ ...camel(r), requestNumber: Number(r.request_number) });
    const toDecide = await this.db.query(
      `${select} WHERE i.status='PENDING' AND r.cancelled_at IS NULL
         ${superAdmin ? '' : 'AND i.handling_team_id=ANY($1::uuid[])'}
       ORDER BY r.created_at`,
      superAdmin ? [] : [leadIds.length ? leadIds : ['00000000-0000-0000-0000-000000000000']],
    );
    const toFulfil = await this.db.query(
      `${select} WHERE i.status='APPROVED' ${superAdmin ? '' : 'AND i.handling_team_id=ANY($1::uuid[])'}
       ORDER BY r.needed_by NULLS LAST, r.created_at`,
      superAdmin ? [] : [teamIds],
    );
    return { toDecide: toDecide.map(map), toFulfil: toFulfil.map(map) };
  }

  /** Procurement: approved lines with nothing in store, oldest first ("approved requests to buy"). */
  async toBuy(req: AuthRequest) {
    assertCan(req.user, 'procurement.view');
    const rows = await this.db.query(
      `SELECT i.id,i.asset_type_code,i.category_code,i.quantity,t.code AS team_code,
              r.request_number,r.needed_by,i.decided_at,u.display_name AS requester_name
         FROM asset_request_items i JOIN asset_requests r ON r.id=i.request_id
         JOIN users u ON u.id=r.requester_id LEFT JOIN teams t ON t.id=i.handling_team_id
        WHERE i.status='APPROVED'
          AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.asset_type=i.asset_type_code AND a.status IN ${IN_STOCK})
        ORDER BY i.decided_at`,
    );
    return {
      items: rows.map((r: any) => ({ ...camel(r), requestNumber: Number(r.request_number) })),
    };
  }

  private async lineFor(c: PoolClient, itemId: string) {
    id(itemId);
    const [row] = await this.db.query(
      `SELECT i.*,r.request_number,r.requester_id,r.cancelled_at,u.email AS requester_email
         FROM asset_request_items i JOIN asset_requests r ON r.id=i.request_id
         JOIN users u ON u.id=r.requester_id
        WHERE i.id=$1 FOR UPDATE OF i`,
      [itemId],
      c,
    );
    if (!row) throw new NotFoundException('Request item not found');
    return row;
  }

  async isRequestItem(itemId: string) {
    const [row] = await this.db.query('SELECT 1 FROM asset_request_items WHERE id=$1', [itemId]);
    return !!row;
  }

  async decide(req: AuthRequest, itemId: string, body: unknown) {
    const { decision, reason } = parse(requestDecisionInput, body);
    return this.db.tx(async (c) => {
      const line = await this.lineFor(c, itemId);
      if (!isSuper(req) && !leadOf(req, line.handling_team_id))
        throw new ForbiddenException('Only the lead of the handling team can decide this');
      if (line.requester_id === req.user.id && !isSuper(req))
        throw new ForbiddenException('You cannot decide your own request');
      if (line.status !== 'PENDING' || line.cancelled_at)
        throw new ConflictException('This item has already been decided');
      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await this.db.query(
        `UPDATE asset_request_items SET status=$2,decision_note=$3,decided_by=$4,decided_at=now() WHERE id=$1`,
        [line.id, status, reason, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset_request', line.request_id, `REQUEST_ITEM_${status}`, {
        item: line.asset_type_code,
        quantity: line.quantity,
        reason,
      });
      await this.db.notify(
        c,
        `request-item-${status.toLowerCase()}:${line.id}`,
        'request_decided',
        [line.requester_email],
        {
          subject: `Request #${line.request_number}: ${line.asset_type_code} ${status === 'APPROVED' ? 'approved' : 'not approved'}`,
          text: `Your request for ${line.quantity} × ${line.asset_type_code} was ${status === 'APPROVED' ? 'approved. The team will hand it over soon.' : 'not approved.'}\n\nNote: ${reason}`,
        },
      );
      // Approved lines go to the handling team to hand over: tell its members.
      if (status === 'APPROVED' && line.handling_team_id) {
        const team = (
          await this.db.query(
            `SELECT DISTINCT u.email FROM team_memberships m JOIN users u ON u.id=m.user_id
              WHERE m.team_id=$1 AND u.id<>$2 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL`,
            [line.handling_team_id, req.user.id],
            c,
          )
        ).map((r) => r.email);
        if (team.length)
          await this.db.notify(
            c,
            `request-item-to-hand-over:${line.id}`,
            'request_to_hand_over',
            team,
            {
              subject: `Request #${line.request_number}: hand over ${line.quantity} × ${line.asset_type_code}`,
              text: `${line.quantity} × ${line.asset_type_code} was approved for a colleague.\n\nOpen Requests → Team requests in the portal and use Hand over to give them an asset.`,
            },
          );
      }
      return { id: line.id, status };
    });
  }

  async fulfil(req: AuthRequest, itemId: string, body: unknown = {}) {
    const { assetIds = [] } = parse(fulfilInput, body ?? {});
    return this.db.tx(async (c) => {
      const line = await this.lineFor(c, itemId);
      if (!isSuper(req) && !memberOf(req, line.handling_team_id))
        throw new ForbiddenException('Only the handling team can hand this over');
      if (line.status !== 'APPROVED')
        throw new ConflictException('Only approved items can be handed over');
      // When assets are named, each must now be with the requester and of the requested type.
      if (assetIds.length) {
        const ok = await this.db.query(
          `SELECT a.id,a.asset_code FROM assets a
             JOIN assignments s ON s.asset_id=a.id AND s.ended_at IS NULL AND s.user_id=$2
            WHERE a.id=ANY($1::uuid[]) AND a.asset_type=$3`,
          [assetIds, line.requester_id, line.asset_type_code],
          c,
        );
        if (ok.length !== new Set(assetIds).size)
          throw new UnprocessableEntityException(
            'Every handed-over asset must be assigned to the requester and match the requested item',
          );
      }
      await this.db.query(
        `UPDATE asset_request_items SET status='FULFILLED',fulfilled_by=$2,fulfilled_at=now() WHERE id=$1`,
        [line.id, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset_request', line.request_id, 'REQUEST_ITEM_FULFILLED', {
        item: line.asset_type_code,
        quantity: line.quantity,
        assetIds,
      });
      await this.db.notify(
        c,
        `request-item-fulfilled:${line.id}`,
        'request_fulfilled',
        [line.requester_email],
        {
          subject: `Request #${line.request_number}: ${line.asset_type_code} is ready`,
          text: `Your requested ${line.asset_type_code} has been handed over. Please confirm it on My assets when you receive it.`,
        },
      );
      return { id: line.id, status: 'FULFILLED' };
    });
  }

  async cancel(req: AuthRequest, requestId: string) {
    id(requestId);
    return this.db.tx(async (c) => {
      const [r] = await this.db.query(
        'SELECT id,requester_id,cancelled_at FROM asset_requests WHERE id=$1 FOR UPDATE',
        [requestId],
        c,
      );
      if (!r) throw new NotFoundException();
      if (r.requester_id !== req.user.id)
        throw new ForbiddenException('Only the requester can cancel');
      if (r.cancelled_at) return { cancelled: true };
      const [{ decided }] = await this.db.query(
        "SELECT count(*) FILTER (WHERE status<>'PENDING')::int AS decided FROM asset_request_items WHERE request_id=$1",
        [requestId],
        c,
      );
      if (decided) throw new ConflictException('Items already decided cannot be cancelled');
      await this.db.query(
        'UPDATE asset_requests SET cancelled_at=now() WHERE id=$1',
        [requestId],
        c,
      );
      await this.db.query(
        "UPDATE asset_request_items SET status='CANCELLED' WHERE request_id=$1",
        [requestId],
        c,
      );
      await this.db.audit(c, req.user, 'asset_request', requestId, 'REQUEST_CANCELLED', {});
      return { cancelled: true };
    });
  }
}

@Controller('requests')
@UseGuards(SessionGuard)
export class RequestsController {
  constructor(@Inject(RequestsService) private readonly service: RequestsService) {}

  @Get('catalog')
  catalog() {
    return this.service.catalog();
  }
  @Get('mine')
  mine(@Req() req: AuthRequest) {
    return this.service.mine(req);
  }
  @Get('queue')
  queue(@Req() req: AuthRequest) {
    return this.service.queue(req);
  }
  @Get('to-buy')
  toBuy(@Req() req: AuthRequest) {
    return this.service.toBuy(req);
  }
  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
  @Post('items/:id/decision')
  decide(@Req() req: AuthRequest, @Param('id') itemId: string, @Body() body: unknown) {
    return this.service.decide(req, itemId, body);
  }
  @Post('items/:id/fulfil')
  fulfil(@Req() req: AuthRequest, @Param('id') itemId: string, @Body() body: unknown) {
    return this.service.fulfil(req, itemId, body);
  }
  @Post(':id/cancel')
  cancel(@Req() req: AuthRequest, @Param('id') requestId: string) {
    return this.service.cancel(req, requestId);
  }
}
