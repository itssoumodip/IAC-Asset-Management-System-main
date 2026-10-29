import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { TicketDomain } from './domain-tickets';
import { configuration } from './config';
import { AuthRequest, assertVersion, requireRole } from './security';
import {
  assetInput,
  camel,
  eligibleEmployee,
  found,
  id,
  idempotent,
  insertObject,
  parse,
  text,
  validateAsset,
} from './domain-helpers';

export const sourceHeaders = [
  'Asset ID',
  'Asset Category',
  'Asset Type',
  'Asset Description',
  'Manufacturer',
  'Model',
  'Serial Number',
  'Barcode / QR Code',
  'Configuration Details',
  'Graphics Details',
  'Ownership Type',
  'Purchase Date',
  'Invoice Number',
  'Supplier',
  'Purchase Cost',
  'Residual Value',
  'Depreciation Method',
  'Useful Life (Years)',
  'Annual Depreciation',
  'Accumulated Depreciation',
  'Net Book Value',
  'Department',
  'Asset Owner',
  'Old Custodian',
  'Custodian',
  'Employee ID',
  'Floor',
  'Room / Location',
  'Asset Status',
  'Condition',
  'Risk Level',
  'Warranty Expiry',
  'AMC Expiry',
  'Insurance Policy No.',
  'Insurance Expiry',
  'Last Audit Date',
  'Next Audit Date',
  'Disposal Date',
  'Disposal Method',
  'Data Wipe Required',
  'Remarks',
  'Comment Type',
  'Custodian Login ID',
  'Custodian Login ID (Manual)',
] as const;
export const register42Headers = [
  ...sourceHeaders.filter(
    (header) =>
      !['Comment Type', 'Custodian Login ID', 'Custodian Login ID (Manual)'].includes(header),
  ),
  'Column1',
];
const sourceRow = z.record(
  z.string(),
  z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.null()]),
);
const stageInput = z
  .object({
    filename: text(200).refine((s) => !/[\\/]/.test(s), 'Use a filename, not a path'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceWorkbookSha256: z.string().regex(/^[a-f0-9]{64}$/),
    exportedAt: z.string().datetime(),
    sourceLayout: z.enum(['REGISTER_44', 'REGISTER_42']).default('REGISTER_44'),
    rows: z.array(sourceRow).min(1).max(500),
  })
  .strict()
  .superRefine((data, context) => {
    const headers = data.sourceLayout === 'REGISTER_42' ? register42Headers : sourceHeaders;
    for (const [index, row] of data.rows.entries()) {
      if (
        !headers.every((header) => header in row) ||
        !Object.keys(row).every((header) => headers.includes(header as any))
      )
        context.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: `Every row must have exactly the ${headers.length} source headers for ${data.sourceLayout}`,
        });
    }
  });
const correction = z
  .object({
    rowNumber: z.number().int().min(1),
    fields: assetInput
      .partial()
      .extend({
        assetCode: z
          .string()
          .regex(/^IAC-IT-\d{6}$/)
          .optional(),
        custodianEmail: z.string().email().optional(),
      })
      .strict(),
  })
  .strict();
const reviewInput = z
  .object({
    reason: text(),
    acceptFinancePending: z.literal(true),
    rows: z.array(correction).max(500),
    expectedAssetCodes: z
      .array(z.string().regex(/^IAC-IT-\d{6}$/))
      .min(1)
      .max(500),
    expectedTotalCost: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    expectedUnknownPurchaseCost: z.number().int().min(0).max(500).default(0),
  })
  .strict();
