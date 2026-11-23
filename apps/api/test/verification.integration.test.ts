import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { DomainService } from '../src/domain';
import { LocationsService } from '../src/locations';
import { ReportsService } from '../src/reports';
import { VerificationService } from '../src/verification';
import type { AuthRequest } from '../src/security';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Verification tests require a database name ending _test');
const tag = `verification-${randomUUID().slice(0, 8)}`;
const request = (user: any) =>
  ({
    user,
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? randomUUID() : undefined),
  }) as AuthRequest;

describe(
  'verification and operational reports PostgreSQL integration',
  { skip: !connection, concurrency: false },
  () => {
    let db: Db;
    let domain: DomainService;
    let locations: LocationsService;
    let verification: VerificationService;
    let reports: ReportsService;
    let admin: any;
    let auditor: any;

    before(async () => {
      process.env.DATABASE_URL = connection;
      process.env.AUTH_MAIL_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
      db = new Db();
      domain = new DomainService(db);
      locations = new LocationsService(db);
      verification = new VerificationService(db);
      reports = new ReportsService(db);
      const makeUser = async (role: string) => {
        const user = {
          id: randomUUID(),
          email: `${tag}-${role.toLowerCase()}-${randomUUID()}@example.org`,
          displayName: role,
          roles: [role],
          teams: [],
          state: 'ACTIVE',
          version: 1,
        };
        await db.query(
          "INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1')",
          [user.id, user.email, user.displayName],
        );
        await db.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [user.id, role]);
        return user;
      };
      admin = await makeUser('SUPER_ADMIN');
      auditor = await makeUser('AUDITOR');
      for (const [kind, code] of [
        ['CATEGORY', 'Verification Test Category'],
        ['ASSET_TYPE', 'Verification Test Type'],
        ['OWNERSHIP', 'Owned'],
        ['CONDITION', 'Good'],
        ['RISK', 'Medium'],
      ])
        await db.query(
          'INSERT INTO reference_values(kind,code,label) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',
          [kind, code],
        );
    });

    after(async () => {
      if (db) await db.onModuleDestroy();
    });

    it('loads all scoped assets, records the actual wrong location, and reports cycle progress', async () => {
      const root = await locations.create(request(admin), {
        code: `${tag}-SITE`,
        name: `${tag} Site`,
        level: 'SITE',
        reason: 'Test fixture',
      });
      const floor = await locations.create(request(admin), {
        code: `${tag}-FLOOR`,
        name: `${tag} Floor`,
        level: 'FLOOR',
        parentId: root.id,
        reason: 'Test fixture',
      });
      const other = await locations.create(request(admin), {
        code: `${tag}-OTHER`,
        name: `${tag} Other Site`,
        level: 'SITE',
        reason: 'Test fixture',
      });
      const asset = await domain.createAsset(request(admin), {
        category: 'Verification Test Category',
        assetType: 'Verification Test Type',
        description: `${tag} laptop`,
        ownershipType: 'Owned',
        status: 'Active',
        condition: 'Good',
        riskLevel: 'Medium',
        amcApplies: false,
        locationId: floor.id,
      });
      const cycle = await verification.startCycle(request(auditor), {
        locationId: root.id,
        reason: 'Physical stocktake',
      });
      const initial = await verification.listItems(request(auditor), cycle.id);
      assert.equal(initial.items.length, 1);
      assert.equal(initial.items[0].assetId, asset.id);
      assert.equal(initial.items[0].verificationStatus, 'PENDING');
      await assert.rejects(verification.completeCycle(request(auditor), cycle.id));

      await verification.recordItem(request(auditor), cycle.id, {
        assetId: asset.id,
        verificationStatus: 'WRONG_PLACE',
        actualLocationId: other.id,
        reason: 'Found at another site',
      });
      const checked = await verification.listItems(request(auditor), cycle.id);
      assert.equal(checked.items[0].actualLocationId, other.id);
      assert.equal(checked.items[0].actualLocation, `${tag} Other Site`);
      await assert.rejects(
        verification.recordItem(request(auditor), cycle.id, {
          assetId: asset.id,
          verificationStatus: 'WRONG_PLACE',
          reason: 'Missing actual location',
        }),
      );
      const summary = await verification.listCycles(request(auditor));
      assert.ok(summary.items.some((item: any) => item.id === cycle.id && item.totalItems === 1));
      assert.equal(
        (await verification.completeCycle(request(auditor), cycle.id)).status,
        'COMPLETED',
      );
    });

    it('executes the warranty/AMC and ticket timing report queries', async () => {
      const [warranty, timings] = await Promise.all([
        reports.warrantyExpiry(request(admin)),
        reports.ticketResponseTimes(request(admin)),
      ]);
      assert.ok(Array.isArray(warranty.items));
      assert.ok(Array.isArray(timings.items));
    });
  },
);
