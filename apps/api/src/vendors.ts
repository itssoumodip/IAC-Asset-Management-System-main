import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { LIVE_ASSET, assetScope, parse, text, uuid } from './domain-helpers';
import { can } from './policy';
import { AuthRequest, SessionGuard, type Actor } from './security';
import { canViewSubscriptions } from './subscriptions';

/**
 * Vendors: companies the organisation buys from or works with, our rating of each, and the
 * staff who deal with them. Assets link when their supplier matches the vendor's name, and
 * subscriptions when their vendor does (ignoring case and spaces).
 *
 * Super Admin, any team lead or member, Finance and Procurement may add and edit vendors;
 * leadership, auditors and anyone who can see the asset catalog may view them.
 */

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

const vendorInput = z
  .object({
    name: text(200),
    services: optionalText(500),
    contactPerson: optionalText(200),
    phone: optionalText(100),
    email: optionalText(500),
    address: optionalText(1000),
    website: optionalText(500),
    gstin: optionalText(20),
    score: z.union([z.coerce.number().min(0).max(10), z.null()]).optional().default(null),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
    notes: optionalText(5000),
    referenceUserIds: z.array(uuid).max(20).optional().default([]),
  })
  .strict();
const updateInput = z.intersection(vendorInput, z.object({ version: z.number().int().min(1) }));
const listQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional(),
  })
  .strict();

export function canManageVendors(actor: Pick<Actor, 'roles' | 'teams'>) {
  return (
    actor.roles.some((r) => ['SUPER_ADMIN', 'FINANCE', 'PROCUREMENT'].includes(r)) || (actor.teams ?? []).length > 0
  );
}
export function canViewVendors(actor: Actor) {
  return canManageVendors(actor) || can(actor, 'asset.view_all') || can(actor, 'report.view');
}

/** Name used to link assets and subscriptions to a vendor: ignores case, spaces and punctuation (see migration 060). */
const KEY = (column: string) => `vendor_key(${column})`;

@Injectable()
export class VendorService {
  constructor(@Inject(Db) private readonly db: Db) {}

  private assertView(actor: Actor) {
    if (!canViewVendors(actor)) throw new ForbiddenException('Insufficient permission');
  }
  private assertManage(actor: Actor) {
    if (!canManageVendors(actor)) throw new ForbiddenException('Only team members, Finance or Procurement can change vendors');
  }

  async list(req: AuthRequest, query: unknown) {
    this.assertView(req.user);
    const p = parse(listQuery, query ?? {});
    const values: unknown[] = [];
    const scope = assetScope(req.user, values);
    const where = ['TRUE'];
    if (!p.status || p.status === 'ACTIVE') where.push("v.status = 'ACTIVE'");
    else if (p.status === 'INACTIVE') where.push("v.status = 'INACTIVE'");
    if (p.q) {
      values.push(`%${p.q.replace(/[\\%_]/g, '\\$&')}%`);
      const i = values.length;
      where.push(`(v.name ILIKE $${i} OR v.services ILIKE $${i} OR v.contact_person ILIKE $${i} OR v.phone ILIKE $${i}
        OR v.email ILIKE $${i} OR v.address ILIKE $${i} OR v.vendor_code ILIKE $${i})`);
    }
    const subs = canViewSubscriptions(req.user);
    const money = can(req.user, 'asset.view_private');
    const rows = await this.db.query(
      `SELECT v.*,
              (SELECT count(*)::int FROM assets a WHERE ${KEY('a.supplier')} = ${KEY('v.name')} AND ${LIVE_ASSET} AND ${scope}) AS asset_count,
              ${money ? `(SELECT coalesce(sum(a.purchase_cost), 0)::float8 FROM assets a WHERE ${KEY('a.supplier')} = ${KEY('v.name')} AND ${LIVE_ASSET} AND ${scope})` : 'NULL'} AS asset_value,
              ${subs ? `(SELECT count(*)::int FROM subscriptions s WHERE ${KEY('s.vendor')} = ${KEY('v.name')} AND s.status IN ('ACTIVE','TRIAL'))` : 'NULL'} AS subscription_count,
              coalesce((SELECT jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.display_name,
                         'hasPhoto', EXISTS(SELECT 1 FROM user_photos ph WHERE ph.user_id = u.id)) ORDER BY u.display_name)
                 FROM vendor_reference_people r JOIN users u ON u.id = r.user_id WHERE r.vendor_id = v.id), '[]'::jsonb) AS reference_people
         FROM vendors v
        WHERE ${where.join(' AND ')}
        ORDER BY v.name
        LIMIT 1000`,
      values,
    );
    return { items: rows.map(mapVendor), showsSubscriptions: subs, showsMoney: money };
  }

