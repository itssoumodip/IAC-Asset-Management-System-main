import { test, expect, request as requests, APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { hash } from 'argon2';
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto';
import { config } from 'dotenv';
config({ quiet: true });
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Isolated TEST_DATABASE_URL required');
const pool = new Pool({ connectionString: url });
const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
let admin: APIRequestContext, employee: APIRequestContext, other: APIRequestContext;
let csrfAdmin = '',
  csrfEmployee = '',
  csrfOther = '';
const suffix = randomUUID().slice(0, 8),
  password = randomBytes(24).toString('base64url');
const emails = {
  admin: `admin-${suffix}@example.org`,
  employee: `employee-${suffix}@example.org`,
  other: `other-${suffix}@example.org`,
};
const ids = { admin: randomUUID(), employee: randomUUID(), other: randomUUID() };
function otp(secret: string) {
  let bits = '';
  for (const ch of secret.toUpperCase())
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let n = 0; n + 8 <= bits.length; n += 8) bytes.push(parseInt(bits.slice(n, n + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
async function write(
  ctx: APIRequestContext,
  csrf: string,
  path: string,
  body: unknown,
  version?: number,
  method = 'POST',
) {
  const r = await ctx.fetch('/api/v1' + path, {
    method,
    headers: {
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Idempotency-Key': randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
    data: body,
  });
  return r;
}
async function login(ctx: APIRequestContext, email: string) {
  const c = await ctx.get('/api/v1/auth/csrf');
  let token = (await c.json()).csrfToken;
  const r = await write(ctx, token, '/auth/login', { email, password });
  expect(r.status(), await r.text()).toBeLessThan(300);
  token = (await (await ctx.get('/api/v1/auth/csrf')).json()).csrfToken;
  return token;
}
test.beforeAll(async () => {
  const probe = await requests.newContext({ baseURL: origin });
  await expect
    .poll(
      async () => {
        try {
          return (await probe.get('/api/v1/health')).status();
        } catch {
          return 0;
        }
      },
      { timeout: 45000 },
    )
    .toBe(200);
  await probe.dispose();
  await pool.query('DELETE FROM auth_rate_limits WHERE key_hash=ANY($1::text[])', [
    ['ip:127.0.0.1', 'ip:::ffff:127.0.0.1'].map((v) =>
      createHash('sha256').update(v).digest('hex'),
    ),
  ]);
  const ph = await hash(password);
  for (const [name, id] of Object.entries(ids)) {
    await pool.query(
      `INSERT INTO users(id,email,display_name,password_hash,state,email_verified_at,portal_accepted_at,portal_notice_version) VALUES($1,$2,$3,$4,'ACTIVE',now(),$5,'1')`,
      [
        id,
        emails[name as keyof typeof emails],
        `Test ${name}`,
        ph,
        name === 'employee' ? null : new Date(),
      ],
    );
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [
      id,
      name === 'admin' ? 'ADMIN' : 'EMPLOYEE',
    ]);
  }
  admin = await requests.newContext({ baseURL: origin });
  employee = await requests.newContext({ baseURL: origin });
  other = await requests.newContext({ baseURL: origin });
  csrfAdmin = await login(admin, emails.admin);
  const enrollment = await write(admin, csrfAdmin, '/auth/mfa/enroll', {});
  expect(enrollment.status(), await enrollment.text()).toBeLessThan(300);
  const uri = (await enrollment.json()).otpauthUri;
  const confirm = await write(admin, csrfAdmin, '/auth/mfa/confirm', {
    code: otp(new URL(uri).searchParams.get('secret')!),
  });
  expect(confirm.status(), await confirm.text()).toBeLessThan(300);
  csrfAdmin = (await (await admin.get('/api/v1/auth/csrf')).json()).csrfToken;
  csrfOther = await login(other, emails.other);
});
test.afterAll(async () => {
  await Promise.all([admin?.dispose(), employee?.dispose(), other?.dispose()]);
  await pool.end();
});
test('fresh Admin signs in, enrolls authenticator, accepts notice and signs in again using recovery', async ({page})=>{
 const id=randomUUID(),email=`onboarding-${suffix}@example.org`;
 await pool.query("INSERT INTO users(id,email,display_name,password_hash,state,email_verified_at) VALUES($1,$2,'Fresh demo Admin',$3,'ACTIVE',now())",[id,email,await hash(password)]);
 await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'ADMIN'),($1,'EMPLOYEE')",[id]);
 await page.goto('/login');
 await page.getByLabel('Work email').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Sign in to workspace'}).click();
 await expect(page.getByRole('heading',{name:'Two-step verification'})).toBeVisible();
 await page.getByRole('button',{name:'Set up authenticator'}).click();
 const setup=await page.getByLabel('Setup key',{exact:true}).inputValue();
 await page.getByLabel('Authenticator code',{exact:true}).fill(otp(setup));
 await page.getByRole('button',{name:'Confirm authenticator'}).click();
 await expect(page.getByText('Save your recovery codes now',{exact:true})).toBeVisible();
 const recovery=(await page.locator('.recovery-codes').innerText()).trim().split('\n')[0];
 await page.getByRole('checkbox').check();
 await page.getByRole('link',{name:/Continue/}).click();
 await expect(page.getByRole('heading',{name:'Your portal access'})).toBeVisible();
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Accept and continue'}).click();
 await expect(page).toHaveURL(/dashboard/);
 await expect(page.getByText('Total assets',{exact:true})).toBeVisible();
 await expect(page.locator('.skeleton').first()).toHaveCount(0);
 await page.screenshot({path:'/downloads/iac-fresh-admin-onboarding.png'});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await page.getByLabel('Work email').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Sign in to workspace'}).click();
 await page.getByRole('button',{name:'Use a recovery code',exact:true}).click();
 await page.getByLabel('Recovery code',{exact:true}).fill(recovery);
 await page.getByRole('button',{name:/Verify/}).click();
 await expect(page).toHaveURL(/dashboard/);
});
test('employee custody and support workflow through real browser and API', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(emails.employee);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /Sign in to workspace/ }).click();
  await expect(page.getByRole('heading', { name: 'Your portal access' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Accept and continue/ }).click();
  await expect(page).toHaveURL(/dashboard/);
  csrfEmployee = await login(employee, emails.employee);
  const create = await write(admin, csrfAdmin, '/assets', {
    category: 'IT Hardware',
    assetType: 'Laptop',
    description: `Workflow laptop ${suffix}`,
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Medium',
    purchaseCost: '1000.00',
  });
  expect(create.status(), await create.text()).toBe(201);
  const asset = await create.json();
  const assign = await write(
    admin,
    csrfAdmin,
    `/assets/${asset.id}/assignments`,
    { userId: ids.employee, note: 'Synthetic test handover' },
    asset.version,
  );
  expect(assign.status(), await assign.text()).toBe(201);
  const assignment = await assign.json();
  await page.goto(`/assets/${asset.id}`);
  await expect(page.getByText(`Workflow laptop ${suffix}`, { exact: true }).first()).toBeVisible();
  const accept = page.getByRole('button', { name: 'Details are correct' });
  await expect(accept).toBeVisible();
  await accept.click();
  await page.getByRole('button', { name: 'Confirm acceptance' }).click();
  await expect(page.getByText('accepted', { exact: true }).first()).toBeVisible();
  const denied = await other.get(`/api/v1/assets/${asset.id}`);
  expect(denied.status()).toBe(404);
  const mine = await employee.get(`/api/v1/assets/${asset.id}`);
  const ownAsset = await mine.json();
  expect(ownAsset).not.toHaveProperty('purchaseCost');
  expect(ownAsset).not.toHaveProperty('residualValue');
await page.goto('/tickets/new');
  const assetSelect = page.getByLabel('Related asset (optional)', { exact: true });
  await assetSelect.click();
  await page.getByRole('option', { name: new RegExp(asset.assetCode) }).click();
  await page.getByLabel('Subject', { exact: true }).fill(`Charging issue ${suffix}`);
  await page
    .getByLabel('What happened?')
    .fill('The adapter indicator is off. Synthetic support request.');
  await page.getByRole('button', { name: /Submit ticket|Create ticket|Send request/ }).click();
  await expect(page).toHaveURL(/tickets\/[a-f0-9-]+/);
  const ticketId = page.url().split('/').pop()!;
  let ticket = await (await admin.get(`/api/v1/tickets/${ticketId}`)).json();
  const internal = await write(
    admin,
    csrfAdmin,
    `/tickets/${ticketId}/updates`,
    { body: 'Staff confidential diagnosis', visibility: 'INTERNAL' },
    ticket.version,
  );
  expect(internal.status(), await internal.text()).toBe(201);
  const timeline = await (await employee.get(`/api/v1/tickets/${ticketId}/updates`)).json();
  expect(JSON.stringify(timeline)).not.toContain('Staff confidential diagnosis');
  ticket = await (await admin.get(`/api/v1/tickets/${ticketId}`)).json();
  const completed = await write(
    admin,
    csrfAdmin,
    `/tickets/${ticketId}/status`,
    { status: 'COMPLETED', resolution: 'Replacement adapter confirmed working.' },
    ticket.version,
    'PATCH',
  );
  expect(completed.status(), await completed.text()).toBeLessThan(300);
  await page.reload();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Staff confidential diagnosis')).toHaveCount(0);
  const deniedClose = await write(
    employee,
    csrfEmployee,
    `/tickets/${ticketId}/status`,
    { status: 'COMPLETED', resolution: 'Unauthorized close' },
    ticket.version,
    'PATCH',
  );
  expect(deniedClose.status()).toBe(403);
  const queued = await pool.query('SELECT count(*)::int AS count FROM email_deliveries');
  expect(queued.rows[0].count).toBeGreaterThan(0);
  const audit = await pool.query(
    'SELECT count(*)::int AS count FROM audit_events WHERE entity_id=ANY($1::uuid[])',
    [[asset.id, assignment.id, ticketId]],
  );
  expect(audit.rows[0].count).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: 'test-results/employee-ticket-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.locator('.metric strong').first()).toHaveText('1');
  await expect(page.locator('.loading')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/employee-dashboard-mobile.png', fullPage: true });
});
test('CSRF and unauthorized inventory writes fail', async () => {
  const bad = await employee.post('/api/v1/tickets', {
    data: { subject: 'No CSRF', description: 'Test', category: 'OTHER', priority: 'LOW' },
  });
  expect(bad.status()).toBe(403);
  const denied = await write(other, csrfOther, '/assets', {
    category: 'IT Hardware',
    assetType: 'Laptop',
    description: 'Unauthorized',
    ownershipType: 'Owned',
    status: 'In Store',
    condition: 'Good',
    riskLevel: 'Low',
  });
  expect(denied.status()).toBe(403);
});

test('Admin creates and assigns an asset and handles a ticket through the UI', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: await admin.storageState() });
  const page = await context.newPage();
await page.goto('/assets/new');
  await page.getByLabel('Description', { exact: true }).fill(`Admin UI laptop ${suffix}`);
  await page.getByLabel('Asset type', { exact: true }).click();
  await page.locator('#assetType ~ ul').getByRole('option', { name: 'Laptop' }).first().click();
  await page.getByLabel('Category', { exact: true }).click();
  await page.locator('#category ~ ul').getByRole('option', { name: 'IT Hardware' }).first().click();
  await page.getByLabel('Ownership type', { exact: true }).click();
  await page.locator('#ownershipType ~ ul').getByRole('option', { name: 'Owned' }).first().click();
  await page.getByLabel('Condition', { exact: true }).click();
  await page.locator('#condition ~ ul').getByRole('option', { name: 'Good' }).first().click();
  await page.getByLabel('Risk level', { exact: true }).click();
  await page.locator('#riskLevel ~ ul').getByRole('option', { name: 'Low' }).first().click();
  await page.getByRole('button', { name: 'Create asset', exact: true }).click();
  await expect(page).toHaveURL(/assets\/[a-f0-9-]+/);
  await expect(
    page.getByRole('heading', { name: `Admin UI laptop ${suffix}`, exact: true }),
  ).toBeVisible();
await page.getByRole('link', { name: 'Assign asset', exact: true }).click();
  const empSelect = page.getByLabel('Approved employee');
  await empSelect.click();
  await page.getByRole('option', { name: /Test employee/ }).first().click();
  await page.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
  await expect(page).toHaveURL(/assets\/[a-f0-9-]+/);
  await expect(page.getByText('pending', { exact: true }).first()).toBeVisible();
  const t = await write(employee, csrfEmployee, '/tickets', {
    subject: `Admin UI request ${suffix}`,
    description: 'Synthetic test public reply and completion',
    category: 'OTHER',
    priority: 'LOW',
  });
  expect(t.status(), await t.text()).toBe(201);
  const ticket = await t.json();
  await page.goto(`/tickets/${ticket.id}`);
  await page.getByRole('button', { name: 'Take ownership', exact: true }).click();
  await expect(page.getByText('You', { exact: true })).toBeVisible();
  await page.getByLabel('Reply', { exact: true }).fill('A public response from the support desk.');
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(
    page.getByText('A public response from the support desk.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await page.getByLabel('Resolution', { exact: true }).fill('Resolved and verified with employee.');
  await page.getByRole('button', { name: 'Confirm completion', exact: true }).click();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.locator('.loading')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/admin-dashboard-desktop.png', fullPage: true });
  await context.close();
});

test('Admin manages masters and asset forms retain historical selections', async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ storageState: await admin.storageState() });
  const page = await context.newPage();
  const departmentCode = `MC_DEPT_${suffix}`;
  const departmentName = `Master department ${suffix}`;
  const categoryCode = `Master category ${suffix}`;
  const categoryLabel = `Therapy devices ${suffix}`;
  const locationCode = `MC_LOC_${suffix}`;
  const site = `Synthetic campus ${suffix}`;
  try {
    await page.goto('/master-control');
    await expect(page.getByRole('heading', { name: 'Master Control', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add department', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill(departmentCode);
    await page.getByLabel('Name', { exact: true }).fill(departmentName);
    await page.getByLabel('Change reason', { exact: true }).fill('Synthetic browser master setup');
    await page.getByRole('button', { name: 'Create department', exact: true }).click();
    await expect(page.getByLabel('Change reason', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Edit ${departmentName}`, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Categories', exact: true }).click();
    await page.getByRole('button', { name: 'Add category', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill(categoryCode);
    await page.getByLabel('Label', { exact: true }).fill(categoryLabel);
    await page.getByLabel('Change reason', { exact: true }).fill('Synthetic selectable asset category');
    await page.getByRole('button', { name: 'Create category', exact: true }).click();
    await expect(page.getByLabel('Change reason', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Edit ${categoryLabel}`, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Locations', exact: true }).click();
    await page.getByRole('button', { name: 'Add location', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill(locationCode);
    await page.getByLabel('Site', { exact: true }).fill(site);
    await page.getByLabel('Building', { exact: true }).fill('Therapy block');
    await page.getByLabel('Floor', { exact: true }).fill('2');
    await page.getByLabel('Room', { exact: true }).fill('T01');
    await page.getByLabel('Change reason', { exact: true }).fill('Synthetic location setup');
    await page.getByRole('button', { name: 'Create location', exact: true }).click();
    await expect(page.getByLabel('Change reason', { exact: true })).toHaveCount(0);
    const masters = await (await admin.get('/api/v1/master-data')).json();
    const department = masters.departments.find((value: any) => value.code === departmentCode);
    const location = masters.locations.find((value: any) => value.code === locationCode);
    expect(department).toBeTruthy();
    expect(location).toBeTruthy();

await page.goto('/assets/new');
    await page.getByLabel('Description', { exact: true }).fill(`Master catalog device ${suffix}`);
    await page.getByLabel('Category', { exact: true }).click();
    await page.locator('#category ~ ul').getByRole('option', { name: categoryLabel }).first().click();
    await page.getByLabel('Asset type', { exact: true }).click();
    await page.locator('#assetType ~ ul').getByRole('option', { name: 'Laptop' }).first().click();
    await page.getByLabel('Ownership type', { exact: true }).click();
    await page.locator('#ownershipType ~ ul').getByRole('option', { name: 'Owned' }).first().click();
    await page.getByLabel('Condition', { exact: true }).click();
    await page.locator('#condition ~ ul').getByRole('option', { name: 'Good' }).first().click();
    await page.getByLabel('Risk level', { exact: true }).click();
    await page.locator('#riskLevel ~ ul').getByRole('option', { name: 'Low' }).first().click();
    await page.getByLabel('Department', { exact: true }).click();
    await page.locator('#departmentId ~ ul').getByRole('option', { name: department.name }).first().click();
    await page.getByLabel('Location', { exact: true }).click();
    const locationLabel = [location.site, location.building, location.floor, location.room]
      .filter(Boolean)
      .join(' / ');
    await page.locator('#locationId ~ ul').getByRole('option', { name: locationLabel }).click();
    await expect(page.getByRole('combobox', { name: 'Location' })).toContainText(locationLabel);
    await page.getByRole('button', { name: 'Create asset', exact: true }).click();
    await expect(page).toHaveURL(/assets\/[a-f0-9-]+$/);
    const assetId = page.url().split('/').pop()!;
    await expect(page.getByText(departmentName, { exact: true })).toBeVisible();

    await page.goto('/master-control');
    await page.getByRole('button', { name: 'Categories', exact: true }).click();
    await page.getByRole('button', { name: `Edit ${categoryLabel}`, exact: true }).click();
    await page.getByLabel('Active for new records', { exact: true }).uncheck();
    await page.getByLabel('Change reason', { exact: true }).fill('Retire test category without changing asset history');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
await expect(page.getByLabel('Change reason', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Availability', { exact: true })).toContainText('Active only');
    await expect(page.getByRole('button', { name: `Edit ${categoryLabel}`, exact: true })).toHaveCount(0);
    await page.getByLabel('Availability', { exact: true }).click();
    await page.getByRole('option', { name: 'Inactive only' }).click();
    await expect(page.getByRole('button', { name: `Edit ${categoryLabel}`, exact: true })).toBeVisible();
    await page.goto('/assets/new');
    await expect(page.getByLabel('Category', { exact: true }).locator('option').filter({ hasText: categoryLabel })).toHaveCount(0);

await page.goto(`/assets/${assetId}/edit`);
    await expect(page.getByLabel('Category', { exact: true })).toContainText(categoryLabel);
    await page.getByLabel('Description', { exact: true }).fill(`Retained master device ${suffix}`);
    await page.getByLabel('Reason for this change', { exact: true }).fill('Unrelated edit keeps inactive historical category');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`assets/${assetId}$`));
    const saved = await (await admin.get(`/api/v1/assets/${assetId}`)).json();
    expect(saved.category).toBe(categoryCode);
    expect(saved.departmentId).toBe(department.id);
    expect(saved.locationId).toBe(location.id);
    const audit = await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE actor_id=$1 AND action LIKE 'MASTER_%'", [ids.admin]);
    expect(audit.rows[0].count).toBeGreaterThanOrEqual(4);

    await page.goto('/master-control');
    await page.getByRole('button', { name: 'Asset statuses', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Departments', exact: true }).click();
    // Capture the visible control surface, not an unbounded accumulated fixture list.
    await page.screenshot({ path: 'test-results/master-control-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      overflow: [...document.querySelectorAll('body *')].filter((element) => !element.closest('.table-scroll, .master-groups nav'))
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width),
          scroll: element.scrollWidth,
          client: element.clientWidth,
        }))
        .filter((element) => element.right > innerWidth)
        .slice(0, 40),
    }));
    expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
    await page.screenshot({ path: 'test-results/master-control-mobile.png' });
  } finally {
    await context.close();
  }
});

test('support triage filters ownership, category and search without exposing team controls to employees',async({browser})=>{
 const tag=`triage-${suffix}`;
 for(let i=0;i<28;i++)await pool.query("INSERT INTO tickets(reporter_id,owner_id,subject,description,category,priority) VALUES($1,$2,$3,'Synthetic triage browser','HARDWARE','HIGH')",[ids.other,i<26?null:ids.admin,tag]);
 const context=await browser.newContext({storageState:await admin.storageState()});
 try {
 const page=await context.newPage();await page.goto('/tickets');
 await page.getByLabel('Search subject or ticket number').fill(tag);
 await page.getByLabel('Ownership',{exact:true}).selectOption('UNASSIGNED');
 await expect(page.locator('tbody tr')).toHaveCount(25);
 await page.getByRole('button',{name:/Load more/}).click();
 await expect(page.locator('tbody tr')).toHaveCount(26);
 await page.getByLabel('Ownership',{exact:true}).selectOption('MINE');
 await expect(page.locator('tbody tr')).toHaveCount(2);
 await page.evaluate(()=>scrollTo(0,0));
 await expect(page.getByRole('heading',{name:'Support desk',exact:true})).toBeVisible();
 expect(await page.getByRole('heading',{name:'Support desk',exact:true}).evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(48);
 await page.screenshot({path:'/downloads/iac-ticket-triage-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(()=>scrollTo(0,0));
 expect(await page.getByRole('heading',{name:'Support desk',exact:true}).evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(48);
 await page.screenshot({path:'/downloads/iac-ticket-triage-mobile.png'});
 const result=await page.request.get('/api/v1/tickets?ownership=UNASSIGNED&q='+tag);expect(result.status()).toBe(200);expect((await result.json()).items.length).toBe(25);
 }finally{await context.close();}
 const own=await browser.newContext({storageState:await other.storageState()});
 try{const page=await own.newPage();await page.goto('/tickets');await expect(page.getByLabel('Ownership',{exact:true})).toHaveCount(0);expect((await page.request.get('/api/v1/tickets?ownership=UNASSIGNED')).status()).toBe(403);}finally{await own.close();}
});
test('Master Control rejects Employee access through browser and API', async ({ browser }) => {
  expect((await other.get('/api/v1/master-data')).status()).toBe(403);
  const denied = await write(other, csrfOther, '/master-data/departments', {
    code: `DENIED_${suffix}`, name: 'Unauthorized department', reason: 'Denied write test',
  });
  expect(denied.status()).toBe(403);
  const context = await browser.newContext({ storageState: await other.storageState() });
  try {
    const page = await context.newPage();
    await page.goto('/master-control');
    await expect(page.getByRole('heading', { name: 'Admin access required', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Master Control', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
