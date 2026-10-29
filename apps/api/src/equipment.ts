import {
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { AuthRequest, SessionGuard, requireRole } from './security';
import { camel } from './domain-helpers';
const paging = z
  .object({
    q: z.string().trim().max(100).optional(),
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
@Injectable()
export class EquipmentService {
  constructor(@Inject(Db) private readonly db: Db) {}
  async people(req: AuthRequest, query: unknown) {
    requireRole(req, 'ADMIN', 'FINANCE');
    const p = paging.parse(query),
      values: any[] = [],
      where = [
        `EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='EMPLOYEE')`,
      ];
    if (p.q) {
      values.push(p.q);
      where.push(
        `(strpos(lower(u.display_name),lower($${values.length}))>0 OR strpos(lower(u.email),lower($${values.length}))>0 OR strpos(lower(coalesce(u.employee_reference,'')),lower($${values.length}))>0)`,
      );
    }
    if (p.after) {
      values.push(p.after);
      where.push(`u.id>$${values.length}::uuid`);
    }
    values.push(p.limit + 1);
    const rows = await this.db.query(
      `SELECT u.id,u.display_name,u.email,u.designation,u.employee_reference,u.state,d.name AS department,
    (SELECT count(*)::int FROM assignments s WHERE s.user_id=u.id AND s.ended_at IS NULL) AS equipment_count,
    (SELECT count(*)::int FROM assignments s WHERE s.user_id=u.id AND s.ended_at IS NULL AND s.acknowledgement='PENDING') AS pending_acknowledgements
    FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE ${where.join(' AND ')} ORDER BY u.id LIMIT $${values.length}`,
      values,
    );
    return {
      items: rows.slice(0, p.limit).map(camel),
      nextCursor: rows.length > p.limit ? rows[p.limit - 1].id : null,
    };
  }
  async person(req: AuthRequest, value: string, query: unknown) {
    const id = z.string().uuid().parse(value),
      isAdmin = req.user.roles.includes('ADMIN'),
      isFinance = req.user.roles.includes('FINANCE');
    if (!isAdmin && !isFinance && !(req.user.roles.includes('EMPLOYEE') && req.user.id === id))
      throw new ForbiddenException('You can only view your own equipment');
    const p = z
      .object({
        after: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(query);
    return this.db.tx(async () => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [person] = await this.db.query(
        `SELECT u.id,u.display_name,u.email,u.designation,u.employee_reference,u.state,d.name AS department FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`,
        [id],
      );
      if (!person) throw new NotFoundException('Person not found');
      const values: any[] = [id];
      let after = '';
      if (p.after) {
        values.push(p.after);
        after = ' AND a.asset_code>$2';
      }
      values.push(p.limit + 1);
      const [summary] = await this.db.query(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE s.acknowledgement='PENDING')::int AS pending_acknowledgements,count(*) FILTER(WHERE s.acknowledgement='DISPUTED')::int AS disputed FROM assignments s WHERE s.user_id=$1 AND s.ended_at IS NULL`,
        [id],
      );
      const rows = await this.db.query(
        `SELECT a.id,a.asset_code,a.asset_type,a.description,a.serial_number,a.manufacturer,a.model,a.condition,a.status,l.site AS location_site,l.room AS location_room,
    s.id AS assignment_id,s.assigned_at,s.acknowledgement,s.version AS assignment_version,a.version AS asset_version${isFinance ? ',a.purchase_cost,f.state AS finance_state,f.approved_cost,f.approved_at' : ''}
    FROM assignments s JOIN assets a ON a.id=s.asset_id LEFT JOIN locations l ON l.id=a.location_id ${isFinance ? 'LEFT JOIN asset_finance f ON f.asset_id=a.id' : ''} WHERE s.user_id=$1 AND s.ended_at IS NULL${after} ORDER BY a.asset_code LIMIT $${values.length}`,
        values,
      );
      // Current equipment only; closed custody remains on the individual asset audit trail.
      return {
        person: camel(person),
        summary: camel(summary),
        items: rows.slice(0, p.limit).map(camel),
        nextCursor: rows.length > p.limit ? rows[p.limit - 1].asset_code : null,
      };
    });
  }
}
@Controller('equipment')
@UseGuards(SessionGuard)
export class EquipmentController {
  constructor(@Inject(EquipmentService) private readonly service: EquipmentService) {}
  @Get('people') people(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.service.people(req, query);
  }
  @Get('people/:id') person(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.service.person(req, id, query);
  }
}
