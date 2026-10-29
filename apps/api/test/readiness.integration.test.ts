import 'reflect-metadata';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { Db } from '../src/db';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated _test database required');
let app: INestApplication, db: Db, base: string;
before(async () => {
  process.env.DATABASE_URL = url;
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  db = app.get(Db);
});
after(async () => app?.close());
test('liveness and schema-aware readiness expose only status', async () => {
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const ready = await fetch(base + '/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });
});
test('readiness fails closed for a missing migration or database failure without leaking details', async () => {
  const original = db.query.bind(db);
  try {
    db.query = async () => [];
    let result = await fetch(base + '/ready');
    assert.equal(result.status, 503);
    let body = await result.json();
    assert.equal(body.error.message, 'Application is not ready');
    assert.ok(!JSON.stringify(body).includes('018_'));
    db.query = async () => {
      throw new Error('private connection material must stay private');
    };
    result = await fetch(base + '/ready');
    assert.equal(result.status, 503);
    body = await result.json();
    assert.ok(!JSON.stringify(body).includes('private connection'));
  } finally {
    db.query = original;
  }
  const recovered = await fetch(base + '/ready');
  assert.equal(recovered.status, 200);
});
