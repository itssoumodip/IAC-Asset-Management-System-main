import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Actor, AuthRequest } from './security';
import { Db } from './db';
import { configuration } from './config';

export const text = (max = 5000) => z.string().trim().min(1).max(max);
export const uuid = z.string().uuid();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    'Invalid date',
  );
const optionalText = (max = 1000) => text(max).nullable().optional();
const optionalDate = date.nullable().optional();
const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/)
  .nullable()
  .optional();
export const statuses = [
  'Active',
  'In Store',
  'Assigned',
  'Under Repair',
  'Lost',
  'Stolen',
  'Retired',
  'Disposed',
  'Leased',
  'Under Verification',
  'Sold',
] as const;
export const NON_REPORTABLE_STATUSES = ['Retired', 'Disposed', 'Sold', 'Lost', 'Stolen'] as const;
export const terminal = new Set(['Retired', 'Disposed', 'Sold']);
export const assetInput = z
  .object({
    category: text(100),
    assetType: text(100),
    description: text(2000),
    manufacturer: optionalText(),
    model: optionalText(),
    serialNumber: optionalText(),
    barcode: optionalText(),
    configuration: optionalText(5000),
    graphics: optionalText(),
    ownershipType: text(100),
    departmentId: uuid.nullable().optional(),
    locationId: uuid.nullable().optional(),
    assetOwner: optionalText(),
    status: z.enum(statuses),
    condition: text(100),
    riskLevel: text(100),
    warrantyExpiry: optionalDate,
    amcApplies: z.boolean().optional(),
    amcExpiry: optionalDate,
    purchaseDate: optionalDate,
    purchaseCost: money,
    currency: z.literal('INR').optional(),
    residualValue: money,
    depreciationMethod: optionalText(),
    usefulLifeYears: z.number().int().min(1).max(100).nullable().optional(),
    invoiceNumber: optionalText(),
    supplier: optionalText(),
    insurancePolicyNumber: optionalText(),
    insuranceExpiry: optionalDate,
    lastAuditDate: optionalDate,
    nextAuditDate: optionalDate,
    disposalDate: optionalDate,
    disposalMethod: optionalText(),
    disposalReference: optionalText(),
    dataWipeRequired: z.enum(['Yes', 'No', 'Not Applicable']).nullable().optional(),
    remarks: optionalText(5000),
    commentType: optionalText(),
  })
  .strict();
// Shared financial metadata for Finance review and immutable approval evidence.
export const financialKeys = [
  'purchaseCost',
  'purchaseDate',
  'currency',
  'invoiceNumber',
  'supplier',
  'residualValue',
  'depreciationMethod',
  'usefulLifeYears',
  'insurancePolicyNumber',
  'insuranceExpiry',
] as const;
export const financialShape = Object.fromEntries(
  financialKeys.map((key) => [key, assetInput.shape[key]]),
) as Pick<typeof assetInput.shape, (typeof financialKeys)[number]>;
export const assetPatch = assetInput.partial().extend({ reason: text() }).strict();
export const ticketInput = z
  .object({
    assetId: uuid.optional(),
    relatedTicketId: uuid.optional(),
    subject: text(160),
    description: text(),
    category: text(100),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    photos: z
      .array(z.string().max(Math.ceil((400 * 1024) / 3) * 4 + 23))
      .max(3)
      .optional(),
  })
  .strict();
export const assignInput = z.object({ userId: uuid, note: optionalText(5000) }).strict();
export const reassignInput = assignInput.extend({ reason: text() }).strict();
export const returnInput = z
  .object({ reason: text(), condition: text(100), locationId: uuid.nullable().optional() })
  .strict();
export const ackInput = z
  .object({ decision: z.enum(['ACCEPTED', 'DISPUTED']), reason: optionalText(5000) })
  .strict()
  .refine((x) => x.decision !== 'DISPUTED' || !!x.reason, 'Dispute reason is required');
export const updateInput = z
  .object({ body: text(), visibility: z.enum(['PUBLIC', 'INTERNAL']) })
  .strict();
export const statusInput = z
  .object({ status: z.enum(['IN_PROGRESS', 'COMPLETED']), resolution: optionalText(5000) })
  .strict()
  .refine((x) => x.status !== 'COMPLETED' || !!x.resolution, 'Resolution is required');
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new UnprocessableEntityException({
      message: 'Invalid fields',
      fields: result.error.flatten(),
    });
  return result.data;
}
export function id(value: string): string {
  return parse(uuid, value);
}
export const admin = (actor: Actor) => actor.roles.includes('ADMIN');
export const staff = (actor: Actor) => admin(actor) || actor.roles.includes('IT_ADMIN');
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
export const camel = (row: any): any =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
  );
