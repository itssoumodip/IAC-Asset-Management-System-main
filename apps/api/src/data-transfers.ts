import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AuthService } from './auth';
import { configuration } from './config';
import { Db } from './db';
import { DomainService } from './domain';
import { assetInput, parse, staff, text, uuid } from './domain-helpers';
import { masterKinds } from './domain-masters';
import { AuthRequest, requireRole, SessionGuard } from './security';

type Row = Record<string, string>;
type Definition = {
  module: string;
  label: string;
  columns: string[];
  example: Row;
  description: string;
};
type RowResult = { rowNumber: number; id?: string; summary: string };
const assetFields = Object.keys(assetInput.shape).filter(
  (key) => !['departmentId', 'locationId'].includes(key),
);
const definitions: Definition[] = [
  {
    module: 'assets',
    label: 'Asset catalog',
    columns: ['action', 'assetCode', 'version', ...assetFields, 'departmentCode', 'locationCode'],
    example: {
      action: 'CREATE',
      category: 'IT Hardware',
      assetType: 'Laptop',
      description: 'Example equipment',
      ownershipType: 'Owned',
      status: 'In Store',
      condition: 'Good',
      riskLevel: 'Low',
      amcApplies: 'false',
    },
    description:
      'CREATE generates a permanent Asset ID: leave assetCode/version blank. UPDATE requires an existing assetCode and current version. Existing register IDs must use Import review. Blank optional cells are omitted; bulk updates cannot clear fields.',
  },
  {
    module: 'people',
    label: 'People and access',
    columns: ['action', 'email', 'displayName', 'designation', 'departmentId', 'version', 'state', 'roles'],
    example: {
      action: 'INVITE',
      email: 'employee@example.org',
      displayName: 'Example Employee',
      designation: 'Occupational Therapist',
      departmentId: 'department UUID',
    },
    description:
      'APPROVE authorizes registration for an email only. INVITE prepares an Employee account and accepts name, designation and a department UUID, code or exact name. New accounts remain INVITED until accepted. UPDATE requires current version and a reason. No passwords, verification or MFA data are imported. Use the email option to send invitations now or leave it off and send them later.',
  },
  {
    module: 'tickets',
    label: 'New support tickets',
    columns: ['subject', 'description', 'category', 'priority', 'assetCode', 'relatedTicketNumber'],
    example: {
      subject: 'Example support request',
      description: 'Describe the issue',
      category: 'HARDWARE',
      priority: 'MEDIUM',
    },
    description:
      'Creates tickets reported by the signed-in user. An assetCode must be in your own current custody. Existing ticket history, owners and status are not overwritten. Confirming queues normal support notices.',
  },
  {
    module: 'assignments',
    label: 'Asset custody',
    columns: [
      'action',
      'assetCode',
      'assetVersion',
      'employeeEmail',
      'assignmentVersion',
      'note',
      'condition',
      'locationCode',
    ],
    example: {
      action: 'ASSIGN',
      assetCode: 'IAC-IT-000001',
      assetVersion: '1',
      employeeEmail: 'employee@example.org',
    },
    description:
      'ASSIGN or TRANSFER requires current assetVersion and an approved, active, verified Employee email. TRANSFER and RETURN require the current assignmentVersion. RETURN requires condition. No historical custody or acknowledgements are imported; confirming queues custody notices.',
  },
  {
    module: 'notifications',
    label: 'Notification groups',
    columns: ['code', 'enabled', 'recipients'],
    example: { code: 'IT', enabled: 'true', recipients: 'it-admin@example.org' },
    description:
      'Replaces ADMIN or IT group recipients using semicolon-separated approved, verified staff addresses. Blank recipients clears the group. Uses existing recipient role checks.',
  },
  ...(['departments', 'locations'] as const).map((kind): Definition => ({
    module: `masters:${kind}`,
    label: kind === 'departments' ? 'Departments' : 'Locations',
    columns:
      kind === 'departments'
        ? ['action', 'code', 'version', 'name', 'active']
        : ['action', 'code', 'version', 'site', 'building', 'floor', 'room', 'active'],
    example:
      kind === 'departments'
        ? { action: 'CREATE', code: 'EXAMPLE_DEPT', name: 'Example department', active: 'true' }
        : { action: 'CREATE', code: 'EXAMPLE_LOC', site: 'Example site', active: 'true' },
    description:
      'CREATE adds a stable code; UPDATE requires the existing code and version. Blank optional cells are omitted. Codes are immutable.',
  })),
  ...masterKinds.map((kind): Definition => ({
    module: `masters:${kind.kind}`,
    label: kind.label,
    columns: kind.allowCreate
      ? ['action', 'code', 'version', 'label', 'active']
      : ['action', 'code', 'version', 'label'],
    example: kind.allowCreate
      ? { action: 'CREATE', code: 'EXAMPLE', label: 'Example option', active: 'true' }
      : {
          action: 'UPDATE',
          code:
            kind.kind === 'STATUS'
              ? 'In Store'
              : kind.kind === 'TICKET_STATUS'
                ? 'OPEN'
                : kind.kind === 'TICKET_PRIORITY'
                  ? 'LOW'
                  : 'Yes',
          version: '1',
          label: 'Approved display label',
        },
    description: kind.allowCreate
      ? 'CREATE or UPDATE a reference choice. UPDATE requires current version. Codes are immutable; deactivate retired choices to preserve history.'
      : 'UPDATE the label of an existing workflow code using its current version. Creating, removing or changing workflow behavior is prohibited.',
  })),
];
const inputSchema = z
  .object({
    module: text(100),
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\\/\u0000-\u001f\u007f]+\.(csv|xlsx)$/i),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((value) => value.toLowerCase()),
    reason: text(1000),
    sendEmails: z.boolean().default(false),
    rows: z
      .array(z.record(z.string().min(1).max(100), z.string().max(5000)))
      .min(1)
      .max(500),
  })
  .strict();

