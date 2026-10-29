import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const timestamp = '2026-01-01T00:00:00.000Z';
const assetCode = 'IAC-IT-000123';
const assetId = '00000000-0000-4000-8000-000000000123';
const ticketId = '00000000-0000-4000-8000-000000000500';
const session = {
  id: '00000000-0000-4000-8000-000000000020',
  email: 'synthetic.employee@example.test',
  displayName: 'Synthetic Employee',
  roles: ['EMPLOYEE'],
  state: 'ACTIVE',
  emailVerifiedAt: timestamp,
  portalAcceptedAt: timestamp,
  portalNoticeVersion: '1',
  currentNoticeVersion: '1',
  mfaEnrolled: true,
  mfaRequired: false,
  version: 1,
};
const scanView = {
  id: assetId,
  assetCode,
  category: 'IT Hardware',
  assetType: 'Laptop',
  manufacturer: 'Synthetic Hardware',
  model: 'Demonstration model',
  department: 'Operations',
  location: { site: 'Main campus', floor: '1', room: 'Office' },
  status: 'Assigned',
  hasPhoto: false,
  reportable: true,
  canViewFull: false,
};
type Write = { method: string; path: string; body: any };
type Options = {
  loggedIn?: boolean;
  admin?: boolean;
  scan?: Partial<typeof scanView>;
};
type Hooked = { __iacScanResult?: (text: string) => void; __prints?: number };

async function tinyJpeg(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#8ab9d3';
    context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#254963';
    context.fillRect(120, 90, 400, 300);
    return canvas.toDataURL('image/jpeg', 0.8);
  });
}

