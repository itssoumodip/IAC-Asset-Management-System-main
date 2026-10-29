import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const timestamp = '2026-01-01T00:00:00.000Z';
const assetId = '00000000-0000-4000-8000-000000000010';
const assignedAssetId = '00000000-0000-4000-8000-000000000011';
const retiredAssetId = '00000000-0000-4000-8000-000000000012';
const employeeId = '00000000-0000-4000-8000-000000000020';
const currentEmployeeId = '00000000-0000-4000-8000-000000000021';
const assetCode = 'IAC-IT-000010';
const assignedAssetCode = 'IAC-IT-000011';
const retiredAssetCode = 'IAC-IT-000012';
const session = {
  id: employeeId,
  email: 'synthetic.recipient@example.test',
  displayName: 'Synthetic Recipient',
  roles: ['EMPLOYEE'],
  state: 'ACTIVE',
  emailVerifiedAt: timestamp,
  portalAcceptedAt: timestamp,
  portalNoticeVersion: '1',
  currentNoticeVersion: '1',
  mfaEnrolled: true,
  mfaRequired: false,
  version: 3,
};
type Write = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

async function mockApi(page: Page, { admin = true, empty = false, stale = false } = {}) {
  const currentAssignment = {
    id: '00000000-0000-4000-8000-000000000040',
    userId: currentEmployeeId,
    acknowledgement: 'ACCEPTED',
    version: 2,
    assignedAt: timestamp,
  };
  const state = {
    writes: [] as Write[],
    unexpected: [] as string[],
    assetQueries: [] as URLSearchParams[],
    userQueries: [] as URLSearchParams[],
    userReads: 0,
    assetReads: 0,
    users: [
      { ...session },
      {
        ...session,
        id: currentEmployeeId,
        email: 'synthetic.custodian@example.test',
        displayName: 'Synthetic Current Custodian',
      },
      {
        ...session,
        id: 'synthetic-unverified',
        displayName: 'Synthetic Unverified',
        emailVerifiedAt: null,
      },
      {
        ...session,
        id: 'synthetic-no-portal',
        displayName: 'Synthetic No Portal',
        portalAcceptedAt: null,
      },
      {
        ...session,
        id: 'synthetic-disabled',
        displayName: 'Synthetic Disabled',
        state: 'DISABLED',
      },
      {
        ...session,
        id: 'synthetic-staff-only',
        displayName: 'Synthetic Staff Only',
        roles: ['IT_ADMIN'],
      },
    ],
    assets: [
      {
        id: assetId,
        assetCode,
        description: 'Synthetic available laptop',
        category: 'IT Hardware',
        assetType: 'Laptop',
        status: 'In Store',
        condition: 'Good',
        version: 7,
        currentAssignment: null as typeof currentAssignment | null,
        timeline: [],
      },
      {
        id: assignedAssetId,
        assetCode: assignedAssetCode,
        description: 'Synthetic assigned laptop',
        category: 'IT Hardware',
        assetType: 'Laptop',
        status: 'Assigned',
        condition: 'Good',
        version: 14,
        currentAssignment,
        timeline: [],
      },
      {
        id: retiredAssetId,
        assetCode: retiredAssetCode,
        description: 'Synthetic disposed laptop',
        category: 'IT Hardware',
        assetType: 'Laptop',
        status: 'Disposed',
        condition: 'Good',
        version: 5,
        currentAssignment: null as typeof currentAssignment | null,
        timeline: [],
      },
    ],
  };
  // Block all unrecognized API calls; no request can reach the running API or mail worker.
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (
      method === 'GET' &&
      (path === '/api/v1/notifications/unread-count' || path === '/notifications/unread-count')
    )
      return route.fulfill({ json: { unreadCount: 0 } });
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/v1/me')
      return json(
        admin
          ? { ...session, displayName: 'Synthetic Admin', roles: ['ADMIN', 'EMPLOYEE'] }
          : session,
      );
    if (method === 'GET' && path === '/api/v1/auth/csrf')
      return json({ csrfToken: 'synthetic-assignment-csrf' });
    if (method === 'GET' && path === '/api/v1/references')
      return json({
        departments: [],
        locations: [],
        values: [
          { kind: 'STATUS', code: 'In Store', label: 'In Store', active: true, version: 1 },
          { kind: 'STATUS', code: 'Assigned', label: 'Assigned', active: true, version: 1 },
          { kind: 'STATUS', code: 'Disposed', label: 'Disposed', active: true, version: 1 },
          { kind: 'CATEGORY', code: 'IT Hardware', label: 'IT Hardware', active: true, version: 1 },
        ],
      });
    if (method === 'GET' && path === '/api/v1/transfers/definitions') return json({ items: [] });
    if (method === 'GET' && path === '/api/v1/assets') {
      state.assetQueries.push(url.searchParams);
      const selectedStatus = url.searchParams.get('status');
      return json({
        items: empty
          ? []
          : state.assets.filter((asset) => !selectedStatus || asset.status === selectedStatus),
        nextCursor: null,
      });
    }
    if (method === 'GET' && path === '/api/v1/users') {
      state.userReads++;
      state.userQueries.push(url.searchParams);
      // Deliberately include ineligible records to exercise the form's defensive filtering.
      return json({ items: state.users, nextCursor: null });
    }
    const asset = state.assets.find((item) => path === `/api/v1/assets/${item.id}`);
    if (method === 'GET' && asset) {
      state.assetReads++;
      return json(asset);
    }
    if (method === 'GET' && state.assets.some((item) => path === `/api/v1/assets/${item.id}/photo`))
      return json({ dataUrl: null, updatedAt: null });
    if (method !== 'GET') {
      const write = { method, path, body: request.postDataJSON(), headers: request.headers() };
      state.writes.push(write);
      const selected = state.assets.find(
        (item) =>
          path === `/api/v1/assets/${item.id}/assignments` ||
          path === `/api/v1/assets/${item.id}/reassign`,
      );
      if (admin && method === 'POST' && selected) {
        if (stale)
          return json(
            { error: { code: 'STALE_VERSION', message: 'Synthetic stale version' } },
            412,
          );
        selected.status = 'Assigned';
        selected.version++;
        selected.currentAssignment = {
          ...currentAssignment,
          userId: String(write.body.userId),
          acknowledgement: 'PENDING',
          version: 1,
        };
        return json({ id: selected.currentAssignment.id, assetVersion: selected.version }, 201);
      }
    }
    state.unexpected.push(`${method} ${path}`);
    await route.abort('blockedbyclient');
  });
  return state;
}

