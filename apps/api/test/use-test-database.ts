// Loaded before every integration test (see the test:integration scripts). Tests open the
// database through DATABASE_URL, which the shared .env points at the development database, so
// test data used to land there. Point it at TEST_DATABASE_URL instead, and refuse anything that
// is not a database ending _test.
import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env'), quiet: true });
const test = process.env.TEST_DATABASE_URL;
if (test) {
  if (!new URL(test).pathname.endsWith('_test'))
    throw new Error('TEST_DATABASE_URL must select a database name ending _test');
  process.env.DATABASE_URL = test;
}
