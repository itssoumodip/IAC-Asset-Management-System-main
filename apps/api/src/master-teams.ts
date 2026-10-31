import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from './db';
import { camel, date, found, id, parse, text } from './domain-helpers';
import { AuthRequest, assertVersion } from './security';

const reason = text(1000);
const teamCreate = z
  .object({
    code: z.string().regex(/^[A-Z]{2,5}$/, 'Code must be 2-5 capital letters'),
    name: text(120),
    assetCodePrefix: z.string().regex(/^[A-Z]{2,5}$/, 'Prefix must be 2-5 capital letters'),
    requiresProject: z.boolean().default(false),
    active: z.boolean().default(true),
    reason,
  })
  .strict();
const teamPatch = teamCreate
  .omit({ code: true, reason: true })
  .partial()
  .extend({ reason })
  .strict();
const optional = (max: number) => text(max).nullable().optional();
const projectCreate = z
  .object({
    code: text(40),
    name: text(160),
    funder: optional(160),
    grantReference: optional(160),
    startDate: date,
    endDate: date.nullable().optional(),
    active: z.boolean().default(true),
    reason,
  })
  .strict()
  .refine((p) => !p.endDate || p.endDate >= p.startDate, 'End date must not precede start date');
const projectPatch = z
  .object({
    name: text(160).optional(),
    funder: optional(160),
    grantReference: optional(160),
    startDate: date.optional(),
    endDate: date.nullable().optional(),
    active: z.boolean().optional(),
    reason,
  })
  .strict();

export type TeamMasterKind = 'teams' | 'projects';
export const isTeamMasterKind = (kind: string): kind is TeamMasterKind =>
  kind === 'teams' || kind === 'projects';

/** Postgres unique/prefix-trigger violations become user-facing conflicts. */
function conflict(error: any): never {
  if (error?.code === '23505')
    throw new ConflictException('This code, name or asset code prefix is already used');
  if (error?.code === '23514' && /prefix/i.test(error.message ?? ''))
    throw new ConflictException(
      'The asset code prefix is already used by assets and cannot change',
    );
  throw error;
}

export async function teamAndProjectLists(db: Db) {
  const [teams, projects, assetTypePolicies, categoryTeams] = await Promise.all([
    db.query(
      `SELECT t.id,t.code,t.name,t.asset_code_prefix,t.requires_project,t.active,t.version,
              EXISTS(SELECT 1 FROM assets a WHERE a.asset_code LIKE 'IAC-'||t.asset_code_prefix||'-%') AS prefix_in_use
       FROM teams t ORDER BY t.name`,
    ),
    db.query(
      `SELECT id,code,name,funder,grant_reference,to_char(start_date,'YYYY-MM-DD') AS start_date,
              to_char(end_date,'YYYY-MM-DD') AS end_date,active,version
       FROM projects ORDER BY name,code`,
    ),
    db.query(
      `SELECT asset_type_code,requires_custodian,owning_team_id,handling_team_id,category_code FROM asset_type_policies ORDER BY 1`,
    ),
    db.query('SELECT category_code,team_id FROM ticket_category_teams ORDER BY 1'),
  ]);
  return {
    teams: teams.map(camel),
    projects: projects.map(camel),
    assetTypePolicies: assetTypePolicies.map(camel),
    ticketCategoryTeams: categoryTeams.map(camel),
  };
}

export async function createTeamOrProject(
  db: Db,
  req: AuthRequest,
  kind: TeamMasterKind,
  body: unknown,
  c: PoolClient,
) {
  if (kind === 'teams') {
    const { reason, ...data } = parse(teamCreate, body);
    const [row] = await db
      .query(
        'INSERT INTO teams(code,name,asset_code_prefix,requires_project,active) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [data.code, data.name, data.assetCodePrefix, data.requiresProject, data.active],
        c,
      )
      .catch(conflict);
    await db.query('INSERT INTO team_asset_counters(team_id,next_value) VALUES($1,1)', [row.id], c);
    await db.audit(c, req.user, 'team', row.id, 'MASTER_CREATED', { reason, after: camel(row) });
    return camel(row);
  }
  const { reason, ...data } = parse(projectCreate, body);
  const [row] = await db
    .query(
      'INSERT INTO projects(code,name,funder,grant_reference,start_date,end_date,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        data.code,
        data.name,
        data.funder ?? null,
        data.grantReference ?? null,
        data.startDate,
        data.endDate ?? null,
        data.active,
      ],
      c,
    )
    .catch(conflict);
  await db.audit(c, req.user, 'project', row.id, 'MASTER_CREATED', { reason, after: camel(row) });
  return camel(row);
}

