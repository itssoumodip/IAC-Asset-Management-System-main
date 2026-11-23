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
  let assetId: string;
  before(async () => {
    db = new Db();
    service = new DepreciationService(db);
    await db.tx(async (c) => {
      const code = await allocateAssetCode(db, IT_TEAM_ID, c);
      const [a] = await db.query(
        `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,owning_team_id,purchase_cost,purchase_date,depreciation_method,useful_life_years)
         VALUES($1,'IT Hardware','Laptop','depreciation run test','Owned','In Use','Good','Low',$2,100000,current_date - 400,'WDV',5) RETURNING id`,
        [code, IT_TEAM_ID],
        c,
      );
      assetId = a.id;
    });
  });
  after(async () => db?.onModuleDestroy());

  it('runs for a year and records each asset’s schedule (the run used to fail on a query parameter)', async () => {
    // Run inside a transaction that is rolled back, so the shared test database is left as it was.
    await assert.rejects(
      db.tx(async () => {
        const result = await service.run({ user: admin } as any, { financialYearStart: 2025, method: 'WDV' });
        assert.ok(result.processed >= 1);
        const [row] = await db.query(
          'SELECT method, depreciation_charge::float8 AS charge, closing_value::float8 AS closing FROM depreciation_schedules WHERE asset_id=$1 AND financial_year_start=2025',
          [assetId],
        );
        assert.equal(row.method, 'WDV');
        assert.equal(row.charge, 15000);
        assert.equal(row.closing, 85000);
        throw new Error('rollback');
      }),
      /rollback/,
    );
  });
});
