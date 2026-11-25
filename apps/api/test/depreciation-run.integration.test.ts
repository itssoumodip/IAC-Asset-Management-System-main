import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DepreciationService } from '../src/depreciation';
import { allocateAssetCode } from '../src/domain-assets';
import { IT_TEAM_ID } from './team-fixtures';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Depreciation integration requires a database ending _test');
const admin: any = { id: randomUUID(), roles: ['SUPER_ADMIN'], teams: [] };

describe('running depreciation', { skip: !connection, concurrency: false }, () => {
  let db: Db, service: DepreciationService;
  const ids: Record<string, string> = {};
  const make = async (
    name: string,
    fields: { cost: number; purchased: string; method: string; residual?: number; status?: string },
  ) =>
    db.tx(async (c) => {
      const code = await allocateAssetCode(db, IT_TEAM_ID, c);
      const [a] = await db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,
                            purchase_cost,purchase_date,depreciation_method,useful_life_years,residual_value,
                            disposal_date,disposal_reference)
         VALUES($1,'IT Hardware','Laptop',$2,'Owned',$3,'Good','Low',$4,$5,$6,$7,5,$8,
                CASE WHEN $3='Disposed' THEN DATE '2025-01-01' END, CASE WHEN $3='Disposed' THEN 'test' END)
         RETURNING id`,
        [code, `depreciation run ${name}`, fields.status ?? 'In Use', IT_TEAM_ID, fields.cost,
          fields.purchased, fields.method, fields.residual ?? null],
        c,
      );
      ids[name] = a.id;
    });
  const schedule = async (name: string, fy: number) =>
    (
      await db.query(
        `SELECT method, opening_value::float8 AS opening, depreciation_charge::float8 AS charge,
                closing_value::float8 AS closing, accumulated_depreciation::float8 AS accumulated
           FROM depreciation_schedules WHERE asset_id=$1 AND financial_year_start=$2`,
        [ids[name], fy],
      )
    )[0];

  before(async () => {
    db = new Db();
    service = new DepreciationService(db);
    await make('full', { cost: 100000, purchased: '2024-06-01', method: 'WDV', residual: 5000 });
    await make('part', { cost: 36500, purchased: '2026-01-01', method: 'WDV' });
    await make('land', { cost: 500000, purchased: '2024-06-01', method: 'NO_DEPRECIATION' });
    await make('later', { cost: 10000, purchased: '2026-06-01', method: 'WDV' });
    await make('gone', { cost: 10000, purchased: '2024-06-01', method: 'WDV', status: 'Disposed' });
  });
  after(async () => db?.onModuleDestroy());

  it('works out a year the way the finance register does', async () => {
    // Run inside a transaction that is rolled back, so the shared test database is left as it was.
    await assert.rejects(
      db.tx(async () => {
        const result = await service.run({ user: admin } as any, { financialYearStart: 2025, method: 'WDV' });
        assert.ok(result.processed >= 2);
        // A full year at 15% on the whole cost (the residual is not deducted for WDV).
        assert.deepEqual(await schedule('full', 2025), {
          method: 'WDV', opening: 100000, charge: 15000, closing: 85000, accumulated: 15000,
        });
        // Put to use on 1 Jan 2026: 90 days of the year → 36500 × 15% × 90/365 = 1350.
        assert.equal((await schedule('part', 2025)).charge, 1350);
        // Land is not depreciated; an asset bought after the year and a disposed one are skipped.
        assert.equal(await schedule('land', 2025), undefined);
        assert.equal(await schedule('later', 2025), undefined);
        assert.equal(await schedule('gone', 2025), undefined);

        // The next year continues from the closing value.
        await service.run({ user: admin } as any, { financialYearStart: 2026, method: 'WDV' });
        assert.deepEqual(await schedule('full', 2026), {
          method: 'WDV', opening: 85000, charge: 12750, closing: 72250, accumulated: 27750,
        });
        throw new Error('rollback');
      }),
      /rollback/,
    );
  });
});
