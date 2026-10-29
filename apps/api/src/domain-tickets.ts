import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AssetDomain } from './domain-assets';
import { sanitizeImage, TICKET_PHOTO } from './image-sanitize';
import { AuthRequest, requireRole, assertVersion } from './security';
import {
  camel,
  found,
  id,
  idempotent,
  insertObject,
  NON_REPORTABLE_STATUSES,
  page,
  parse,
  requestPage,
  staff,
  statusInput,
  ticketColumns,
  ticketInput,
  ticketScope,
  updateInput,
  uuid,
  validateReference,
} from './domain-helpers';

export class TicketDomain extends AssetDomain {
  async staffRecipients(c: PoolClient) {
    // Group addresses must resolve to a currently active, verified privileged account.
    const rows = await this.db.query(
      `SELECT DISTINCT r.email FROM notification_recipients r JOIN notification_groups g ON g.id=r.group_id JOIN users u ON u.email=r.email WHERE g.enabled AND r.verified_at IS NOT NULL AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ((g.code='ADMIN' AND ur.role_code='ADMIN') OR (g.code='IT' AND ur.role_code='IT_ADMIN')))`,
      [],
      c,
    );
    return rows.map((r) => r.email);
  }
  async adminRecipients(c: PoolClient) {
    const rows = await this.db.query(
      `SELECT DISTINCT u.email FROM users u
       WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='ADMIN')`,
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
          `SELECT ${ticketColumns}${staff(req.user) ? ',t.reporter_id' : ''},(SELECT count(*)::int FROM ticket_photos p WHERE p.ticket_id=t.id) AS photo_count FROM tickets t WHERE t.id=$1 AND ${scope}${lock ? ' FOR UPDATE OF t' : ''}`,
          values,
          c,
        )
      )[0],
    );
    return camel(row);
  }
  async tickets(req: AuthRequest, query: any) {
    const { ownership: requestedOwnership, ...filters } = query;
    const ownership = z
      .enum(['ANY', 'MINE', 'UNASSIGNED'])
      .default('ANY')
      .parse(requestedOwnership);
    const p = requestPage(filters, ['created_at', 'id']);
    if (ownership !== 'ANY' && p.ownerId)
      throw new UnprocessableEntityException('Choose ownership or ownerId, not both');
    const values: any[] = [];
    const where = [ticketScope(req.user, values)];
    if (ownership !== 'ANY') {
      if (!staff(req.user))
        throw new ForbiddenException('Team ownership filters require support access');
      if (ownership === 'UNASSIGNED') where.push('t.owner_id IS NULL');
      else {
        values.push(req.user.id);
        where.push(`t.owner_id=$${values.length}`);
      }
    }
    for (const [key, col] of [
      ['status', 'status'],
      ['category', 'category'],
      ['priority', 'priority'],
      ['ownerId', 'owner_id'],
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
        `SELECT ${ticketColumns}${staff(req.user) ? ',t.reporter_id' : ''},to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT $${values.length}`,
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
      if (data.assetId) {
        // Serialize custody snapshot with return/reassign so the recorded assignment was current.
        const [asset] = await this.db.query(
          'SELECT status FROM assets WHERE id=$1 FOR UPDATE',
          [data.assetId],
          c,
        );
        found(asset);
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
      if (data.relatedTicketId) await this.ticket(req, data.relatedTicketId, c);
      const row = await insertObject(
        this.db,
        'tickets',
        { ...data, reporterId: req.user.id, assignmentAtCreationId: assignment?.id || null },
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
        category: data.category,
        priority: data.priority,
        photoCount: images.length,
      });
      const recipients = await this.adminRecipients(c);
      await this.db.notify(
        c,
        `ticket:${row.id}:created`,
        'TICKET_CREATED',
        recipients,
        {
          subject: `IAC support ticket #${row.ticket_number} created`,
          text: 'A support ticket has been created. Sign in to the IAC Asset portal to view the ticket.',
        },
        {
          kind: 'TICKET',
          entityId: row.id,
          title: `Support ticket #${row.ticket_number} created`,
          message: 'A new ticket is ready for support triage.',
        },
      );
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
    if (!staff(req.user)) where.push("u.visibility='PUBLIC'");
    if (p.after) {
      values.push(...p.after);
      where.push(
        `(u.created_at,u.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(p.limit + 1);
    const result = page(
      await this.db.query(
        `SELECT u.id,u.ticket_id,u.kind,u.visibility,u.body,u.old_status,u.new_status,u.created_at,to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM ticket_updates u WHERE ${where.join(' AND ')} ORDER BY u.created_at,u.id LIMIT $${values.length}`,
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
    if (data.visibility === 'INTERNAL' && !staff(req.user))
      throw new ForbiddenException('Internal notes require a staff role');
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
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
        const recipients = staff(req.user) ? [reporter.email] : await this.staffRecipients(c);
        await this.db.notify(
          c,
          `ticket-update:${row.id}`,
          'TICKET_REPLY',
          recipients,
          {
            subject: `IAC support ticket #${before.ticketNumber} updated`,
            text: 'A public reply has been added to your support ticket. Sign in to read the reply.',
          },
          {
            kind: 'TICKET',
            entityId: ticketId,
            title: `Support ticket #${before.ticketNumber} updated`,
            message: 'A public reply was added. Open the ticket to read it.',
          },
        );
      }
      return { ...camel(row), ticketVersion: after.version };
    });
  }
  async ticketOwner(req: AuthRequest, ticketId: string, body: unknown) {
    requireRole(req, 'ADMIN', 'IT_ADMIN');
    id(ticketId);
    const data = parse(z.object({ ownerId: uuid.nullable() }).strict(), body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
      assertVersion(req, before.version);
      if (before.status === 'COMPLETED')
        throw new ConflictException('Completed tickets are terminal');
      if (data.ownerId)
        found(
          (
            await this.db.query(
              `SELECT u.id FROM users u WHERE u.id=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code IN ('ADMIN','IT_ADMIN')) FOR SHARE OF u`,
              [data.ownerId],
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
      if (data.ownerId) {
        const [owner] = await this.db.query(
          'SELECT email FROM users WHERE id=$1',
          [data.ownerId],
          c,
        );
        await this.db.notify(
          c,
          `ticket:${ticketId}:owner:v${before.version + 1}`,
          'TICKET_OWNER',
          [owner.email],
          {
            subject: `Support ticket #${before.ticketNumber} assigned to you`,
            text: 'Open the portal to review your support assignment.',
          },
          {
            kind: 'TICKET',
            entityId: ticketId,
            title: `Support ticket #${before.ticketNumber} assigned to you`,
            message: 'Review the support queue and next action.',
          },
        );
      }
      return this.ticket(req, ticketId, c);
    });
  }
  async ticketStatus(req: AuthRequest, ticketId: string, body: unknown) {
    requireRole(req, 'ADMIN', 'IT_ADMIN');
    id(ticketId);
    const data = parse(statusInput, body);
    return this.db.tx(async (c) => {
      const before = await this.ticket(req, ticketId, c, true);
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
      {
        const [reporter] = await this.db.query(
          'SELECT u.email FROM users u JOIN tickets t ON t.reporter_id=u.id WHERE t.id=$1',
          [ticketId],
          c,
        );
        await this.db.notify(
          c,
          `ticket:${ticketId}:status:v${before.version + 1}`,
          complete ? 'TICKET_COMPLETED' : 'TICKET_STATUS',
          [reporter.email],
          {
            subject: `IAC support ticket #${before.ticketNumber}: ${data.status}`,
            text: complete
              ? 'Your support ticket was completed. Sign in to review the resolution. For follow-up, create a related ticket.'
              : 'Your support ticket status changed. Sign in to review the current state.',
          },
          {
            kind: 'TICKET',
            entityId: ticketId,
            title: `Support ticket #${before.ticketNumber}: ${data.status}`,
            message: complete
              ? 'Review the resolution in your ticket.'
              : 'Review the current status in your ticket.',
          },
        );
      }
      return this.ticket(req, ticketId, c);
    });
  }
}
