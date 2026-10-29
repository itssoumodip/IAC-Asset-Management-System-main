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
const tag = `browser-fin-${randomUUID().slice(0, 8)}`;
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
test.use({ reducedMotion: 'reduce' });
test.beforeAll(async () => {
  const [d] = (
    await pool.query('INSERT INTO departments(code,name) VALUES($1,$1) RETURNING id', [tag])
  ).rows;
  department = d.id;
  admin = await identity(['ADMIN']);
  finance = await identity(['FINANCE']);
  executive = await identity(['EXECUTIVE']);
  employee = await identity(['EMPLOYEE']);
  const [a] = (
    await pool.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by) VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop',$1,'Owned','In Store','Good','Low',$2,$3) RETURNING id,asset_code`,
      [`${tag} demo laptop`, department, admin.id],
    )
  ).rows;
  assetId = a.id;
  assetCode = a.asset_code;
});
test.afterAll(async () => {
  await pool.end();
});
test('Admin can enter initial financial drafts for independent Finance review', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.goto('/assets/new');
  for (const label of [
    'Purchase cost (INR)',
    'Purchase date',
    'Invoice number',
    'Supplier',
    'Residual value (INR)',
    'Depreciation method',
    'Insurance policy number',
    'Insurance expiry',
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(1);
  await page.getByLabel('Purchase cost (INR)', { exact: true }).fill('65000');
  await page.getByLabel('Invoice number', { exact: true }).fill('SYNTHETIC-DRAFT');
  await page.getByLabel('Supplier', { exact: true }).fill('Example supplier');
  await page
    .getByRole('heading', { name: 'Financial metadata', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/downloads/iac-admin-financial-draft-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('heading', { name: 'Financial metadata', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/downloads/iac-admin-financial-draft-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('registrar submits, Finance returns and approves amendment, executive reads without edit powers', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.goto(`/finance/${assetId}`);
  await expect(page.getByRole('heading', { name: `Finance · ${assetCode}` })).toBeVisible();
  await page.getByLabel('Submission reason').fill('Synthetic invoice ready for independent review');
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/finance/assets/${assetId}/submit`) &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    ),
    page.getByRole('button', { name: 'Submit to Finance', exact: true }).click(),
  ]);
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Finance review', exact: true })).toBeVisible();
  await page.getByLabel('Asset code or description').fill(tag);
  await page.getByRole('link', { name: `Review ${assetCode}` }).click();
  await page.getByLabel('Decision', { exact: true }).selectOption('RETURN');
  await page.getByLabel('Review reason').fill('Correct the invoice reference before approval');
  await page.getByRole('button', { name: 'Return to registrar', exact: true }).click();
  await expect(page.getByText('RETURNED', { exact: true }).first()).toBeVisible();
  await signIn(context, admin);
  await page.goto(`/finance/${assetId}`);
  await page
    .getByLabel('Submission reason')
    .fill('Corrected source invoice attached in demo records');
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/finance/assets/${assetId}/submit`) &&
        r.request().method() === 'POST' &&
        r.status() === 201,
    ),
    page.getByRole('button', { name: 'Submit to Finance', exact: true }).click(),
  ]);
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto(`/finance/${assetId}`);
  await page.getByLabel('Purchase cost (INR)').fill('85000.50');
  await page.getByLabel('Purchase date', { exact: true }).fill('2026-01-15');
  await page.getByLabel('Invoice number').fill('DEMO-INV-2026-01');
  await page.getByLabel('Supplier', { exact: true }).fill('Synthetic Equipment Supplier');
  await page.getByLabel('Residual value (INR)', { exact: true }).fill('5000');
  await page.getByLabel('Useful life (years)', { exact: true }).fill('5');
  await page.getByLabel('Insurance policy number', { exact: true }).fill('SYNTHETIC-POL-42');
  await page.getByLabel('Insurance expiry', { exact: true }).fill('2027-01-15');
  await page
    .getByLabel('Review reason')
    .fill('Invoice total and asset identity independently verified');
  await page.screenshot({ path: '/downloads/iac-finance-review-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Record Finance approval', exact: true }).click();
  await expect(page.getByText('APPROVED', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/iac-finance-approved-desktop.png', fullPage: true });
  const financial = (
    await pool.query(
      'SELECT residual_value,useful_life_years,insurance_policy_number FROM assets WHERE id=$1',
      [assetId],
    )
  ).rows[0];
  expect(financial).toEqual({
    residual_value: '5000.00',
    useful_life_years: 5,
    insurance_policy_number: 'SYNTHETIC-POL-42',
  });
  const [row] = (
    await pool.query('SELECT state,approved_cost FROM asset_finance WHERE asset_id=$1', [assetId])
  ).rows;
  expect(row).toEqual({ state: 'APPROVED', approved_cost: '85000.50' });
  await signIn(context, executive);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { name: 'Executive overview', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Your executive role has read-only summary access.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'People & access' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Finance review', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/downloads/iac-executive-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Executive overview', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '/downloads/iac-executive-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`/finance/${assetId}`);
  await expect(page.getByRole('heading', { name: 'Finance access required' })).toBeVisible();
  await signIn(context, employee);
  await page.goto('/executive');
  await expect(page.getByRole('heading', { name: 'Executive access required' })).toBeVisible();
});
test('Finance history reaches older evidence through the real paginated API', async ({
  page,
  context,
}) => {
  await pool.query(
    `INSERT INTO asset_finance_events(asset_id,action,actor_id,reason,finance_version,occurred_at)
    SELECT $1,'SUBMITTED',$2,'Synthetic archived Finance event '||i,i,'2010-01-01 00:00:00.123456+00'::timestamptz
    FROM generate_series(1,57) i`,
    [assetId, admin.id],
  );
  await signIn(context, finance);
  await page.goto(`/finance/${assetId}`);
  const list = page.locator('.finance-history');
  await expect(list.locator('li')).toHaveCount(25);
  await page.getByRole('button', { name: 'Load earlier Finance events', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load earlier Finance events', exact: true }).click();
  const expected = Number(
    (await pool.query('SELECT count(*) FROM asset_finance_events WHERE asset_id=$1', [assetId]))
      .rows[0].count,
  );
  await expect(list.locator('li')).toHaveCount(expected);
  await expect(
    page.getByRole('button', { name: 'Load earlier Finance events', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await list.locator('li').last().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/downloads/iac-finance-history-paging-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .getByRole('heading', { name: 'Finance history', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/downloads/iac-finance-history-paging-desktop.png' });
});
test('Finance queue combines master-data filters and loads subsequent pages', async ({
  page,
  context,
}) => {
  await pool.query(
    `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by)
    SELECT 'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware',CASE WHEN i<=28 THEN 'Laptop' ELSE 'Monitor' END,$1,'Owned','In Store','Good','Low',$2,$3 FROM generate_series(1,30)i`,
    [`${tag} filter fixture`, department, admin.id],
  );
  await signIn(context, finance);
  await page.goto('/finance');
  await page.getByLabel('Asset code or description').fill(`${tag} filter fixture`);
  await page.getByLabel('Review state').selectOption('UNSUBMITTED');
  await expect(page.locator('#finance-department option').filter({ hasText: tag })).toHaveCount(1);
  await page.getByLabel('Department', { exact: true }).selectOption({ label: tag });
  await page.getByLabel('Asset type', { exact: true }).selectOption('Laptop');
  await expect(page.getByRole('link', { name: /^Review IAC/ })).toHaveCount(25);
  await page.getByRole('button', { name: 'Load more records', exact: true }).click();
  await expect(page.getByRole('link', { name: /^Review IAC/ })).toHaveCount(28);
  await expect(page.getByRole('button', { name: 'Load more records', exact: true })).toHaveCount(0);
  await page.getByLabel('Asset type', { exact: true }).selectOption('Monitor');
  await expect(page.getByRole('link', { name: /^Review IAC/ })).toHaveCount(2);
  await page.screenshot({ path: '/downloads/iac-finance-filters-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/downloads/iac-finance-filters-mobile.png' });
});
test('Finance mobile queue, errors and server unread history remain usable', async ({
  page,
  context,
}) => {
  await signIn(context, finance);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/finance');
  await page.getByLabel('Review state').selectOption('ALL');
  await page.getByLabel('Asset code or description').fill(tag);
  await expect(page.getByRole('link', { name: `Review ${assetCode}` })).toBeVisible();
  await page.screenshot({ path: '/downloads/iac-finance-queue-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Asset code or description').fill('no-such-synthetic-device');
  await expect(page.getByRole('heading', { name: 'No matching records' })).toBeVisible();
  const ids: string[] = [];
  for (let i = 0; i < 110; i++) {
    const [n] = (
      await pool.query(
        `INSERT INTO in_app_announcements(title,message,path,audience,department_id,created_at) VALUES($1,'Synthetic pagination check','/notifications','DEPARTMENT',$2,'2020-01-01'::timestamptz+$3*interval '1 minute') RETURNING id`,
        [`${tag} notice ${i}`, department, i],
      )
    ).rows;
    ids.push(n.id);
  }
  await pool.query(
    'INSERT INTO in_app_announcement_reads(announcement_id,user_id) SELECT unnest($1::uuid[]),$2',
    [ids.slice(1), finance.id],
  );
  await page.goto('/notifications');
  await page.getByRole('button', { name: /^Unread \d+$/ }).click();
  await expect(page.getByRole('heading', { name: `${tag} notice 0`, exact: true })).toBeVisible();
  await page.screenshot({ path: '/downloads/iac-old-unread-mobile.png', fullPage: true });
});
test('Admin delivery health shows retry evidence without message content and denies Finance', async ({
  page,
  context,
}) => {
  const o = (
    await pool.query(
      'INSERT INTO notification_outbox(event_key,template,payload) VALUES($1,$2,$3) RETURNING id',
      [randomUUID(), `${tag}-DELIVERY`, { ciphertext: 'DO-NOT-EXPOSE-PRIVATE-TOKEN' }],
    )
  ).rows[0];
  const d = (
    await pool.query(
      "INSERT INTO email_deliveries(outbox_id,recipient,state,attempts,last_error_code) VALUES($1,'synthetic-retry@example.org','DEAD',6,'EAUTH') RETURNING id",
      [o.id],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO email_attempts(delivery_id,attempt_number,result_code) VALUES($1,6,'EAUTH')",
    [d.id],
  );
  await signIn(context, admin);
  await page.goto('/admin/deliveries');
  await expect(
    page.getByRole('heading', { name: 'Email delivery health', exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/v1/admin/deliveries?state=DEAD') && r.status() === 200,
    ),
    page.getByLabel('Delivery state').selectOption('DEAD'),
  ]);
  await expect(page.locator('article').first()).toBeVisible();
  const card = page.locator('article').filter({ hasText: `${tag}-DELIVERY` });
  // Delivery IDs are random UUIDs, not chronological. Accumulated fixtures can
  // put this record on any page; exercise the real pagination rather than
  // assuming the newest insertion sorts first.
  while (!(await card.count())) {
    const more = page.getByRole('button', { name: 'Load more deliveries', exact: true });
    if (!(await more.count())) break;
    const count = await page.locator('article').count();
    await more.click();
    await expect.poll(() => page.locator('article').count()).toBeGreaterThan(count);
  }
  await expect(card).toBeVisible();
  await expect(card).toContainText('6 / 6');
  await card.getByText('Attempt history', { exact: true }).click();
  await expect(card).toContainText('Attempt 6: EAUTH');
  await expect(page.getByText('DO-NOT-EXPOSE-PRIVATE-TOKEN')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await card.screenshot({ path: '/downloads/iac-delivery-health-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Email delivery health', exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/v1/admin/deliveries?state=DEAD') && r.status() === 200,
    ),
    page.getByLabel('Delivery state').selectOption('DEAD'),
  ]);
  await expect(page.locator('article').first()).toBeVisible();
  // Delivery IDs are random UUIDs, not chronological. Accumulated fixtures can
  // put this record on any page; exercise the real pagination rather than
  // assuming the newest insertion sorts first.
  while (!(await card.count())) {
    const more = page.getByRole('button', { name: 'Load more deliveries', exact: true });
    if (!(await more.count())) break;
    const count = await page.locator('article').count();
    await more.click();
    await expect.poll(() => page.locator('article').count()).toBeGreaterThan(count);
  }
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.screenshot({ path: '/downloads/iac-delivery-health-mobile.png' });
  await signIn(context, finance);
  await page.goto('/admin/deliveries');
  await expect(
    page.getByRole('heading', { name: 'Email delivery health', exact: true }),
  ).toHaveCount(0);
  const response = await page.request.get('/api/v1/admin/deliveries');
  expect(response.status()).toBe(403);
});

test('new UI asset keeps department and person mapping through Finance return and approval', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.goto('/assets/new');
  await page.getByLabel('Description', { exact: true }).fill(`${tag} mapped arrival`);
  for (const [label, id, option] of [
    ['Asset type', 'assetType', 'Laptop'],
    ['Category', 'category', 'IT Hardware'],
    ['Ownership type', 'ownershipType', 'Owned'],
    ['Condition', 'condition', 'Good'],
    ['Risk level', 'riskLevel', 'Low'],
    ['Department', 'departmentId', tag],
  ]) {
    await page.getByLabel(label, { exact: true }).click();
    await page
      .locator(`#${id} ~ ul`)
      .getByRole('option', { name: option, exact: true })
      .first()
      .click();
  }
  await page.getByRole('button', { name: 'Create asset', exact: true }).click();
  await expect(page).toHaveURL(/assets\/[a-f0-9-]+$/);
  const id = page.url().split('/').at(-1)!;
  const a = (
    await pool.query('SELECT id,asset_code,department_id,version FROM assets WHERE id=$1', [id])
  ).rows[0];
  expect(a.department_id).toBe(department);
  await page.goto(`/assets/${id}/assign?person=${employee.id}`);
  await page.getByRole('button', { name: 'Use this person for this item', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/equipment/people/' + employee.id + '$'));
  await page.goto(`/finance/${id}`);
  await page
    .getByLabel('Submission reason')
    .fill('New arrival mapped to correct department and employee');
  await page.getByRole('button', { name: 'Submit to Finance', exact: true }).click();
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  const post = async (path: string, version: number, data: unknown) =>
    page.request.post('/api/v1' + path, {
      headers: {
        Origin: origin,
        'X-CSRF-Token': (await context.cookies()).find((c) => c.name === 'iac_dev_csrf')!.value,
        'If-Match': `"${version}"`,
      },
      data,
    });
  const asset = (await pool.query('SELECT * FROM assets WHERE id=$1', [id])).rows[0];
  expect(
    (
      await post(`/finance/assets/${id}/submit`, asset.version, {
        reason: 'Duplicate test submission',
      })
    ).status(),
  ).toBe(409);
  await signIn(context, finance);
  await page.goto('/finance');
  await page.getByLabel('Department', { exact: true }).selectOption(department);
  await page.getByLabel('Asset code or description').fill(a.asset_code);
  await page.getByRole('link', { name: `Review ${a.asset_code}`, exact: true }).click();
  await page.getByLabel('Decision', { exact: true }).selectOption('RETURN');
  await page.getByLabel('Review reason').fill('Verify arrival invoice before approval');
  await page.getByRole('button', { name: 'Return to registrar', exact: true }).click();
  await expect(page.getByText('RETURNED', { exact: true }).first()).toBeVisible();
  await signIn(context, admin);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Submission reason').fill('Invoice independently reconciled');
  await page.getByRole('button', { name: 'Submit to Finance', exact: true }).click();
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Purchase cost (INR)').fill('12345.67');
  await page.getByLabel('Purchase date', { exact: true }).fill('2026-10-28');
  await page.getByLabel('Invoice number').fill('SYNTHETIC-MAPPING-INV');
  await page.getByLabel('Supplier', { exact: true }).fill('Synthetic Mapping Supplier');
  await page.getByLabel('Review reason').fill('Arrival and employee mapping verified');
  await page.getByRole('button', { name: 'Record Finance approval', exact: true }).click();
  await expect(page.getByText('APPROVED', { exact: true }).first()).toBeVisible();
  const mapping = (
    await pool.query(
      'SELECT a.department_id,x.user_id,f.state,f.approved_cost FROM assets a JOIN assignments x ON x.asset_id=a.id AND x.ended_at IS NULL JOIN asset_finance f ON f.asset_id=a.id WHERE a.id=$1',
      [id],
    )
  ).rows[0];
  expect(mapping).toEqual({
    department_id: department,
    user_id: employee.id,
    state: 'APPROVED',
    approved_cost: '12345.67',
  });
  const history = (
    await pool.query(
      'SELECT action FROM asset_finance_events WHERE asset_id=$1 ORDER BY occurred_at,id',
      [id],
    )
  ).rows.map((r) => r.action);
  expect(history).toEqual(['SUBMITTED', 'RETURNED', 'SUBMITTED', 'APPROVED']);
  const mail = (
    await pool.query('SELECT template FROM notification_outbox WHERE event_key LIKE $1', [
      `finance:${id}:%`,
    ])
  ).rows
    .map((r) => r.template)
    .sort();
  expect(mail).toEqual([
    'FINANCE_APPROVED',
    'FINANCE_RETURNED',
    'FINANCE_SUBMITTED',
    'FINANCE_SUBMITTED',
  ]);
  await signIn(context, executive);
  await page.goto('/executive');
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByRole('heading', { name: 'Executive overview', exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`/api/v1/finance/assets/${id}`)).status()).toBe(403);
  await signIn(context, employee);
  await page.goto('/equipment/mine');
  await expect(page.getByRole('heading', { name: a.asset_code, exact: true })).toBeVisible();
  await expect(page.getByText('₹12,345.67', { exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/finance/assets/${id}`)).status()).toBe(403);
  await page.screenshot({ path: '/downloads/iac-mapped-arrival-employee.png' });
});

test('Admin can edit non-financial metadata after Finance approval without resending protected cost fields', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assets(id,asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,department_id,created_by,purchase_cost,purchase_date,invoice_number,supplier)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Synthetic approved edit','Owned','In Store','Good','Low',$2,$3,65000,'2026-01-15','SYNTHETIC-EDIT','Synthetic supplier')`,
    [id, department, admin.id],
  );
  await pool.query(
    `INSERT INTO asset_finance(asset_id,state,asset_version,submitted_by,submission_reason,approved_cost,approved_at,approved_by)VALUES($1,'APPROVED',1,$2,'Synthetic approved edit fixture',65000,now(),$3)`,
    [id, admin.id, finance.id],
  );
  await page.goto(`/assets/${id}/edit`);
  await page
    .getByLabel('Remarks', { exact: true })
    .fill('Updated storage and accountability note only');
  await page
    .getByLabel('Reason for this change', { exact: true })
    .fill('Non-financial record correction');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/assets/' + id) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(200);
  await expect(page).toHaveURL(new RegExp('/assets/' + id + '$'));
  const row = (await pool.query('SELECT remarks,purchase_cost FROM assets WHERE id=$1', [id]))
    .rows[0];
  expect(row).toEqual({
    remarks: 'Updated storage and accountability note only',
    purchase_cost: '65000.00',
  });
  await page.goto(`/assets/${id}/edit`);
  await expect(page.getByLabel('Purchase cost (INR)', { exact: true })).toHaveCount(1);
  const protectedResponse = await page.request.patch('/api/v1/assets/' + id, {
    headers: { Origin: origin, 'X-CSRF-Token': admin.csrf, 'If-Match': '"2"' },
    data: { purchaseCost: '66000.00', reason: 'Attempt to bypass Finance review' },
  });
  expect(protectedResponse.status()).toBe(409);
  expect(
    (await pool.query('SELECT purchase_cost FROM assets WHERE id=$1', [id])).rows[0].purchase_cost,
  ).toBe('65000.00');
  await page.screenshot({ path: '/downloads/iac-approved-edit-protected.png' });
});

test('Finance reviews invoice extraction before applying fields and separately approves', async ({
  page,
  context,
}) => {
  const Excel = (await import('exceljs')).default;
  const wb = new Excel.Workbook(),
    ws = wb.addWorksheet('Invoice');
  ws.addRow(['Supplier', 'Example Systems']);
  ws.addRow(['Invoice Number', 'INV-1042']);
  ws.addRow(['Invoice Date', '2026-10-28']);
  ws.addRow(['Grand Total', 'INR 65000.00']);
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assets(id,asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Invoice extraction browser','Owned','In Store','Good','Low',$2)`,
    [id, admin.id],
  );
  await signIn(context, admin);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Submission reason').fill('Invoice ready for review');
  await page.getByRole('button', { name: 'Submit to Finance', exact: true }).click();
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Invoice file (PDF or XLSX)').setInputFiles({
    name: 'Invoice.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: bytes,
  });
  await expect(
    page.getByText('Evidence saved. Asset values and Finance approval are unchanged.'),
  ).toBeVisible();
  await expect(page.getByLabel('Purchase cost (INR)', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Apply selected suggestions to form' }),
  ).toBeDisabled();
  for (const label of ['Invoice total (INR)', 'Purchase date:', 'Invoice number:', 'Supplier:'])
    await page.getByRole('checkbox', { name: new RegExp(label.replace(/[()]/g, '\\$&')) }).check();
  await page.getByRole('checkbox', { name: /I checked the original/ }).check();
  await page.getByRole('button', { name: 'Apply selected suggestions to form' }).click();
  await expect(page.getByLabel('Purchase cost (INR)', { exact: true })).toHaveValue('65000.00');
  await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('INV-1042');
  expect(
    (await pool.query('SELECT state FROM asset_finance WHERE asset_id=$1', [id])).rows[0].state,
  ).toBe('SUBMITTED');
  await page.screenshot({ path: '/downloads/iac-invoice-suggestions-desktop.png', fullPage: true });
  await page
    .getByLabel('Review reason')
    .fill('Original invoice and per-asset cost independently checked');
  await page.getByRole('button', { name: 'Record Finance approval', exact: true }).click();
  await expect(page.getByText('APPROVED', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Original invoice used for this approval' }),
  ).toBeVisible();
  const evidence = (
    await pool.query(
      "SELECT details FROM asset_finance_events WHERE asset_id=$1 AND action='APPROVED'",
      [id],
    )
  ).rows[0].details;
  expect(evidence.invoiceEvidence.id).toBeTruthy();
  expect(evidence.invoiceEvidence.sha256).toMatch(/^[a-f0-9]{64}$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText(/bytes · SHA-256/)).toBeVisible();
  expect(
    await page.getByText(/bytes · SHA-256/).evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: '/downloads/iac-invoice-evidence-mobile.png' });
});

test('invoice apply preserves unchecked manual fields and malformed upload gives a useful error', async ({
  page,
  context,
}) => {
  const Excel = (await import('exceljs')).default,
    wb = new Excel.Workbook();
  const ws = wb.addWorksheet('Invoice');
  ws.addRow(['Supplier', 'Suggested Supplier']);
  ws.addRow(['Grand Total', 'INR 100.00']);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assets(id,asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Selective invoice fields','Owned','In Store','Good','Low',$2)`,
    [id, admin.id],
  );
  await signIn(context, admin);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Submission reason').fill('Review only selected fields');
  await page.getByRole('button', { name: 'Submit to Finance', exact: true }).click();
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Supplier', { exact: true }).fill('Manually verified supplier');
  await page
    .getByLabel('Invoice file (PDF or XLSX)')
    .setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toContainText('Invalid PDF signature');
  await expect(page.getByLabel('Supplier', { exact: true })).toHaveValue(
    'Manually verified supplier',
  );
  await page.getByLabel('Invoice file (PDF or XLSX)').setInputFiles({
    name: 'Invoice.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  });
  await expect(
    page.getByText('Evidence saved. Asset values and Finance approval are unchanged.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: /Invoice total/ }).check();
  await page.getByRole('checkbox', { name: /I checked the original/ }).check();
  await page.getByRole('button', { name: 'Apply selected suggestions to form' }).click();
  await expect(page.getByLabel('Purchase cost (INR)', { exact: true })).toHaveValue('100.00');
  await expect(page.getByLabel('Supplier', { exact: true })).toHaveValue(
    'Manually verified supplier',
  );
  await page.getByRole('button', { name: 'Record Finance approval' }).click();
  expect(
    (await pool.query('SELECT state FROM asset_finance WHERE asset_id=$1', [id])).rows[0].state,
  ).toBe('SUBMITTED');
});

test('workflow inbox links Finance requests, keeps read state and does not expose another role', async ({
  page,
  context,
}) => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO assets(id,asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Workflow notification browser','Owned','In Store','Good','Low',$2)`,
    [id, admin.id],
  );
  await signIn(context, admin);
  await page.goto(`/finance/${id}`);
  await page.getByLabel('Submission reason').fill('Independent invoice review');
  await page.getByRole('button', { name: 'Submit to Finance', exact: true }).click();
  await expect(page.getByText('SUBMITTED', { exact: true }).first()).toBeVisible();
  await signIn(context, finance);
  await page.goto('/notifications');
  const [notice] = (
    await pool.query('SELECT title FROM workflow_notifications WHERE user_id=$1 AND entity_id=$2', [
      finance.id,
      id,
    ])
  ).rows;
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: notice.title, exact: true }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Unread');
  await page.screenshot({ path: '/downloads/iac-workflow-inbox-desktop.png', fullPage: true });
  await card.getByRole('button', { name: 'Mark workflow as read' }).click();
  await expect(card).toContainText('Read');
  await expect(card.getByRole('button', { name: 'Mark workflow as read' })).toHaveCount(0);
  await page.reload();
  await expect(card.getByRole('button', { name: 'Mark workflow as read' })).toHaveCount(0);
  await card.getByRole('link', { name: 'Open workflow' }).click();
  await expect(page).toHaveURL(new RegExp(`/finance/${id}$`));
  await page.goto('/notifications');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/downloads/iac-workflow-inbox-mobile.png', fullPage: true });
  await signIn(context, executive);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: notice.title, exact: true })).toHaveCount(0);
});

test('camera scanner decodes generated QR pixels through simulated video stream and opens live asset', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    (window as any).__iacHoldQrPixels = true;
  });
  const QRCode = await import('qrcode');
  const id = randomUUID();
  const [asset] = (
    await pool.query(
      `INSERT INTO assets(id,asset_code,category,asset_type,description,manufacturer,model,ownership_type,status,condition,risk_level,created_by)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Dell Latitude 5450','Dell','Latitude 5450','Owned','In Store','Good','Low',$2)RETURNING asset_code`,
      [id, admin.id],
    )
  ).rows;
  const encoded = await QRCode.toDataURL(`${origin}/a/${asset.asset_code}`, {
    width: 400,
    margin: 4,
    errorCorrectionLevel: 'M',
  });
  await page.addInitScript(
    ({ data }) => {
      const media = navigator.mediaDevices;
      Object.defineProperty(media, 'enumerateDevices', {
        value: async () => [
          {
            kind: 'videoinput',
            deviceId: 'simulated-qr',
            label: 'Simulated QR video',
            groupId: 'qr',
          },
        ],
      });
      Object.defineProperty(media, 'getUserMedia', {
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 800;
          canvas.height = 800;
          const c = canvas.getContext('2d')!;
          c.fillStyle = 'white';
          c.fillRect(0, 0, 800, 800);
          const image = new Image();
          image.src = data;
          await image.decode();
          const stream = canvas.captureStream(10);
          let frames = 0;
          setInterval(() => {
            c.fillStyle = 'white';
            c.fillRect(0, 0, 800, 800);
            if (++frames > 20 && !(window as any).__iacHoldQrPixels)
              c.drawImage(image, 200, 200, 400, 400);
          }, 100);
          return stream;
        },
      });
    },
    { data: encoded },
  );
  await signIn(context, employee);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Open camera scanner', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Scan asset label' })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((v) => v.readyState)).toBeGreaterThan(1);
  const dialog = page.getByRole('dialog', { name: 'Scan asset label' });
  expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await page.screenshot({ path: '/downloads/iac-scanner-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: '/downloads/iac-simulated-qr-camera.png' });
  await page.evaluate(() => {
    (window as any).__iacHoldQrPixels = false;
  });
  await expect(page).toHaveURL(new RegExp(`/a/${asset.asset_code}$`), { timeout: 15000 });
  await expect(page.getByRole('heading', { name: asset.asset_code, exact: true })).toBeVisible();
  await expect(page.getByText('Dell Latitude 5450', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: '/downloads/iac-simulated-qr-result.png', fullPage: true });
});

test('Executive weekly activity renders defined source counts at desktop and mobile', async ({
  page,
  context,
}) => {
  await signIn(context, executive);
  await page.goto('/executive');
  await expect(page.getByRole('heading', { name: 'Recorded activity by week' })).toBeVisible();
  await expect(page.locator('.executive-activity-week')).toHaveCount(12);
  await expect(
    page.getByText(
      'Monday-start weeks · Asia/Kolkata · current week is partial. Counts are events, not spending or historical backlog.',
    ),
  ).toBeVisible();
  await page.getByText('Exact weekly counts and definitions', { exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Approval events', exact: true }),
  ).toBeVisible();
  await page.getByRole('heading', { name: 'Recorded activity by week' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/downloads/iac-executive-trends-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Recorded activity by week' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/downloads/iac-executive-trends-mobile.png' });
});

test('Admin freezes stocktake, records evidence and closes without changing inventory', async ({
  page,
  context,
}) => {
  const id = randomUUID();
  const [asset] = (
    await pool.query(
      `INSERT INTO assets(id,asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by)VALUES($1,'IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Dell Latitude count example','Owned','In Store','Good','Low',$2)RETURNING asset_code`,
      [id, admin.id],
    )
  ).rows;
  await signIn(context, admin);
  await page.goto('/admin/stocktake');
  const countName = 'October Operations count ' + randomUUID().slice(0, 8);
  await page.getByLabel('Count name').fill(countName);
  await pool.query('UPDATE assets SET department_id=$2 WHERE id=$1', [id, department]);
  await page.getByLabel('Count department scope').selectOption(department);
  await page.screenshot({ path: '/downloads/iac-stocktake-scope-form.png' });
  await page.getByRole('button', { name: 'Create frozen stocktake' }).click();
  await page.getByRole('link', { name: countName, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Record an observation' })).toBeVisible();
  const run = page.url().split('/').pop();
  expect(
    (await pool.query('SELECT scope FROM stocktake_runs WHERE id=$1', [run])).rows[0].scope
      .departmentId,
  ).toBe(department);
  const expected = (
    await pool.query('SELECT asset_id FROM stocktake_expected WHERE run_id=$1', [run])
  ).rows;
  expect(expected.some((x) => x.asset_id === id)).toBe(true);
  expect(
    (
      await pool.query(
        'SELECT count(*)::int n FROM stocktake_expected e JOIN assets a ON a.id=e.asset_id WHERE e.run_id=$1 AND a.department_id IS DISTINCT FROM $2',
        [run, department],
      )
    ).rows[0].n,
  ).toBe(0);
  await expect(page.getByText(/Frozen scope:/)).toContainText(tag);
  await page.getByLabel('Observed asset ID').fill(asset.asset_code);
  await page.getByLabel('Observation', { exact: true }).selectOption('MISMATCH');
  await page
    .getByLabel('Observation evidence or difference')
    .fill('Physical serial differs from expected label. Investigate before correction.');
  await page.getByRole('button', { name: 'Save observation only' }).click();
  await expect(
    page.getByText('Observation saved. Asset, custody and Finance values are unchanged.'),
  ).toBeVisible();
  const [record] = (
    await pool.query('SELECT * FROM stocktake_observations WHERE run_id=$1 AND asset_id=$2', [
      run,
      id,
    ])
  ).rows;
  expect(record.outcome).toBe('MISMATCH');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/iac-stocktake-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/iac-stocktake-mobile.png' });
  await page
    .getByLabel('Closing reason')
    .fill('Count completed with exceptions. No inventory correction approved.');
  await page.getByRole('button', { name: 'Close count', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Count closed', exact: true })).toBeVisible();
  expect((await pool.query('SELECT version,status FROM assets WHERE id=$1', [id])).rows[0]).toEqual(
    { version: 1, status: 'In Store' },
  );
  await signIn(context, finance);
  await page.goto('/admin/stocktake');
  await expect(page.getByText('Admin access required', { exact: true })).toBeVisible();
});

test('Admin lifecycle attention shows coverage and role-changed custody with no automatic changes', async ({
  page,
  context,
}) => {
  const person = randomUUID(),
    name = 'Recovery planning ' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO users(id,email,display_name,state)VALUES($1,$2,$3,'DISABLED')", [
    person,
    `recovery-${person}@example.org`,
    name,
  ]);
  const [a] = (
    await pool.query(
      `INSERT INTO assets(asset_code,category,asset_type,description,ownership_type,status,condition,risk_level,created_by,warranty_expiry,amc_applies)VALUES('IAC-IT-'||lpad(nextval('asset_number_seq')::text,6,'0'),'IT Hardware','Laptop','Dell Latitude coverage','Owned','Assigned','Good','Low',$1,(now() AT TIME ZONE 'Asia/Kolkata')::date+10,false)RETURNING id`,
      [admin.id],
    )
  ).rows;
  await pool.query('INSERT INTO assignments(asset_id,user_id,assigned_by)VALUES($1,$2,$3)', [
    a.id,
    person,
    admin.id,
  ]);
  await signIn(context, admin);
  await page.goto('/admin/lifecycle');
  await expect(page.getByRole('heading', { name: 'Warranty and AMC attention' })).toBeVisible();
  await page.getByLabel('Find a person for recovery').fill(name);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('1 outstanding items · 0 disputed')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/iac-lifecycle-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/downloads/iac-lifecycle-mobile.png' });
  await page.getByRole('link', { name: "Review this person's equipment" }).click();
  await expect(page).toHaveURL(new RegExp(`/equipment/people/${person}$`));
  await expect(
    page.getByRole('heading', { name: name + "'s equipment", exact: true }),
  ).toBeVisible();
  expect(
    (await pool.query('SELECT status,version FROM assets WHERE id=$1', [a.id])).rows[0],
  ).toEqual({ status: 'Assigned', version: 1 });
});
