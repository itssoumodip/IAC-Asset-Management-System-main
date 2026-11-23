import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { TicketInsightsService } from '../src/ticket-insights';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Ticket insights integration requires a database ending _test');
const tag = `tins-${randomUUID()}`;
const actor = (roles: string[], teams: any[] = [], id = randomUUID()): any => ({ id, email: `${tag}@example.org`, roles, teams });

describe('support desk insights', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: TicketInsightsService;
  const reporter = randomUUID();
  const ids: Record<string, string> = {};
  before(async () => {
    db = new Db();
    service = new TicketInsightsService(db);
    await db.query(
      "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
      [reporter, `${tag}@example.org`, `${tag} reporter`],
    );
    const add = async (key: string, team: string, done: boolean) => {
      const [t] = await db.query(
        `INSERT INTO tickets(reporter_id,subject,description,category,priority,status,team_id,created_at,completed_at,completed_by,resolution)
         VALUES($1,$2,'d','HARDWARE','HIGH',$3,$4, now() - interval '3 days', $5, $6, $7) RETURNING id`,
        [reporter, `${tag} ${key}`, done ? 'COMPLETED' : 'OPEN', team, done ? new Date() : null, done ? reporter : null, done ? 'fixed' : null],
      );
      ids[key] = t.id;
    };
    await add('itFixed', IT_TEAM_ID, true);
    await add('itOpen', IT_TEAM_ID, false);
    await add('admOpen', ADM_TEAM_ID, false);
  });
  after(async () => db?.onModuleDestroy());

  it('shows every team to admins with fix times', async () => {
    const r = await service.insights({ user: actor(['SUPER_ADMIN']) } as any, { days: '30' });
    assert.equal(r.scope, 'all');
    const it = r.byTeam.find((x) => x.teamId === IT_TEAM_ID)!;
    const adm = r.byTeam.find((x) => x.teamId === ADM_TEAM_ID)!;
    assert.ok(it.fixed >= 1 && adm.open >= 1);
    assert.ok((r.totals.medianFixHours ?? 0) > 0);
    assert.equal(r.weeks.length, 12);
  });

  it('limits a team member to their own team', async () => {
    const member = actor(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
    const r = await service.insights({ user: member } as any, {});
    assert.equal(r.scope, 'team');
    assert.deepEqual(r.byTeam.map((x) => x.teamId), [ADM_TEAM_ID]);
    assert.ok(r.oldestOpen.every((o) => o.team !== 'IT'));
  });

  it('gives Executives every team and everyone else only what they raised', async () => {
    assert.equal((await service.insights({ user: actor(['EXECUTIVE']) } as any, {})).scope, 'all');
    const mine = await service.insights({ user: actor(['EMPLOYEE'], [], reporter) } as any, { days: 'all' });
    assert.equal(mine.scope, 'mine');
    assert.equal(mine.totals.raised, 3);
    const stranger = await service.insights({ user: actor(['EMPLOYEE']) } as any, {});
    assert.equal(stranger.totals.raised, 0);
    await assert.rejects(service.insights({ user: actor(['EMPLOYEE']) } as any, { days: '7' }));
  });
});
