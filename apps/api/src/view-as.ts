import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, text } from './domain-helpers';
import { AuthRequest, SessionGuard } from './security';
import { parseViewAs, simulate } from './view-as-core';

const startInput = z.object({ target: z.string().max(100), reason: text(500).optional() }).strict();

@Controller('admin/view-as')
@UseGuards(SessionGuard)
export class ViewAsController {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Records that a Super Admin started previewing the portal as someone else. */
  @Post()
  async start(@Req() req: AuthRequest, @Body() body: unknown) {
    if (req.user.viewAs) throw new ForbiddenException('Exit the current preview first');
    if (!req.user.roles.includes('SUPER_ADMIN'))
      throw new ForbiddenException('Only a Super Admin can use "View as"');
    const input = parse(startInput, body);
    const preview = await simulate(this.db, req.user, parseViewAs(input.target));
    await this.db.tx((c) =>
      this.db.audit(c, req.user, 'user', req.user.id, 'VIEW_AS_STARTED', {
        target: preview.viewAs?.target,
        label: preview.viewAs?.label,
        reason: input.reason ?? null,
      }),
    );
    return { target: preview.viewAs?.target, label: preview.viewAs?.label };
  }
}
