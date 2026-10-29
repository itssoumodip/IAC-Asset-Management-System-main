import {
  Inject,
  Injectable,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  NotFoundException,
  Res,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { configuration } from './config';
import { AuthRequest, SessionGuard } from './security';

const announcementId = z.string().uuid();
const visibleToUser = (versionParam = '$2') => `
  u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
  AND u.portal_accepted_at IS NOT NULL AND u.portal_notice_version=${versionParam}
  AND (n.audience='ALL'
    OR (n.audience='ADMIN' AND EXISTS(SELECT 1 FROM user_roles ar WHERE ar.user_id=u.id AND ar.role_code='ADMIN'))
    OR (n.audience='DEPARTMENT' AND n.department_id=u.department_id))`;

const workflowVisible = `u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.portal_accepted_at IS NOT NULL AND u.portal_notice_version=$2 AND (
 (n.kind='ASSIGNMENT' AND EXISTS(SELECT 1 FROM assignments a WHERE a.id=n.entity_id AND (a.user_id=u.id AND EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='EMPLOYEE') OR EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='ADMIN'))))
 OR (n.kind='TICKET' AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=n.entity_id AND (t.reporter_id=u.id OR EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code IN ('ADMIN','IT_ADMIN')))))
 OR (n.kind='FINANCE_REVIEW' AND EXISTS(SELECT 1 FROM assets a WHERE a.id=n.entity_id) AND EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='FINANCE'))
 OR (n.kind='FINANCE_RESULT' AND EXISTS(SELECT 1 FROM assets a WHERE a.id=n.entity_id) AND EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='ADMIN')))`;
const workflowPath = `CASE WHEN n.kind='TICKET' THEN '/tickets/'||n.entity_id::text WHEN n.kind IN ('FINANCE_REVIEW','FINANCE_RESULT') THEN '/finance/'||n.entity_id::text WHEN EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='ADMIN') THEN (SELECT '/assets/'||a.asset_id::text FROM assignments a WHERE a.id=n.entity_id) ELSE '/equipment/mine' END`;
@Injectable()
export class NotificationsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async workflow(req: AuthRequest, query: unknown = {}) {
    const input = z
      .object({
        filter: z.enum(['ALL', 'UNREAD']).default('ALL'),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(500).optional(),
      })
      .strict()
      .parse(query);
    const values: any[] = [req.user.id, configuration().noticeVersion];
    let boundary = '';
    if (input.cursor) {
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      } catch {
        decoded = null;
      }
      const cursor = z
        .object({ createdAt: z.string().datetime(), id: z.string().uuid() })
        .strict()
        .parse(decoded);
      values.push(cursor.createdAt, cursor.id);
      boundary = ' AND (n.created_at,n.id)<($3::timestamptz,$4::uuid)';
    }
    values.push(input.limit + 1);
    return this.db.tx(async (c) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], c);
      const rows = await this.db.query(
        `SELECT n.id,n.title,n.message,${workflowPath} AS path,n.kind,n.created_at,to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,(r.read_at IS NOT NULL) AS read FROM workflow_notifications n JOIN users u ON u.id=n.user_id LEFT JOIN workflow_notification_reads r ON r.notification_id=n.id AND r.user_id=u.id WHERE n.user_id=$1 AND ${workflowVisible}${input.filter === 'UNREAD' ? ' AND r.read_at IS NULL' : ''}${boundary} ORDER BY n.created_at DESC,n.id DESC LIMIT $${values.length}`,
        values,
        c,
      );
      const [counts] = await this.db.query(
        `SELECT count(*)::int total,count(*) FILTER(WHERE r.read_at IS NULL)::int unread FROM workflow_notifications n JOIN users u ON u.id=n.user_id LEFT JOIN workflow_notification_reads r ON r.notification_id=n.id AND r.user_id=u.id WHERE n.user_id=$1 AND ${workflowVisible}`,
        [req.user.id, configuration().noticeVersion],
        c,
      );
      const items = rows.slice(0, input.limit).map((r) => ({ ...r, createdAt: r.created_at }));
      return {
        items,
        total: counts.total,
        unreadCount: counts.unread,
        nextCursor:
          rows.length > input.limit
            ? Buffer.from(
                JSON.stringify({
                  createdAt: items.at(-1)!.cursor_time,
                  id: items.at(-1)!.id,
                }),
              ).toString('base64url')
            : null,
      };
    });
  }
  async workflowRead(req: AuthRequest, value?: unknown) {
    const id = value === undefined ? undefined : announcementId.parse(value);
    const rows = await this.db.query(
      `INSERT INTO workflow_notification_reads(notification_id,user_id) SELECT n.id,u.id FROM workflow_notifications n JOIN users u ON u.id=n.user_id WHERE n.user_id=$1 AND ${workflowVisible}${id ? ' AND n.id=$3' : ''} ON CONFLICT DO NOTHING RETURNING notification_id`,
      [req.user.id, configuration().noticeVersion, ...(id ? [id] : [])],
    );
    if (id && !rows.length) {
      const page = await this.db.query(
        `SELECT n.id FROM workflow_notifications n JOIN users u ON u.id=n.user_id WHERE n.user_id=$1 AND ${workflowVisible} AND n.id=$3`,
        [req.user.id, configuration().noticeVersion, id],
      );
      if (!page.length) throw new NotFoundException('Workflow notification not found');
    }
    return { read: true };
  }
  async inbox(req: AuthRequest, query: unknown = {}) {
    const input = z
      .object({
        filter: z.enum(['ALL', 'UNREAD']).default('ALL'),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(500).optional(),
      })
      .strict()
      .parse(query);
    const values: any[] = [req.user.id, configuration().noticeVersion];
    let after = '';
    if (input.cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      } catch {
        decoded = null;
      }
      const cursor = z
        .object({ createdAt: z.string().datetime(), id: z.string().uuid() })
        .strict()
        .parse(decoded);
      values.push(cursor.createdAt, cursor.id);
      after = ' AND (n.created_at,n.id)<($3::timestamptz,$4::uuid)';
    }
    values.push(input.limit + 1);
    const [rows, counts] = await Promise.all([
      this.db.query(
        `SELECT n.id,n.title,n.message,n.path,n.audience,d.name AS department_name,
                n.created_at,to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,(r.read_at IS NOT NULL) AS is_read,
                n.attachment_name,n.attachment_type,octet_length(n.attachment_content) AS attachment_size
         FROM in_app_announcements n
         JOIN users u ON u.id=$1
         LEFT JOIN departments d ON d.id=n.department_id
         LEFT JOIN in_app_announcement_reads r ON r.announcement_id=n.id AND r.user_id=$1
         WHERE ${visibleToUser()}${input.filter === 'UNREAD' ? ' AND r.read_at IS NULL' : ''}${after}
         ORDER BY n.created_at DESC,n.id DESC LIMIT $${values.length}`,
        values,
      ),
      this.db.query(
        `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE r.read_at IS NULL)::int AS unread
         FROM in_app_announcements n
         JOIN users u ON u.id=$1
         LEFT JOIN in_app_announcement_reads r ON r.announcement_id=n.id AND r.user_id=$1
         WHERE ${visibleToUser()}`,
        [req.user.id, configuration().noticeVersion],
      ),
    ]);
    return {
      items: rows.slice(0, input.limit).map((row) => ({
        id: row.id,
        title: row.title,
        message: row.message,
        path: row.path,
        audience: row.audience,
        departmentName: row.department_name,
        createdAt: row.created_at,
        read: row.is_read,
        attachment: row.attachment_name
          ? { name: row.attachment_name, type: row.attachment_type, size: row.attachment_size }
          : null,
      })),
      nextCursor:
        rows.length > input.limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: rows[input.limit - 1].cursor_time,
                id: rows[input.limit - 1].id,
              }),
            ).toString('base64url')
          : null,
      total: counts[0]?.total ?? 0,
      unreadCount: counts[0]?.unread ?? 0,
    };
  }

  async unreadCount(req: AuthRequest) {
    const [row] = await this.db.query(
      `SELECT count(*)::int AS count FROM in_app_announcements n
       JOIN users u ON u.id=$1
       WHERE NOT EXISTS (
         SELECT 1 FROM in_app_announcement_reads r
         WHERE r.announcement_id=n.id AND r.user_id=$1
       ) AND ${visibleToUser()}`,
      [req.user.id, configuration().noticeVersion],
    );
    const [workflow] = await this.db.query(
      `SELECT count(*)::int count FROM workflow_notifications n JOIN users u ON u.id=n.user_id WHERE n.user_id=$1 AND ${workflowVisible} AND NOT EXISTS(SELECT 1 FROM workflow_notification_reads r WHERE r.notification_id=n.id AND r.user_id=u.id)`,
      [req.user.id, configuration().noticeVersion],
    );
    return { unreadCount: (row?.count ?? 0) + workflow.count };
  }

  async markRead(req: AuthRequest, value: unknown) {
    const id = announcementId.parse(value);
    const [visible] = await this.db.query(
      `SELECT 1 FROM in_app_announcements n JOIN users u ON u.id=$2
       WHERE n.id=$1 AND ${visibleToUser('$3')}`,
      [id, req.user.id, configuration().noticeVersion],
    );
    if (!visible) throw new NotFoundException('Announcement not found');
    await this.db.query(
      `INSERT INTO in_app_announcement_reads(announcement_id,user_id)
       VALUES($1,$2) ON CONFLICT(announcement_id,user_id) DO NOTHING`,
      [id, req.user.id],
    );
    return { read: true };
  }

  async markAllRead(req: AuthRequest) {
    await this.db.query(
      `INSERT INTO in_app_announcement_reads(announcement_id,user_id)
       SELECT n.id,$1 FROM in_app_announcements n JOIN users u ON u.id=$1
       WHERE ${visibleToUser('$2')}
       ON CONFLICT(announcement_id,user_id) DO NOTHING`,
      [req.user.id, configuration().noticeVersion],
    );
    return { read: true };
  }

  async attachment(req: AuthRequest, value: unknown) {
    const id = announcementId.parse(value);
    const [row] = await this.db.query(
      `SELECT n.attachment_name,n.attachment_type,n.attachment_content
       FROM in_app_announcements n JOIN users u ON u.id=$2
       WHERE n.id=$1 AND n.attachment_content IS NOT NULL AND ${visibleToUser('$3')}`,
      [id, req.user.id, configuration().noticeVersion],
    );
    if (!row) throw new NotFoundException('Attachment not found');
    return {
      name: row.attachment_name as string,
      type: row.attachment_type as string,
      content: row.attachment_content as Buffer,
    };
  }
}

@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly service: NotificationsService) {}

  @Get()
  inbox(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.inbox(req, query);
  }

  @Get('unread-count')
  unreadCount(@Req() req: AuthRequest) {
    return this.service.unreadCount(req);
  }

  @Get('workflow') workflow(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.workflow(req, query);
  }
  @Post('workflow/read-all') workflowReadAll(@Req() req: AuthRequest) {
    return this.service.workflowRead(req);
  }
  @Post('workflow/:id/read') workflowRead(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.workflowRead(req, id);
  }

  @Get(':id/attachment')
  async attachment(@Req() req: AuthRequest, @Param('id') id: string, @Res() res: Response) {
    const file = await this.service.attachment(req, id);
    const disposition = file.type === 'application/pdf' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Length', file.content.length);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${file.name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.content);
  }

  @Post('read-all')
  markAllRead(@Req() req: AuthRequest) {
    return this.service.markAllRead(req);
  }

  @Post(':id/read')
  markRead(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.markRead(req, id);
  }
}