function required(row: Row, key: string): string {
  const value = row[key]?.trim();
  if (!value) throw new UnprocessableEntityException(`${key} is required`);
  return value;
}
function version(row: Row, key = 'version'): number {
  const value = required(row, key);
  if (!/^[1-9]\d{0,8}$/.test(value))
    throw new UnprocessableEntityException(`${key} must be a current positive integer`);
  return Number(value);
}
function boolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new UnprocessableEntityException('Boolean cells must contain true or false');
}
function list(value: string): string[] {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
}
function duplicateInvitationRows(module: string, rows: Row[]): Set<number> {
  const emails = new Set<string>();
  const duplicates = new Set<number>();
  if (module !== 'people') return duplicates;
  rows.forEach((row, index) => {
    if (row.action?.trim().toUpperCase() !== 'INVITE') return;
    const email = row.email?.trim().toLowerCase();
    if (!email) return;
    if (emails.has(email)) duplicates.add(index);
    emails.add(email);
  });
  return duplicates;
}
function safeError(error: unknown): string {
  if (error instanceof ZodError) return 'Review the row fields against the template';
  if (error instanceof HttpException && error.getStatus() < 500) {
    // Existing command messages are fixed server text, never raw database errors or row data.
    const response = error.getResponse();
    return typeof response === 'string'
      ? response
      : typeof (response as any)?.message === 'string'
        ? (response as any).message
        : 'Review the row fields against the template';
  }
  if ((error as any)?.code === '23505') return 'This record already exists';
  if (['23503', '23514', '22007', '22P02', '22008', '22003'].includes((error as any)?.code))
    return 'One or more row values are invalid';
  return 'The row could not be validated; retry or contact an Admin';
}
class PreviewRollback extends Error {}

