import { test, expect, BrowserContext } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { config } from 'dotenv';
config({ quiet: true });
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated _test database required');
const pool = new Pool({ connectionString: url }),
  origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
const tag = `browser-equipment-${randomUUID().slice(0, 8)}`;
let assetId: string,
  assetCode: string,
  admin: any,
  finance: any,
  executive: any,
  employee: any,
  department: string;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function identity(roles: string[]) {
  const u = { id: randomUUID(), session: randomBytes(32).toString('hex'), csrf: '' };
  const raw = randomBytes(32).toString('hex');
  u.csrf =
    raw +
    '.' +
    createHmac('sha256', Buffer.from(process.env.CSRF_SECRET!, 'hex'))
      .update(raw)
      .digest('base64url');
  await pool.query(
    `INSERT INTO users(id,email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version,mfa_enrolled_at,department_id) VALUES($1,$2,$3,'ACTIVE',now(),now(),'1',now(),$4)`,
    [u.id, `${tag}-${u.id}@example.org`, `Demo ${roles.join(' ')}`, department],
  );
  for (const r of roles)
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [u.id, r]);
  await pool.query(
    `INSERT INTO sessions(id_hash,user_id,csrf_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,now()+interval '2 hours',now())`,
    [hash(u.session), u.id, hash(u.csrf)],
  );
  return u;
}
async function signIn(context: BrowserContext, u: any) {
  await context.clearCookies();
  await context.addCookies([
    { name: 'iac_dev_session', value: u.session, url: origin, httpOnly: true, sameSite: 'Strict' },
    { name: 'iac_dev_csrf', value: u.csrf, url: origin, sameSite: 'Strict' },
  ]);
}
const recipientName = `Synthetic Equipment ${tag}`;
const assets: { id: string; asset_code: string }[] = [];
test.use({ reducedMotion: 'reduce' });
test.beforeAll(async () => {
  department = (
    await pool.query('INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id', [tag])
  ).rows[0].id;
  admin = await identity(['ADMIN']);
  finance = await identity(['FINANCE']);
  employee = await identity(['EMPLOYEE']);
  await pool.query("UPDATE users SET display_name=$2,created_at='2010-01-01' WHERE id=$1", [
    employee.id,
    recipientName,
  ]);
  for (let i = 0; i < 27; i++)
    await pool.query(
      `WITH u AS(INSERT INTO users(email,display_name,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,'Synthetic Other Recipient','ACTIVE',now(),now(),'1') RETURNING id) INSERT INTO user_roles SELECT id,'EMPLOYEE' FROM u`,
      [`${tag}-later${i}@example.org`],
    );
  for (const type of ['Laptop', 'Mouse', 'Keyboard'])
    assets.push(
      (
        await pool.query(
          `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by,purchase_cost) VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',$1,$2,'Owned','In Store','Good','Low',$3,$4,1500) RETURNING id,asset_code`,
          [type, `${tag} ${type}`, department, admin.id],
        )
      ).rows[0],
    );
});
test.afterAll(async () => {
  await pool.end();
});
test('Admin maps three items to an older person, employee and Finance see appropriate grouped views', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.goto('/equipment/people');
  await page.getByLabel('Find a person').fill(recipientName);
  await page
    .getByRole('link', { name: `View equipment for ${recipientName}`, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: `${recipientName}'s equipment` })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'No equipment currently assigned' }),
  ).toBeVisible();
  let originalLaptopAssignment: string | undefined;
  const untouched = (
    await pool.query(
      'SELECT id,asset_id,user_id,version FROM assignments WHERE ended_at IS NULL AND user_id<>$1 ORDER BY id LIMIT 1',
      [employee.id],
    )
  ).rows[0];
  for (const [i, a] of assets.entries()) {
    await page.getByRole('link', { name: 'Assign another item', exact: true }).click();
    await page.getByLabel('Search assets').fill(a.asset_code);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: `Assign ${a.asset_code}`, exact: true }).click();
    await expect(page.getByLabel('Approved employee', { exact: true })).toContainText(
      recipientName,
    );
    await expect(
      page.getByRole('button', { name: 'Confirm assignment', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Use this person for this item', exact: true }).click();
    await page.getByLabel('Handover note', { exact: true }).fill(`Synthetic set, item ${i + 1}`);
    await page.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
    await expect(page.getByRole('heading', { name: `${recipientName}'s equipment` })).toBeVisible();
    await expect(page.getByRole('heading', { name: a.asset_code, exact: true })).toBeVisible();
    const current = (
      await pool.query(
        'SELECT id,asset_id,user_id,version FROM assignments WHERE asset_id=ANY($1::uuid[]) AND ended_at IS NULL',
        [assets.map((x) => x.id)],
      )
    ).rows;
    expect(current).toHaveLength(i + 1);
    expect(current.every((x) => x.user_id === employee.id)).toBe(true);
    const laptop = current.find((x) => x.asset_id === assets[0].id)!;
    if (i === 0) originalLaptopAssignment = laptop.id;
    expect(laptop.id).toBe(originalLaptopAssignment);
    expect(laptop.version).toBe(1);
    if (untouched)
      expect(
        (
          await pool.query(
            'SELECT id,asset_id,user_id,version FROM assignments WHERE id=$1 AND ended_at IS NULL',
            [untouched.id],
          )
        ).rows[0],
      ).toEqual(untouched);
  }
  await expect(page.locator('.equipment-item-card')).toHaveCount(3);
  await page.screenshot({ path: '/downloads/iac-equipment-admin-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.equipment-item-card')).toHaveCount(3);
  await page.screenshot({ path: '/downloads/iac-equipment-admin-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await signIn(context, employee);
  await page.goto('/equipment/mine');
  await expect(page.getByRole('heading', { name: 'My equipment', exact: true })).toBeVisible();
  await expect(page.locator('.equipment-item-card')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Assign another item' })).toHaveCount(0);
  await expect(page.getByText('Last approved cost:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Report an issue', exact: true })).toHaveCount(3);
  await page.screenshot({ path: '/downloads/iac-equipment-employee-mobile.png', fullPage: true });
  await signIn(context, finance);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/equipment/people/${employee.id}`);
  await expect(page.getByRole('link', { name: 'Open financial review', exact: true })).toHaveCount(
    3,
  );
  await expect(page.getByRole('link', { name: 'Manage item / return', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('link', { name: 'Assign another item' })).toHaveCount(0);
  await page.screenshot({ path: '/downloads/iac-equipment-finance-desktop.png', fullPage: true });
  const rows = (
    await pool.query(
      'SELECT asset_id,user_id FROM assignments WHERE asset_id=ANY($1::uuid[]) AND ended_at IS NULL',
      [assets.map((a) => a.id)],
    )
  ).rows;
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.user_id === employee.id)).toBe(true);
});
