// Guided Zoho setup: exchanges a Self Client code for a refresh token and saves the
// ZOHO_* settings into .env. Values are typed by the user and sent only to Zoho.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();

console.log('Zoho People setup. Have the api-console.zoho.in Self Client page open.\n');
const clientId = await ask('1/3 Client ID (Client Secret tab): ');
const clientSecret = await ask('2/3 Client Secret (Client Secret tab): ');
const code = await ask('3/3 Code you just generated (Generate Code tab, valid 10 minutes): ');
rl.close();
if (!clientId || !clientSecret || !code) {
  console.error('\nAll three values are needed. Nothing was saved.');
  process.exit(1);
}

const dc = process.env.ZOHO_DC || 'in';
const response = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
  }),
});
const result = await response.json().catch(() => ({}));
if (!result.refresh_token) {
  console.error(
    `\nZoho did not return a refresh token (${result.error ?? response.status}).` +
      '\nThe code may have expired or been used already: generate a new code and run this again.',
  );
  process.exit(1);
}

const settings = {
  ZOHO_CLIENT_ID: clientId,
  ZOHO_CLIENT_SECRET: clientSecret,
  ZOHO_REFRESH_TOKEN: result.refresh_token,
  ZOHO_DC: dc,
};
let env = await readFile('.env', 'utf8');
const newline = env.includes('\r\n') ? '\r\n' : '\n';
for (const [key, value] of Object.entries(settings)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}${newline}${line}${newline}`;
}
await writeFile('.env', env);
console.log('\nSaved ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_DC to .env.');
console.log('Restart the app (npm run dev), then open Directory & Zoho and click Sync now.');
