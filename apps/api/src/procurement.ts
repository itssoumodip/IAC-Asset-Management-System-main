import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';
import { parse, text } from './domain-helpers';

/** Procurement page: approved requests to buy, out-of-stock products, basic purchase record
 * (supplier, date, qty, amount). [OPEN full PO] */
@Injectable()
export class ProcurementService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest) {
    assertCan(req.user, 'procurement.view');
    const rows = await this.db.query(`
      SELECT p.id, p.purchase_code, p.supplier, p.purchase_date, p.quantity, p.amount,
             p.currency, p.notes, p.created_by, u.display_name AS created_by_name,
             p.created_at
      FROM purchases p
      JOIN users u ON u.id = p.created_by
      ORDER BY p.purchase_date DESC, p.purchase_code
    `);
    return { items: rows.map((r: any) => ({
      id: r.id,
      purchaseCode: r.purchase_code,
      supplier: r.supplier,
      purchaseDate: r.purchase_date,
      quantity: r.quantity,
      amount: Number(r.amount),
      currency: r.currency,
      notes: r.notes,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      createdAt: r.created_at,
    })) };
  }

  async create(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'procurement.view');
    const b = body as {
      purchaseCode?: string;
      supplier?: string;
      purchaseDate?: string;
      quantity?: number;
      amount?: number;
      currency?: string;
      notes?: string;
    };
    const purchaseCode = parse(z.string().min(1).max(40), b.purchaseCode) as string;
    const supplier = parse(text(200), b.supplier) as string;
    const purchaseDate = parse(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      b.purchaseDate,
    ) as string;
    const quantity = parse(z.number().int().min(1), b.quantity) as number;
    const amount = parse(z.number().min(0), b.amount) as number;
    const currency = parse(z.string().length(3), b.currency ?? 'INR') as string;
    const notes = parse(text(1000).nullable().optional(), b.notes) as string | null;

    const [purchase] = await this.db.query(`
      INSERT INTO purchases(purchase_code, supplier, purchase_date, quantity, amount, currency, notes, created_by)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, purchase_code
    `, [purchaseCode, supplier, purchaseDate, quantity, amount, currency, notes, req.user.id]);

    return { id: purchase.id, purchaseCode: purchase.purchase_code };
  }
}

@Controller('procurement')
@UseGuards(SessionGuard)
export class ProcurementController {
  constructor(@Inject(ProcurementService) private readonly service: ProcurementService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.service.list(req);
  }

  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
}