  async detail(req: AuthRequest, id: string) {
    this.assertView(req.user);
    const vid = parse(uuid, id);
    const [v] = await this.db.query(
      `SELECT v.*, coalesce((SELECT jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.display_name,
                'designation', u.designation, 'hasPhoto', EXISTS(SELECT 1 FROM user_photos ph WHERE ph.user_id = u.id))
                ORDER BY u.display_name)
                FROM vendor_reference_people r JOIN users u ON u.id = r.user_id WHERE r.vendor_id = v.id), '[]'::jsonb) AS reference_people,
              cb.display_name AS created_by_name
         FROM vendors v LEFT JOIN users cb ON cb.id = v.created_by WHERE v.id = $1`,
      [vid],
    );
    if (!v) throw new NotFoundException('Vendor not found');
    const values: unknown[] = [v.name];
    const scope = assetScope(req.user, values);
    const money = can(req.user, 'asset.view_private');
    const subs = canViewSubscriptions(req.user);
    const [assets, subscriptions] = await Promise.all([
      this.db.query(
        `SELECT a.id, a.asset_code, a.description, a.category, a.asset_type, a.manufacturer, a.model, a.status,
                a.purchase_date, a.purchase_cost, a.invoice_number, a.warranty_expiry,
                holder.id AS holder_id, holder.display_name AS holder_name,
                EXISTS(SELECT 1 FROM user_photos ph WHERE ph.user_id = holder.id) AS holder_has_photo
           FROM assets a
           LEFT JOIN assignments g ON g.asset_id = a.id AND g.ended_at IS NULL
           LEFT JOIN users holder ON holder.id = g.user_id
          WHERE ${KEY('a.supplier')} = ${KEY('$1')} AND ${LIVE_ASSET} AND ${scope}
          ORDER BY a.purchase_date DESC NULLS LAST, a.asset_code
          LIMIT 500`,
        values,
      ),
      subs
        ? this.db.query(
            `SELECT s.id, s.name, s.plan, s.status, s.renewal_date, s.cost::float8 AS cost, s.currency, s.billing_cycle
               FROM subscriptions s WHERE ${KEY('s.vendor')} = ${KEY('$1')} ORDER BY s.name`,
            [v.name],
          )
        : Promise.resolve(null),
    ]);
    return {
      ...mapVendor(v),
      createdBy: v.created_by_name,
      canManage: canManageVendors(req.user),
      showsMoney: money,
      assets: assets.map((a: any) => ({
        id: a.id,
        assetCode: a.asset_code,
        description: a.description,
        category: a.category,
        assetType: a.asset_type,
        manufacturer: a.manufacturer,
        model: a.model,
        status: a.status,
        purchaseDate: a.purchase_date,
        purchaseCost: money && a.purchase_cost != null ? Number(a.purchase_cost) : null,
        invoiceNumber: a.invoice_number,
        warrantyExpiry: a.warranty_expiry,
        holder: a.holder_id ? { userId: a.holder_id, name: a.holder_name, hasPhoto: a.holder_has_photo } : null,
      })),
      subscriptions: subscriptions
        ? subscriptions.map((s: any) => ({
            id: s.id,
            name: s.name,
            plan: s.plan,
            status: s.status,
            renewalDate: s.renewal_date,
            cost: s.cost,
            currency: s.currency,
            billingCycle: s.billing_cycle,
          }))
        : null,
    };
  }

  /** Vendor names for suggestions on asset and subscription forms. */
  async names(req: AuthRequest) {
    const rows = await this.db.query("SELECT id, name FROM vendors WHERE status = 'ACTIVE' ORDER BY name");
    return { items: rows.map((r: any) => ({ id: r.id, name: r.name })) };
  }

  /** The vendor an asset's supplier (or a subscription's vendor) points to, if any. */
  async lookup(req: AuthRequest, name: string) {
    if (!name?.trim()) return { vendor: null };
    const [row] = await this.db.query(`SELECT id, name, vendor_code FROM vendors WHERE ${KEY('name')} = ${KEY('$1')}`, [
      name.slice(0, 200),
    ]);
    return { vendor: row ? { id: row.id, name: row.name, code: row.vendor_code } : null };
  }

