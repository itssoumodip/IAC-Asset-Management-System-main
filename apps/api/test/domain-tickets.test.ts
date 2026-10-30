import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { TicketDomain } from '../src/domain-tickets';

test('new-ticket recipient lookup selects only active, verified Admin accounts', async () => {
  let statement = '';
  const domain = new TicketDomain({
    query: async (sql: string) => {
      statement = sql;
      return [{ email: 'admin@example.org' }];
    },
  } as never);

  const recipients = await domain.adminRecipients({} as PoolClient);

  assert.deepEqual(recipients, ['admin@example.org']);
  assert.match(statement, /u\.state='ACTIVE'/);
  assert.match(statement, /u\.email_verified_at IS NOT NULL/);
  assert.match(statement, /ur\.role_code='SUPER_ADMIN'/);
  assert.doesNotMatch(statement, /IT_ADMIN/);
});