@Injectable()
export class DataTransferService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(DomainService) private readonly domain: DomainService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  definitions(req: AuthRequest) {
    return {
      items: definitions.filter(
        (item) => item.module === 'tickets' || req.user.roles.includes('ADMIN'),
      ),
    };
  }
  private definition(req: AuthRequest, module: string) {
    const definition = definitions.find((item) => item.module === module);
    if (!definition) throw new UnprocessableEntityException('Unsupported transfer module');
    if (module !== 'tickets') requireRole(req, 'ADMIN');
    return definition;
  }
  private async currentActor(req: AuthRequest): Promise<AuthRequest> {
    // Hold account/session locks until this whole batch commits. Access changes use the same
    // user lock and cannot interleave between validation and business writes.
    const [user] = await this.db.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [req.user.id]);
    const [session] = await this.db.query(
      "SELECT * FROM sessions WHERE id_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() AND last_seen_at>now()-interval '30 minutes' FOR SHARE",
      [req.user.sessionHash, req.user.id],
    );
    if (!user || user.state !== 'ACTIVE' || !user.email_verified_at || !session)
      throw new UnauthorizedException('Sign in required');
    const roles = (
      await this.db.query('SELECT role_code FROM user_roles WHERE user_id=$1', [user.id])
    ).map((row) => row.role_code);
    if (
      session.scope !== 'APP' ||
      (roles.some((role) => ['ADMIN', 'IT_ADMIN', 'FINANCE', 'EXECUTIVE'].includes(role)) && !session.mfa_verified_at)
    )
      throw new HttpException('MFA verification is required', 403);
    if (!user.portal_accepted_at || user.portal_notice_version !== configuration().noticeVersion)
      throw new HttpException('Accept portal access first', 403);
    return {
      ...req,
      user: { ...req.user, roles, state: user.state, email: user.email },
      get: req.get.bind(req),
    } as AuthRequest;
  }
  private rowRequest(
    req: AuthRequest,
    batchId: string,
    rowNumber: number,
    currentVersion?: number,
  ): AuthRequest {
    return {
      ...req,
      user: req.user,
      get: (name: string) => {
        if (name.toLowerCase() === 'if-match')
          return currentVersion === undefined ? undefined : `"${currentVersion}"`;
        if (name.toLowerCase() === 'idempotency-key') return `transfer:${batchId}:${rowNumber}`;
        return req.get(name);
      },
    } as AuthRequest;
  }
  private async code(table: 'assets' | 'departments' | 'locations', code: string) {
    const [row] = await this.db.query(
      `SELECT * FROM ${table} WHERE ${table === 'assets' ? 'asset_code' : 'code'}=$1`,
      [code],
    );
    if (!row) throw new NotFoundException('Referenced record not found');
    return row;
  }
  private async departmentId(value: string): Promise<string> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      const [department] = await this.db.query(
        'SELECT id FROM departments WHERE id=$1 AND active=true',
        [value],
      );
      if (department) return department.id;
    } else {
      const matches = await this.db.query(
        'SELECT id FROM departments WHERE active=true AND (lower(code)=lower($1) OR lower(name)=lower($1)) LIMIT 2',
        [value],
      );
      if (matches.length === 1) return matches[0].id;
      if (matches.length > 1)
        throw new UnprocessableEntityException('Department value matches more than one department; use its UUID');
    }
    throw new NotFoundException('Department not found. Use an active department name, code or UUID.');
  }
  private async execute(
    req: AuthRequest,
    module: string,
    raw: Row,
    reason: string,
    batchId: string,
    rowNumber: number,
    sendEmails = false,
  ): Promise<RowResult> {
    const definition = this.definition(req, module);
    if (Object.keys(raw).some((key) => !definition.columns.includes(key)))
      throw new UnprocessableEntityException(
        'Unrecognized columns; use the current module template',
      );
    const row: Row = Object.fromEntries(
      Object.entries(raw)
        .filter(([, value]) => value.trim() !== '')
        .map(([key, value]) => [key, value.trim()]),
    );
    const action = row.action?.toUpperCase();
    if (action) row.action = action;
    let result: any;
    const request = (currentVersion?: number) =>
      this.rowRequest(req, batchId, rowNumber, currentVersion);
    if (module.startsWith('masters:')) {
      const kind = module.slice('masters:'.length);
      if (!['CREATE', 'UPDATE'].includes(action || ''))
        throw new UnprocessableEntityException('action must be CREATE or UPDATE');
      const code = required(row, 'code');
      const fields = Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !['action', 'code', 'version'].includes(key))
          .map(([key, value]) => [key, key === 'active' ? boolean(value) : value]),
      );
      if (action === 'CREATE') {
        if (row.version) throw new UnprocessableEntityException('CREATE must leave version blank');
        result = await this.domain.createMaster(request(), kind, { code, ...fields, reason });
      } else {
        const identifier = ['departments', 'locations'].includes(kind)
          ? (await this.code(kind as 'departments' | 'locations', code)).id
          : code;
        result = await this.domain.updateMaster(request(version(row)), kind, identifier, {
          ...fields,
          reason,
        });
      }
    } else if (module === 'assets') {
      if (!['CREATE', 'UPDATE'].includes(action || ''))
        throw new UnprocessableEntityException('action must be CREATE or UPDATE');
      const fields: Record<string, unknown> = Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !['action', 'assetCode', 'version', 'departmentCode', 'locationCode'].includes(key),
        ),
      );
      if (row.amcApplies) fields.amcApplies = boolean(row.amcApplies);
      if (row.usefulLifeYears) {
        if (!/^[1-9]\d{0,2}$/.test(row.usefulLifeYears))
          throw new UnprocessableEntityException('Invalid usefulLifeYears');
        fields.usefulLifeYears = Number(row.usefulLifeYears);
      }
      if (row.departmentCode)
        fields.departmentId = (await this.code('departments', row.departmentCode)).id;
      if (row.locationCode) fields.locationId = (await this.code('locations', row.locationCode)).id;
      if (action === 'CREATE') {
        if (row.assetCode)
          throw new UnprocessableEntityException(
            'Permanent Asset IDs from registers must use Import review; leave assetCode blank for new assets',
          );
        if (row.version) throw new UnprocessableEntityException('CREATE must leave version blank');
        result = await this.domain.createAsset(request(), fields);
      } else {
        const asset = await this.code('assets', required(row, 'assetCode'));
        result = await this.domain.editAsset(request(version(row)), asset.id, {
          ...fields,
          reason,
        });
      }
    } else if (module === 'people') {
      const email = parse(z.string().email().max(254), required(row, 'email')).toLowerCase();
      if (action === 'APPROVE') {
        if (Object.keys(row).some((key) => !['action', 'email'].includes(key)))
          throw new UnprocessableEntityException('This row includes employee details. Use INVITE to create an account; APPROVE accepts only an email.');
        result = await this.auth.approve(request(), { email });
      } else if (action === 'INVITE') {
        if (
          Object.keys(row).some(
            (key) => !['action', 'email', 'displayName', 'designation', 'departmentId', 'version', 'state', 'roles'].includes(key),
          )
        )
          throw new UnprocessableEntityException(
            'INVITE accepts email, employee name, designation, department, state and roles',
          );
        if (row.version)
          throw new UnprocessableEntityException('INVITE must leave version blank');
        if (row.state && !['ACTIVE', 'INVITED'].includes(row.state.toUpperCase()))
          throw new UnprocessableEntityException('For an invitation, state must be Active or Invited; the account stays invited until accepted');
        const roles = row.roles ? list(row.roles).map((value) => value.toUpperCase()) : [];
        if (roles.some((role) => role !== 'EMPLOYEE'))
          throw new UnprocessableEntityException('Bulk invitations grant Employee access only');
        result = await this.auth.invite(request(), {
          email,
          ...(row.displayName ? { displayName: row.displayName } : {}),
          ...(row.designation ? { designation: row.designation } : {}),
          ...(row.departmentId ? { departmentId: await this.departmentId(row.departmentId) } : {}),
          sendEmail: sendEmails,
        });
      } else if (action === 'UPDATE') {
        if (row.displayName)
          throw new UnprocessableEntityException('Account updates cannot change displayName');
        const [user] = await this.db.query('SELECT id FROM users WHERE email=$1', [email]);
        if (!user) throw new NotFoundException('Account not found');
        result = await this.auth.editUser(request(version(row)), user.id, {
          ...(row.state ? { state: row.state.toUpperCase() } : {}),
          ...(row.roles ? { roles: list(row.roles).map((role) => role.toUpperCase()) } : {}),
          ...(row.designation ? { designation: row.designation } : {}),
          ...(row.departmentId ? { departmentId: await this.departmentId(row.departmentId) } : {}),
          reason,
        });
        result.id = user.id;
      } else throw new UnprocessableEntityException('action must be APPROVE, INVITE or UPDATE');
    } else if (module === 'tickets') {
      const { assetCode, relatedTicketNumber, ...fields } = row;
      const body: Record<string, unknown> = { ...fields };
      if (assetCode) {
        const [asset] = await this.db.query(
          'SELECT a.id FROM assets a JOIN assignments s ON s.asset_id=a.id WHERE a.asset_code=$1 AND s.user_id=$2 AND s.ended_at IS NULL',
          [assetCode, req.user.id],
        );
        if (!asset) throw new NotFoundException('Record not found');
        body.assetId = asset.id;
      }
      if (relatedTicketNumber) {
        if (!/^[1-9]\d{0,15}$/.test(relatedTicketNumber))
          throw new UnprocessableEntityException('Invalid relatedTicketNumber');
        const [ticket] = await this.db.query(
          `SELECT id FROM tickets WHERE ticket_number=$1${staff(req.user) ? '' : ' AND reporter_id=$2'}`,
          staff(req.user) ? [relatedTicketNumber] : [relatedTicketNumber, req.user.id],
        );
        if (!ticket) throw new NotFoundException('Record not found');
        body.relatedTicketId = ticket.id;
      }
      result = await this.domain.createTicket(request(), body);
    } else if (module === 'assignments') {
      if (!['ASSIGN', 'TRANSFER', 'RETURN'].includes(action || ''))
        throw new UnprocessableEntityException('action must be ASSIGN, TRANSFER or RETURN');
      const asset = await this.code('assets', required(row, 'assetCode'));
      const assetVersion = version(row, 'assetVersion');
      // Also protect RETURN against changes to the asset since the exported snapshot.
      await this.db.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE', [asset.id]);
      const [currentAsset] = await this.db.query('SELECT version FROM assets WHERE id=$1', [
        asset.id,
      ]);
      if (currentAsset.version !== assetVersion)
        throw new HttpException('This record changed. Refresh and try again.', 412);
      const [assignment] = await this.db.query(
        'SELECT * FROM assignments WHERE asset_id=$1 AND ended_at IS NULL',
        [asset.id],
      );
      if (action !== 'ASSIGN') {
        if (!assignment) throw new ConflictException('There is no current custody');
        if (assignment.version !== version(row, 'assignmentVersion'))
          throw new HttpException('This record changed. Refresh and try again.', 412);
      } else if (row.assignmentVersion || row.condition || row.locationCode)
        throw new UnprocessableEntityException(
          'ASSIGN accepts asset, employee and optional note only',
        );
      if (action === 'RETURN') {
        if (row.employeeEmail || row.note)
          throw new UnprocessableEntityException(
            'RETURN accepts condition and optional location only',
          );
        result = await this.domain.returnAsset(request(assignment.version), assignment.id, {
          reason,
          condition: required(row, 'condition'),
          ...(row.locationCode
            ? { locationId: (await this.code('locations', row.locationCode)).id }
            : {}),
        });
      } else {
        if (row.condition || row.locationCode)
          throw new UnprocessableEntityException(
            'Assignment does not change condition or location',
          );
        const email = parse(
          z.string().email().max(254),
          required(row, 'employeeEmail'),
        ).toLowerCase();
        const [user] = await this.db.query(
          'SELECT u.id FROM users u JOIN approved_emails a ON a.email=u.email WHERE u.email=$1',
          [email],
        );
        if (!user) throw new UnprocessableEntityException('Employee must have an approved account');
        result = await this.domain.assign(
          request(assetVersion),
          asset.id,
          {
            userId: user.id,
            ...(row.note ? { note: row.note } : {}),
            ...(action === 'TRANSFER' ? { reason } : {}),
          },
          action === 'TRANSFER',
          { sendEmail: sendEmails, allowInvited: true },
        );
      }
    } else {
      result = await this.domain.updateGroup(request(), required(row, 'code'), {
        enabled: boolean(required(row, 'enabled')),
        recipients: list(row.recipients || ''),
      });
    }
    return {
      rowNumber,
      ...(result?.id ? { id: result.id } : {}),
      summary:
        module === 'people' && action === 'INVITE'
          ? 'Employee invitation; account remains invited until accepted'
          : `${definition.label}: ${action || (module === 'tickets' ? 'CREATE' : 'UPDATE')}`,
    };
  }
  async preview(req: AuthRequest, body: unknown) {
    const input = parse(inputSchema, body);
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 6 * 1024 * 1024)
      throw new UnprocessableEntityException('Transfer requests must not exceed 6 MiB');
    const definition = this.definition(req, input.module);
    if (input.rows.some((row) => Object.keys(row).some((key) => !definition.columns.includes(key))))
      throw new UnprocessableEntityException(
        'Unrecognized columns; use the current module template',
      );
    const batchId = randomUUID();
    const duplicateInvitations = duplicateInvitationRows(input.module, input.rows);
    const rows: { rowNumber: number; valid: boolean; errors: string[]; summary: string }[] = [];
    // Reuse real commands under savepoints, then roll back ALL business records, tokens,
    // outbox and audits. PostgreSQL sequence values may advance and are never rewound.
    try {
      await this.db.tx(async () => {
        let actor = await this.currentActor(req);
        for (let i = 0; i < input.rows.length; i++) {
          try {
            if (duplicateInvitations.has(i))
              throw new UnprocessableEntityException(
                'An invitation email appears more than once in this batch',
              );
            const result = await this.db.tx(async () => {
              actor = await this.currentActor(req);
              return this.execute(
                actor,
                input.module,
                input.rows[i]!,
                input.reason,
                batchId,
                i + 1,
                input.sendEmails,
              );
            });
            rows.push({ rowNumber: i + 1, valid: true, errors: [], summary: result.summary });
          } catch (error) {
            rows.push({
              rowNumber: i + 1,
              valid: false,
              errors: [safeError(error)],
              summary: 'Row requires correction',
            });
          }
        }
        throw new PreviewRollback();
      });
    } catch (error) {
      if (!(error instanceof PreviewRollback)) throw error;
    }
    const preview = {
      id: batchId,
      module: input.module,
      rowCount: input.rows.length,
      valid: rows.every((row) => row.valid),
      rows,
      warnings: [
        'Preview writes are rolled back. Sequence numbers may be reserved and are never reused.',
        input.sendEmails
          ? 'Email is on: invitations and assignment notices may be sent when you confirm.'
          : 'Email is off: invitations and assignment notices are not sent. You can invite these accounts later.',
        'Blank optional cells do not clear existing values.',
      ],
    };
    await this.db.tx(async (client) => {
      const actor = await this.currentActor(req);
      this.definition(actor, input.module);
      await this.db.query(
        'INSERT INTO data_transfers(id,actor_id,module,source_filename,source_sha256,raw_rows,reason,preview,send_emails) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          batchId,
          actor.user.id,
          input.module,
          input.filename,
          input.sha256,
          JSON.stringify(input.rows),
          input.reason,
          JSON.stringify(preview),
          input.sendEmails,
        ],
        client,
      );
      await this.db.audit(client, actor.user, 'data_transfer', batchId, 'TRANSFER_PREVIEWED', {
        module: input.module,
        rowCount: input.rows.length,
        valid: preview.valid,
        sourceSha256: input.sha256,
      });
    });
    return preview;
  }
  async commit(req: AuthRequest, batchId: string, body: unknown) {
    parse(uuid, batchId);
    parse(z.object({ confirmed: z.literal(true) }).strict(), body);
    return this.db.tx(async (client) => {
      let actor = await this.currentActor(req);
      const [batch] = await this.db.query(
        'SELECT * FROM data_transfers WHERE id=$1 AND actor_id=$2 FOR UPDATE',
        [batchId, actor.user.id],
        client,
      );
      if (!batch) throw new NotFoundException('Transfer preview not found');
      this.definition(actor, batch.module);
      if (batch.state === 'COMMITTED') return batch.receipt;
      if (new Date(batch.expires_at).getTime() <= Date.now())
        throw new ConflictException('Transfer preview expired; create a new preview');
      if (!Array.isArray(batch.preview.rows) || batch.preview.rows.length !== batch.raw_rows.length)
        throw new ConflictException('The import preview is incomplete; validate the file again');
      const skippedCount = batch.preview.rows.filter((row: { valid?: boolean }) => !row.valid).length;
      if (!batch.preview.rows.some((row: { valid?: boolean }) => row.valid))
        throw new ConflictException('There are no valid rows to import; correct the file and validate again');
      const results: RowResult[] = [];
      for (let i = 0; i < batch.raw_rows.length; i++) {
        // Keep bad rows out of the transaction. A later import can apply them after correction.
        if (!batch.preview.rows[i]?.valid) continue;
        actor = await this.currentActor(req);
        try {
          results.push(
            await this.execute(
              actor,
              batch.module,
              batch.raw_rows[i],
              batch.reason,
              batchId,
              i + 1,
              batch.send_emails,
            ),
          );
        } catch (error) {
          if (error instanceof HttpException && [401, 403].includes(error.getStatus())) throw error;
          throw new ConflictException(`Row ${i + 1}: ${safeError(error)}. No rows were applied.`);
        }
      }
      const receipt = { id: batchId, state: 'COMMITTED', rowCount: results.length, skippedCount, results };
      await this.db.query(
        "UPDATE data_transfers SET state='COMMITTED',committed_at=now(),receipt=$2 WHERE id=$1",
        [batchId, JSON.stringify(receipt)],
        client,
      );
      await this.db.audit(client, actor.user, 'data_transfer', batchId, 'TRANSFER_COMMITTED', {
        module: batch.module,
        rowCount: results.length,
        skippedCount,
        sourceSha256: batch.source_sha256,
        reason: batch.reason,
      });
      return receipt;
    });
  }
}

@Controller('transfers')
@UseGuards(SessionGuard)
export class DataTransferController {
  constructor(@Inject(DataTransferService) private readonly service: DataTransferService) {}
  @Get('definitions') definitions(@Req() req: AuthRequest) {
    return this.service.definitions(req);
  }
  @Post('preview') preview(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.preview(req, body);
  }
  @Post(':id/commit') commit(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.commit(req, id, body);
  }
}
