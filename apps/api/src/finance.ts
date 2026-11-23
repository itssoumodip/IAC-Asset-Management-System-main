import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { Db } from './db';
import { submitAssetToFinance } from './finance-submit';
import { DomainService } from './domain';
import {
  assetInput,
  camel,
  found,
  id,
  page,
  parse,
  patchObject,
  requestPage,
  text,
  validateAsset,
} from './domain-helpers';
import { assertCan, can, teamsFor } from './policy';
import { extractInvoiceFields } from './invoice-extract';
import { ExtractionError, localTextExtractor } from './invoice-ocr';
import { AuthRequest, SessionGuard, assertVersion } from './security';

export const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

const uploadInput = z
  .object({
    dataUrl: z.string().max(60 + 4 * Math.ceil(INVOICE_MAX_BYTES / 3)),
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

// Finance fields Finance may correct while approving (financePending is derived).
const approveFields = assetInput
  .pick({
    purchaseDate: true,
    capitalisationDate: true,
    purchaseCost: true,
    currency: true,
    residualValue: true,
    depreciationMethod: true,
    usefulLifeYears: true,
    invoiceNumber: true,
    supplier: true,
    insurancePolicyNumber: true,
    insuranceExpiry: true,
  })
  .partial()
  .strict();
const approveInput = z.object({ fields: approveFields.optional(), reason: text(1000) }).strict();
const rejectInput = z.object({ reason: text(1000) }).strict();
const financeCommentInput = z.object({ body: text(2000) }).strict();

function sniff(bytes: Buffer): (typeof MIMES)[number] | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  return null;
}

const invalidFile = () =>
  new UnprocessableEntityException('Upload a PDF, JPEG or PNG invoice up to 10 MB');

const meta = (row: any, assetIds: string[] = []) => ({
  id: row.id,
  mime: row.mime,
  size: row.size,
  sha256: row.sha256,
  originalName: row.original_name,
  uploadedBy: row.uploaded_by,
  uploadedAt: row.uploaded_at,
  extractionState: row.extraction_state,
  extractionError: row.extraction_error ?? null,
  fields: row.extracted_fields ?? {},
  assetIds,
});

@Injectable()
export class FinanceService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(DomainService) private readonly domain: DomainService,
  ) {}

  private canUpload(req: AuthRequest, teamId: string) {
    return can(req.user, 'asset.edit', teamId) || can(req.user, 'asset.finance_edit');
  }

  /** Validates an uploaded invoice (type, size, real content) and returns its bytes. */
  private async readUpload(body: unknown) {
    const input = parse(uploadInput, body);
    const match = input.dataUrl.match(/^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match || !match[1] || !match[2] || !(MIMES as readonly string[]).includes(match[1]))
      throw invalidFile();
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > INVOICE_MAX_BYTES) throw invalidFile();
    const mime = sniff(bytes);
    if (!mime || mime !== match[1]) throw invalidFile();
    if (mime !== 'application/pdf') {
      try {
        const info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
        if (!info.width || !info.height) throw invalidFile();
      } catch {
        throw invalidFile();
      }
    }
    return { bytes, mime, fileName: input.fileName };
  }

  private previews = 0;

  /**
   * Reads an invoice and returns the proposed values without storing anything, so the
   * Create asset form can fill itself before the asset exists. The file is attached to the
   * asset through the normal upload once the asset has been created.
   */
  async preview(req: AuthRequest, body: unknown) {
    const createTeams = teamsFor(req.user, 'asset.create');
    if (createTeams !== 'ALL' && !createTeams.length && !can(req.user, 'asset.finance_edit'))
      throw new ForbiddenException('Insufficient permission');
    const { bytes, mime } = await this.readUpload(body);
    // Reading is CPU-heavy; keep it from crowding out normal requests.
    if (this.previews >= 2)
      throw new HttpException('Another invoice is being read. Try again in a moment.', 429);
    this.previews += 1;
    try {
      const text = (await localTextExtractor(bytes, mime, 30_000)).slice(0, 50_000);
      return { fields: extractInvoiceFields(text) };
    } catch (error) {
      throw new UnprocessableEntityException(
        error instanceof ExtractionError ? error.message : 'The invoice could not be read',
      );
    } finally {
      this.previews -= 1;
    }
  }

  async upload(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
    const { bytes, mime, fileName } = await this.readUpload(body);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const name = (fileName ?? 'invoice').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    return this.db.tx(async (c) => {
      const asset = found(
        (
          await this.db.query(
            'SELECT id,owning_team_id,finance_status,version FROM assets WHERE id=$1 FOR UPDATE',
            [assetId],
            c,
          )
        )[0],
      );
      if (!this.canUpload(req, asset.owning_team_id))
        throw new ForbiddenException('Insufficient permission');
      let [invoice] = await this.db.query(
        `INSERT INTO invoices(file,mime,size,sha256,original_name,uploaded_by)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sha256) DO NOTHING RETURNING *`,
        [bytes, mime, bytes.length, sha256, name, req.user.id],
        c,
      );
      if (!invoice)
        [invoice] = await this.db.query('SELECT * FROM invoices WHERE sha256=$1', [sha256], c);
      await this.db.query(
        `INSERT INTO invoice_assets(invoice_id,asset_id,linked_by,linked_at)
         VALUES($1,$2,$3,now())
         ON CONFLICT(invoice_id,asset_id) DO UPDATE
           SET linked_by=excluded.linked_by,linked_at=excluded.linked_at`,
        [invoice.id, assetId, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'INVOICE_UPLOADED', {
        invoiceId: invoice.id,
        sha256,
        byteSize: bytes.length,
      });
      await this.db.query(
        `INSERT INTO finance_comments(asset_id,author_id,body,entry_type)
         VALUES($1,$2,$3,'EVENT')`,
        [assetId, req.user.id, `Invoice attached: ${name}`],
        c,
      );
      // New evidence on a rejected asset is a resubmission.
      if (asset.finance_status === 'REJECTED') await this.backToPending(req, assetId, c, 'invoice');
      return meta(invoice, [assetId]);
    });
  }

  private async backToPending(req: AuthRequest, assetId: string, c: any, via: string) {
    await patchObject(this.db, 'assets', assetId, { financeStatus: 'PENDING' }, c);
    await this.db.audit(c, req.user, 'asset', assetId, 'FINANCE_RESUBMITTED', { via });
    await this.db.query(
      `INSERT INTO finance_comments(asset_id,author_id,body,entry_type)
       VALUES($1,$2,$3,'EVENT')`,
      [assetId, req.user.id, 'Resubmitted to Finance for review.'],
      c,
    );
    // Tell Finance it is back in their queue (in-app notice and email).
    const [asset] = await this.db.query(
      'SELECT id,asset_code,description,purchase_cost FROM assets WHERE id=$1',
      [assetId],
      c,
    );
    if (asset) await submitAssetToFinance(this.db, c, req.user, asset, via, { audit: false });
  }

  async listForAsset(req: AuthRequest, assetId: string) {
    id(assetId);
    const asset = await this.domain.asset(req, assetId); // enforces asset visibility
    if (!can(req.user, 'asset.view_private') && !this.canUpload(req, asset.owningTeamId))
      throw new ForbiddenException('Insufficient permission');
    const rows = await this.db.query(
      `SELECT i.id,i.mime,i.size,i.sha256,i.original_name,i.uploaded_by,ia.linked_at AS uploaded_at,i.extraction_state,i.extraction_error,i.extracted_fields
       FROM invoice_assets ia JOIN invoices i ON i.id=ia.invoice_id
       WHERE ia.asset_id=$1 ORDER BY ia.linked_at DESC,i.uploaded_at DESC,i.id DESC`,
      [assetId],
    );
    return { items: rows.map((r) => meta(r, [assetId])) };
  }

  async financeComments(req: AuthRequest, assetId: string) {
    id(assetId);
    const asset = await this.domain.asset(req, assetId);
    if (!can(req.user, 'asset.view_private') && !this.canUpload(req, asset.owningTeamId))
      throw new ForbiddenException('Insufficient permission');
    const rows = await this.db.query(
      `SELECT * FROM (
         SELECT c.id,c.asset_id,c.author_id,u.display_name AS author_name,c.body,c.entry_type,c.created_at
         FROM finance_comments c JOIN users u ON u.id=c.author_id
         WHERE c.asset_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 200
       ) recent ORDER BY created_at,id`,
      [assetId],
    );
    return { items: rows.map(camel) };
  }

  async addFinanceComment(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
    const asset = await this.domain.asset(req, assetId);
    if (!this.canUpload(req, asset.owningTeamId))
      throw new ForbiddenException('Insufficient permission');
    const input = parse(financeCommentInput, body);
    return this.db.tx(async (c) => {
      const [row] = await this.db.query(
        `INSERT INTO finance_comments(asset_id,author_id,body)
         VALUES($1,$2,$3)
         RETURNING id,asset_id,author_id,body,entry_type,created_at`,
        [assetId, req.user.id, input.body],
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'FINANCE_COMMENT_ADDED', {
        commentId: row.id,
      });
      return { ...camel(row), authorName: req.user.displayName };
    });
  }

  private async invoiceRow(req: AuthRequest, invoiceId: string, withFile: boolean) {
    id(invoiceId);
    const row = found(
      (
        await this.db.query(
          `SELECT i.id,i.mime,i.size,i.sha256,i.original_name,i.uploaded_by,i.uploaded_at,i.extraction_state,i.extraction_error,i.extracted_fields${withFile ? ',i.file' : ''},
                  coalesce((SELECT array_agg(ia.asset_id) FROM invoice_assets ia WHERE ia.invoice_id=i.id),'{}') AS asset_ids
           FROM invoices i WHERE i.id=$1`,
          [invoiceId],
        )
      )[0],
    );
    if (!can(req.user, 'asset.view_private')) {
      const linkedTeams = await this.db.query(
        'SELECT owning_team_id FROM assets WHERE id=ANY($1::uuid[])',
        [row.asset_ids],
      );
      if (!linkedTeams.some((asset) => this.canUpload(req, asset.owning_team_id)))
        throw new ForbiddenException('Insufficient permission');
    }
    return row;
  }

  async get(req: AuthRequest, invoiceId: string) {
    const row = await this.invoiceRow(req, invoiceId, false);
    return meta(row, row.asset_ids);
  }

  async file(req: AuthRequest, invoiceId: string) {
    return this.invoiceRow(req, invoiceId, true);
  }

  /**
   * Finance review snapshot: the queue by state, what is blocking it (no cost, no invoice,
   * invoice still being read), how long items wait, value waiting and approved this financial
   * year, the queue by team and 12 weeks of approvals and rejections. Live assets only.
   */
  async summary(req: AuthRequest) {
    assertCan(req.user, 'asset.finance_edit');
    const live = 'a.removed_at IS NULL';
    const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
    const fyStart = `make_date(extract(year FROM ${today} - interval '3 months')::int, 4, 1)`;
    const [[t], byTeam, weeks] = await Promise.all([
      this.db.query(`
        WITH latest AS (
          SELECT DISTINCT ON (ia.asset_id) ia.asset_id, i.extraction_state
            FROM invoice_assets ia JOIN invoices i ON i.id = ia.invoice_id
           ORDER BY ia.asset_id, ia.linked_at DESC, i.uploaded_at DESC)
        SELECT count(*) FILTER (WHERE a.finance_status = 'PENDING')::int AS pending,
               count(*) FILTER (WHERE a.finance_status = 'REJECTED')::int AS rejected,
               count(*) FILTER (WHERE a.finance_status = 'APPROVED')::int AS approved,
               count(*) FILTER (WHERE a.finance_status = 'PENDING' AND a.purchase_cost IS NULL)::int AS pending_no_cost,
               count(*) FILTER (WHERE a.finance_status = 'PENDING' AND l.asset_id IS NULL)::int AS pending_no_invoice,
               count(*) FILTER (WHERE a.finance_status = 'PENDING' AND l.extraction_state = 'PENDING')::int AS reading,
               count(*) FILTER (WHERE a.finance_status = 'PENDING' AND l.extraction_state = 'FAILED')::int AS manual,
               coalesce(sum(a.purchase_cost) FILTER (WHERE a.finance_status = 'PENDING'), 0)::float8 AS pending_value,
               coalesce(sum(a.purchase_cost) FILTER (WHERE a.finance_status = 'APPROVED' AND a.purchase_date >= ${fyStart}), 0)::float8 AS approved_value_fy,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM now() - a.created_at) / 86400)
                 FILTER (WHERE a.finance_status = 'PENDING') AS median_wait_days,
               max(EXTRACT(EPOCH FROM now() - a.created_at) / 86400) FILTER (WHERE a.finance_status = 'PENDING') AS oldest_wait_days
          FROM assets a LEFT JOIN latest l ON l.asset_id = a.id
         WHERE ${live}`),
      this.db.query(`
        SELECT tm.id, tm.code, tm.name,
               count(*) FILTER (WHERE a.finance_status = 'PENDING')::int AS pending,
               count(*) FILTER (WHERE a.finance_status = 'REJECTED')::int AS rejected
          FROM assets a JOIN teams tm ON tm.id = a.owning_team_id
         WHERE ${live} AND a.finance_status <> 'APPROVED'
         GROUP BY tm.id, tm.code, tm.name ORDER BY pending DESC, tm.name`),
      this.db.query(`
        WITH w AS (
          SELECT generate_series(date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') - interval '11 weeks',
                                 date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata'), interval '1 week') AS week_start)
        SELECT w.week_start,
               count(e.id) FILTER (WHERE e.action = 'FINANCE_APPROVED')::int AS approved,
               count(e.id) FILTER (WHERE e.action = 'FINANCE_REJECTED')::int AS rejected
          FROM w LEFT JOIN audit_events e
            ON e.entity_type = 'asset' AND e.action IN ('FINANCE_APPROVED','FINANCE_REJECTED')
           AND e.occurred_at AT TIME ZONE 'Asia/Kolkata' >= w.week_start
           AND e.occurred_at AT TIME ZONE 'Asia/Kolkata' < w.week_start + interval '1 week'
         GROUP BY w.week_start ORDER BY w.week_start`),
    ]);
    const days = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
    return {
      pending: t.pending,
      rejected: t.rejected,
      approved: t.approved,
      blockers: {
        noCost: t.pending_no_cost,
        noInvoice: t.pending_no_invoice,
        readingInvoice: t.reading,
        manualEntry: t.manual,
      },
      pendingValue: Number(t.pending_value),
      approvedValueThisYear: Number(t.approved_value_fy),
      medianWaitDays: days(t.median_wait_days),
      oldestWaitDays: days(t.oldest_wait_days),
      byTeam: byTeam.map((r: any) => ({ teamId: r.id, code: r.code, name: r.name, pending: r.pending, rejected: r.rejected })),
      weeks: weeks.map((w: any) => ({ weekStart: w.week_start, approved: w.approved, rejected: w.rejected })),
    };
  }

  async queue(req: AuthRequest, query: any) {
    assertCan(req.user, 'asset.finance_edit');
    const p = requestPage(query, ['asset_code', 'id']);
    const status = p.status ?? 'PENDING';
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status))
      throw new UnprocessableEntityException('Invalid status');
    const values: any[] = [status];
    const where = ['a.finance_status=$1'];
    for (const [key, column] of [['teamId', 'owning_team_id']] as const)
      if (p[key]) {
        values.push(p[key]);
        where.push(`a.${column}=$${values.length}`);
      }
    if (p.q) {
      values.push(p.q);
      where.push(
        `(strpos(lower(a.asset_code),lower($${values.length}))>0 OR strpos(lower(a.description),lower($${values.length}))>0)`,
      );
    }
    if (p.after) {
      values.push(...p.after);
      where.push(`(a.asset_code,a.id)>($${values.length - 1},$${values.length}::uuid)`);
    }
    values.push(p.limit + 1);
    const rows = await this.db.query(
      `SELECT a.id,a.asset_code,a.description,a.category,a.owning_team_id,tm.code AS team_code,a.finance_status,a.finance_rejection_reason,
              a.supplier,a.invoice_number,a.purchase_date,a.purchase_cost,a.created_at,
              (a.purchase_cost IS NULL) AS missing_cost,(inv.id IS NULL) AS missing_invoice,
              inv.id AS invoice_id,inv.extraction_state AS invoice_state
       FROM assets a JOIN teams tm ON tm.id=a.owning_team_id
       LEFT JOIN LATERAL (SELECT i.id,i.extraction_state FROM invoice_assets ia JOIN invoices i ON i.id=ia.invoice_id
                          WHERE ia.asset_id=a.id ORDER BY ia.linked_at DESC,i.uploaded_at DESC,i.id DESC LIMIT 1) inv ON true
       WHERE ${where.join(' AND ')} ORDER BY a.asset_code,a.id LIMIT $${values.length}`,
      values,
    );
    return page(rows, p.limit, ['asset_code', 'id']);
  }

  async approve(req: AuthRequest, assetId: string, body: unknown) {
    assertCan(req.user, 'asset.finance_edit');
    id(assetId);
    const input = parse(approveInput, body);
    return this.db.tx(async (c) => {
      const before = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );
      if (before.finance_status === 'APPROVED')
        throw new ConflictException('This asset is already approved');
      assertVersion(req, before.version);
      const fields = input.fields ?? {};
      const merged = { ...camel(before), ...fields };
      await validateAsset(this.db, merged, c, camel(before));
      await patchObject(
        this.db,
        'assets',
        assetId,
        {
          ...fields,
          financeStatus: 'APPROVED',
          financeReviewedBy: req.user.id,
          financeReviewedAt: new Date(),
        },
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'FINANCE_APPROVED', {
        fields: Object.keys(fields),
        reason: input.reason,
      });
      return this.domain.asset(req, assetId, c);
    });
  }

  async reject(req: AuthRequest, assetId: string, body: unknown) {
    assertCan(req.user, 'asset.finance_edit');
    id(assetId);
    const { reason } = parse(rejectInput, body);
    return this.db.tx(async (c) => {
      const before = found(
        (await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0],
      );
      if (before.finance_status === 'REJECTED')
        throw new ConflictException('This asset is already rejected');
      await patchObject(
        this.db,
        'assets',
        assetId,
        {
          financeStatus: 'REJECTED',
          financeRejectionReason: reason,
          financeReviewedBy: req.user.id,
          financeReviewedAt: new Date(),
        },
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'FINANCE_REJECTED', { reason });
      await this.db.query(
        `INSERT INTO finance_comments(asset_id,author_id,body,entry_type)
         VALUES($1,$2,$3,'EVENT')`,
        [assetId, req.user.id, `Finance sent this back: ${reason}`],
        c,
      );
      const recipients = (
        await this.db.query(
          `SELECT DISTINCT u.email FROM users u JOIN team_memberships m ON m.user_id=u.id
           WHERE m.team_id=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL`,
          [before.owning_team_id],
          c,
        )
      ).map((r) => r.email);
      if (recipients.length)
        await this.db.notify(
          c,
          `finance-rejected:${assetId}:${Date.now()}`,
          'finance_rejected',
          recipients,
          {
            subject: `Finance rejected asset ${before.asset_code}`,
            text: `Finance sent asset ${before.asset_code} back for correction.\n\nReason: ${reason}\n\nPlease fix the invoice or details in the portal and resubmit it for review.`,
          },
        );
      return this.domain.asset(req, assetId, c);
    });
  }

  async resubmit(req: AuthRequest, assetId: string) {
    id(assetId);
    return this.db.tx(async (c) => {
      const asset = found(
        (
          await this.db.query(
            'SELECT id,owning_team_id,finance_status FROM assets WHERE id=$1 FOR UPDATE',
            [assetId],
            c,
          )
        )[0],
      );
      if (!this.canUpload(req, asset.owning_team_id))
        throw new ForbiddenException('Insufficient permission');
      if (asset.finance_status !== 'REJECTED')
        throw new ConflictException('Only rejected assets can be resubmitted');
      await this.backToPending(req, assetId, c, 'resubmit');
      return this.domain.asset(req, assetId, c);
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly service: FinanceService) {}

  @Post('assets/:id/invoices')
  upload(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.upload(req, assetId, body);
  }
  @Get('assets/:id/invoices')
  list(@Req() req: AuthRequest, @Param('id') assetId: string) {
    return this.service.listForAsset(req, assetId);
  }
  @Get('assets/:id/finance-comments')
  comments(@Req() req: AuthRequest, @Param('id') assetId: string) {
    return this.service.financeComments(req, assetId);
  }
  @Post('assets/:id/finance-comments')
  addComment(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.addFinanceComment(req, assetId, body);
  }
  @Post('invoices/preview')
  preview(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.preview(req, body);
  }
  @Get('invoices/:id')
  get(@Req() req: AuthRequest, @Param('id') invoiceId: string) {
    return this.service.get(req, invoiceId);
  }
  @Get('invoices/:id/file')
  async file(@Req() req: AuthRequest, @Param('id') invoiceId: string, @Res() res: Response) {
    const row = await this.service.file(req, invoiceId);
    res.status(200);
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.file.length));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(row.original_name).replace(/[^\w.\- ()]/g, '_')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Same-origin framing is needed for the in-page preview; the sandbox keeps images inert.
    if (row.mime !== 'application/pdf')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; sandbox; frame-ancestors 'self'",
      );
    else res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.end(row.file);
  }
  @Get('finance/summary')
  summary(@Req() req: AuthRequest) {
    return this.service.summary(req);
  }
  @Get('finance/queue')
  queue(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.queue(req, query);
  }
  @Post('finance/assets/:id/approve')
  approve(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.approve(req, assetId, body);
  }
  @Post('finance/assets/:id/reject')
  reject(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.reject(req, assetId, body);
  }
  @Post('finance/assets/:id/resubmit')
  resubmit(@Req() req: AuthRequest, @Param('id') assetId: string) {
    return this.service.resubmit(req, assetId);
  }
}
