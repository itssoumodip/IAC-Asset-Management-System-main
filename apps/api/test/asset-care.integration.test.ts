import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { ReportsService } from '../src/reports';
import { InsuranceService } from '../src/insurance';
import { DomainService } from '../src/domain';
import { FinanceService } from '../src/finance';
import { allocateAssetCode } from '../src/domain-assets';
import { ADM_TEAM_ID, IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Asset care integration requires a database ending _test');
const tag = `care-${randomUUID()}`;
const actor = (roles: string[], teams: any[] = []): any => ({
  id: randomUUID(),
  email: `${tag}@example.org`,
  roles,
  teams,
});

describe('warranty, AMC and insurance registers', { skip: !connection, concurrency: false }, () => {
  let db: Db, reports: ReportsService, insurance: InsuranceService;
  const admin = actor(['SUPER_ADMIN']);
  const holder = randomUUID();
  const ids: Record<string, string> = {};

  before(async () => {
    db = new Db();
    reports = new ReportsService(db);
    insurance = new InsuranceService(db);
    for (const id of [admin.id, holder])
      await db.query(
        "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
        [id, `${tag}-${id}@example.org`, `${tag} person`],
      );
    const add = async (key: string, team: string, status: string, extra: string) =>
      db.tx(async (c) => {
        const code = await allocateAssetCode(db, team, c);
        const [asset] = await db.query(
          `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,
                              warranty_expiry,amc_applies,amc_expiry,insurance_policy_number,insurance_expiry,purchase_cost,purchase_date)
           VALUES($1,'IT Hardware','Laptop',$2,'Owned',$3,'Good','Low',$4, ${extra}, 40000, current_date - 400) RETURNING id`,
          [code, `${tag} ${key}`, status, team],
          c,
        );
        ids[key] = asset.id;
        return asset.id as string;
      });
    // IT laptop: warranty ends in 10 days, AMC ended, insured for a year; held by someone.
    const it = await add(
      'it',
      IT_TEAM_ID,
      'In Use',
      "current_date + 10, true, current_date - 5, 'POL-1', current_date + 365",
    );
    await db.query(
      "INSERT INTO assignments(asset_id,user_id,assigned_by,acknowledgement,acknowledged_at) VALUES($1,$2,$3,'ACCEPTED',now())",
      [it, holder, admin.id],
    );
    // Admin-team item without any dates; and a lost item that should not be listed.
    await add('adm', ADM_TEAM_ID, 'Active', 'NULL, false, NULL, NULL, NULL');
    await add('sold', IT_TEAM_ID, 'Lost', 'current_date - 1, false, NULL, NULL, NULL');
  });
  after(async () => db?.onModuleDestroy());

  it('lists every live asset with days left and the current holder', async () => {
    const { items } = await reports.warrantyExpiry({ user: admin } as any, { q: tag });
    const row: any = items.find((r: any) => r.id === ids.it);
    assert.equal(row.warrantyDaysRemaining, 10);
    assert.equal(row.amcDaysRemaining, -5);
    assert.equal(row.custodian.userId, holder);
    assert.equal(typeof row.custodian.hasPhoto, 'boolean');
    assert.ok(items.some((r: any) => r.id === ids.adm), 'assets with no dates are listed too');
    assert.ok(!items.some((r: any) => r.id === ids.sold), 'written-off assets are left out');
  });

  it('gives team members their own team only, and refuses people without a team', async () => {
    const member = actor(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
    const { items } = await reports.warrantyExpiry({ user: member } as any, { q: tag });
    assert.ok(items.some((r: any) => r.id === ids.adm));
    assert.ok(!items.some((r: any) => r.id === ids.it));
    const cover = await insurance.assets({ user: member } as any, { q: tag });
    assert.ok(!cover.items.some((r: any) => r.id === ids.it));
    await assert.rejects(reports.warrantyExpiry({ user: actor(['EMPLOYEE']) } as any, {}), /permission/i);
    await assert.rejects(insurance.assets({ user: actor(['EMPLOYEE']) } as any, {}), /permission/i);
  });

  it('shows the insurer the cover but not who holds each item', async () => {
    const { items } = await insurance.assets({ user: actor(['INSURER']) } as any, { q: tag });
    const row: any = items.find((r: any) => r.id === ids.it);
    assert.equal(row.insurancePolicyNumber, 'POL-1');
    assert.equal(row.insuranceDaysRemaining, 365);
    assert.equal(row.custodian, null);
  });

  it('opens exactly the assets a Needs attention row counts', async () => {
    const domain = new DomainService(db);
    const list = async (attention: string) =>
      (await domain.assets({ user: admin } as any, { attention, limit: 100, q: tag })).items.map((a: any) => a.id);
    assert.deepEqual(await list('no_warranty'), [ids.adm]);
    assert.ok(!(await list('unconfirmed')).includes(ids.it), 'accepted custody is not listed');
    await assert.rejects(domain.assets({ user: admin } as any, { attention: 'everything' }));
  });

  it('filters and pages the register on the server, most urgent first', async () => {
    const soon = await reports.warrantyExpiry({ user: admin } as any, { q: tag, show: 'due30' });
    assert.deepEqual(soon.items.map((r: any) => r.id), [ids.it]);
    const amcExpired = await reports.warrantyExpiry({ user: admin } as any, { q: tag, cover: 'amc', show: 'expired' });
    assert.deepEqual(amcExpired.items.map((r: any) => r.id), [ids.it]);
    const first = await reports.warrantyExpiry({ user: admin } as any, { q: tag, limit: '1' });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].id, ids.it, 'ending soon comes before not recorded');
    assert.equal(first.nextCursor, '1');
    const second = await reports.warrantyExpiry({ user: admin } as any, { q: tag, limit: '1', cursor: '1' });
    assert.equal(second.items[0].id, ids.adm);
    assert.equal(second.nextCursor, null);
    await assert.rejects(reports.warrantyExpiry({ user: admin } as any, { show: 'everything' }));
  });

  it('counts warranty, AMC and insurance in the database, scoped like the list', async () => {
    const member = actor(['EMPLOYEE'], [{ teamId: ADM_TEAM_ID, teamCode: 'ADM', level: 'MEMBER' }]);
    const all = await reports.warrantySummary({ user: admin } as any);
    const mine = await reports.warrantySummary({ user: member } as any);
    assert.ok(all.total >= mine.total + 1, 'the IT laptop is outside the Admin member view');
    assert.ok(all.warranty!.due30 >= 1 && all.amc!.expired >= 1 && all.insurance!.active >= 1);
    assert.equal(all.months.length, 12);
    assert.ok(all.soonest.length > 0 && all.soonest.every((x, i, l) => x.days >= 0 && x.days <= 90 && (i === 0 || l[i - 1].days <= x.days)));
    assert.ok(all.value && all.value.total >= all.value.insured);
    const insurer = await insurance.summary({ user: actor(['INSURER']) } as any);
    assert.ok(insurer.insurance!.active >= 1);
    await assert.rejects(reports.warrantySummary({ user: actor(['EMPLOYEE']) } as any), /permission/i);
  });

  it('gives Finance a review snapshot with blockers, waits and 12 weeks of decisions', async () => {
    const finance = new FinanceService(db, new DomainService(db));
    const s = await finance.summary({ user: actor(['FINANCE']) } as any);
    assert.ok(s.pending >= 2, 'the new test assets wait for Finance');
    assert.ok(s.blockers.noInvoice >= 2);
    assert.equal(s.weeks.length, 12);
    assert.ok(s.medianWaitDays != null && s.oldestWaitDays! >= s.medianWaitDays);
    assert.ok(s.byTeam.some((t) => t.teamId === ADM_TEAM_ID && t.pending >= 1));
    await assert.rejects(finance.summary({ user: actor(['EMPLOYEE']) } as any), /permission/i);
  });

  it('lets Finance open the insurance register for every team', async () => {
    const { items } = await insurance.assets({ user: actor(['FINANCE']) } as any, { q: tag });
    assert.ok(items.some((r: any) => r.id === ids.it) && items.some((r: any) => r.id === ids.adm));
  });
});
