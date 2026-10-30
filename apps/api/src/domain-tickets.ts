import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AssetDomain } from './domain-assets';
import { sanitizeImage, TICKET_PHOTO } from './image-sanitize';
import { AuthRequest, assertVersion } from './security';
import { can } from './policy';
import {
  camel,
  canWorkTicket,
  found,
  id,
  idempotent,
  insertObject,
  NON_REPORTABLE_STATUSES,
  page,
  parse,
  requestPage,
  statusInput,
  ticketColumns,
  ticketInput,
  ticketScope,
  updateInput,
  text,
  uuid,
  validateReference,
} from './domain-helpers';

const IT_TEAM_ID = '00000000-0000-4000-8000-000000000001';

export class TicketDomain extends AssetDomain {
  async staffRecipients(c: PoolClient) {
    // Group addresses must resolve to a currently active, verified privileged account.
    const rows = await this.db.query(
      `SELECT DISTINCT r.email FROM notification_recipients r JOIN notification_groups g ON g.id=r.group_id JOIN users u ON u.email=r.email WHERE g.enabled AND r.verified_at IS NOT NULL AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND ((g.code='ADMIN' AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='SUPER_ADMIN')) OR (g.code='IT' AND EXISTS(SELECT 1 FROM team_memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=u.id AND t.code='IT')))`,
      [],
      c,
    );
    return rows.map((r) => r.email);
  }
  /** Verified, active members of a team. */
  async teamRecipients(c: PoolClient, teamId: string) {
    const rows = await this.db.query(
      `SELECT DISTINCT u.email FROM users u JOIN team_memberships m ON m.user_id=u.id
       WHERE m.team_id=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL`,
      [teamId],
      c,
    );
    return rows.map((r) => r.email);
  }
  async adminRecipients(c: PoolClient) {
    const rows = await this.db.query(
      `SELECT DISTINCT u.email FROM users u
       WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='SUPER_ADMIN')`,
      [],
      c,
    );
    return rows.map((r) => r.email);
  }
  async ticket(req: AuthRequest, ticketId: string, c?: PoolClient, lock = false) {
    const values: any[] = [id(ticketId)];
    const scope = ticketScope(req.user, values);
    const row = found(
      (
        await this.db.query(
          `SELECT ${ticketColumns}${can(req.user, 'ticket.work') ? ',t.reporter_id' : ''},(SELECT count(*)::int FROM ticket_photos p WHERE p.ticket_id=t.id) AS photo_count FROM tickets t WHERE t.id=$1 AND ${scope}${lock ? ' FOR UPDATE OF t' : ''}`,
          values,
          c,
        )
      )[0],
    );
    return camel(row);
  }
  async tickets(req: AuthRequest, query: any) {
    const p = requestPage(query, ['created_at', 'id']);
    const values: any[] = [];
    const where = [ticketScope(req.user, values)];
    for (const [key, col] of [
      ['status', 'status'],
      ['category', 'category'],
      ['priority', 'priority'],
      ['ownerId', 'owner_id'],
      ['teamId', 'team_id'],
    ] as const)
      if (p[key]) {
        values.push(p[key]);
        where.push(`t.${col}=$${values.length}`);
      }
    if (p.q) {
      values.push(p.q);
      where.push(
        `(strpos(lower(t.subject),lower($${values.length}))>0 OR strpos(t.ticket_number::text,$${values.length})>0)`,
      );
    }
    if (p.after) {
      values.push(...p.after);
      where.push(
        `(t.created_at,t.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(p.limit + 1);
    return page(
      await this.db.query(
        `SELECT ${ticketColumns}${can(req.user, 'ticket.work') ? ',t.reporter_id' : ''} FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT $${values.length}`,
        values,
      ),
      p.limit,
      ['created_at', 'id'],
    );
  }
  async createTicket(req: AuthRequest, body: unknown) {
    const { photos = [], ...data } = parse(ticketInput, body);
    // Sanitize before the transaction so invalid photos never take row locks.
    // Process sequentially to cap peak memory at one large image at a time.
    const images: Awaited<ReturnType<typeof sanitizeImage>>[] = [];
    for (const p of photos) {
      images.push(await sanitizeImage(p, TICKET_PHOTO));
    }
    return idempotent(this.db, req, 'POST /tickets', { ...data, photos }, async (c) => {
      await validateReference(this.db, 'TICKET_CATEGORY', data.category, c, 'category');
      await validateReference(this.db, 'TICKET_PRIORITY', data.priority, c, 'priority');
      let assignment: any = null;
      let teamId: string | null = null;
      if (data.assetId) {
        // Serialize custody snapshot with return/reassign so the recorded assignment was current.
        const [asset] = await this.db.query(
          'SELECT status,owning_team_id FROM assets WHERE id=$1 FOR UPDATE',
          [data.assetId],
          c,
        );
        found(asset);
        teamId = asset.owning_team_id;
        if ((NON_REPORTABLE_STATUSES as readonly string[]).includes(asset.status))
          throw new UnprocessableEntityException(
            'This asset is not in service and cannot be reported',
          );
        assignment =
          (
            await this.db.query(
              'SELECT id FROM assignments WHERE asset_id=$1 AND user_id=$2 AND ended_at IS NULL FOR SHARE',
              [data.assetId, req.user.id],
              c,
            )
          )[0] || null;
      }
      if (!teamId)
        teamId =
          (
            await this.db.query(
              'SELECT team_id FROM ticket_category_teams WHERE category_code=$1',
              [data.category],
              c,
            )
          )[0]?.team_id || IT_TEAM_ID;
      if (data.relatedTicketId) await this.ticket(req, data.relatedTicketId, c);
      const row = await insertObject(
        this.db,
        'tickets',
        { ...data, teamId, reporterId: req.user.id, assignmentAtCreationId: assignment?.id || null },
        c,
      );
      for (const [i, image] of images.entries())
        await this.db.query(
          "INSERT INTO ticket_photos(ticket_id,position,content,mime_type,sha256,width,height,created_by) VALUES($1,$2,$3,'image/jpeg',$4,$5,$6,$7)",
          [row.id, i + 1, image.content, image.sha256, image.width, image.height, req.user.id],
          c,
        );
      await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility) VALUES($1,$2,'CREATED','PUBLIC')",
        [row.id, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'ticket', row.id, 'TICKET_CREATED', {
        assetId: data.assetId || null,
        teamId,
        category: data.category,
        priority: data.priority,
        photoCount: images.length,
      });
      const recipients = [
        ...(await this.adminRecipients(c)),
        ...(await this.teamRecipients(c, teamId!)),
      ];
      await this.db.notify(c, `ticket:${row.id}:created`, 'TICKET_CREATED', recipients, {
        subject: `IAC support ticket #${row.ticket_number} created`,
        text: 'A support ticket has been created. Sign in to the IAC Asset portal to view the ticket.',
      });
      return { ...(await this.ticket(req, row.id, c)), notificationState: 'QUEUED' };
    });
  }
  async ticketPhoto(req: AuthRequest, ticketId: string, position: number) {
    await this.ticket(req, ticketId);
    const row = found(
      (
        await this.db.query(
          'SELECT content,mime_type FROM ticket_photos WHERE ticket_id=$1 AND position=$2',
          [ticketId, position],
        )
      )[0],
    );
    return { dataUrl: `data:${row.mime_type};base64,${row.content.toString('base64')}` };
  }
  async updates(req: AuthRequest, ticketId: string, query: any) {
    const ticket = await this.ticket(req, ticketId);
    const p = requestPage(query, ['created_at', 'id']);
    const values: any[] = [ticketId];
    const where = ['u.ticket_id=$1'];
    if (!canWorkTicket(req.user, ticket.teamId)) where.push("u.visibility='PUBLIC'");
    if (p.after) {
      values.push(...p.after);
      where.push(
        `(u.created_at,u.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(p.limit + 1);
    const result = page(
      await this.db.query(
        `SELECT u.id,u.ticket_id,u.kind,u.visibility,u.body,u.old_status,u.new_status,u.created_at FROM ticket_updates u WHERE ${where.join(' AND ')} ORDER BY u.created_at,u.id LIMIT $${values.length}`,
        values,
      ),
      p.limit,
      ['created_at', 'id'],
    );
    return { ...result, ticketVersion: ticket.version };
  }
  async addUpdate(req: AuthRequest, ticketId: string, body: unknown) {
    id(ticketId);
    const data = parse(updateInput, body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
      if (data.visibility === 'INTERNAL' && !canWorkTicket(req.user, before.teamId))
        throw new ForbiddenException('Internal notes require membership of the ticket team');
      assertVersion(req, before.version);
      if (before.status === 'COMPLETED')
        throw new ConflictException('Completed tickets cannot receive updates');
      const [row] = await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility,body) VALUES($1,$2,'COMMENT',$3,$4) RETURNING id,ticket_id,kind,visibility,body,created_at",
        [ticketId, req.user.id, data.visibility, data.body],
        c,
      );
      const [after] = await this.db.query(
        'UPDATE tickets SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version',
        [ticketId],
        c,
      );
      await this.db.audit(
        c,
        req.user,
        'ticket',
        ticketId,
        data.visibility === 'INTERNAL' ? 'INTERNAL_NOTE_ADDED' : 'PUBLIC_REPLY_ADDED',
        { updateId: row.id },
      );
      if (data.visibility === 'PUBLIC') {
        const [reporter] = await this.db.query(
          'SELECT u.email FROM users u JOIN tickets t ON t.reporter_id=u.id WHERE t.id=$1',
          [ticketId],
          c,
        );
        const recipients = canWorkTicket(req.user, before.teamId)
          ? [reporter.email]
          : [...(await this.adminRecipients(c)), ...(await this.teamRecipients(c, before.teamId))];
        await this.db.notify(c, `ticket-update:${row.id}`, 'TICKET_REPLY', recipients, {
          subject: `IAC support ticket #${before.ticketNumber} updated`,
          text: 'A public reply has been added to your support ticket. Sign in to read the reply.',
        });
      }
      return { ...camel(row), ticketVersion: after.version };
    });
  }
  assertTicketWork(req: AuthRequest, teamId: string) {
    if (!canWorkTicket(req.user, teamId))
      throw new ForbiddenException('Insufficient permission for this ticket team');
  }
  async moveTicketTeam(req: AuthRequest, ticketId: string, body: unknown) {
    id(ticketId);
    const data = parse(z.object({ teamId: uuid, reason: text(1000) }).strict(), body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
      assertVersion(req, before.version);
      const lead = (req.user.teams ?? []).some(
        (t) => t.teamId === before.teamId && t.level === 'LEAD',
      );
      if (!req.user.roles.includes('SUPER_ADMIN') && !lead)
        throw new ForbiddenException('Only a Super Admin or lead of the current team can move a ticket');
      if (before.status === 'COMPLETED')
        throw new ConflictException('Completed tickets are terminal');
      if (data.teamId === before.teamId)
        throw new ConflictException('The ticket is already with this team');
      const team = found(
        (await this.db.query('SELECT active FROM teams WHERE id=$1 FOR SHARE', [data.teamId], c))[0],
      );
      if (!team.active) throw new UnprocessableEntityException('The team is not active');
      // The previous owner belongs to the old team; the new team picks its own.
      const [moved] = await this.db.query(
        'UPDATE tickets SET team_id=$2,owner_id=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,team_id,owner_id,version,status',
        [ticketId, data.teamId],
        c,
      );
      await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility) VALUES($1,$2,'TEAM_CHANGED','INTERNAL')",
        [ticketId, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'ticket', ticketId, 'TICKET_TEAM_CHANGED', {
        from: before.teamId,
        to: data.teamId,
        reason: data.reason,
        clearedOwnerId: before.ownerId || null,
      });
      // The actor may have just lost visibility of the ticket, so do not re-read it through their scope.
      return camel(moved);
    });
  }
  async ticketOwner(req: AuthRequest, ticketId: string, body: unknown) {
    id(ticketId);
    const data = parse(z.object({ ownerId: uuid.nullable() }).strict(), body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
      this.assertTicketWork(req, before.teamId);
      assertVersion(req, before.version);
      if (before.status === 'COMPLETED')
        throw new ConflictException('Completed tickets are terminal');
      if (data.ownerId)
        found(
          (
            await this.db.query(
              `SELECT u.id FROM users u WHERE u.id=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND (EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='SUPER_ADMIN') OR EXISTS(SELECT 1 FROM team_memberships m WHERE m.user_id=u.id AND m.team_id=$2)) FOR SHARE OF u`,
              [data.ownerId, before.teamId],
              c,
            )
          )[0],
        );
      await this.db.query(
        'UPDATE tickets SET owner_id=$2,version=version+1,updated_at=now() WHERE id=$1',
        [ticketId, data.ownerId],
        c,
      );
      await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility) VALUES($1,$2,'OWNER_CHANGED','INTERNAL')",
        [ticketId, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'ticket', ticketId, 'TICKET_OWNER_CHANGED', {
        ownerId: data.ownerId,
      });
      return this.ticket(req, ticketId, c);
    });
  }
  /** Who a ticket worker may pick as owner: active verified team members plus Super Admins. */
  async ticketOwnerCandidates(req: AuthRequest, ticketId: string) {
    const ticket = await this.ticket(req, ticketId);
    this.assertTicketWork(req, ticket.teamId);
    const items = await this.db.query(
      `SELECT u.id,u.display_name,u.email FROM users u
       WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
         AND (EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='SUPER_ADMIN')
           OR EXISTS(SELECT 1 FROM team_memberships m WHERE m.user_id=u.id AND m.team_id=$1))
       ORDER BY u.display_name,u.id`,
      [ticket.teamId],
    );
    return { items: items.map(camel) };
  }
  async ticketStatus(req: AuthRequest, ticketId: string, body: unknown) {
    id(ticketId);
    const data = parse(statusInput, body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
      this.assertTicketWork(req, before.teamId);
      assertVersion(req, before.version);
      if (before.status === 'COMPLETED' || before.status === data.status)
        throw new ConflictException('Invalid ticket status transition');
      const complete = data.status === 'COMPLETED';
      await this.db.query(
        'UPDATE tickets SET status=$2,resolution=$3,completed_by=$4,completed_at=CASE WHEN $5 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1',
        [
          ticketId,
          data.status,
          complete ? data.resolution : null,
          complete ? req.user.id : null,
          complete,
        ],
        c,
      );
      await this.db.query(
        "INSERT INTO ticket_updates(ticket_id,actor_id,kind,visibility,body,old_status,new_status) VALUES($1,$2,'STATUS_CHANGED','PUBLIC',$3,$4,$5) RETURNING id",
        [ticketId, req.user.id, complete ? data.resolution : null, before.status, data.status],
        c,
      );
      await this.db.audit(c, req.user, 'ticket', ticketId, 'TICKET_STATUS_CHANGED', {
        from: before.status,
        to: data.status,
      });
      if (complete) {
        const [reporter] = await this.db.query(
          'SELECT u.email FROM users u JOIN tickets t ON t.reporter_id=u.id WHERE t.id=$1',
          [ticketId],
          c,
        );
        await this.db.notify(
          c,
          `ticket:${ticketId}:completed`,
          'TICKET_COMPLETED',
          [reporter.email],
          {
            subject: `IAC support ticket #${before.ticketNumber} completed`,
            text: 'Your support ticket was completed. Sign in to review the resolution. For follow-up, create a related ticket.',
          },
        );
      }
      return this.ticket(req, ticketId, c);
    });
  }
}
