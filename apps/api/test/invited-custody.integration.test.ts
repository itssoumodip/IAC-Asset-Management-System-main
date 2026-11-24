import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db';
import { PeopleService } from '../src/people';
import { eligibleEmployee } from '../src/domain-helpers';

const connection = process.env.TEST_DATABASE_URL;
if (connection && !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Invited custody integration requires a database ending _test');
const tag = `inv-${randomUUID().slice(0, 8)}`;

describe('invited people can be given custody', { skip: !connection, concurrency: false }, () => {
  let db: Db, people: PeopleService;
  const invited = randomUUID();
  const invitedLeft = randomUUID();
  const admin: any = { id: randomUUID(), roles: ['SUPER_ADMIN'], teams: [] };
  before(async () => {
    db = new Db();
    people = new PeopleService(db);
    for (const [id, left] of [[invited, false], [invitedLeft, true]] as const) {
      await db.query(
        `INSERT INTO users(id,email,display_name,state,left_at) VALUES($1,$2,$3,'INVITED',${left ? 'now()' : 'NULL'})`,
        [id, `${tag}-${id}@example.org`, `${tag} ${left ? 'left' : 'here'}`],
      );
      await db.query("INSERT INTO user_roles(user_id, role_code) VALUES($1,'EMPLOYEE') ON CONFLICT DO NOTHING", [id]);
    }
  });
  after(async () => db?.onModuleDestroy());

  it('shows an invited person who has not signed in, but not one who has left', async () => {
    const found = await people.assignableAnywhere({ user: admin } as any, { q: tag });
    const ids = found.items.map((p: any) => p.id);
    assert.ok(ids.includes(invited));
    assert.ok(!ids.includes(invitedLeft));
  });

  it('accepts them when the assignment is saved', async () => {
    await db.tx(async (c) => {
      const user = await eligibleEmployee(db, invited, c);
      assert.equal(user.id, invited);
      await assert.rejects(eligibleEmployee(db, invitedLeft, c));
    });
  });
});
