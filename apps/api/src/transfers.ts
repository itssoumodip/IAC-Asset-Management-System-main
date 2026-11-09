import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, found, id, parse, text, uuid } from './domain-helpers';
import { WRITE_OFF_STATUSES, assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';

const optionalText = (max = 1000) => text(max).nullable().optional();
const requestInput = z.object({ toTeamId: uuid, reason: text(1000) }).strict();
const acceptInput = z.object({ note: optionalText(1000) }).strict();
const declineInput = z.object({ note: text(1000) }).strict();
const cancelInput = z.object({ note: optionalText(1000) }).strict();
const listQuery = z.object({
  direction: z.enum(['incoming', 'outgoing', 'all']).default('all'),
  state: z.enum(['REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'FORCED']).optional(),
});

const isSuper = (req: AuthRequest) => req.user.roles.includes('SUPER_ADMIN');
const inTeam = (req: AuthRequest, teamId: string) =>
  (req.user.teams ?? []).some((t) => t.teamId === teamId);

const SELECT = `SELECT x.*,a.asset_code,a.description AS asset_description,a.status AS asset_status,
  ft.code AS from_team_code,ft.name AS from_team_name,tt.code AS to_team_code,tt.name AS to_team_name,
  rb.display_name AS requested_by_name,db.display_name AS decided_by_name
  FROM asset_team_transfers x
  JOIN assets a ON a.id=x.asset_id
  JOIN teams ft ON ft.id=x.from_team_id JOIN teams tt ON tt.id=x.to_team_id
  JOIN users rb ON rb.id=x.requested_by LEFT JOIN users db ON db.id=x.decided_by`;

/**
 * Team-to-team asset transfers. The asset code is deliberately NOT reissued:
 * asset_code is immutable (trigger) and the team-prefix check only runs on INSERT,
 * so the prefix stays as the issuing team and ownership is tracked by owning_team_id
 * plus this table and the audit trail.
 */
@Injectable()
export class TransferService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest, query: unknown) {
    const q = parse(listQuery, query ?? {});
    const values: any[] = [];
    const where: string[] = [];
    if (!isSuper(req)) {
      const teamIds = (req.user.teams ?? []).map((t) => t.teamId);
      if (!teamIds.length) throw new ForbiddenException('Insufficient permission');
      values.push(teamIds);
      const n = `$${values.length}::uuid[]`;
      where.push(
        q.direction === 'incoming'
          ? `x.to_team_id=ANY(${n})`
          : q.direction === 'outgoing'
            ? `x.from_team_id=ANY(${n})`
            : `(x.to_team_id=ANY(${n}) OR x.from_team_id=ANY(${n}))`,
      );
    }
    if (q.state) {
      values.push(q.state);
      where.push(`x.state=$${values.length}`);
    }
    const rows = await this.db.query(
      `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.requested_at DESC LIMIT 200`,
      values,
    );
    return { items: rows.map(camel) };
  }

  async request(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
    const data = parse(requestInput, body);
    return this.open(req, assetId, data, false);
  }

  async force(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
    assertCan(req.user, 'asset.change_team');
    return this.open(req, assetId, parse(requestInput, body), true);
  }

  private async open(
    req: AuthRequest,
    assetId: string,
    data: { toTeamId: string; reason: string },
    force: boolean,
  ) {
    return this.db.tx(async (c) => {
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );
      // Members/leads of the owning team (or Super Admin) may start a transfer.
      assertCan(req.user, 'asset.edit', asset.owning_team_id);
      if (asset.owning_team_id === data.toTeamId)
        throw new UnprocessableEntityException('The asset already belongs to that team');
      if (WRITE_OFF_STATUSES.has(asset.status))
        throw new UnprocessableEntityException('Retired or written-off assets cannot be transferred');
      const target = found(
        (await this.db.query('SELECT id,active FROM teams WHERE id=$1', [data.toTeamId], c))[0],
      );
      if (!target.active) throw new UnprocessableEntityException('The target team is not active');
      const [openRow] = await this.db.query(
        "SELECT id FROM asset_team_transfers WHERE asset_id=$1 AND state='REQUESTED'",
        [assetId],
        c,
      );
      if (openRow) {
        if (!force) throw new ConflictException('A transfer request for this asset is already open');
        // A forced move supersedes the pending request.
        await this.close(c, openRow.id, 'CANCELLED', req, 'Superseded by a forced transfer');
      }
      const [row] = await this.db.query(
        `INSERT INTO asset_team_transfers(asset_id,from_team_id,to_team_id,reason,requested_by)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [assetId, asset.owning_team_id, data.toTeamId, data.reason, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'ASSET_TRANSFER_REQUESTED', {
        transferId: row.id,
        from: asset.owning_team_id,
        to: data.toTeamId,
        reason: data.reason,
        force,
      });
      if (force) {
        await this.close(c, row.id, 'FORCED', req, null);
        await this.apply(c, req, row.id, asset, data.toTeamId, 'ASSET_TRANSFER_FORCED');
      } else {
        await this.tell(c, row.id, 'requested', [data.toTeamId], asset.asset_code, data.reason);
      }
      return this.one(c, row.id);
    });
  }

  async accept(req: AuthRequest, transferId: string, body: unknown) {
    const { note } = parse(acceptInput, body ?? {});
    return this.decide(req, transferId, 'ACCEPTED', note ?? null);
  }

  async decline(req: AuthRequest, transferId: string, body: unknown) {
    const { note } = parse(declineInput, body ?? {});
    return this.decide(req, transferId, 'DECLINED', note);
  }

  async cancel(req: AuthRequest, transferId: string, body: unknown) {
    const { note } = parse(cancelInput, body ?? {});
    return this.decide(req, transferId, 'CANCELLED', note ?? null);
  }

  private async decide(
    req: AuthRequest,
    transferId: string,
    state: 'ACCEPTED' | 'DECLINED' | 'CANCELLED',
    note: string | null,
  ) {
    id(transferId);
    return this.db.tx(async (c) => {
      const [probe] = await this.db.query(
        'SELECT asset_id FROM asset_team_transfers WHERE id=$1',
        [transferId],
        c,
      );
      found(probe);
      // Lock order: asset then transfer, same as open().
      const asset = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [probe.asset_id], c))[0],
      );
      const transfer = found(
        (
          await this.db.query('SELECT * FROM asset_team_transfers WHERE id=$1 FOR UPDATE', [transferId], c)
        )[0],
      );
      if (state === 'CANCELLED') {
        const mine = transfer.requested_by === req.user.id;
        if (!isSuper(req) && !mine && !inTeam(req, transfer.from_team_id))
          throw new ForbiddenException('Insufficient permission');
      } else if (!isSuper(req) && !inTeam(req, transfer.to_team_id)) {
        throw new ForbiddenException('Only the receiving team can answer this request');
      }
      if (transfer.state !== 'REQUESTED')
        throw new ConflictException('This transfer request has already been closed');
      if (state === 'ACCEPTED') {
        if (asset.owning_team_id !== transfer.from_team_id)
          throw new ConflictException('The asset changed owner since this request was made');
        if (WRITE_OFF_STATUSES.has(asset.status))
          throw new UnprocessableEntityException('Retired or written-off assets cannot be transferred');
      }
      await this.close(c, transferId, state, req, note);
      if (state === 'ACCEPTED') {
        await this.apply(c, req, transferId, asset, transfer.to_team_id, 'ASSET_TRANSFER_ACCEPTED');
      } else {
        await this.db.audit(c, req.user, 'asset', asset.id, `ASSET_TRANSFER_${state}`, {
          transferId,
          note,
        });
        await this.tell(
          c,
          transferId,
          state.toLowerCase(),
          [transfer.from_team_id, transfer.to_team_id],
          asset.asset_code,
          note,
        );
      }
      return this.one(c, transferId);
    });
  }

  private async close(
    c: PoolClient,
    transferId: string,
    state: string,
    req: AuthRequest,
    note: string | null,
  ) {
    await this.db.query(
      'UPDATE asset_team_transfers SET state=$2,decision_note=$3,decided_by=$4,decided_at=now() WHERE id=$1',
      [transferId, state, note, req.user.id],
      c,
    );
  }

  /** Moves ownership and open tickets, audits and notifies, inside the caller's transaction. */
  private async apply(
    c: PoolClient,
    req: AuthRequest,
    transferId: string,
    asset: any,
    toTeamId: string,
    action: string,
  ) {
    await this.db.query(
      'UPDATE assets SET owning_team_id=$2,version=version+1,updated_at=now() WHERE id=$1',
      [asset.id, toTeamId],
      c,
    );
    const moved = await this.db.query(
      `UPDATE tickets SET team_id=$2,owner_id=NULL,version=version+1,updated_at=now()
       WHERE asset_id=$1 AND status<>'COMPLETED' AND team_id<>$2 RETURNING id`,
      [asset.id, toTeamId],
      c,
    );
    for (const t of moved)
      await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility,body) VALUES($1,$2,'TEAM_CHANGED','INTERNAL','Rerouted: asset moved to another team')",
        [t.id, req.user.id],
        c,
      );
    await this.db.audit(c, req.user, 'asset', asset.id, action, {
      transferId,
      from: asset.owning_team_id,
      to: toTeamId,
      ticketsRerouted: moved.length,
    });
    await this.db.audit(c, req.user, 'asset', asset.id, 'ASSET_TEAM_CHANGED', {
      from: asset.owning_team_id,
      to: toTeamId,
      transferId,
    });
    await this.tell(
      c,
      transferId,
      action === 'ASSET_TRANSFER_FORCED' ? 'forced' : 'accepted',
      [asset.owning_team_id, toTeamId],
      asset.asset_code,
      null,
    );
  }

  private async tell(
    c: PoolClient,
    transferId: string,
    event: string,
    teamIds: string[],
    assetCode: string,
    note: string | null,
  ) {
    const rows = await this.db.query(
      `SELECT DISTINCT u.email FROM team_memberships m JOIN users u ON u.id=m.user_id
       WHERE m.team_id=ANY($1::uuid[]) AND u.state='ACTIVE'`,
      [teamIds],
      c,
    );
    if (!rows.length) return;
    await this.db.notify(
      c,
      `transfer:${transferId}:${event}`,
      'ASSET_TEAM_TRANSFER',
      rows.map((r) => r.email),
      {
        subject: `Asset ${assetCode}: team transfer ${event}`,
        text: `Asset ${assetCode} team transfer was ${event}.${note ? ` Note: ${note}` : ''}`,
      },
    );
  }

  private async one(c: PoolClient, transferId: string) {
    return camel((await this.db.query(`${SELECT} WHERE x.id=$1`, [transferId], c))[0]);
  }
}

@Controller()
@UseGuards(SessionGuard)
export class TransferController {
  constructor(@Inject(TransferService) private readonly service: TransferService) {}

  @Get('transfers')
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req, query);
  }

  @Post('assets/:id/transfers')
  request(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.request(req, assetId, body);
  }

  @Post('assets/:id/transfers/force')
  force(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.force(req, assetId, body);
  }

  @Post('transfers/:id/accept')
  accept(@Req() req: AuthRequest, @Param('id') transferId: string, @Body() body: unknown) {
    return this.service.accept(req, transferId, body);
  }

  @Post('transfers/:id/decline')
  decline(@Req() req: AuthRequest, @Param('id') transferId: string, @Body() body: unknown) {
    return this.service.decline(req, transferId, body);
  }

  @Post('transfers/:id/cancel')
  cancel(@Req() req: AuthRequest, @Param('id') transferId: string, @Body() body: unknown) {
    return this.service.cancel(req, transferId, body);
  }
}
