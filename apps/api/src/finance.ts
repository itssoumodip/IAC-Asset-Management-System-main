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
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { Db } from './db';
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
import { assertCan, can } from './policy';
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

  async upload(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
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
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const name = (input.fileName ?? 'invoice').replace(/[^\w.\- ()]/g, '_').slice(0, 200);
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
        'INSERT INTO invoice_assets(invoice_id,asset_id,linked_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [invoice.id, assetId, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'INVOICE_UPLOADED', {
        invoiceId: invoice.id,
        sha256,
        byteSize: bytes.length,
      });
      // New evidence on a rejected asset is a resubmission.
      if (asset.finance_status === 'REJECTED') await this.backToPending(req, assetId, c, 'invoice');
      return meta(invoice, [assetId]);
    });
  }

  private async backToPending(req: AuthRequest, assetId: string, c: any, via: string) {
    await patchObject(this.db, 'assets', assetId, { financeStatus: 'PENDING' }, c);
    await this.db.audit(c, req.user, 'asset', assetId, 'FINANCE_RESUBMITTED', { via });
  }

  async listForAsset(req: AuthRequest, assetId: string) {
    id(assetId);
    assertCan(req.user, 'asset.view_private');
    await this.domain.asset(req, assetId); // enforces asset visibility
    const rows = await this.db.query(
      `SELECT i.id,i.mime,i.size,i.sha256,i.original_name,i.uploaded_by,i.uploaded_at,i.extraction_state,i.extraction_error,i.extracted_fields
       FROM invoice_assets ia JOIN invoices i ON i.id=ia.invoice_id WHERE ia.asset_id=$1 ORDER BY i.uploaded_at DESC`,
      [assetId],
    );
    return { items: rows.map((r) => meta(r, [assetId])) };
  }

  private async invoiceRow(req: AuthRequest, invoiceId: string, withFile: boolean) {
    id(invoiceId);
    assertCan(req.user, 'asset.view_private');
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
    return row;
  }

  async get(req: AuthRequest, invoiceId: string) {
    const row = await this.invoiceRow(req, invoiceId, false);
    return meta(row, row.asset_ids);
  }

  async file(req: AuthRequest, invoiceId: string) {
    return this.invoiceRow(req, invoiceId, true);
  }

  async queue(req: AuthRequest, query: any) {
    assertCan(req.user, 'asset.finance_edit');
    const p = requestPage(query, ['asset_code', 'id']);
    const status = p.status ?? 'PENDING';
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status))
      throw new UnprocessableEntityException('Invalid status');
    const values: any[] = [status];
    const where = ['a.finance_status=$1'];
    for (const [key, column] of [
      ['teamId', 'owning_team_id'],
      ['projectId', 'project_id'],
    ] as const)
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
      `SELECT a.id,a.asset_code,a.description,a.category,a.owning_team_id,tm.code AS team_code,a.project_id,a.finance_status,a.finance_rejection_reason,
              a.supplier,a.invoice_number,a.purchase_date,a.purchase_cost,a.created_at,
              inv.id AS invoice_id,inv.extraction_state AS invoice_state
       FROM assets a JOIN teams tm ON tm.id=a.owning_team_id
       LEFT JOIN LATERAL (SELECT i.id,i.extraction_state FROM invoice_assets ia JOIN invoices i ON i.id=ia.invoice_id
                          WHERE ia.asset_id=a.id ORDER BY i.uploaded_at DESC LIMIT 1) inv ON true
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
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'");
    else res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.end(row.file);
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
