import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { MaintenanceService } from '../src/maintenance';
import { VerificationService } from '../src/verification';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Page insights integration requires a database ending _test');
const actor = (roles: string[], teams: any[] = []): any => ({ id: randomUUID(), email: 'x@example.org', roles, teams });

describe('maintenance and verification insights', { skip: !connection, concurrency: false }, () => {
  let db: Db;
  before(() => {
    db = new Db();
  });
  after(async () => db?.onModuleDestroy());

  it('maintenance gives 12 weeks done, 8 weeks coming and an on-time rate, to staff only', async () => {
    const service = new MaintenanceService(db);
    const r = await service.insights({ user: actor(['SUPER_ADMIN']) } as any);
    assert.equal(r.done.length, 12);
    assert.equal(r.upcoming.length, 8);
    assert.ok(r.onTime90.onTime <= r.onTime90.total);
    assert.ok(Array.isArray(r.byType) && Array.isArray(r.byPerson));
    await assert.rejects(service.insights({ user: actor(['EMPLOYEE']) } as any), /permission/i);
  });

  it('verification gives coverage, 12 months of results and places overdue, to auditors only', async () => {
    const service = new VerificationService(db);
    const r = await service.insights({ user: actor(['AUDITOR']) } as any);
    assert.equal(r.months.length, 12);
    assert.ok(r.checkedThisYear + r.neverChecked <= r.liveAssets);
    assert.ok(r.staleLocations.length <= 8);
    await assert.rejects(service.insights({ user: actor(['EMPLOYEE']) } as any), /permission/i);
  });
});