export const found = <T>(value: T | undefined): T => {
  if (!value) throw new NotFoundException('Record not found');
  return value;
};
export function requestPage(query: any, fields: string[]) {
  const input = parse(
    z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(1000).optional(),
        q: z.string().trim().max(100).optional(),
        status: z.string().max(100).optional(),
        category: z.string().max(100).optional(),
        departmentId: uuid.optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
        ownerId: uuid.optional(),
        entityType: z.string().max(100).optional(),
        entityId: uuid.optional(),
        labelPrinted: z.enum(['no']).optional(),
      })
      .strict(),
    query,
  );
  let after: any[] | null = null;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (
        !Array.isArray(decoded) ||
        decoded.length !== fields.length ||
        decoded.some((x) => typeof x !== 'string' || x.length > 100)
      )
        throw Error();
      after = decoded;
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }
  return { ...input, after };
}
export function page(rows: any[], limit: number, fields: string[]) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((row) =>
      camel(Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('cursor_')))),
    ),
    nextCursor: hasMore
      ? Buffer.from(
          JSON.stringify(
            fields.map(
              (f) =>
                last[`cursor_${f}`] ??
                (last[f] instanceof Date ? last[f].toISOString() : String(last[f])),
            ),
          ),
        ).toString('base64url')
      : null,
  };
}
export function assetScope(actor: Actor, values: any[]) {
  if (admin(actor)) return 'TRUE';
  if (actor.roles.includes('EMPLOYEE')) values.push(actor.id);
  const p = `$${values.length}`;
  const own = actor.roles.includes('EMPLOYEE')
    ? `EXISTS(SELECT 1 FROM assignments own WHERE own.asset_id=a.id AND own.user_id=${p} AND own.ended_at IS NULL)`
    : 'FALSE';
  return actor.roles.includes('IT_ADMIN')
    ? `(${own} OR EXISTS(SELECT 1 FROM tickets access_ticket WHERE access_ticket.asset_id=a.id))`
    : own;
}
export const employeeAssetColumns = [
  'id',
  'asset_code',
  'version',
  'category',
  'asset_type',
  'description',
  'manufacturer',
  'model',
  'serial_number',
  'barcode',
  'configuration',
  'graphics',
  'ownership_type',
  'department_id',
  'location_id',
  'status',
  'condition',
  'risk_level',
  'warranty_expiry',
  'amc_applies',
  'amc_expiry',
  'purchase_date',
  'currency',
  'insurance_expiry',
  'last_audit_date',
  'next_audit_date',
  'disposal_date',
  'disposal_method',
  'data_wipe_required',
];
export const privateAssetColumns = [
  'asset_owner',
  'purchase_cost',
  'residual_value',
  'depreciation_method',
  'useful_life_years',
  'invoice_number',
  'supplier',
  'insurance_policy_number',
  'disposal_reference',
  'remarks',
  'comment_type',
  'finance_pending',
  'legacy_metadata',
  'import_row_id',
  'created_at',
  'updated_at',
];
export function assetColumns(actor: Actor) {
  return [...employeeAssetColumns, ...(admin(actor) ? privateAssetColumns : [])]
    .map((c) => `a.${c}`)
    .join(',');
}
export function ticketScope(actor: Actor, values: any[]) {
  if (staff(actor)) return 'TRUE';
  values.push(actor.id);
  return `t.reporter_id=$${values.length}`;
}
export const ticketColumns =
  't.id,t.ticket_number,t.asset_id,t.related_ticket_id,t.subject,t.description,t.category,t.priority,t.status,t.owner_id,t.resolution,t.created_at,t.updated_at,t.completed_at,t.version';
