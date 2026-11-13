import { config } from 'dotenv';
import { spawn } from 'node:child_process';
config({ quiet: true });
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must name an isolated _test database');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('Run integration tests with npm run test:integration');
const child = spawn(process.execPath, [cli, 'run', 'test:integration', '-w', '@iac/api'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: connection,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '11025',
    SMTP_SECURE: 'false',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: 'synthetic-tests@example.org',
    // Tests deliver only to the local Mailpit catcher above, so delivery can be exercised.
    OUTBOUND_NOTIFICATIONS: 'on',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('Could not start isolated integration tests');
  process.exitCode = 1;
});
child.on('exit', (code) => process.exit(code ?? 1));
