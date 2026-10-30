import {
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import webpush from 'web-push';
import { Db } from './db';
import { encrypt, hash, decrypt, configuration } from './config';
import { sanitizeImage } from './image-sanitize';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

const ATTACHMENT_LIMIT = 4 * 1024 * 1024;
const ANNOUNCEMENT_IMAGE = {
  inputLimit: ATTACHMENT_LIMIT,
  outputLimit: 2 * 1024 * 1024,
  maxWidth: 1800,
  maxHeight: 1800,
  quality: 82,
  maxPixels: 24_000_000,
  message: 'Use a valid JPEG or PNG image up to 4 MiB.',
};
const attachmentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[\w][\w .()\-]*\.(?:jpe?g|pdf)$/i),
    type: z.enum(['image/jpeg', 'application/pdf']),
    dataUrl: z.string().max(Math.ceil(ATTACHMENT_LIMIT / 3) * 4 + 32),
  })
  .strict()
  .refine((file) =>
    file.type === 'application/pdf' ? /\.pdf$/i.test(file.name) : /\.jpe?g$/i.test(file.name),
  );

const subscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((value) => new URL(value).protocol === 'https:'),
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({ p256dh: z.string().min(20).max(256), auth: z.string().min(12).max(128) })
      .strict(),
  })
  .strict();

function vapid() {
  const publicKey = process.env.PUSH_VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY || '';
  const configuredSubject = process.env.PUSH_VAPID_SUBJECT?.trim() || '';
  const subject = configuredSubject.includes(':')
    ? configuredSubject
    : `mailto:${configuredSubject}`;
  return publicKey && privateKey && /^mailto:[^\s@]+@[^\s@]+$/.test(subject)
    ? { publicKey, privateKey, subject }
    : undefined;
}

@Injectable()
export class PushService {
  constructor(@Inject(Db) private readonly db: Db) {
    const keys = vapid();
    if (keys) webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  }

  publicKey() {
    return { enabled: !!vapid(), publicKey: vapid()?.publicKey ?? null };
  }

  async subscribe(req: AuthRequest, input: unknown) {
    if (!vapid()) throw new ServiceUnavailableException('Push notifications are not configured');
    const subscription = subscriptionSchema.parse(input);
    const endpointHash = hash(subscription.endpoint);
    await this.db.query(
      `INSERT INTO web_push_subscriptions(endpoint_hash,user_id,subscription_ciphertext)
       VALUES($1,$2,$3) ON CONFLICT(endpoint_hash) DO UPDATE SET
       user_id=excluded.user_id,subscription_ciphertext=excluded.subscription_ciphertext,updated_at=now()`,
      [
        endpointHash,
        req.user.id,
        encrypt(JSON.stringify(subscription), 'AUTH_MAIL_ENCRYPTION_KEY'),
      ],
    );
    return { enabled: true };
  }

  async unsubscribe(req: AuthRequest, endpoint: unknown) {
    const value = z.string().url().max(2048).parse(endpoint);
    await this.db.query(
      'DELETE FROM web_push_subscriptions WHERE endpoint_hash=$1 AND user_id=$2',
      [hash(value), req.user.id],
    );
    return { enabled: true };
  }

  async broadcast(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'announcement.send');
    const keys = vapid();
    const input = z
      .object({
        title: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(500),
        path: z.enum(['/dashboard', '/assets', '/tickets', '/notifications']),
        audience: z.enum(['ALL', 'ADMIN', 'DEPARTMENT']).default('ALL'),
        departmentId: z.string().uuid().optional(),
        attachment: attachmentSchema.optional(),
      })
      .strict()
      .refine((value) => (value.audience === 'DEPARTMENT') === !!value.departmentId, {
        path: ['departmentId'],
        message: 'Choose a department only for department announcements.',
      })
      .parse(body);

    let attachment:
      | { name: string; type: 'image/jpeg' | 'application/pdf'; content: Buffer; sha256: string }
      | undefined;
    if (input.attachment?.type === 'image/jpeg') {
      const image = await sanitizeImage(input.attachment.dataUrl, ANNOUNCEMENT_IMAGE);
      attachment = {
        name: input.attachment.name,
        type: 'image/jpeg',
        content: image.content,
        sha256: image.sha256,
      };
    } else if (input.attachment) {
      const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        input.attachment.dataUrl,
      );
      if (!match) throw new HttpException('Choose a valid PDF attachment.', 422);
      const encoded = match[1]!;
      const content = Buffer.from(encoded, 'base64');
      if (
        !content.length ||
        content.length > ATTACHMENT_LIMIT ||
        content.toString('base64') !== encoded ||
        content.subarray(0, 5).toString('ascii') !== '%PDF-'
      )
        throw new HttpException('Choose a valid PDF attachment up to 4 MiB.', 422);
      attachment = {
        name: input.attachment.name,
        type: 'application/pdf',
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    }