  private async checkPeople(c: any, ids: string[]) {
    if (!ids.length) return;
    const ok = await this.db.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [ids], c);
    if (ok.length !== ids.length) throw new UnprocessableEntityException('Some reference people were not found');
  }
  private async setPeople(c: any, vendorId: string, ids: string[]) {
    await this.db.query('DELETE FROM vendor_reference_people WHERE vendor_id = $1', [vendorId], c);
    for (const userId of ids)
      await this.db.query('INSERT INTO vendor_reference_people(vendor_id, user_id) VALUES($1, $2)', [vendorId, userId], c);
  }
  private values(v: z.infer<typeof vendorInput>) {
    return [v.name, v.services, v.contactPerson, v.phone, v.email, v.address, v.website, v.gstin, v.score, v.status, v.notes];
  }

  async create(req: AuthRequest, body: unknown) {
    this.assertManage(req.user);
    const input = parse(vendorInput, body);
    const people = [...new Set(input.referenceUserIds)];
    return this.db.tx(async (c) => {
      const [dup] = await this.db.query(`SELECT 1 FROM vendors WHERE ${KEY('name')} = ${KEY('$1')}`, [input.name], c);
      if (dup) throw new ConflictException('A vendor with this name already exists');
      await this.checkPeople(c, people);
      const [row] = await this.db.query(
        `INSERT INTO vendors(name, services, contact_person, phone, email, address, website, gstin, score, status, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, vendor_code`,
        [...this.values(input), req.user.id],
        c,
      );
      await this.setPeople(c, row.id, people);
      await this.db.audit(c, req.user, 'vendor', row.id, 'VENDOR_CREATED', { after: input });
      return { id: row.id, code: row.vendor_code };
    });
  }

  async update(req: AuthRequest, id: string, body: unknown) {
    this.assertManage(req.user);
    const vid = parse(uuid, id);
    const { version, ...input } = parse(updateInput, body);
    const people = [...new Set(input.referenceUserIds)];
    return this.db.tx(async (c) => {
      const [before] = await this.db.query('SELECT * FROM vendors WHERE id = $1 FOR UPDATE', [vid], c);
      if (!before) throw new NotFoundException('Vendor not found');
      if (before.version !== version) throw new ConflictException('Someone else changed this vendor. Reload and try again.');
      const [dup] = await this.db.query(`SELECT 1 FROM vendors WHERE ${KEY('name')} = ${KEY('$1')} AND id <> $2`, [input.name, vid], c);
      if (dup) throw new ConflictException('A vendor with this name already exists');
      await this.checkPeople(c, people);
      await this.db.query(
        `UPDATE vendors SET name=$1, services=$2, contact_person=$3, phone=$4, email=$5, address=$6, website=$7, gstin=$8,
            score=$9, status=$10, notes=$11, updated_at=now(), version=version+1 WHERE id=$12`,
        [...this.values(input), vid],
        c,
      );
      await this.setPeople(c, vid, people);
      await this.db.audit(c, req.user, 'vendor', vid, 'VENDOR_UPDATED', { before, after: input });
      return { id: vid, version: version + 1 };
    });
  }
}

function mapVendor(v: any) {
  return {
    id: v.id,
    code: v.vendor_code,
    name: v.name,
    services: v.services,
    contactPerson: v.contact_person,
    phone: v.phone,
    email: v.email,
    address: v.address,
    website: v.website,
    gstin: v.gstin,
    score: v.score != null ? Number(v.score) : null,
    status: v.status,
    notes: v.notes,
    referencePeople: v.reference_people ?? [],
    assetCount: v.asset_count ?? null,
    assetValue: v.asset_value != null ? Number(v.asset_value) : null,
    subscriptionCount: v.subscription_count ?? null,
    version: v.version,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

@Controller('vendors')
@UseGuards(SessionGuard)
export class VendorController {
  constructor(@Inject(VendorService) private readonly service: VendorService) {}

  @Get()
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.list(req, query);
  }
  @Get('names')
  names(@Req() req: AuthRequest) {
    return this.service.names(req);
  }
  @Get('lookup')
  lookup(@Req() req: AuthRequest, @Query('name') name: string) {
    return this.service.lookup(req, name);
  }
  @Get(':id')
  detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.service.detail(req, id);
  }
  @Post()
  create(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.create(req, body);
  }
  @Put(':id')
  update(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(req, id, body);
  }
}
