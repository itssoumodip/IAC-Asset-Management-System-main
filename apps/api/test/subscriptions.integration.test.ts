import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { SubscriptionService, websiteDomain } from '../src/subscriptions';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Subscription integration requires a database ending _test');
const tag = `sub-${randomUUID().slice(0, 8)}`;
const person = (roles: string[], teams: any[] = []): any => ({ id: randomUUID(), email: `${tag}@example.org`, roles, teams, requestId: randomUUID() });

describe('subscriptions', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: SubscriptionService;
  const itMember = person(['EMPLOYEE'], [{ teamId: IT_TEAM_ID, teamCode: 'IT', level: 'MEMBER' }]);
  const admMember = person(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
  const finance = person(['FINANCE']);
  const userA = person(['EMPLOYEE']);
  const userB = person(['EMPLOYEE']);
  let subId = '';
  before(async () => {
    db = new Db();
    service = new SubscriptionService(db);
    for (const u of [itMember, admMember, finance, userA, userB])
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
        [u.id, `${tag}-${u.id}@example.org`, `${tag} ${u.id.slice(0, 4)}`],
      );
  });
  after(async () => db?.onModuleDestroy());

  it('reads the domain from a website field for the logo, refusing anything that is not a public name', () => {
    assert.equal(websiteDomain('openai.com'), 'openai.com');
    assert.equal(websiteDomain('https://chat.openai.com/c/1'), 'chat.openai.com');
    assert.equal(websiteDomain('localhost'), null);
    assert.equal(websiteDomain('http://10.0.0.1/admin'), null);
    assert.equal(websiteDomain(''), null);
  });

  it('lets only the IT team add one, with a SUB- code', async () => {
    const body = {
      name: `${tag} ChatGPT Team`,
      vendor: 'OpenAI',
      category: 'AI tool',
      billingCycle: 'MONTHLY',
      cost: 3000,
      seatsTotal: 1,
      renewalDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10),
    };
    await assert.rejects(service.create({ user: admMember } as any, body), /Only the IT team/);
    await assert.rejects(service.create({ user: itMember } as any, { ...body, category: 'Nonsense' }), /type from the list/);
    const created = await service.create({ user: itMember } as any, body);
    assert.match(created.code, /^SUB-\d{6}$/);
    subId = created.id;
  });

  it('gives it to people up to the seat limit, keeps history, and shows it on My assets', async () => {
    await service.assign({ user: itMember } as any, subId, { userId: userA.id });
    await assert.rejects(service.assign({ user: itMember } as any, subId, { userId: userB.id }), /seats are in use/);
    await assert.rejects(service.assign({ user: admMember } as any, subId, { userId: userB.id }), /Only the IT team/);
    const mine = await service.mine({ user: userA } as any);
    assert.ok(mine.items.some((s) => s.id === subId));
    const detail = await service.detail({ user: finance } as any, subId);
    assert.equal(detail.people.length, 1);
    assert.equal(detail.canManage, false);
    await service.end({ user: itMember } as any, subId, detail.people[0].assignmentId, { note: 'moved team' });
    const after = await service.detail({ user: itMember } as any, subId);
    assert.equal(after.people.length, 0);
    assert.equal(after.history[0].endNote, 'moved team');
    assert.equal((await service.mine({ user: userA } as any)).items.some((s) => s.id === subId), false);
  });

  it('adds a plan for several people at once, or for a whole department', async () => {
    const base = { vendor: 'Vendor', category: 'Software', billingCycle: 'YEARLY', cost: 1200 };
    await assert.rejects(
      service.create({ user: itMember } as any, { ...base, name: `${tag} Too many`, seatsTotal: 1, userIds: [userA.id, userB.id] }),
      /2 people but the plan has 1 seats/,
    );
    const team = await service.create({ user: itMember } as any, { ...base, name: `${tag} Team plan`, userIds: [userA.id, userB.id] });
    const teamDetail = await service.detail({ user: itMember } as any, team.id);
    assert.equal(teamDetail.people.length, 2);
    assert.equal(teamDetail.audience, 'PEOPLE');

    const [dept] = await db.query('SELECT id FROM departments ORDER BY name LIMIT 1');
    await assert.rejects(
      service.create({ user: itMember } as any, { ...base, name: `${tag} Dept`, audience: 'DEPARTMENT' }),
      /Invalid fields/,
    );
    const deptPlan = await service.create({ user: itMember } as any, { ...base, name: `${tag} Dept plan`, audience: 'DEPARTMENT', departmentId: dept.id });
    // Someone in that department sees it on My assets without being named.
    await db.query('UPDATE users SET department_id=$2 WHERE id=$1', [userB.id, dept.id]);
    const mine = await service.mine({ user: userB } as any);
    assert.equal(mine.items.find((s) => s.id === deptPlan.id)?.via, 'DEPARTMENT');
    assert.equal(mine.items.find((s) => s.id === team.id)?.via, 'PERSON');
  });

  it('edits with a version check, refuses lowering seats below use, and counts spend', async () => {
    await service.assign({ user: itMember } as any, subId, { userId: userB.id });
    const d = await service.detail({ user: itMember } as any, subId);
    const base = { name: d.name, vendor: d.vendor, category: d.category, billingCycle: 'YEARLY', cost: 36000, seatsTotal: 5 };
    await service.update({ user: itMember } as any, subId, { ...base, version: d.version });
    await assert.rejects(service.update({ user: itMember } as any, subId, { ...base, version: d.version }), /changed this subscription/);
    const list = await service.list({ user: finance } as any, { q: tag });
    assert.equal(list.items.find((x) => x.id === subId)?.logoVersion, null, 'no website, no logo');
    assert.equal(list.items[0].monthlyCost, 3000);
    assert.equal(list.items[0].seatsUsed, 1);
    const found = await service.list({ user: finance } as any, { q: `${tag} ${userB.id.slice(0, 4)}` });
    assert.ok(found.items.some((s) => s.id === subId), 'searchable by the person using it');
    const summary = await service.summary({ user: finance } as any);
    assert.ok(summary.monthlySpend >= 3000 && summary.months.length === 12);
    await assert.rejects(service.list({ user: admMember } as any, {}), /permission/i);
  });
});
