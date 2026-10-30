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
    OR (n.audience='ADMIN' AND EXISTS(SELECT 1 FROM user_roles ar WHERE ar.user_id=u.id AND ar.role_code='SUPER_ADMIN'))
    OR (n.audience='DEPARTMENT' AND n.department_id=u.department_id))`;

@Injectable()
export class NotificationsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async inbox(req: AuthRequest) {
    const [rows, counts] = await Promise.all([
      this.db.query(
        `SELECT n.id,n.title,n.message,n.path,n.audience,d.name AS department_name,
                n.created_at,(r.read_at IS NOT NULL) AS is_read,
                n.attachment_name,n.attachment_type,octet_length(n.attachment_content) AS attachment_size
         FROM in_app_announcements n
         JOIN users u ON u.id=$1
         LEFT JOIN departments d ON d.id=n.department_id
         LEFT JOIN in_app_announcement_reads r ON r.announcement_id=n.id AND r.user_id=$1
         WHERE ${visibleToUser()}
         ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,
        [req.user.id, configuration().noticeVersion],
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
      items: rows.map((row) => ({
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
    return { unreadCount: row?.count ?? 0 };
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
  inbox(@Req() req: AuthRequest) {
    return this.service.inbox(req);
  }

  @Get('unread-count')
  unreadCount(@Req() req: AuthRequest) {
    return this.service.unreadCount(req);
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
