import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DepreciationService } from '../src/depreciation';
import type { AuthRequest } from '../src/security';
import { ADM_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Depreciation method integration requires isolated _test database');

describe('depreciation method settings PostgreSQL integration', { concurrency: false }, () => {
  let db: Db;
  let service: DepreciationService;
  let finance: any;
  let employee: any;
  let categoryCode: string;
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const request = (user: any, version?: number) => ({
    user,
    get: (name: string) => name.toLowerCase() === 'if-match' && version ? `"${version}"` : undefined,
  }) as AuthRequest;
  const status = (expected: number) => (error: any) => {
    assert.equal(error.status, expected);
    return true;
  };
  const reason = 'Synthetic depreciation method test';

  before(async () => {
    process.env.DATABASE_URL = connection;
    db = new Db();
    service = new DepreciationService(db);
    const user = async (role: string) => {
      const actor = {
        id: randomUUID(),
        email: `depreciation-${role.toLowerCase()}-${randomUUID()}@example.org`,
        displayName: 'Synthetic depreciation method test',
        roles: [role],
      };
      await db.query(
        `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version)
         VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')`,
        [actor.id, actor.email, actor.displayName],
      );
      await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [actor.id, role]);
      return actor;
    };
    finance = await user('FINANCE');
    employee = await user('EMPLOYEE');
    const [category] = await db.query(
      `SELECT code FROM reference_values WHERE kind='CATEGORY' AND active ORDER BY code LIMIT 1`,
    );
    assert.ok(category, 'an active asset category is required');
    categoryCode = category.code;
  });

  after(async () => {
    if (db) await db.onModuleDestroy();
  });

  it('lets Finance create scoped methods with generated codes and safely deactivate/delete unused methods', async () => {
    await assert.rejects(service.methods(request(employee)), status(403));
    await assert.rejects(
      service.createMethod(request(employee), {
        label: `Test Chair SLM ${tag}`,
        calculationType: 'SLM',
        teamId: ADM_TEAM_ID,
        categoryCode,
        reason,
      }),
      status(403),
    );

    const created = await service.createMethod(request(finance), {
      label: `Test Chair SLM ${tag}`,
      calculationType: 'SLM',
      teamId: ADM_TEAM_ID,
      categoryCode,
      reason,
    });
    assert.equal(created.calculationType, 'SLM');
    assert.match(created.code, /^TEST_CHAIR_SLM_[A-F0-9]+$/);

    const methods = await service.methods(request(finance));
    const saved = methods.items.find((method: any) => method.code === created.code);
    assert.equal(saved.teamId, ADM_TEAM_ID);
    assert.equal(saved.categoryCode, categoryCode);
    assert.equal(saved.active, true);

    await assert.rejects(service.deleteMethod(request(finance), created.code), status(409));
    const deactivated = await service.updateMethod(request(finance, saved.version), created.code, {
      label: saved.label,
      calculationType: 'SLM',
      ratePercent: null,
      teamId: ADM_TEAM_ID,
      categoryCode,
      active: false,
      version: saved.version,
      reason,
    });
    assert.equal(deactivated.active, false);
    assert.deepEqual(await service.deleteMethod(request(finance), created.code), {
      deleted: true,
      code: created.code,
    });
    assert.equal((await service.methods(request(finance))).items.some((m: any) => m.code === created.code), false);
  });
});
