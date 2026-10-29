import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm, stat, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scripts = new URL('./', import.meta.url);
test('local setup generates private loopback fake-mail settings and preserves existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iac-setup-regression-'));
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(new URL('setup-local.mjs', scripts), join(root, 'scripts/setup-local.mjs'));
    const run = () =>
      spawnSync(process.execPath, ['scripts/setup-local.mjs'], { cwd: root, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0);
    const file = join(root, '.env'),
      content = await readFile(file, 'utf8');
    assert.match(content, /SMTP_HOST=127\.0\.0\.1\nSMTP_PORT=11025\nSMTP_SECURE=false/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    for (const line of content
      .split('\n')
      .filter((l) => /^(DB_PASSWORD|.*ENCRYPTION_KEY|CSRF_SECRET)=/.test(l))) {
      const value = line.split('=')[1];
      assert.ok(value.length >= 48);
      assert.ok(!first.stdout.includes(value));
    }
    assert.equal(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  'production setup rejects unsafe inputs, stores secrets privately and never prints them',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'iac-production-regression-'));
    try {
      await mkdir(join(root, 'scripts'));
      await copyFile(
        new URL('setup-production-env.sh', scripts),
        join(root, 'scripts/setup-production-env.sh'),
      );
      const file = join(root, '.env.production');
      const run = (input) =>
        spawnSync('bash', ['scripts/setup-production-env.sh'], {
          cwd: root,
          input,
          encoding: 'utf8',
        });
      for (const input of [
        'https://invalid.example/path\n',
        'valid.example\nnot-an-email\n',
        'valid.example\nsender@example.org\nshort\n',
      ]) {
        assert.notEqual(run(input).status, 0);
        await assert.rejects(stat(file));
      }
      const sample = randomBytes(8).toString('hex');
      const result = run(
        `assets.example.org\nsender@example.org\n${sample.match(/.{4}/g).join(' ')}\n`,
      );
      assert.equal(result.status, 0);
      const content = await readFile(file, 'utf8');
      assert.equal(
        content
          .split('\n')
          .find((line) => line.startsWith('SMTP_PASSWORD='))
          .split('=')[1],
        sample,
      );
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      for (const line of content
        .split('\n')
        .filter((l) => /PASSWORD|KEY|SECRET/.test(l.split('=')[0]))) {
        assert.ok(!result.stdout.includes(line.split('=')[1]));
        assert.ok(!result.stderr.includes(line.split('=')[1]));
      }
      assert.notEqual(run('').status, 0);
      assert.equal(await readFile(file, 'utf8'), content);
      await unlink(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('production proxy permits the API JSON envelope but preserves matching API routing', async () => {
  const nginx = await readFile(new URL('../infra/nginx.conf', import.meta.url), 'utf8');
  assert.match(nginx, /location \/api\/ \{[^}]*client_max_body_size 6m;/);
  assert.match(nginx, /proxy_pass http:\/\/api:3000/);
  const caddy = await readFile(new URL('../infra/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /handle \/api\/\*/);
  assert.match(caddy, /reverse_proxy api:3000/);
});
