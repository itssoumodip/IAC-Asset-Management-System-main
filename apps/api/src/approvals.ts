import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { id as asUuid, parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';
import { RequestsService } from './requests';
import { TransferService } from './transfers';
import { DomainService } from './domain';

// The page historically sent APPROVED / REJECTED; accept both spellings.
const approvalDecision = z
  .object({
    decision: z
      .enum(['APPROVE', 'REJECT', 'APPROVED', 'REJECTED'])
      .transform((d) => (d.startsWith('APPROVE') ? 'APPROVE' : 'REJECT') as 'APPROVE' | 'REJECT'),
    reason: text(1000),
  })
  .strict();

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(TransferService) private readonly transfers: TransferService,
    @Inject(DomainService) private readonly domain: DomainService,
  ) {}

  async list(req: AuthRequest, tab: string) {
    assertCan(req.user, 'approvals.act');
    const userTeams = req.user.teams ?? [];
    const userTeamIds = userTeams.map((t) => t.teamId);
    const userRole = req.user.roles.includes('SUPER_ADMIN')
      ? 'SUPER_ADMIN'
      : req.user.roles.includes('FINANCE')
        ? 'FINANCE'
        : req.user.roles.includes('EXECUTIVE')
          ? 'EXECUTIVE'
          : userTeams.some((t) => t.level === 'LEAD')
            ? 'TEAM_LEAD'
            : userTeams.some((t) => t.level === 'MEMBER')
              ? 'TEAM_MEMBER'
              : 'EMPLOYEE';

    switch (tab) {
      case 'requests':
        return this.listRequests(req);
      case 'transfers':
        return this.listTransfers(req, userTeamIds);
      case 'change-requests':
        return this.listChangeRequests(userRole);
      case 'verification':
        return { items: [] };
      default:
        return { items: [] };
    }
  }

  /** Item request lines waiting for this lead's decision (Super Admin sees all). */
  private async listRequests(req: AuthRequest) {
    const { toDecide } = await this.requests.queue(req);
    return {
      items: toDecide.map((row: any) => ({
        id: row.id,
        requester: row.requesterName,
        requesterRole: row.teamCode
          ? `Request #${row.requestNumber} · for ${row.teamCode}`
          : `Request #${row.requestNumber}`,
        entityType: 'request',
        entityId: row.requestId,
        entityLabel: `${row.quantity} × ${row.assetTypeCode}`,
        action: 'Request item',
        before: row.inStock > 0 ? `${row.inStock} in store` : 'Out of stock',
        after: row.neededBy ? `Needed by ${String(row.neededBy).slice(0, 10)}` : 'No date given',
        when: row.createdAt,
        reason: row.remarks ?? '',
        status: 'PENDING',
      })),
    };
  }

  /** Team-to-team transfers waiting for the receiving team (Super Admin sees all). */
  private async listTransfers(req: AuthRequest, userTeamIds: string[]) {
    const superAdmin = req.user.roles.includes('SUPER_ADMIN');
    const transfers = await this.db.query(
      `SELECT x.id,x.asset_id,x.reason,x.requested_at,a.asset_code,a.description,
              ft.code AS from_code,tt.code AS to_code,u.display_name AS requester_name
         FROM asset_team_transfers x JOIN assets a ON a.id=x.asset_id
         JOIN teams ft ON ft.id=x.from_team_id JOIN teams tt ON tt.id=x.to_team_id
         JOIN users u ON u.id=x.requested_by
        WHERE x.state='REQUESTED' ${superAdmin ? '' : 'AND x.to_team_id = ANY($1::uuid[])'}
        ORDER BY x.requested_at`,
      superAdmin
        ? []
        : [userTeamIds.length ? userTeamIds : ['00000000-0000-0000-0000-000000000000']],
    );
    return {
      items: transfers.map((row: any) => ({
        id: row.id,
        requester: row.requester_name,
        requesterRole: `${row.from_code} team`,
        entityType: 'transfer',
        entityId: row.asset_id,
        entityLabel: row.asset_code || row.description || 'Asset',
        action: 'Move to another team',
        before: row.from_code,
        after: row.to_code,
        when: row.requested_at,
        reason: row.reason,
        status: 'PENDING',
      })),
    };
  }

  /** Older list of custody handovers awaiting the receiver; kept for reference, not shown. */
  private async listPendingHandovers(userTeamIds: string[]) {
    const rows = await this.db.query(
      `SELECT a.id, a.asset_id, a.user_id, a.assigned_by, a.assigned_at, a.handover_note,
              u.display_name AS requester_name,
              coalesce((
                SELECT ur.role_code FROM user_roles ur WHERE ur.user_id=u.id
                ORDER BY CASE ur.role_code
                  WHEN 'SUPER_ADMIN' THEN 0 WHEN 'EXECUTIVE' THEN 1 WHEN 'FINANCE' THEN 2
                  WHEN 'TEAM_LEAD' THEN 3 WHEN 'TEAM_MEMBER' THEN 4 WHEN 'STORE' THEN 5
                  WHEN 'TECHNICIAN' THEN 6 WHEN 'AUDITOR' THEN 7 WHEN 'INSURER' THEN 8
                  WHEN 'PROCUREMENT' THEN 9 ELSE 10 END
                LIMIT 1
              ), 'EMPLOYEE') AS requester_role_code,
              ast.asset_code, ast.description AS asset_desc,
              prev_user.display_name AS prev_custodian_name,
              ass_team.code AS asset_team_code, ass_team.id AS asset_team_id
       FROM assignments a
       JOIN users u ON u.id = a.assigned_by
       JOIN assets ast ON ast.id = a.asset_id
       JOIN teams ass_team ON ass_team.id = ast.owning_team_id
       LEFT JOIN assignments prev ON prev.asset_id = a.asset_id AND prev.ended_at IS NOT NULL
       LEFT JOIN users prev_user ON prev_user.id = prev.user_id
       WHERE a.acknowledgement = 'PENDING' AND a.ended_at IS NULL
         AND ass_team.id = ANY($1::uuid[])
       ORDER BY a.assigned_at DESC`,
      [userTeamIds.length ? userTeamIds : ['00000000-0000-0000-0000-000000000000']],
    );
    return {
      items: rows.map((row: any) => ({
        id: row.id,
        requester: row.requester_name,
        requesterRole:
          (row.requester_role_code as string | undefined)?.replace('_', ' ') ?? 'Employee',
        entityType: 'asset',
        entityId: row.asset_id,
        entityLabel: row.asset_code || row.asset_desc || 'Asset',
        action: 'Transfer custody',
        before: row.prev_custodian_name ?? 'Unassigned',
        after: row.requester_name,
        when: row.assigned_at,
        reason: row.handover_note,
        status: 'PENDING',
      })),
    };
  }

  private async listChangeRequests(userRole: string) {
    // Change requests pending approval, where the owner_role matches the user's role
    const rows = await this.db.query(
      `SELECT acr.id, acr.asset_id, acr.requester_id, acr.owner_role, acr.proposed_changes,
              acr.reason, acr.created_at, acr.asset_version,
              u.display_name AS requester_name,
              ast.asset_code, ast.description AS asset_desc
       FROM asset_change_requests acr
       JOIN users u ON u.id = acr.requester_id
       JOIN assets ast ON ast.id = acr.asset_id
       WHERE acr.status = 'PENDING'
         AND acr.owner_role = $1
       ORDER BY acr.created_at DESC`,
      [userRole],
    );
    return {
      items: rows.map((row: any) => {
        const changes = row.proposed_changes ?? {};
        const before = changes.before ?? '—';
        const after = changes.after ?? '—';
        return {
          id: row.id,
          requester: row.requester_name,
          requesterRole: row.owner_role.replace('_', ' '),
          entityType: 'asset',
          entityId: row.asset_id,
          entityLabel: row.asset_code || row.asset_desc || 'Asset',
          action: 'Change field',
          before,
          after,
          when: row.created_at,
          reason: row.reason,
          status: 'PENDING',
        };
      }),
    };
  }

  async decide(req: AuthRequest, id: string, body: unknown) {
    assertCan(req.user, 'approvals.act');
    const input = parse(approvalDecision, body);
    const idUuid = asUuid(id);

    // Item request line → the requests service decides it (lead of the handling team).
    if (await this.requests.isRequestItem(idUuid))
      return this.requests.decide(req, idUuid, { decision: input.decision, reason: input.reason });
    // Team transfer → accept or decline on behalf of the receiving team.
    const [transfer] = await this.db.query('SELECT 1 FROM asset_team_transfers WHERE id=$1', [
      idUuid,
    ]);
    if (transfer)
      return input.decision === 'APPROVE'
        ? this.transfers.accept(req, idUuid, { note: input.reason })
        : this.transfers.decline(req, idUuid, { note: input.reason });

    const [existing] = await this.db.query(
      'SELECT id, status FROM asset_change_requests WHERE id = $1',
      [idUuid],
    );
    if (!existing) throw new NotFoundException('Approval request not found');
    if (existing.status !== 'PENDING')
      throw new UnprocessableEntityException('This request has already been reviewed');

    // Asset change request → the asset service reviews it: only the owning role
    // (or Super Admin) may decide, an approval applies the change to the asset
    // with a version check, and both outcomes are audited.
    const reviewed = await this.domain.reviewChangeRequest(req, idUuid, {
      decision: input.decision,
      reason: input.reason,
    });
    return { ...reviewed, id: idUuid, status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  }
}

@Controller('approvals')
@UseGuards(SessionGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly service: ApprovalsService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ tab: z.string().optional() }), query);
    return this.service.list(req, parsed.tab ?? 'requests');
  }

  @Patch(':id')
  decide(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.decide(req, id, body);
  }
}
