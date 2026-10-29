import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UnprocessableEntityException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole, assertVersion } from './security';
import { extractInvoice } from './invoice-extract';
const input = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(180)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._()-]*\.(?:pdf|xlsx)$/i),
    data: z
      .string()
      .min(4)
      .max(5592408)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
@Injectable()
export class InvoiceEvidenceService {
  private extracting = 0;
  constructor(@Inject(Db) private readonly db: Db) {}
  async upload(req: AuthRequest, value: string, body: unknown) {
    requireRole(req, 'ADMIN', 'FINANCE');
    const assetId = z.string().uuid().parse(value),
      data = input.parse(body),
      bytes = Buffer.from(data.data, 'base64');
    if (bytes.toString('base64') !== data.data)
      throw new UnprocessableEntityException('Invalid invoice encoding');
    const [asset] = await this.db.query('SELECT version FROM assets WHERE id=$1', [assetId]);
    if (!asset) throw new NotFoundException('Asset not found');
    assertVersion(req, asset.version);
    if (this.extracting >= 2)
      throw new ConflictException('Invoice extraction is busy. Try again shortly.');
    this.extracting++;
    let extraction;
    try {
      extraction = await extractInvoice(bytes, /\.pdf$/i.test(data.filename) ? 'PDF' : 'XLSX');
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    } finally {
      this.extracting--;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    return this.db.tx(async (c) => {
      const [current] = await this.db.query(
        'SELECT version FROM assets WHERE id=$1 FOR UPDATE',
        [assetId],
        c,
      );
      if (!current) throw new NotFoundException('Asset not found');
      assertVersion(req, current.version);
      const [usage] = await this.db.query(
        'SELECT count(*)::int count,bool_or(sha256=$2) duplicate FROM finance_invoice_evidence WHERE asset_id=$1',
        [assetId, sha],
        c,
      );
      if (usage.count >= 50 && !usage.duplicate)
        throw new ConflictException(
          'This asset has reached the 50 invoice file limit. Contact an administrator about retention before adding more evidence.',
        );
      const rows = await this.db.query(
        `INSERT INTO finance_invoice_evidence(asset_id,uploaded_by,filename,mime_type,content,sha256,extraction)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(asset_id,sha256)DO NOTHING RETURNING id`,
        [
          assetId,
          req.user.id,
          data.filename,
          /\.pdf$/i.test(data.filename)
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes,
          sha,
          extraction,
        ],
        c,
      );
      const row =
        rows[0] ??
        (
          await this.db.query(
            'SELECT id FROM finance_invoice_evidence WHERE asset_id=$1 AND sha256=$2',
            [assetId, sha],
            c,
          )
        )[0];
      if (rows.length)
        await this.db.audit(c, req.user, 'INVOICE_EVIDENCE', row.id, 'INVOICE_UPLOADED', {
          assetId,
          sha256: sha,
          bytes: bytes.length,
        });
      return { ...row, sha256: sha, ...extraction, unchangedAssetVersion: current.version };
    });
  }
  async list(req: AuthRequest, value: string) {
    requireRole(req, 'ADMIN', 'FINANCE');
    const assetId = z.string().uuid().parse(value);
    const items = await this.db.query(
      'SELECT id,filename,mime_type,sha256,octet_length(content) AS bytes,extraction,created_at FROM finance_invoice_evidence WHERE asset_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',
      [assetId],
    );
    return { items };
  }
  async download(req: AuthRequest, value: string, evidence: string, res: Response) {
    requireRole(req, 'ADMIN', 'FINANCE');
    const [row] = await this.db.query(
      'SELECT filename,mime_type,content FROM finance_invoice_evidence WHERE asset_id=$1 AND id=$2',
      [z.string().uuid().parse(value), z.string().uuid().parse(evidence)],
    );
    if (!row) throw new NotFoundException('Invoice evidence not found');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${row.filename.replaceAll('"', '')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(row.content);
  }
}
@Controller('finance/assets/:id/invoices')
@UseGuards(SessionGuard)
export class InvoiceEvidenceController {
  constructor(@Inject(InvoiceEvidenceService) private readonly service: InvoiceEvidenceService) {}
  @Post() upload(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.upload(req, id, body);
  }
  @Get() list(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.list(req, id);
  }
  @Get(':evidence') download(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('evidence') evidence: string,
    @Res() res: Response,
  ) {
    return this.service.download(req, id, evidence, res);
  }
}
