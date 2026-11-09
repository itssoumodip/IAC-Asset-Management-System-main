import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Put,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';

const fieldName = text(100).regex(/^[a-z][a-zA-Z0-9_]{1,79}$/, 'Invalid field name');

const roleFieldInput = z
  .object({
    roleCode: text(100),
    fieldName,
    canView: z.boolean().default(true),
    canEdit: z.boolean().default(false),
  })
  .strict();

const roleFieldBatch = z
  .object({
    permissions: z.array(roleFieldInput).min(1).max(500),
    reason: text(1000),
  })
  .strict();

/** Fields the asset screens cannot work without; never hidden or locked by role settings. */
const ESSENTIAL_FIELDS = new Set(['id', 'version', 'assetCode']);

/**
 * Field restrictions for an actor from the Field permissions page.
 * A field is restricted only when EVERY one of the actor's roles has a saved row denying it,
 * so a role without settings keeps today's access. Super Admin is never restricted.
 */
export async function assetFieldRestrictions(
  db: Db,
  actor: { roles: string[]; teams?: { level: string }[] },
  client?: PoolClient,
): Promise<{ hidden: Set<string>; locked: Set<string> }> {
  const hidden = new Set<string>();
  const locked = new Set<string>();
  // Team Lead / Team Member are team levels, not login roles; they count as roles here so a
  // team member keeps the access the Field permissions page gives Team Member.
  const levels = (actor.teams ?? []).map((t) => (t.level === 'LEAD' ? 'TEAM_LEAD' : 'TEAM_MEMBER'));
  const roles = [...new Set([...(actor.roles ?? []), ...levels])];
  if (!roles.length || roles.includes('SUPER_ADMIN')) return { hidden, locked };
  const rows: { field_name: string; denied_view: number; denied_edit: number }[] = await db.query(
    `SELECT field_name,
            count(*) FILTER (WHERE NOT can_view)::int AS denied_view,
            count(*) FILTER (WHERE NOT can_edit)::int AS denied_edit
       FROM role_field_permissions
      WHERE role_code = ANY($1::text[])
      GROUP BY field_name`,
    [roles],
    client,
  );
  for (const row of rows) {
    if (ESSENTIAL_FIELDS.has(row.field_name)) continue;
    if (row.denied_view === roles.length) hidden.add(row.field_name);
    if (row.denied_edit === roles.length) locked.add(row.field_name);
  }
  return { hidden, locked };
}

/** Removes hidden fields from asset objects in place (camelCase keys). */
export function stripHiddenFields<T extends Record<string, unknown>>(
  items: T[],
  hidden: Set<string>,
) {
  if (!hidden.size) return;
  for (const item of items) for (const field of hidden) delete item[field];
}

export class RoleFieldService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async allFields(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    const rows = await this.db.query(
      `SELECT role_code AS "roleCode", field_name AS "fieldName", can_view AS "canView", can_edit AS "canEdit", updated_at AS "updatedAt"
       FROM role_field_permissions ORDER BY role_code, field_name`,
    );
    const byRole = new Map<string, { roleCode: string; fields: any[] }>();
    for (const row of rows) {
      let group = byRole.get(row.roleCode);
      if (!group) {
        group = { roleCode: row.roleCode, fields: [] };
        byRole.set(row.roleCode, group);
      }
      group.fields.push(camel(row));
    }
    return { permissions: Array.from(byRole.values()) };
  }

  async updateFields(req: AuthRequest, body: unknown) {
    assertCan(req.user, 'system.admin');
    const { permissions, reason } = parse(roleFieldBatch, body);

    // Validate role codes exist
    const roleCodes = [...new Set(permissions.map((p) => p.roleCode))];
    const existingRoles = await this.db.query(`SELECT code FROM roles WHERE code=ANY($1::text[])`, [
      roleCodes,
    ]);
    if (existingRoles.length !== roleCodes.length) {
      const found = new Set(existingRoles.map((r) => r.code));
      const missing = roleCodes.filter((c) => !found.has(c));
      throw new UnprocessableEntityException(`Unknown role codes: ${missing.join(', ')}`);
    }

    // Validate field names are unique per role
    for (const roleCode of roleCodes) {
      const rolePerms = permissions.filter((p) => p.roleCode === roleCode);
      const fieldNames = rolePerms.map((p) => p.fieldName);
      if (new Set(fieldNames).size !== fieldNames.length) {
        throw new ConflictException(`Duplicate field names for role ${roleCode}`);
      }
    }

    return this.db.tx(async (c) => {
      for (const perm of permissions) {
        await this.db.query(
          `INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit, updated_by, updated_at)
           VALUES($1,$2,$3,$4,$5,now())
           ON CONFLICT (role_code, field_name) DO UPDATE SET
             can_view=EXCLUDED.can_view,
             can_edit=EXCLUDED.can_edit,
             updated_by=EXCLUDED.updated_by,
             updated_at=now()`,
          [perm.roleCode, perm.fieldName, perm.canView, perm.canEdit, req.user.id],
          c,
        );
      }
      await this.db.audit(c, req.user, 'role_field_permissions', null, 'ROLE_FIELDS_UPDATED', {
        reason,
        count: permissions.length,
      });
      return { updated: permissions.length };
    });
  }
}

@Controller('admin/roles')
@UseGuards(SessionGuard)
export class RoleFieldController {
  constructor(@Inject(RoleFieldService) private readonly service: RoleFieldService) {}

  @Get('fields')
  allFields(@Req() req: AuthRequest) {
    return this.service.allFields(req);
  }

  @Put('fields')
  updateFields(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.updateFields(req, body);
  }
}
