import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { camel, id, parse } from './domain-helpers';
import { assertCan, can } from './policy';
import { AuthRequest, SessionGuard } from './security';

const LIMIT = 25;
const query = z
  .object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().max(1000).optional(),
    // The assign screens send limit; accept it rather than failing the whole search.
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** People who can be given custody of an asset (mirrors eligibleEmployee in domain-helpers). */
@Injectable()
export class PeopleService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async assignable(req: AuthRequest, assetId: string, raw: unknown) {
    id(assetId);
    const input = parse(query, raw ?? {});
    const [asset] = await this.db.query('SELECT owning_team_id FROM assets WHERE id=$1', [assetId]);
    if (!asset) throw new NotFoundException();
    assertCan(req.user, 'asset.custody', asset.owning_team_id);
    return this.search(input);
  }

  /** Same search without an asset, for the Store "Issue to user" form. */
  async assignableAnywhere(req: AuthRequest, raw: unknown) {
    const input = parse(query, raw ?? {});
    if (!can(req.user, 'store.operations') && !can(req.user, 'asset.custody'))
      throw new ForbiddenException('Insufficient permission');
    return this.search(input);
  }

  private async search(input: z.infer<typeof query>) {
    let after: [string, string] | null = null;
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          decoded.some((x) => typeof x !== 'string' || x.length > 200)
        )
          throw Error();
        after = decoded as [string, string];
        id(after[1]);
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
    }
    const values: any[] = [];
    const where = [
      `EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role_code='EMPLOYEE')`,
      `u.merged_into_user_id IS NULL`,
      `((u.state='DIRECTORY' AND u.left_at IS NULL) OR (u.state='ACTIVE' AND u.email_verified_at IS NOT NULL AND u.portal_accepted_at IS NOT NULL))`,
    ];
    if (input.q) {
      values.push(input.q);
      const n = values.length;
      where.push(
        `(strpos(lower(u.display_name),lower($${n}))>0 OR strpos(lower(u.email),lower($${n}))>0 OR strpos(lower(coalesce(u.employee_code,'')),lower($${n}))>0)`,
      );
    }
    if (after) {
      values.push(after[0], after[1]);
      where.push(`(u.display_name,u.id)>($${values.length - 1}::text,$${values.length}::uuid)`);
    }
    const limit = input.limit ?? LIMIT;
    values.push(limit + 1);
    const rows = await this.db.query(
      `SELECT u.id,u.display_name,u.email,u.employee_code,u.designation,d.name AS department,u.state,
              EXISTS(SELECT 1 FROM user_photos p WHERE p.user_id=u.id) AS has_photo
       FROM users u LEFT JOIN departments d ON d.id=u.department_id
       WHERE ${where.join(' AND ')} ORDER BY u.display_name,u.id LIMIT $${values.length}`,
      values,
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(camel),
      nextCursor: more
        ? Buffer.from(JSON.stringify([last.display_name, last.id])).toString('base64url')
        : null,
    };
  }
}

@Controller('assets')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Get(':id/assignable-people')
  assignable(@Req() req: AuthRequest, @Param('id') assetId: string, @Query() q: unknown) {
    return this.service.assignable(req, assetId, q);
  }
}

@Controller('assignable-people')
@UseGuards(SessionGuard)
export class AssignablePeopleController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Get()
  search(@Req() req: AuthRequest, @Query() q: unknown) {
    return this.service.assignableAnywhere(req, q);
  }
}
