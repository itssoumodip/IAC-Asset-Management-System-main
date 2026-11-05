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
    const existingRoles = await this.db.query(
      `SELECT code FROM roles WHERE code=ANY($1::text[])`,
      [roleCodes],
    );
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
      await this.db.audit(
        c,
        req.user,
        'role_field_permissions',
        null,
        'ROLE_FIELDS_UPDATED',
        { reason, count: permissions.length },
      );
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
