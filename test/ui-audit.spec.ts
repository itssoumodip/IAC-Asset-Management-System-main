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
  itAdmin: any,
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
  itAdmin = await identity(['IT_ADMIN']);
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
test('role and viewport visual audit', async ({ page, context }) => {
  test.setTimeout(180000);
  const routes = [
    [
      'admin',
      admin,
      [
        '/dashboard',
        '/equipment/people',
        '/finance',
        '/assets',
        '/assets/new',
        '/tickets',
        '/tickets/new',
        '/admin/users',
        '/master-control',
        '/admin/imports',
        '/admin/audit',
        '/admin/announcements',
        '/admin/deliveries',
        '/assets/labels',
        '/profile',
        '/notifications',
        '/install',
      ],
    ],
    [
      'finance',
      finance,
      ['/dashboard', '/equipment/people', `/finance/${assetId}`, '/executive', '/profile'],
    ],
    [
      'it',
      itAdmin,
      ['/dashboard', '/assets', '/tickets', '/tickets/new', '/admin/announcements', '/profile'],
    ],
    ['executive', executive, ['/dashboard', '/profile']],
    [
      'employee',
      employee,
      ['/dashboard', '/equipment/mine', '/assets', '/tickets/new', '/profile'],
    ],
  ] as const;
  const findings: any[] = [];
  for (const [role, u, paths] of routes) {
    await signIn(context, u);
    for (const path of paths) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (role === 'it' && path === '/assets')
          await expect(
            page.getByRole('heading', { name: 'Available assets', exact: true }),
          ).toBeVisible();
        await page.evaluate(() => scrollTo(0, 0));
        const file = `/downloads/iac-ui-audit/${role}-${path.replaceAll('/', '_')}-${width}.png`;
        await page.screenshot({ path: file });
        const result = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          heading: document.querySelector('main h1,main h2,main h3')?.textContent,
          alerts: [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent),
          overflowElements: [...document.querySelectorAll('main *')]
            .filter(
              (e) =>
                !e.closest('.table-scroll,.master-groups nav') &&
                e.getBoundingClientRect().right > innerWidth + 2,
            )
            .slice(0, 8)
            .map((e) => ({ tag: e.tagName, cls: e.className, text: e.textContent?.slice(0, 65) })),
        }));
        findings.push({ role, path, width, file, ...result });
      }
    }
  }
  console.log(`Audited ${findings.length} settled role/viewport visits`);
  expect(findings.filter((f) => f.overflow)).toEqual([]);
});

test('mobile navigation is keyboard-safe and Finance errors recover without stale content', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  const nav = page.locator('#mobile-nav');
  await expect(nav).toHaveAttribute('inert', '');
  await toggle.click();
  await expect(nav).not.toHaveAttribute('inert', '');
  await page.getByRole('link', { name: 'People & access', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(nav).toHaveAttribute('inert', '');
  await toggle.click();
  await page.screenshot({ path: '/downloads/iac-ui-audit/mobile-navigation-open.png' });
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click({ position: { x: 350, y: 300 } });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await signIn(context, finance);
  await page.route('**/api/v1/finance/queue*', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic temporary data failure' },
      }),
    }),
  );
  await page.goto('/finance');
  await expect(page.getByRole('alert')).toContainText('Synthetic temporary data failure');
  await expect(page.getByRole('heading', { name: 'No matching records', exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: '/downloads/iac-ui-audit/finance-recoverable-error-mobile.png' });
  await page.unroute('**/api/v1/finance/queue*');
  await page.getByRole('button', { name: 'Reload data', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Asset code or description').fill('no-such-synthetic-asset-' + tag);
  await expect(
    page.getByRole('heading', { name: 'No matching records', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '/downloads/iac-ui-audit/finance-empty-mobile.png' });
  await signIn(context, employee);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance access required' })).toBeVisible();
  expect((await page.request.get('/api/v1/finance/queue')).status()).toBe(403);
});

test('narrow phone and tablet keep forms, long person cards and navigation usable', async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  for (const width of [320, 768])
    for (const path of [
      '/equipment/people',
      '/assets/new',
      '/tickets',
      '/profile',
      '/master-control',
    ]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width} ${path}`,
      ).toBe(true);
      await page.screenshot({
        path: `/downloads/iac-ui-audit/narrow-${width}-${path.replaceAll('/', '_')}.png`,
      });
    }
});

test('signed-out screens and bottom form actions remain usable on phones', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/login', '/register', '/forgot-password']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `/downloads/iac-ui-audit/auth-${path.slice(1)}.png` });
  }
  await signIn(context, admin);
  for (const [path, name] of [
    ['/assets/new', 'Create asset'],
    ['/profile', 'Save account details'],
    ['/tickets/new', 'Submit ticket →'],
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
    await page.getByRole('button', { name, exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/downloads/iac-ui-audit/form-bottom-${path.replaceAll('/', '_')}.png`,
    });
  }
});