export async function idempotent<T>(
  db: Db,
  req: AuthRequest,
  route: string,
  body: unknown,
  execute: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 200)
    throw new BadRequestException('Idempotency-Key must contain 8 to 200 characters');
  // If-Match participates so a stale command cannot be repurposed with the same key.
  const hash = createHash('sha256')
    .update(JSON.stringify({ body, ifMatch: req.get('If-Match') || null }))
    .digest('hex');
  return db.tx(async (c) => {
    await db.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${req.user.id}:${route}:${key}`],
      c,
    );
    const [prior] = await db.query(
      'SELECT * FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3 FOR UPDATE',
      [req.user.id, route, key],
      c,
    );
    if (prior && new Date(prior.expires_at) > new Date()) {
      if (prior.request_hash !== hash)
        throw new ConflictException('Idempotency key was already used for a different request');
      return prior.response_body as T;
    }
    if (prior)
      await db.query(
        'DELETE FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3',
        [req.user.id, route, key],
        c,
      );
    const result = await execute(c);
    await db.query(
      `INSERT INTO idempotency_keys(user_id,route,key,request_hash,response_code,response_body,expires_at) VALUES($1,$2,$3,$4,200,$5,now()+interval '24 hours')`,
      [req.user.id, route, key, hash, JSON.stringify(result)],
      c,
    );
    return result;
  });
}
export async function insertObject(
  db: Db,
  table: 'assets' | 'assignments' | 'tickets',
  data: Record<string, unknown>,
  client: PoolClient,
) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  const cols = entries.map(([k]) => snake(k));
  return (
    await db.query(
      `INSERT INTO ${table}(${cols.join(',')}) VALUES(${entries.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
      entries.map(([, v]) => v),
      client,
    )
  )[0];
}
export async function patchObject(
  db: Db,
  table: 'assets' | 'tickets',
  resourceId: string,
  data: Record<string, unknown>,
  client: PoolClient,
) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  const values = entries.map(([, v]) => v);
  values.push(resourceId);
  return (
    await db.query(
      `UPDATE ${table} SET ${entries.map(([k], i) => `${snake(k)}=$${i + 1}`).join(',')},version=version+1,updated_at=now() WHERE id=$${values.length} RETURNING *`,
      values,
      client,
    )
  )[0];
}
export async function validateReference(
  db: Db,
  kind: string,
  code: string,
  c: PoolClient,
  field = kind,
) {
  const [value] = await db.query(
    'SELECT code FROM reference_values WHERE kind=$1 AND code=$2 AND active FOR SHARE',
    [kind, code],
    c,
  );
  if (!value) throw new UnprocessableEntityException(`Invalid or inactive ${field}`);
}
export async function validateAsset(db: Db, data: any, c: PoolClient, previous?: any) {
  for (const [key, kind] of [
    ['category', 'CATEGORY'],
    ['assetType', 'ASSET_TYPE'],
    ['ownershipType', 'OWNERSHIP'],
    ['condition', 'CONDITION'],
    ['riskLevel', 'RISK'],
    ['status', 'STATUS'],
    ['depreciationMethod', 'DEPRECIATION_METHOD'],
    ['disposalMethod', 'DISPOSAL_METHOD'],
    ['commentType', 'COMMENT_TYPE'],
    ['dataWipeRequired', 'DATA_WIPE'],
  ] as const) {
    if (data[key] == null || (previous && previous[key] === data[key])) continue;
    await validateReference(db, kind, data[key], c, key);
  }
  for (const [key, table] of [
    ['departmentId', 'departments'],
    ['locationId', 'locations'],
  ] as const) {
    if (!data[key] || (previous && previous[key] === data[key])) continue;
    if (
      !(
        await db.query(`SELECT id FROM ${table} WHERE id=$1 AND active FOR SHARE`, [data[key]], c)
      )[0]
    )
      throw new UnprocessableEntityException(`Invalid or inactive ${key}`);
  }
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const today = ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join('-');
  if (data.purchaseDate && data.purchaseDate > today)
    throw new UnprocessableEntityException('Purchase date cannot be in the future');
  if (data.disposalDate && data.disposalDate > today)
    throw new UnprocessableEntityException('Disposal date cannot be in the future');
  if (
    data.residualValue != null &&
    (data.purchaseCost == null || Number(data.residualValue) > Number(data.purchaseCost))
  )
    throw new UnprocessableEntityException('Residual must not exceed purchase cost');
  if (data.amcExpiry && !data.amcApplies)
    throw new UnprocessableEntityException('AMC expiry requires AMC applicability');
  if (data.warrantyExpiry && data.purchaseDate && data.warrantyExpiry < data.purchaseDate)
    throw new UnprocessableEntityException('Warranty predates purchase');
  if (data.lastAuditDate && data.nextAuditDate && data.nextAuditDate <= data.lastAuditDate)
    throw new UnprocessableEntityException('Next audit must follow last audit');
  if (terminal.has(data.status) && (!data.disposalDate || !data.disposalReference))
    throw new UnprocessableEntityException(
      'Terminal assets require disposal date and evidence reference',
    );
}
export async function eligibleEmployee(
  db: Db,
  userId: string,
  c: PoolClient,
  allowInvited = false,
) {
  return found(
    (
      await db.query(
        `SELECT u.id,u.email FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role_code='EMPLOYEE' WHERE u.id=$1 AND (($2::boolean AND u.state='INVITED') OR (u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.portal_accepted_at IS NOT NULL AND u.portal_notice_version=$3)) FOR SHARE OF u`,
        [userId, allowInvited, configuration().noticeVersion],
        c,
      )
    )[0],
  );
}