    // Publish to the in-app inbox first. Push is an optional delivery channel, so
    // absent VAPID configuration must never prevent users from seeing the notice.
    let targetDepartmentName: string | null = null;
    const announcement = await this.db.tx(async (client) => {
      await this.db.query(
        'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
        [req.user.id],
        client,
      );
      const [recent] = await this.db.query(
        `SELECT count(*)::int AS count FROM in_app_announcements
         WHERE created_by=$1 AND created_at>now()-interval '5 minutes'`,
        [req.user.id],
        client,
      );
      if (recent.count >= 3)
        throw new HttpException('Please wait before publishing another announcement', 429);
      if (input.departmentId) {
        const [department] = await this.db.query(
          'SELECT id,name FROM departments WHERE id=$1 AND active',
          [input.departmentId],
          client,
        );
        if (!department) throw new HttpException('Choose an active department.', 422);
        targetDepartmentName = department.name;
      }
      const [row] = await this.db.query(
        `INSERT INTO in_app_announcements(
           title,message,path,created_by,audience,department_id,
           attachment_name,attachment_type,attachment_content,attachment_sha256
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,created_at`,
        [
          input.title,
          input.message,
          input.path,
          req.user.id,
          input.audience,
          input.departmentId ?? null,
          attachment?.name ?? null,
          attachment?.type ?? null,
          attachment?.content ?? null,
          attachment?.sha256 ?? null,
        ],
        client,
      );
      const [recipients] = await this.db.query(
        `SELECT count(*)::int AS count FROM users u
         WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL
           AND u.portal_accepted_at IS NOT NULL AND u.portal_notice_version=$1
           AND ($2='ALL'
             OR ($2='ADMIN' AND EXISTS(SELECT 1 FROM user_roles ar WHERE ar.user_id=u.id AND ar.role_code='SUPER_ADMIN'))
             OR ($2='DEPARTMENT' AND u.department_id=$3))`,
        [configuration().noticeVersion, input.audience, input.departmentId ?? null],
        client,
      );
      if (!recipients.count)
        throw new HttpException('There are no active users in this audience.', 422);
      await this.db.audit(
        client,
        req.user,
        'IN_APP_ANNOUNCEMENT',
        row.id,
        'ANNOUNCEMENT_PUBLISHED',
        {
          title: input.title,
          audience: input.audience,
          departmentId: input.departmentId ?? null,
          attachment: attachment?.name ?? null,
          inAppRecipients: recipients.count,
        },
      );
      return {
        id: row.id,
        createdAt: row.created_at,
        inAppRecipients: recipients.count,
        audience: input.audience,
        departmentName: targetDepartmentName,
      };
    });

    if (!keys) {
      return {
        announcementId: announcement.id,
        createdAt: announcement.createdAt,
        inAppRecipients: announcement.inAppRecipients,
        audience: announcement.audience,
        departmentName: announcement.departmentName,
        pushConfigured: false,
        subscribedDevices: 0,
        sent: 0,
        failed: 0,
        failureStatuses: [],
      };
    }
    const rows = await this.db.query(
      `SELECT s.endpoint_hash,s.subscription_ciphertext FROM web_push_subscriptions s
       JOIN users u ON u.id=s.user_id
       WHERE u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.portal_accepted_at IS NOT NULL
         AND u.portal_notice_version=$1
         AND ($2='ALL'
           OR ($2='ADMIN' AND EXISTS(SELECT 1 FROM user_roles ar WHERE ar.user_id=u.id AND ar.role_code='SUPER_ADMIN'))
           OR ($2='DEPARTMENT' AND u.department_id=$3))`,
      [configuration().noticeVersion, input.audience, input.departmentId ?? null],
    );
    let sent = 0;
    let failed = 0;
    const stale: string[] = [];
    const failureStatuses = new Map<number | null, number>();
    const payload = JSON.stringify({ title: input.title, body: input.message, path: input.path });
    for (let offset = 0; offset < rows.length; offset += 16) {
      const batch = rows.slice(offset, offset + 16);
      const outcomes = await Promise.allSettled(
        batch.map(async (row: { endpoint_hash: string; subscription_ciphertext: string }) => {
          const subscription = JSON.parse(
            decrypt(row.subscription_ciphertext, 'AUTH_MAIL_ENCRYPTION_KEY'),
          );
          await webpush.sendNotification(subscription, payload, {
            TTL: 60 * 60,
            urgency: 'normal',
          });
          return row.endpoint_hash as string;
        }),
      );
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') sent += 1;
        else {
          failed += 1;
          const statusCode = (outcome.reason as { statusCode?: number })?.statusCode;
          const safeStatus = typeof statusCode === 'number' ? statusCode : null;
          failureStatuses.set(safeStatus, (failureStatuses.get(safeStatus) ?? 0) + 1);
          if (statusCode === 404 || statusCode === 410) stale.push(batch[index].endpoint_hash);
        }
      });
    }
    if (stale.length)
      await this.db.query(
        'DELETE FROM web_push_subscriptions WHERE endpoint_hash=ANY($1::text[])',
        [stale],
      );
    await this.db.tx((client) =>
      this.db.audit(
        client,
        req.user,
        'PUSH_ANNOUNCEMENT',
        announcement.id,
        'PUSH_ANNOUNCEMENT_SENT',
        {
          title: input.title,
          subscribedDevices: rows.length,
          sent,
          failed,
          failureStatuses: Object.fromEntries(failureStatuses),
        },
      ),
    );
    return {
      announcementId: announcement.id,
      createdAt: announcement.createdAt,
      inAppRecipients: announcement.inAppRecipients,
      audience: announcement.audience,
      departmentName: announcement.departmentName,
      pushConfigured: true,
      subscribedDevices: rows.length,
      sent,
      failed,
      failureStatuses: [...failureStatuses].map(([statusCode, count]) => ({ statusCode, count })),
    };
  }
}

@Controller('push')
@UseGuards(SessionGuard)
export class PushController {
  constructor(@Inject(PushService) private readonly service: PushService) {}

  @Get('public-key') publicKey() {
    return this.service.publicKey();
  }

  @Put('subscription') subscribe(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.subscribe(req, body);
  }

  @Delete('subscription') unsubscribe(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.unsubscribe(req, (body as { endpoint?: unknown })?.endpoint);
  }

  @Post('broadcast') broadcast(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.broadcast(req, body);
  }
}
