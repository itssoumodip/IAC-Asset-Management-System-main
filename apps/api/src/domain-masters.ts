import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { AuthRequest, assertVersion } from './security';
import { assertCan } from './policy';
import { camel, found, id, parse, text } from './domain-helpers';
import {
  createTeamOrProject,
  isTeamMasterKind,
  setRequiresCustodian,
  setTicketCategoryTeam,
  teamAndProjectLists,
  updateTeamOrProject,
} from './master-teams';

const editable = [
  ['CATEGORY', 'Asset categories'],
  ['ASSET_TYPE', 'Asset types'],
  ['OWNERSHIP', 'Ownership types'],
  ['CONDITION', 'Conditions'],
  ['RISK', 'Risk levels'],
  ['DEPRECIATION_METHOD', 'Depreciation methods'],
  ['DISPOSAL_METHOD', 'Disposal methods'],
  ['COMMENT_TYPE', 'Comment types'],
  ['TICKET_CATEGORY', 'Ticket categories'],
] as const;
const fixed = [
  ['STATUS', 'Asset statuses'],
  ['TICKET_STATUS', 'Ticket statuses'],
  ['TICKET_PRIORITY', 'Ticket priorities'],
  ['DATA_WIPE', 'Data wipe requirements'],
] as const;
export const masterKinds = [
  ...editable.map(([kind, label]) => ({
    kind,
    label,
    mode: 'EDITABLE',
    allowCreate: true,
    allowDeactivate: true,
    description: 'Stable codes with editable labels. Inactive values remain in historical records.',
  })),
  ...fixed.map(([kind, label]) => ({
    kind,
    label,
    mode: 'FIXED',
    allowCreate: false,
    allowDeactivate: false,
    description: 'Display labels are editable; codes and active workflow behavior are fixed.',
  })),
];
const codeInput = text(100).regex(
  /^[^\u0000-\u001f\u007f]+$/,
  'Code cannot contain control characters',
);
const referenceIdentifier = text(1000).regex(
  /^[^\u0000-\u001f\u007f]+$/,
  'Code cannot contain control characters',
);
const reasonInput = text(1000);
const optionalPlace = text(150).nullable().optional();
const departmentCreate = z
  .object({
    code: codeInput,
    name: text(150),
    active: z.boolean().default(true),
    reason: reasonInput,
  })
  .strict();
const departmentPatch = departmentCreate
  .omit({ code: true, reason: true })
  .partial()
  .extend({ active: z.boolean().optional(), reason: reasonInput })
  .strict();
const locationCreate = z
  .object({
    code: codeInput,
    site: text(150),
    building: optionalPlace,
    floor: optionalPlace,
    room: optionalPlace,
    active: z.boolean().default(true),
    reason: reasonInput,
  })
  .strict();
const locationPatch = locationCreate
  .omit({ code: true, reason: true })
  .partial()
  .extend({ active: z.boolean().optional(), reason: reasonInput })
  .strict();
const referenceCreate = z
  .object({
    code: codeInput,
    label: text(150),
    active: z.boolean().default(true),
    reason: reasonInput,
  })
  .strict();
const referencePatch = referenceCreate
  .omit({ code: true, reason: true })
  .partial()
  .extend({ active: z.boolean().optional(), reason: reasonInput })
  .strict();