async function mockApi(page: Page, options: Options = {}) {
  const state = {
    loggedIn: options.loggedIn ?? true,
    writes: [] as Write[],
    unexpected: [] as string[],
  };
  const labelAssets = Array.from({ length: 24 }, (_, index) => ({
    id: `00000000-0000-4000-8000-0000000009${String(index).padStart(2, '0')}`,
    assetCode: `IAC-IT-0009${String(index).padStart(2, '0')}`,
    description: `Synthetic asset ${index + 1}`,
    category: 'IT Hardware',
    assetType: 'Laptop',
    status: 'Assigned',
    version: 1,
  }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    if (
      method === 'GET' &&
      (path === '/api/v1/notifications/unread-count' || path === '/notifications/unread-count')
    )
      return route.fulfill({ json: { unreadCount: 0 } });
    if (method !== 'GET') {
      state.writes.push({
        method,
        path,
        body: request.postData() ? request.postDataJSON() : undefined,
      });
    }
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/me')
      return state.loggedIn
        ? json(
            options.admin
              ? { ...session, displayName: 'Synthetic Admin', roles: ['ADMIN', 'EMPLOYEE'] }
              : session,
          )
        : json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } }, 401);
    if (method === 'GET' && path === '/auth/csrf') return json({ csrfToken: 'synthetic-csrf' });
    if (method === 'POST' && path === '/auth/login') {
      state.loggedIn = true;
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/references')
      return json({
        values: [
          {
            kind: 'TICKET_CATEGORY',
            code: 'HARDWARE',
            label: 'Hardware',
            active: true,
            version: 1,
          },
          { kind: 'TICKET_PRIORITY', code: 'MEDIUM', label: 'Medium', active: true, version: 1 },
        ],
        departments: [],
        locations: [],
      });
    if (method === 'GET' && path === `/scan/${assetCode}`)
      return json({ ...scanView, ...options.scan });
    if (method === 'GET' && path === '/assets')
      return json({ items: options.admin ? labelAssets : [] });
    if (method === 'GET' && /^\/assets\/[^/]+$/.test(path))
      return json({
        id: assetId,
        assetCode,
        description: 'Synthetic asset 123',
        category: 'IT Hardware',
        assetType: 'Laptop',
        status: 'Assigned',
        version: 1,
        currentAssignment: { userId: session.id },
      });
    if (method === 'GET' && path === '/dashboard') return json({ role: 'EMPLOYEE' });
    if (method === 'GET' && path === '/tickets') return json({ items: [] });
    if (method === 'POST' && path === '/tickets')
      return json({ id: ticketId, ticketNumber: 77 }, 201);
    if (method === 'GET' && path === `/tickets/${ticketId}`)
      return json({
        id: ticketId,
        ticketNumber: 77,
        subject: 'Screen flickers',
        description: 'The screen flickers.',
        category: 'HARDWARE',
        priority: 'MEDIUM',
        status: 'OPEN',
        version: 1,
        assetId,
        reporterId: session.id,
        createdAt: timestamp,
        photoCount: 2,
      });
    if (method === 'GET' && path === `/tickets/${ticketId}/updates`) return json({ items: [] });
    if (method === 'GET' && /^\/tickets\/[^/]+\/photos\/\d$/.test(path))
      return json({ dataUrl: await tinyJpeg(page) });
    if (method === 'POST' && path === '/asset-labels/prints')
      return json({ recorded: 24, printedAt: timestamp });
    state.unexpected.push(`${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return state;
}

test('scan link while logged out returns to the asset after login', async ({ page }) => {
  const state = await mockApi(page, { loggedIn: false });
  await page.goto(`/a/${assetCode}`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Work email').fill('synthetic.employee@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password-1');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${assetCode}$`));
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test('staff raises a ticket with two photos', async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(`/a/${assetCode}`);
  await page.getByRole('link', { name: 'Report a problem' }).click();
  await expect(page.getByLabel('Asset', { exact: true })).toHaveValue(assetCode);
  await expect(page.getByLabel('Asset', { exact: true })).toHaveJSProperty('readOnly', true);
  const jpeg = await tinyJpeg(page);
  const buffer = Buffer.from(jpeg.split(',')[1], 'base64');
  await page.getByLabel('Choose photo', { exact: true }).setInputFiles([
    { name: 'one.jpg', mimeType: 'image/jpeg', buffer },
    { name: 'two.jpg', mimeType: 'image/jpeg', buffer },
  ]);
  await expect(page.getByRole('img', { name: /^Attached photo/ })).toHaveCount(2);
  await page.getByLabel('Subject').fill('Screen flickers');
  await page.getByLabel('What happened?').fill('The screen flickers.');
  await page.getByRole('button', { name: /Submit ticket/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticketId}$`));
  await expect(page.getByRole('img', { name: /^Ticket photo \d$/ })).toHaveCount(2);
  const create = state.writes.find((write) => write.path === '/tickets');
  expect(create?.body.assetId).toBe(assetId);
  expect(create?.body.photos).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
});

test('retired asset shows no report button', async ({ page }) => {
  await mockApi(page, { scan: { status: 'Retired', reportable: false } });
  await page.goto(`/a/${assetCode}`);
  await expect(
    page.getByText('This asset is no longer in service.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Report a problem' })).toHaveCount(0);
});

test('label preview renders 24 cells on A4_24 and posts a print run after confirm', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as Hooked;
    w.__prints = 0;
    window.print = () => {
      w.__prints = (w.__prints ?? 0) + 1;
    };
  });
  const state = await mockApi(page, { admin: true });
  await page.goto('/assets/labels');
  await page.getByLabel('Select all loaded assets').check();
  await expect(page.getByText('A4 sheet, 40 small labels (4 x 10)').first()).toBeVisible();
  await page.getByLabel('Label layout').click();
  await page.getByRole('option', { name: 'A4 sheet, 24 labels (3 x 8)' }).click();
  await expect(page.locator('.label-cell')).toHaveCount(24);
  await page.getByRole('button', { name: 'Print 24 labels' }).click();
  expect(await page.evaluate(() => (window as unknown as Hooked).__prints)).toBe(1);
  expect(state.writes.filter((write) => write.path === '/asset-labels/prints')).toHaveLength(0);
  await page.getByRole('button', { name: 'Yes, record print' }).click();
  await expect(page.getByText('Recorded 24 label print(s).')).toBeVisible();
  const run = state.writes.find((write) => write.path === '/asset-labels/prints');
  expect(run?.body.layout).toBe('A4_24');
  expect(run?.body.assetIds).toHaveLength(24);
  expect(state.unexpected).toEqual([]);
});

test('label preview renders 14 cells on A4_14', async ({ page }) => {
  const state = await mockApi(page, { admin: true });
  await page.goto('/assets/labels');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByLabel('Select all loaded assets').check();
  const layoutSelect = page.getByLabel('Label layout');
  await layoutSelect.click();
  await page.getByRole('option', { name: 'A4 sheet, 14 labels (2 x 7)' }).click();
  await expect(page.getByText('A4 sheet, 14 labels (2 x 7)').first()).toBeVisible();
  await expect(page.locator('.label-cell')).toHaveCount(24);
  expect(state.unexpected).toEqual([]);
});

test('label preview renders 1 cell per page on THERMAL_50x25', async ({ page }) => {
  const state = await mockApi(page, { admin: true });
  await page.goto('/assets/labels');
  await page.getByLabel('Select all loaded assets').check();
  const layoutSelect = page.getByLabel('Label layout');
  await layoutSelect.click();
  await page.getByRole('option', { name: 'Thermal roll, 50 x 25 mm' }).click();
  await expect(page.getByText('Thermal roll, 50 x 25 mm').first()).toBeVisible();
  await expect(page.locator('.label-sheet')).toHaveCount(24);
  await expect(page.locator('.label-cell')).toHaveCount(24);
  expect(state.unexpected).toEqual([]);
});

test('scanner rejects a foreign label and follows an own-origin label', async ({ page }) => {
  const state = await mockApi(page);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Open camera scanner', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan asset label' });
  await expect(dialog).toBeVisible();
  await page.waitForFunction(
    () => typeof (window as unknown as Hooked).__iacScanResult === 'function',
  );
  await page.evaluate(() =>
    (window as unknown as Hooked).__iacScanResult?.('https://evil.org/a/X'),
  );
  await expect(dialog.getByText("This isn't an IAC asset label")).toBeVisible();
  const own = `${new URL(page.url()).origin}/a/${assetCode}`;
  await page.evaluate((url) => (window as unknown as Hooked).__iacScanResult?.(url), own);
  await expect(page).toHaveURL(new RegExp(`/a/${assetCode}$`));
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test('admin insights show KPIs, spend chart and update financial year filter', async ({ page }) => {
  await mockApi(page, { admin: true });
  const requests: string[] = [];
  const dashboard = {
    filters: { fy: 2026, fyLabel: 'FY 2026-27' },
    kpis: {
      totalAssets: 18,
      totalSpend: 100000,
      fySpend: 25000,
      missingCost: 2,
      assigned: 12,
      assignedPct: 66.7,
      openTickets: 3,
      warrantyExpiring: 1,
    },
    spendByYear: [
      { label: 'FY 2025-26', spend: 75000, count: 5 },
      { label: 'FY 2026-27', spend: 25000, count: 2 },
    ],
    spendByCategory: [{ label: 'IT Hardware', spend: 100000, count: 7 }],
    spendByDepartment: [{ label: 'Operations', spend: 100000, count: 7 }],
    statusCounts: [{ label: 'Assigned', count: 12 }],
    ticketWeeks: Array.from({ length: 12 }, (_, index) => ({
      weekStart: `2026-08-${String(index + 1).padStart(2, '0')}`,
      opened: index % 3,
      completed: index % 2,
    })),
    expiring: [
      { assetId, assetCode, assetType: 'Laptop', kind: 'Warranty' as const, date: '2026-11-01' },
    ],
    topReported: [{ assetId, assetCode, assetType: 'Laptop', tickets: 4 }],
    financeGaps: [
      { assetId, assetCode, assetType: 'Laptop', missingCost: true, missingDate: false },
    ],
    recentActivity: [
      {
        action: 'TICKET_CREATED',
        entityType: 'TICKET',
        actor: 'Synthetic Admin',
        occurredAt: timestamp,
      },
    ],
  };
  await page.route('**/api/v1/dashboard/admin**', async (route) => {
    requests.push(new URL(route.request().url()).search);
    await route.fulfill({ json: dashboard });
  });
  await page.goto('/dashboard');
  await expect(page.getByText('₹1,00,000').first()).toBeVisible();
  await expect(page.getByRole('img', { name: /FY 2025-26: ₹75,000/ })).toBeVisible();
  await expect(page.getByRole('link', { name: assetCode }).first()).toHaveAttribute(
    'href',
    `/assets/${assetId}`,
  );
  const fy = page.getByLabel('Financial year');
  await fy.click();
  await page.getByRole('option', { name: 'FY 2025-26' }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  expect(requests.at(-1)).toContain('fy=2025');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Synthetic Admin/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await expect
    .poll(() =>
      page
        .locator('.admin-insights-panel .table-scroll')
        .evaluateAll((tables) => tables.some((table) => table.scrollWidth > table.clientWidth + 1)),
    )
    .toBe(false);
});

test('scan page on a phone viewport', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/a/${assetCode}`);
  await expect(page.getByRole('heading', { name: assetCode, exact: true })).toBeVisible();
  mkdirSync('test-results/qr-scan', { recursive: true });
  await page.screenshot({ path: 'test-results/qr-scan/scan-page-375x812.png' });
});
