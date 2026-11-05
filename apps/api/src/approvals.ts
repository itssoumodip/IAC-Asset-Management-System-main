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

const approvalDecision = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: text(1000),
  })
  .strict();

@Injectable()
export class ApprovalsService {
  constructor(@Inject(Db) private readonly db: Db) {}

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
        return this.listTransfers(userTeamIds);
      case 'change-requests':
        return this.listChangeRequests(userRole);
      case 'verification':
        return { items: [] };
      default:
        return { items: [] };
    }
  }

  private async listRequests(_req: AuthRequest) {
    // Open tickets that are unassigned (owner_id IS NULL) - requests needing action
    const rows = await this.db.query(
      `SELECT t.id, t.subject, t.description, t.created_at, u.display_name AS requester_name,
              u.email AS requester_email, t.team_id, tm.code AS team_code
       FROM tickets t
       JOIN users u ON u.id = t.reporter_id
       JOIN teams tm ON tm.id = t.team_id
       WHERE t.owner_id IS NULL AND t.status = 'OPEN'
       ORDER BY t.created_at DESC`,
    );
    return {
      items: rows.map((row: any) => ({
        id: row.id,
        requester: row.requester_name,
        requesterRole: 'Employee',
        entityType: 'ticket',
        entityId: row.id,
        entityLabel: row.subject,
        action: 'Create ticket',
        before: '—',
        after: 'Open',
        when: row.created_at,
        reason: row.description?.slice(0, 120),
        status: 'PENDING',
      })),
    };
  }

  private async listTransfers(userTeamIds: string[]) {
    // Assignments where acknowledgement='PENDING' and the user's team owns the asset
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
        requesterRole: (row.requester_role_code as string | undefined)?.replace('_', ' ') ?? 'Employee',
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

    const [existing] = await this.db.query(
      'SELECT id, status FROM asset_change_requests WHERE id = $1 FOR UPDATE',
      [idUuid],
    );
    if (!existing) throw new NotFoundException('Approval request not found');
    if (existing.status !== 'PENDING')
      throw new UnprocessableEntityException('This request has already been reviewed');

    const [updated] = await this.db.query(
      `UPDATE asset_change_requests
       SET status = $1, reviewed_by = $2, review_reason = $3, reviewed_at = now()
       WHERE id = $4 RETURNING id, status`,
      [input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.user.id, input.reason, idUuid],
    );

    return { id: updated.id, status: updated.status };
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