export async function updateTeamOrProject(
  db: Db,
  req: AuthRequest,
  kind: TeamMasterKind,
  identifier: string,
  body: unknown,
  c: PoolClient,
) {
  id(identifier);
  const { reason, ...changes } = parse(kind === 'teams' ? teamPatch : projectPatch, body) as any;
  if (!Object.keys(changes).length)
    throw new UnprocessableEntityException('Supply a master change');
  const before = found(
    (await db.query(`SELECT * FROM ${kind} WHERE id=$1 FOR UPDATE`, [identifier], c))[0],
  );
  assertVersion(req, before.version);
  const columns: Record<string, string> = {
    name: 'name',
    assetCodePrefix: 'asset_code_prefix',
    requiresProject: 'requires_project',
    active: 'active',
    funder: 'funder',
    grantReference: 'grant_reference',
    startDate: 'start_date',
    endDate: 'end_date',
  };
  const entries = Object.entries(changes);
  const [after] = await db
    .query(
      `UPDATE ${kind} SET ${entries.map(([key], i) => `${columns[key]}=$${i + 2}`).join(',')},version=version+1 WHERE id=$1 RETURNING *`,
      [identifier, ...entries.map(([, value]) => value)],
      c,
    )
    .catch(conflict);
  if (after.end_date && after.start_date && after.end_date < after.start_date)
    throw new UnprocessableEntityException('End date must not precede start date');
  await db.audit(c, req.user, kind === 'teams' ? 'team' : 'project', before.id, 'MASTER_UPDATED', {
    reason,
    before: camel(before),
    after: camel(after),
  });
  return camel(after);
}

/** Room-held flag for an asset type; types without a row require a person. */
export async function setRequiresCustodian(
  db: Db,
  req: AuthRequest,
  assetType: string,
  requiresCustodian: unknown,
  reason: string,
  c: PoolClient,
) {
  const value = parse(z.boolean(), requiresCustodian);
  await db.query(
    'INSERT INTO asset_type_policies(asset_type_code,requires_custodian) VALUES($1,$2) ON CONFLICT(asset_type_code) DO UPDATE SET requires_custodian=excluded.requires_custodian',
    [assetType, value],
    c,
  );
  await db.audit(c, req.user, 'reference', null, 'ASSET_TYPE_POLICY_UPDATED', {
    assetType,
    requiresCustodian: value,
    reason,
  });
  return value;
}

const categoryTeam = z.object({ teamId: z.string().uuid(), reason }).strict();

/** Maps a ticket category to the team whose queue receives its tickets. */
export async function setTicketCategoryTeam(
  db: Db,
  req: AuthRequest,
  category: string,
  body: unknown,
  c: PoolClient,
) {
  const data = parse(categoryTeam, body);
  found(
    (
      await db.query(
        "SELECT 1 FROM reference_values WHERE kind='TICKET_CATEGORY' AND code=$1",
        [category],
        c,
      )
    )[0],
  );
  const team = found(
    (await db.query('SELECT id,active FROM teams WHERE id=$1 FOR SHARE', [data.teamId], c))[0],
  );
  if (!team.active) throw new UnprocessableEntityException('The team is not active');
  const [before] = await db.query(
    'SELECT team_id FROM ticket_category_teams WHERE category_code=$1 FOR UPDATE',
    [category],
    c,
  );
  await db.query(
    'INSERT INTO ticket_category_teams(category_code,team_id) VALUES($1,$2) ON CONFLICT(category_code) DO UPDATE SET team_id=excluded.team_id',
    [category, data.teamId],
    c,
  );
  await db.audit(c, req.user, 'reference', null, 'TICKET_CATEGORY_TEAM_UPDATED', {
    category,
    before: before?.team_id ?? null,
    after: data.teamId,
    reason: data.reason,
  });
  return { categoryCode: category, teamId: data.teamId };
}
