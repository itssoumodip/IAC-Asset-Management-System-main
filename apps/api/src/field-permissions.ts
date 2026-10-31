import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import {
  ASSET_PERMISSION_FIELDS,
  FIELD_PERMISSION_ROLES,
  assertCan,
} from './policy';
import { AuthRequest, SessionGuard } from './security';
import { camel, parse, text } from './domain-helpers';

const role = z.enum(FIELD_PERMISSION_ROLES);
const updateInput = z
  .object({
    fields: z
      .array(
        z.object({
          name: z.enum(ASSET_PERMISSION_FIELDS),
          view: z.boolean(),
          edit: z.boolean(),
        }),
      )
      .max(ASSET_PERMISSION_FIELDS.length),
    reason: text(1000),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.fields.map((field) => field.name);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', path: ['fields'], message: 'Duplicate fields are not allowed' });
    if (value.fields.some((field) => field.edit && !field.view))
      context.addIssue({ code: 'custom', path: ['fields'], message: 'Editable fields must be visible' });
  });

@Injectable()
export class FieldPermissionService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest) {
    assertCan(req.user, 'system.admin');
    const rows = await this.db.query(
      `SELECT role_code,field_name,can_view,can_edit
       FROM role_field_permissions
       WHERE role_code=ANY($1::text[])
       ORDER BY role_code,field_name`,
      [FIELD_PERMISSION_ROLES],
    );
    return {
      roles: FIELD_PERMISSION_ROLES,
      fields: ASSET_PERMISSION_FIELDS,
      permissions: rows.map(camel),
    };
  }

  async update(req: AuthRequest, roleCode: string, body: unknown) {
    assertCan(req.user, 'system.admin');
    const roleValue = parse(role, roleCode);
    const input = parse(updateInput, body);
    return this.db.tx(async (client) => {
      await this.db.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['iac-field-permissions'],
        client,
      );
      await this.db.query('DELETE FROM role_field_permissions WHERE role_code=$1', [roleValue], client);
      for (const field of input.fields)
        await this.db.query(
          `INSERT INTO role_field_permissions(role_code,field_name,can_view,can_edit,updated_by)
           VALUES($1,$2,$3,$4,$5)`,
          [roleValue, field.name, field.view, field.edit, req.user.id],
          client,
        );
      await this.db.audit(client, req.user, 'role_field_permissions', null, 'UPDATED', {
        role: roleValue,
        reason: input.reason,
        fields: input.fields,
      });
      return { role: roleValue, fields: input.fields };
    });
  }
}

@Controller('field-permissions')
@UseGuards(SessionGuard)
export class FieldPermissionController {
  constructor(@Inject(FieldPermissionService) private readonly service: FieldPermissionService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.service.list(req);
  }

  @Put(':role')
  update(@Req() req: AuthRequest, @Param('role') roleCode: string, @Body() body: unknown) {
    return this.service.update(req, roleCode, body);
  }
}
