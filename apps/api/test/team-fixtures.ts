import type { Db } from '../src/db';
import type { TeamLevel } from '../src/policy';

export const IT_TEAM_ID = '00000000-0000-4000-8000-000000000001';
export const ADM_TEAM_ID = '00000000-0000-4000-8000-000000000002';
export const PRJ_TEAM_ID = '00000000-0000-4000-8000-000000000003';
const codes: Record<string, string> = {
  [IT_TEAM_ID]: 'IT',
  [ADM_TEAM_ID]: 'ADM',
  [PRJ_TEAM_ID]: 'PRJ',
};

/** Adds a synthetic user to a team in the database and on the in-memory actor. */
export async function joinTeam<T extends { id: string; teams?: unknown[] }>(
  db: Db,
  user: T,
  level: TeamLevel = 'MEMBER',
  teamId = IT_TEAM_ID,
): Promise<T> {
  await db.query(
    'INSERT INTO team_memberships(user_id,team_id,level) VALUES($1,$2,$3) ON CONFLICT(user_id,team_id) DO UPDATE SET level=excluded.level',
    [user.id, teamId, level],
  );
  user.teams = [
    ...((user.teams as any[]) ?? []).filter((t) => t.teamId !== teamId),
    { teamId, teamCode: codes[teamId], level },
  ];
  return user;
}
