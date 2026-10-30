import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  NotFoundException,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, found, id, parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';

const putInput = z.object({ level: z.enum(['LEAD', 'MEMBER']), reason: text(1000) }).strict();
const deleteInput = z.object({ reason: text(1000) }).strict();
const candidateQuery = z.object({ q: z.string().trim().max(100).optional() }).strict();

/** Team Leads (and Super Admins) manage who belongs to their team. */
@Injectable()
export class TeamService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async members(req: AuthRequest, teamId: string) {
    id(teamId);
    assertCan(req.user, 'team.manage_members', teamId);
    const items = await this.db.query(
      `SELECT m.user_id,u.display_name,u.email,m.level,m.granted_at
       FROM team_memberships m JOIN users u ON u.id=m.user_id
       WHERE m.team_id=$1 ORDER BY m.level,u.display_name`,
      [teamId],
    );
    return { items: items.map(camel) };
  }

  async put(req: AuthRequest, teamId: string, userId: string, body: unknown) {
    const { level, reason } = parse(putInput, body);
    return this.change(req, teamId, userId, reason, async (c, before) => {
      await this.db.query(
        'INSERT INTO team_memberships(user_id,team_id,level,granted_by) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,team_id) DO UPDATE SET level=excluded.level,granted_by=excluded.granted_by,granted_at=now()',
        [userId, teamId, level, req.user.id],
        c,
      );
      return { before, after: level };
    });
  }

  /** Searchable active colleagues not yet in the team, so Leads pick a person instead of typing an email. */
  async candidates(req: AuthRequest, teamId: string, raw: unknown) {
    const { q } = parse(candidateQuery, raw ?? {});
    id(teamId);
    assertCan(req.user, 'team.manage_members', teamId);
    const values: any[] = [teamId];
    let search = '';
    if (q) {
      values.push(q);
      search = `AND (strpos(lower(u.display_name),lower($2))>0 OR strpos(lower(u.email),lower($2))>0 OR strpos(lower(coalesce(u.employee_code,'')),lower($2))>0)`;
    }
    const items = await this.db.query(
      `SELECT u.id,u.display_name,u.email,u.employee_code,u.designation
       FROM users u
       WHERE u.state='ACTIVE' AND u.merged_into_user_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM team_memberships m WHERE m.user_id=u.id AND m.team_id=$1)
         ${search}
       ORDER BY u.display_name,u.id LIMIT 25`,
      values,
    );
    return { items: items.map(camel) };
  }

  /** Adds an active colleague by work email (the picker sends the chosen person's email). */
  async add(req: AuthRequest, teamId: string, body: unknown) {
    const { email, ...rest } = parse(putInput.extend({ email: z.string().trim().email() }), body);
    id(teamId);
    assertCan(req.user, 'team.manage_members', teamId);
    const [user] = await this.db.query(
      "SELECT id FROM users WHERE email=lower($1) AND state='ACTIVE'",
      [email],
    );
    if (!user) throw new NotFoundException('No active account uses that email');
    return this.put(req, teamId, user.id, rest);
  }

  async remove(req: AuthRequest, teamId: string, userId: string, body: unknown) {
    const { reason } = parse(deleteInput, body);
    return this.change(req, teamId, userId, reason, async (c, before) => {
      await this.db.query(
        'DELETE FROM team_memberships WHERE user_id=$1 AND team_id=$2',
        [userId, teamId],
        c,
      );
      return { before, after: null };
    });
  }

  /** Shared path: permission, locks, audit and session revocation so access changes apply now. */
  private async change(
    req: AuthRequest,
    teamId: string,
    userId: string,
    reason: string,
    apply: (
      c: PoolClient,
      before: string | null,
    ) => Promise<{ before: string | null; after: string | null }>,
  ) {
    id(teamId);
    id(userId);
    assertCan(req.user, 'team.manage_members', teamId);
    return this.db.tx(async (c) => {
      found((await this.db.query('SELECT id FROM teams WHERE id=$1', [teamId], c))[0]);
      found(
        (
          await this.db.query(
            "SELECT id FROM users WHERE id=$1 AND state<>'DISABLED' FOR UPDATE",
            [userId],
            c,
          )
        )[0],
      );
      const [current] = await this.db.query(
        'SELECT level FROM team_memberships WHERE user_id=$1 AND team_id=$2 FOR UPDATE',
        [userId, teamId],
        c,
      );
      const change = await apply(c, current?.level ?? null);
      await this.db.query(
        'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [userId],
        c,
      );
      await this.db.audit(c, req.user, 'user', userId, 'TEAM_MEMBERSHIP_CHANGED', {
        teamId,
        ...change,
        reason,
      });
      return { userId, teamId, level: change.after, sessionsRevoked: true };
    });
  }
}

@Controller('teams')
@UseGuards(SessionGuard)
export class TeamController {
  constructor(@Inject(TeamService) private readonly service: TeamService) {}

  @Get(':id/members')
  members(@Req() req: AuthRequest, @Param('id') teamId: string) {
    return this.service.members(req, teamId);
  }

  @Get(':id/candidates')
  candidates(@Req() req: AuthRequest, @Param('id') teamId: string, @Query() q: unknown) {
    return this.service.candidates(req, teamId, q);
  }

  @Post(':id/members')
  add(@Req() req: AuthRequest, @Param('id') teamId: string, @Body() body: unknown) {
    return this.service.add(req, teamId, body);
  }

  @Put(':id/members/:userId')
  put(
    @Req() req: AuthRequest,
    @Param('id') teamId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.service.put(req, teamId, userId, body);
  }

  @Delete(':id/members/:userId')
  remove(
    @Req() req: AuthRequest,
    @Param('id') teamId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.service.remove(req, teamId, userId, body);
  }
}