test('Admin can discover assignment from the catalog, choose an In Store asset, and explicitly assign to an eligible employee', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Asset catalog', exact: true })).toBeVisible();
  const available = page.getByRole('row').filter({ hasText: assetCode });
  await expect(
    available.getByRole('link', { name: `Assign ${assetCode}`, exact: true }),
  ).toHaveAttribute('href', `/assets/${assetId}/assign`);
  await expect(
    page.getByRole('link', { name: `Transfer ${assignedAssetCode}`, exact: true }),
  ).toHaveAttribute('href', `/assets/${assignedAssetId}/assign?transfer=1`);
  const retired = page.getByRole('row').filter({ hasText: retiredAssetCode });
  await expect(retired.getByRole('link', { name: /^Assign |^Transfer / })).toHaveCount(0);
  await page.getByRole('link', { name: 'Assign asset', exact: true }).click();
  await expect(page).toHaveURL(/\/assignments\/new$/);
  await expect(page.getByRole('heading', { name: 'Assign an asset', exact: true })).toBeVisible();
  await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: assetCode })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: assignedAssetCode })).toHaveCount(0);
  expect(state.assetQueries.at(-1)?.get('status')).toBe('In Store');
  await page.getByRole('link', { name: `Assign ${assetCode}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/assets/${assetId}/assign$`));
  const recipient = page.getByLabel('Approved employee', { exact: true });
  await expect(recipient).toBeVisible();
  expect(state.userQueries[0]?.get('state')).toBe('ACTIVE');
  expect(state.userQueries[0]?.get('role')).toBe('EMPLOYEE');
  const confirm = page.getByRole('button', { name: 'Confirm assignment', exact: true });
  await expect(confirm).toBeDisabled();
  await recipient.click();
  await expect(page.getByRole('option', { name: /Synthetic Recipient/ })).toBeAttached();
  await expect(
    page.getByRole('option', {
      name: /Synthetic Unverified|Synthetic No Portal|Synthetic Disabled|Synthetic Staff Only/,
    }),
  ).toHaveCount(0);
  await page.getByRole('option', { name: /Synthetic Recipient/ }).click();
  await page
    .getByLabel('Handover note', { exact: true })
    .fill('Synthetic laptop issued after review');
  await expect(confirm).toBeEnabled();
  expect(state.writes).toEqual([]);
  await page.screenshot({
    path: join(process.cwd(), 'test-results', 'assignment-discovery.png'),
    fullPage: true,
  });
  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/assets/${assetId}$`));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: `/api/v1/assets/${assetId}/assignments`,
    body: { userId: employeeId, note: 'Synthetic laptop issued after review' },
    headers: { 'if-match': '"7"', 'x-csrf-token': 'synthetic-assignment-csrf' },
  });
  expect(state.writes[0].headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
  expect(state.unexpected).toEqual([]);
});

test('Admin transfer excludes the current custodian and requires an explicit reason before confirmation', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto('/assets');
  await page.getByRole('link', { name: `Transfer ${assignedAssetCode}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Transfer custody', exact: true })).toBeVisible();
  const recipient = page.getByLabel('Approved employee', { exact: true });
  await recipient.click();
  await expect(page.getByRole('option', { name: /Synthetic Current Custodian/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Synthetic Recipient/ }).click();
  const confirm = page.getByRole('button', { name: 'Confirm transfer', exact: true });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel('Reason for transfer', { exact: true })
    .fill('Reviewed synthetic custody change');
  expect(state.writes).toEqual([]);
  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/assets/${assignedAssetId}$`));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: `/api/v1/assets/${assignedAssetId}/reassign`,
    body: { userId: employeeId, reason: 'Reviewed synthetic custody change' },
    headers: { 'if-match': '"14"', 'x-csrf-token': 'synthetic-assignment-csrf' },
  });
  expect(state.writes[0].headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
  expect(state.unexpected).toEqual([]);
});

test('Employee sees no assignment controls and direct chooser or assignment routes require Admin access', async ({
  page,
}) => {
  const state = await mockApi(page, { admin: false });
  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Your assets', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Assign |^Transfer / })).toHaveCount(0);
  await page.goto('/assignments/new');
  await expect(
    page.getByRole('heading', { name: 'Admin access required', exact: true }),
  ).toBeVisible();
  await page.goto(`/assets/${assetId}/assign`);
  await expect(
    page.getByRole('heading', { name: 'Admin access required', exact: true }),
  ).toBeVisible();
  expect(state.userReads).toBe(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('Empty assignment chooser explains inventory prerequisites without offering an invalid assignment', async ({
  page,
}) => {
  const state = await mockApi(page, { empty: true });
  await page.goto('/assignments/new');
  await expect(
    page.getByRole('heading', { name: 'No assets ready for assignment', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Create asset', exact: true }).first(),
  ).toHaveAttribute('href', '/assets/new');
  await expect(
    page.getByRole('link', { name: 'Import review', exact: true }).last(),
  ).toHaveAttribute('href', '/admin/imports');
  await expect(page.getByRole('link', { name: /^Assign IAC-/ })).toHaveCount(0);
  expect(state.assetQueries[0]?.get('status')).toBe('In Store');
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('Background changes retain the chosen asset version and stale custody is rejected without automatic retry', async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockApi(page, { stale: true });
  await page.goto(`/assets/${assetId}/assign`);
  const recipient = page.getByLabel('Approved employee', { exact: true });
  await recipient.click();
  await page.getByRole('option', { name: /Synthetic Recipient/ }).click();
  state.assets[0].version = 8;
  await page.clock.fastForward(21000);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await page.clock.runFor(100);
  await expect.poll(() => state.assetReads).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'This record changed. Reload it and review the latest details before saving.',
  );
  await expect(page).toHaveURL(new RegExp(`/assets/${assetId}/assign$`));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].headers['if-match']).toBe('"7"');
  expect(state.unexpected).toEqual([]);
});

test('A recipient who loses portal eligibility during review cannot be submitted', async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockApi(page);
  await page.goto(`/assets/${assetId}/assign`);
  const recipient = page.getByLabel('Approved employee', { exact: true });
  await recipient.click();
  await page.getByRole('option', { name: /Synthetic Recipient/ }).click();
  const confirm = page.getByRole('button', { name: 'Confirm assignment', exact: true });
  await expect(confirm).toBeEnabled();
  state.users[0].portalAcceptedAt = null;
  const priorReads = state.userReads;
  await page.clock.fastForward(21000);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await page.clock.runFor(100);
  await expect.poll(() => state.userReads).toBeGreaterThan(priorReads);
  await expect(recipient.getByRole('option', { name: /Synthetic Recipient/ })).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('obsolete portal notice acceptance is not an eligible custody recipient', async ({ page }) => {
  const state = await mockApi(page);
  state.users[0].portalNoticeVersion = 'obsolete';
  await page.goto(`/assets/${assetId}/assign`);
  await page.getByLabel('Approved employee', { exact: true }).click();
  await expect(page.getByRole('option', { name: /Synthetic Recipient/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Confirm assignment', exact: true }),
  ).toBeDisabled();
  expect(state.writes).toEqual([]);
});