export class MasterDomain {
  constructor(protected readonly db: Db) {}
  async references() {
    const [values, departments, locations] = await Promise.all([
      this.db.query(
        'SELECT kind,code,label,active,version FROM reference_values ORDER BY kind,label,code',
      ),
      this.db.query('SELECT id,code,name,active,version FROM departments ORDER BY name,code'),
      this.db.query(
        'SELECT id,code,site,building,floor,room,active,version FROM locations ORDER BY code',
      ),
    ]);
    return { values, departments, locations, ...(await teamAndProjectLists(this.db)) };
  }
  async setTicketCategoryTeam(req: AuthRequest, category: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    return this.db.tx((c) => setTicketCategoryTeam(this.db, req, parse(referenceIdentifier, category), body, c));
  }
  async masterData(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    return { kinds: masterKinds, ...(await this.references()) };
  }
  private kind(kind: string) {
    const entry = masterKinds.find((item) => item.kind === kind);
    if (!entry) throw new UnprocessableEntityException('Invalid master kind');
    return entry;
  }
  private async lock(c: PoolClient) {
    // Serialize master writers so case-insensitive code/label duplicate checks cannot race.
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('iac-master-data',0))",
      [],
      c,
    );
  }
  private async duplicate(
    c: PoolClient,
    table: 'reference_values' | 'departments' | 'locations',
    code: string,
    label: string | null,
    kind?: string,
    exclude?: string,
  ) {
    const rows =
      table === 'reference_values'
        ? await this.db.query(
            'SELECT code FROM reference_values WHERE kind=$1 AND ($4::text IS NULL OR code<>$4) AND (lower(btrim(code))=lower($2) OR lower(btrim(label))=lower($3))',
            [kind, code, label, exclude ?? null],
            c,
          )
        : table === 'departments'
          ? await this.db.query(
              'SELECT code FROM departments WHERE ($3::text IS NULL OR code<>$3) AND (lower(btrim(code))=lower($1) OR lower(btrim(name))=lower($2))',
              [code, label, exclude ?? null],
              c,
            )
          : await this.db.query(
              'SELECT code FROM locations WHERE ($2::text IS NULL OR code<>$2) AND lower(btrim(code))=lower($1)',
              [code, exclude ?? null],
              c,
            );
    if (rows.length)
      throw new ConflictException(
        'This master code or label already exists; reactivate the existing record if needed',
      );
  }
  async createMaster(req: AuthRequest, kind: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    if (isTeamMasterKind(kind))
      return this.db.tx(async (c) => {
        await this.lock(c);
        return createTeamOrProject(this.db, req, kind, body, c);
      });
    if (kind === 'departments' || kind === 'locations') {
      const data = (
        kind === 'departments' ? parse(departmentCreate, body) : parse(locationCreate, body)
      ) as any;
      const { reason, ...changes } = data;
      return this.db.tx(async (c) => {
        await this.lock(c);
        await this.duplicate(c, kind, data.code, data.name ?? null);
        const keys =
          kind === 'departments'
            ? ['code', 'name', 'active']
            : ['code', 'site', 'building', 'floor', 'room', 'active'];
        const [row] = await this.db.query(
          `INSERT INTO ${kind}(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
          keys.map((key) => changes[key] ?? null),
          c,
        );
        await this.db.audit(
          c,
          req.user,
          kind === 'departments' ? 'department' : 'location',
          row.id,
          'MASTER_CREATED',
          { reason, after: camel(row) },
        );
        return camel(row);
      });
    }
    const definition = this.kind(kind);
    if (!definition.allowCreate)
      throw new ConflictException('Workflow codes are fixed; edit an existing display label');
    const { reason, ...data } = parse(referenceCreate, body);
    return this.db.tx(async (c) => {
      await this.lock(c);
      await this.duplicate(c, 'reference_values', data.code, data.label, kind);
      const [row] = await this.db.query(
        'INSERT INTO reference_values(kind,code,label,active) VALUES($1,$2,$3,$4) RETURNING kind,code,label,active,version',
        [kind, data.code, data.label, data.active],
        c,
      );
      await this.db.audit(c, req.user, 'reference', null, 'MASTER_CREATED', {
        kind,
        code: data.code,
        reason,
        after: row,
      });
      return row;
    });
  }
  async updateMaster(
    req: AuthRequest,
    kind: string,
    identifier: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    assertCan(req.user, 'system.admin');
    if (isTeamMasterKind(kind))
      return this.db.tx(async (c) => {
        await this.lock(c);
        return updateTeamOrProject(this.db, req, kind, identifier, body, c);
      });
    if (kind === 'ASSET_TYPE' && body && typeof body === 'object' && 'requiresCustodian' in body) {
      const { requiresCustodian, ...rest } = body as Record<string, unknown>;
      const code = parse(referenceIdentifier, identifier);
      const why = parse(reasonInput, rest.reason);
      const onlyPolicy = Object.keys(rest).every((key) => key === 'reason');
      const result: Record<string, unknown> | undefined = onlyPolicy
        ? undefined
        : await this.updateMaster(req, kind, identifier, rest);
      return this.db.tx(async (c) => ({
        ...(result ?? { kind, code }),
        requiresCustodian: await setRequiresCustodian(
          this.db,
          req,
          code,
          requiresCustodian,
          why,
          c,
        ),
      }));
    }
    if (kind === 'departments' || kind === 'locations') {
      id(identifier);
      const { reason, ...changes } = (
        kind === 'departments' ? parse(departmentPatch, body) : parse(locationPatch, body)
      ) as any;
      if (!Object.keys(changes).length)
        throw new UnprocessableEntityException('Supply a master change');
      return this.db.tx(async (c) => {
        await this.lock(c);
        const before = found(
          (await this.db.query(`SELECT * FROM ${kind} WHERE id=$1 FOR UPDATE`, [identifier], c))[0],
        );
        assertVersion(req, before.version);
        if (kind === 'departments' && changes.name !== undefined && changes.name !== before.name)
          await this.duplicate(c, kind, before.code, changes.name, undefined, before.code);
        const entries = Object.entries(changes);
        const values: unknown[] = entries.map(([, v]) => v);
        values.push(identifier);
        const [after] = await this.db.query(
          `UPDATE ${kind} SET ${entries.map(([key], i) => key + '=$' + (i + 1)).join(',')},version=version+1,updated_at=now() WHERE id=$${values.length} RETURNING *`,
          values,
          c,
        );
        await this.db.audit(
          c,
          req.user,
          kind === 'departments' ? 'department' : 'location',
          before.id,
          'MASTER_UPDATED',
          { reason, before: camel(before), after: camel(after) },
        );
        return camel(after);
      });
    }
    const definition = this.kind(kind);
    const code = parse(referenceIdentifier, identifier);
    const { reason, ...changes } = parse(referencePatch, body);
    if (!Object.keys(changes).length)
      throw new UnprocessableEntityException('Supply a master change');
    if (!definition.allowDeactivate && changes.active === false)
      throw new ConflictException('Workflow choices must remain active');
    return this.db.tx(async (c) => {
      await this.lock(c);
      const before = found(
        (
          await this.db.query(
            'SELECT kind,code,label,active,version FROM reference_values WHERE kind=$1 AND code=$2 FOR UPDATE',
            [kind, code],
            c,
          )
        )[0],
      );
      assertVersion(req, before.version);
      if (changes.label !== undefined && changes.label !== before.label)
        await this.duplicate(c, 'reference_values', code, changes.label, kind, code);
      const [after] = await this.db.query(
        'UPDATE reference_values SET label=$3,active=$4,version=version+1,updated_at=now() WHERE kind=$1 AND code=$2 RETURNING kind,code,label,active,version',
        [kind, code, changes.label ?? before.label, changes.active ?? before.active],
        c,
      );
      await this.db.audit(c, req.user, 'reference', null, 'MASTER_UPDATED', {
        kind,
        code,
        reason,
        before,
        after,
      });
      return after;
    });
  }
  async referenceUpdate(req: AuthRequest, kind: string, code: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    this.kind(kind);
    parse(referenceIdentifier, code);
    // Preserve the compatibility route while using the same allowlist, audit and version checks.
    const [existing] = await this.db.query(
      'SELECT code FROM reference_values WHERE kind=$1 AND code=$2',
      [kind, code],
    );
    return existing
      ? this.updateMaster(req, kind, code, body)
      : this.createMaster(req, kind, { ...(typeof body === 'object' && body ? body : {}), code });
  }
}