const sourceMap: Record<string, string> = {
  category: 'Asset Category',
  assetType: 'Asset Type',
  description: 'Asset Description',
  manufacturer: 'Manufacturer',
  model: 'Model',
  serialNumber: 'Serial Number',
  barcode: 'Barcode / QR Code',
  configuration: 'Configuration Details',
  graphics: 'Graphics Details',
  ownershipType: 'Ownership Type',
  purchaseDate: 'Purchase Date',
  invoiceNumber: 'Invoice Number',
  supplier: 'Supplier',
  purchaseCost: 'Purchase Cost',
  residualValue: 'Residual Value',
  depreciationMethod: 'Depreciation Method',
  usefulLifeYears: 'Useful Life (Years)',
  assetOwner: 'Asset Owner',
  status: 'Asset Status',
  condition: 'Condition',
  riskLevel: 'Risk Level',
  warrantyExpiry: 'Warranty Expiry',
  amcExpiry: 'AMC Expiry',
  insurancePolicyNumber: 'Insurance Policy No.',
  insuranceExpiry: 'Insurance Expiry',
  lastAuditDate: 'Last Audit Date',
  nextAuditDate: 'Next Audit Date',
  disposalDate: 'Disposal Date',
  disposalMethod: 'Disposal Method',
  dataWipeRequired: 'Data Wipe Required',
  remarks: 'Remarks',
  commentType: 'Comment Type',
};
export function resolveImportEmail(raw: Record<string, unknown>, approvedMapping?: string) {
  const manual = String(raw['Custodian Login ID (Manual)'] ?? '')
    .trim()
    .toLowerCase();
  const exported = String(raw['Custodian Login ID'] ?? '')
    .trim()
    .toLowerCase();
  const chosen = manual || exported || approvedMapping?.trim().toLowerCase() || null;
  if (chosen && !z.string().email().safeParse(chosen).success)
    return { email: null, issue: manual ? 'INVALID_MANUAL_EMAIL' : 'INVALID_EXPORTED_EMAIL' };
  // Employee ID and custodian name are never used as account keys.
  return { email: chosen, issue: null };
}
function paisa(value: string | number | null | undefined) {
  if (value == null || value === '') return 0n;
  const [whole = '', fraction = ''] = String(value).split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction))
    throw new UnprocessableEntityException(
      'Purchase cost must be a nonnegative two-decimal amount',
    );
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function decimal(amount: bigint) {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export class ImportDomain extends TicketDomain {
  async importBatch(req: AuthRequest, batchId: string, c?: PoolClient) {
    requireRole(req, 'ADMIN');
    id(batchId);
    const row = found(
      (await this.db.query('SELECT * FROM import_batches WHERE id=$1', [batchId], c))[0],
    );
    const rows = await this.db.query(
      'SELECT id,row_number,raw_fields,normalized_fields,issues,state FROM import_rows WHERE batch_id=$1 ORDER BY row_number',
      [batchId],
      c,
    );
    return {
      ...camel(row),
      total: rows.length,
      accepted: rows.filter((r) => r.state === 'ACCEPTED' || r.state === 'PROMOTED').length,
      quarantined: rows.filter((r) => r.state === 'QUARANTINED').length,
      rows: rows.map(camel),
    };
  }
  async stageImport(req: AuthRequest, body: unknown) {
    requireRole(req, 'ADMIN');
    const data = parse(stageInput, body);
    if (new Date(data.exportedAt) > new Date())
      throw new UnprocessableEntityException('Export date cannot be in the future');
    return idempotent(this.db, req, 'POST /imports', data, async (c) => {
      if (
        (
          await this.db.query(
            'SELECT id FROM import_batches WHERE source_sha256=$1',
            [data.sourceSha256],
            c,
          )
        )[0]
      )
        throw new ConflictException('This export hash is already staged');
      const [batch] = await this.db.query(
        "INSERT INTO import_batches(source_sha256,source_filename,exported_at,state,created_by,reconciliation) VALUES($1,$2,$3,'STAGED',$4,$5) RETURNING *",
        [
          data.sourceSha256,
          data.filename,
          data.exportedAt,
          req.user.id,
          JSON.stringify({
            sourceWorkbookSha256: data.sourceWorkbookSha256,
            sourceLayout: data.sourceLayout,
            sourceRowCount: data.rows.length,
            reviewed: false,
          }),
        ],
        c,
      );
      for (const [index, raw] of data.rows.entries())
        await this.db.query(
          "INSERT INTO import_rows(batch_id,row_number,raw_fields,issues,state) VALUES($1,$2,$3,$4,'QUARANTINED')",
          [
            batch.id,
            index + 1,
            JSON.stringify(raw),
            JSON.stringify([
              { code: 'REVIEW_REQUIRED', message: 'Restricted source row awaits owner review' },
            ]),
          ],
          c,
        );
      await this.db.audit(c, req.user, 'import', batch.id, 'IMPORT_STAGED', {
        rowCount: data.rows.length,
        sourceSha256: data.sourceSha256,
      });
      return this.importBatch(req, batch.id, c);
    });
  }
  async normalizeImport(raw: any, corrections: any, c: PoolClient) {
    const issues: { code: string; message: string }[] = [];
    const candidate: any = {};
    if (String(raw.Column1 ?? '').trim() !== '')
      issues.push({
        code: 'UNMAPPED_SOURCE_FIELD',
        message:
          'Nonempty Column1 is preserved as source evidence and requires owner reconciliation',
      });
    for (const [key, header] of Object.entries(sourceMap))
      if (raw[header] !== null && raw[header] !== undefined && String(raw[header]).trim() !== '')
        candidate[key] =
          key === 'usefulLifeYears' ? Number(raw[header]) : String(raw[header]).trim();
    const code = corrections.assetCode || String(raw['Asset ID'] ?? '').trim();
    if (!/^IAC-IT-\d{6}$/.test(code))
      issues.push({
        code: 'INVALID_ASSET_ID',
        message: 'Stable source Asset ID must match IAC-IT-nnnnnn',
      });
    // Corrections cannot mutate the immutable source ID; a bad code stays quarantined.
    if (corrections.assetCode && corrections.assetCode !== String(raw['Asset ID'] ?? '').trim())
      issues.push({
        code: 'IMMUTABLE_ASSET_ID',
        message: 'Source Asset ID may not be changed during import',
      });
    const department = String(raw.Department ?? '').trim();
    if (department && !corrections.departmentId) {
      const matches = await this.db.query(
        'SELECT id FROM departments WHERE active AND (code=$1 OR name=$1)',
        [department],
        c,
      );
      if (matches.length === 1) candidate.departmentId = matches[0].id;
      else
        issues.push({
          code: 'DEPARTMENT_UNRESOLVED',
          message: 'Department must map to one approved active reference',
        });
    }
    const room = String(raw['Room / Location'] ?? '').trim(),
      floor = String(raw.Floor ?? '').trim();
    if ((room || floor) && !corrections.locationId) {
      const matches = await this.db.query(
        "SELECT id FROM locations WHERE active AND (code=$1 OR room=$1) AND ($2='' OR floor=$2)",
        [room, floor],
        c,
      );
      if (matches.length === 1) candidate.locationId = matches[0].id;
      else
        issues.push({
          code: 'LOCATION_UNRESOLVED',
          message: 'Location must map to one approved active reference',
        });
    }
    candidate.amcApplies = !!candidate.amcExpiry;
    Object.assign(candidate, corrections);
    delete candidate.assetCode;
    delete candidate.custodianEmail;
    const result = assetInput.safeParse(candidate);
    if (!result.success)
      issues.push({
        code: 'INVALID_FIELDS',
        message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    else
      try {
        await validateAsset(this.db, result.data, c);
      } catch (e) {
        issues.push({
          code: 'INVALID_REFERENCE_OR_POLICY',
          message: e instanceof Error ? e.message : 'Invalid operational metadata',
        });
      }
    const formulaFields = Object.keys(raw).filter(
      (k) => typeof raw[k] === 'string' && String(raw[k]).trimStart().startsWith('='),
    );
    if (formulaFields.length)
      issues.push({
        code: 'FORMULA_NOT_EXPORTED',
        message: `Export displayed values instead of formula strings: ${formulaFields.join(', ')}`,
      });
    const identity = resolveImportEmail(raw, corrections.custodianEmail);
    if (identity.issue)
      issues.push({
        code: identity.issue,
        message: 'Invalid preferred email is quarantined; lower-priority identity cannot bypass it',
      });
    const hasCustodian = !!String(raw.Custodian ?? '').trim();
    const needsCustody = candidate.status === 'Assigned' || hasCustodian || !!identity.email;
    let custodianId: null | string = null;
    if (needsCustody) {
      if (!identity.email)
        issues.push({
          code: 'CUSTODIAN_UNRESOLVED',
          message: 'Approved individual email required; Employee ID is reference-only',
        });
      else {
        const users = await this.db.query(
          `SELECT u.id FROM users u JOIN approved_emails e ON e.email=u.email JOIN user_roles r ON r.user_id=u.id AND r.role_code='EMPLOYEE' WHERE u.email=$1 AND u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.portal_accepted_at IS NOT NULL AND u.portal_notice_version=$2`,
          [identity.email, configuration().noticeVersion],
          c,
        );
        if (users.length === 1) custodianId = users[0].id;
        else
          issues.push({
            code: 'CUSTODIAN_UNAPPROVED',
            message: 'Custodian must be an approved active, verified portal Employee',
          });
      }
      if (!['Assigned', 'Under Repair', 'Lost', 'Stolen'].includes(candidate.status))
        issues.push({
          code: 'CUSTODY_STATUS_CONFLICT',
          message:
            'Current custody requires Assigned, Under Repair, Lost or Stolen; owner must resolve ambiguous source status',
        });
    }
    if ((await this.db.query('SELECT id FROM assets WHERE asset_code=$1', [code], c))[0])
      issues.push({
        code: 'ASSET_ALREADY_EXISTS',
        message: 'Import never overwrites existing live inventory',
      });
    return {
      data: result.success ? result.data : candidate,
      assetCode: code,
      custodianId,
      issues,
      corrections,
    };
  }
  async reviewImport(req: AuthRequest, batchId: string, body: unknown) {
    requireRole(req, 'ADMIN');
    id(batchId);
    const input = parse(reviewInput, body);
    return this.db.tx(async (c) => {
      const batch = found(
        (
          await this.db.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [batchId], c)
        )[0],
      );
      assertVersion(req, batch.version);
      if (batch.state === 'COMMITTED') throw new ConflictException('Committed batch is immutable');
      const rows = await this.db.query(
        'SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number FOR UPDATE',
        [batchId],
        c,
      );
      if (
        new Set(input.rows.map((r) => r.rowNumber)).size !== input.rows.length ||
        input.rows.some((r) => !rows.find((x) => x.row_number === r.rowNumber))
      )
        throw new UnprocessableEntityException('Unknown or repeated correction row');
      const codes = rows.map((r) => String(r.raw_fields['Asset ID'] ?? '').trim());
      if (new Set(codes).size !== codes.length)
        throw new ConflictException('Duplicate source Asset IDs require source reconciliation');
      if (
        input.expectedAssetCodes.length !== codes.length ||
        new Set(input.expectedAssetCodes).size !== codes.length ||
        input.expectedAssetCodes.some((code) => !codes.includes(code))
      )
        throw new ConflictException('Expected Asset ID set does not reconcile exactly');
      let cost = 0n,
        accepted = 0,
        unknownCost = 0;
      for (const row of rows) {
        const supplied = input.rows.find((r) => r.rowNumber === row.row_number)?.fields;
        const corrections = supplied || row.normalized_fields?.corrections || {};
        const normalized = await this.normalizeImport(row.raw_fields, corrections, c);
        if (!normalized.issues.length) accepted++;
        // Control totals use the approved normalized amount and preserve original amounts in raw_fields.
        if (normalized.data.purchaseCost == null) unknownCost++;
        else cost += paisa(normalized.data.purchaseCost);
        await this.db.query(
          'UPDATE import_rows SET normalized_fields=$2,issues=$3,state=$4 WHERE id=$1',
          [
            row.id,
            JSON.stringify(normalized),
            JSON.stringify(normalized.issues),
            normalized.issues.length ? 'QUARANTINED' : 'ACCEPTED',
          ],
          c,
        );
      }
      if (unknownCost !== input.expectedUnknownPurchaseCost)
        throw new ConflictException(
          'Unknown purchase-cost count must be explicitly reconciled; missing costs are not zero',
        );
      if (cost !== paisa(input.expectedTotalCost))
        throw new ConflictException('Purchase cost control total does not reconcile to the paisa');
      const reconciliation = {
        ...batch.reconciliation,
        reviewed: true,
        reviewReason: input.reason,
        acceptFinancePending: true,
        expectedAssetCodes: input.expectedAssetCodes,
        knownTotalCost: decimal(cost),
        unknownPurchaseCost: unknownCost,
        accepted,
        quarantined: rows.length - accepted,
        total: rows.length,
      };
      await this.db.query(
        "UPDATE import_batches SET state='REVIEWED',reconciliation=$2,version=version+1 WHERE id=$1",
        [batchId, JSON.stringify(reconciliation)],
        c,
      );
      await this.db.audit(c, req.user, 'import', batchId, 'IMPORT_REVIEWED', {
        total: rows.length,
        accepted,
        quarantined: rows.length - accepted,
        reason: input.reason,
      });
      return this.importBatch(req, batchId, c);
    });
  }
  async commitImport(req: AuthRequest, batchId: string, body: unknown) {
    requireRole(req, 'ADMIN');
    id(batchId);
    const input = parse(z.object({ reviewed: z.literal(true) }).strict(), body);
    return idempotent(this.db, req, `POST /imports/${batchId}/commit`, input, async (c) => {
      const batch = found(
        (
          await this.db.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [batchId], c)
        )[0],
      );
      assertVersion(req, batch.version);
      if (batch.state !== 'REVIEWED' || !batch.reconciliation.reviewed)
        throw new ConflictException('Batch must have a completed owner review');
      await this.db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence',0))",
        [],
        c,
      );
      const rows = await this.db.query(
        "SELECT * FROM import_rows WHERE batch_id=$1 AND state='ACCEPTED' ORDER BY row_number FOR UPDATE",
        [batchId],
        c,
      );
      if (!rows.length) throw new ConflictException('No eligible rows were accepted');
      let promoted = 0;
      for (const row of rows) {
        const normalized = await this.normalizeImport(
          row.raw_fields,
          row.normalized_fields.corrections,
          c,
        );
        if (normalized.issues.length)
          throw new ConflictException(
            `Row ${row.row_number} requires another review before commit`,
          );
        const asset = await insertObject(
          this.db,
          'assets',
          {
            ...normalized.data,
            assetCode: normalized.assetCode,
            createdBy: req.user.id,
            importRowId: row.id,
            financePending: true,
            legacyMetadata: {
              rawSourceRowId: row.id,
              asOf: batch.exported_at,
              annual_depreciation_cache: row.raw_fields['Annual Depreciation'],
              accumulated_depreciation_cache: row.raw_fields['Accumulated Depreciation'],
              net_book_value_cache: row.raw_fields['Net Book Value'],
              old_custodian: row.raw_fields['Old Custodian'],
              employee_reference: row.raw_fields['Employee ID'],
            },
          },
          c,
        );
        if (normalized.custodianId) {
          const employee = await eligibleEmployee(this.db, normalized.custodianId, c);
          const assignment = await insertObject(
            this.db,
            'assignments',
            {
              assetId: asset.id,
              userId: employee.id,
              assignedBy: req.user.id,
              handoverNote: 'Imported current custody; historical acceptance is unknown',
            },
            c,
          );
          await this.db.query(
            "INSERT INTO assignment_events(assignment_id,actor_id,kind) VALUES($1,$2,'IMPORTED_PENDING')",
            [assignment.id, req.user.id],
            c,
          );
          await this.db.query(
            "INSERT INTO asset_movements(asset_id,kind,to_assignment_id,reason,actor_id) VALUES($1,'ASSIGN',$2,'Approved import of current custody',$3)",
            [asset.id, assignment.id, req.user.id],
            c,
          );
          await this.db.workflowNotify(
            c,
            `assignment:${assignment.id}:created`,
            'ASSIGNMENT',
            assignment.id,
            [employee.email],
            `Verify imported asset ${asset.asset_code}`,
            'Imported current custody needs your acknowledgement.',
          );
          await this.db.notify(
            c,
            `assignment:${assignment.id}:created`,
            'ASSIGNMENT_CREATED',
            [employee.email],
            {
              subject: `Verify imported asset ${asset.asset_code}`,
              text: 'Current custody was imported with pending acknowledgement. Sign in and verify the asset details.',
            },
          );
        }
        await this.db.query("UPDATE import_rows SET state='PROMOTED' WHERE id=$1", [row.id], c);
        await this.db.audit(c, req.user, 'asset', asset.id, 'ASSET_IMPORTED', {
          batchId,
          sourceRowNumber: row.row_number,
          assetCode: asset.asset_code,
        });
        promoted++;
      }
      // Sequence only advances, and allocation shares a transaction lock with imported-code reconciliation.
      await this.db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('iac-asset-sequence',0))",
        [],
        c,
      );
      await this.db.query(
        "SELECT setval('asset_number_seq',greatest((SELECT last_value FROM asset_number_seq),(SELECT max(substring(asset_code from 8)::bigint) FROM assets)),true)",
        [],
        c,
      );
      await this.db.query(
        "UPDATE import_batches SET state='COMMITTED',version=version+1,reconciliation=reconciliation || $2::jsonb WHERE id=$1",
        [batchId, JSON.stringify({ promoted, committedAt: new Date().toISOString() })],
        c,
      );
      await this.db.audit(c, req.user, 'import', batchId, 'IMPORT_COMMITTED', {
        promoted,
        quarantined: batch.reconciliation.quarantined,
      });
      return this.importBatch(req, batchId, c);
    });
  }
}
