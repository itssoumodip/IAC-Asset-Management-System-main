import { expect, test, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';

const assetId = '00000000-0000-4000-8000-000000000010';
const employeeId = '00000000-0000-4000-8000-000000000020';
const assetCode = 'IAC-IT-000010';
const timestamp = '2026-01-01T00:00:00.000Z';
const baseSession = {
  id: employeeId,
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

type Photo = { dataUrl: string | null; updatedAt: string | null };
type Write = { method: string; path: string; body: unknown; headers: Record<string, string> };

// Produce a synthetic laptop drawing in memory; no employee or real asset photo is used.
async function syntheticPng(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f1f6fa';
    context.fillRect(0, 0, 480, 300);
    context.fillStyle = '#254963';
    context.fillRect(80, 45, 320, 200);
    context.fillStyle = '#8ab9d3';
    context.fillRect(92, 58, 296, 173);
    context.fillStyle = '#314f65';
    context.font = '24px sans-serif';
    context.fillText('SYNTHETIC ASSET', 122, 143);
    context.fillStyle = '#a9bfce';
    context.beginPath();
    context.moveTo(80, 245);
    context.lineTo(45, 275);
    context.lineTo(435, 275);
    context.lineTo(400, 245);
    context.closePath();
    context.fill();
    return canvas.toDataURL('image/png');
  });
}

async function mockApi(
  page: Page,
  options: {
    admin?: boolean;
    photo?: Photo;
    onPut?: (route: Route, write: Write, state: ReturnType<typeof initialState>) => Promise<void>;
  } = {},
) {
  const state = initialState(options.photo);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (
      method === 'GET' &&
      (path === '/api/v1/notifications/unread-count' || path === '/notifications/unread-count')
    )
      return route.fulfill({ json: { unreadCount: 0 } });
    if (method !== 'GET') {
      const write = {
        method,
        path,
        body: request.postDataJSON(),
        headers: request.headers(),
      };
      state.writes.push(write);
      if (options.admin && method === 'PUT' && path === `/api/v1/assets/${assetId}/photo`) {
        if (options.onPut) await options.onPut(route, write, state);
        else await acceptPhoto(route, write, state);
        return;
      }
    }
    if (method === 'GET' && path === '/api/v1/me') {
      await route.fulfill({
        json: options.admin
          ? {
              ...baseSession,
              id: '00000000-0000-4000-8000-000000000030',
              displayName: 'Synthetic Admin',
              roles: ['ADMIN', 'EMPLOYEE'],
            }
          : baseSession,
      });
    } else if (method === 'GET' && path === '/api/v1/references') {
      await route.fulfill({ json: { values: [], departments: [], locations: [] } });
    } else if (method === 'GET' && path === `/api/v1/assets/${assetId}`) {
      state.assetReads++;
      await route.fulfill({
        json: {
          id: assetId,
          assetCode,
          description: 'Synthetic staff laptop',
          category: 'IT Hardware',
          assetType: 'Laptop',
          status: 'Assigned',
          condition: 'Good',
          manufacturer: 'Synthetic Hardware',
          model: 'Demonstration model',
          serialNumber: 'SYNTHETIC-SERIAL-001',
          riskLevel: 'Low',
          ownershipType: 'Owned',
          version: state.version,
          currentAssignment: {
            id: '00000000-0000-4000-8000-000000000040',
            userId: employeeId,
            acknowledgement: 'ACCEPTED',
            version: 2,
            assignedAt: timestamp,
            acknowledgedAt: timestamp,
          },
          timeline: [],
        },
      });
    } else if (method === 'GET' && path === `/api/v1/assets/${assetId}/photo`) {
      state.photoReads++;
      await route.fulfill({ json: state.photo });
    } else if (method === 'GET' && path === '/api/v1/auth/csrf') {
      await route.fulfill({ json: { csrfToken: 'synthetic-photo-csrf' } });
    } else {
      state.unexpected.push(`${method} ${path}`);
      await route.abort('blockedbyclient');
    }
  });
  return state;
}

function initialState(photo: Photo = { dataUrl: null, updatedAt: null }) {
  return {
    photo,
    version: 7,
    writes: [] as Write[],
    unexpected: [] as string[],
    photoReads: 0,
    assetReads: 0,
  };
}
async function acceptPhoto(route: Route, write: Write, state: ReturnType<typeof initialState>) {
  state.photo = { dataUrl: (write.body as { dataUrl: string }).dataUrl, updatedAt: timestamp };
  state.version++;
  await route.fulfill({ json: { ...state.photo, assetVersion: state.version } });
}
async function chooseSyntheticPhoto(page: Page, png: string) {
  await page.getByLabel('Choose asset photo', { exact: true }).setInputFiles({
    name: 'synthetic-laptop.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png.split(',')[1], 'base64'),
  });
  await expect(page.getByText('Preview, not saved', { exact: true })).toBeVisible();
}

test('Admin previews locally and explicitly saves an asset photo with current version and CSRF', async ({
  page,
}) => {
  const png = await syntheticPng(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await mockApi(page, {
    admin: true,
    onPut: async (route, write, current) => {
      await held;
      await acceptPhoto(route, write, current);
    },
  });
  await page.goto(`/assets/${assetId}`);
  await expect(
    page.getByRole('img', { name: 'Generic laptop illustration', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Generic illustration, not the actual asset', { exact: true }),
  ).toBeVisible();
  await chooseSyntheticPhoto(page, png);
  const preview = page.getByRole('img', { name: `Photo preview for ${assetCode}`, exact: true });
  const prepared = await preview.getAttribute('src');
  expect(prepared).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);
  expect(Buffer.from(prepared!.split(',')[1], 'base64').length).toBeLessThanOrEqual(40 * 1024);
  expect(state.writes).toEqual([]);
  const save = page.getByRole('button', { name: 'Save photo', exact: true });
  await expect(save).toBeDisabled();
  await page
    .getByLabel('Photo change reason', { exact: true })
    .fill('  Approved synthetic asset image  ');
  expect(state.writes).toEqual([]);
  await save.click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Saving photo...', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Choose asset photo', { exact: true })).toBeDisabled();
  expect(state.writes[0]).toMatchObject({
    method: 'PUT',
    path: `/api/v1/assets/${assetId}/photo`,
    body: { dataUrl: prepared, reason: 'Approved synthetic asset image' },
    headers: { 'if-match': '"7"', 'x-csrf-token': 'synthetic-photo-csrf' },
  });
  release();
  await expect(page.getByRole('status')).toHaveText('Asset photo saved.');
  await expect(
    page.getByRole('img', { name: `Asset photo for ${assetCode}`, exact: true }),
  ).toHaveAttribute('src', prepared!);
  await expect(page.getByText('Preview, not saved', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'Generic laptop illustration', exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => state.photoReads).toBeGreaterThan(1);
  await expect.poll(() => state.assetReads).toBeGreaterThan(1);
  await page.reload();
  await expect(
    page.getByRole('img', { name: `Asset photo for ${assetCode}`, exact: true }),
  ).toHaveAttribute('src', prepared!);
  expect(state.writes).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test('Employee sees the saved photo and read-only detail on desktop and mobile; direct editing is denied', async ({
  page,
}) => {
  const png = await syntheticPng(page);
  const state = await mockApi(page, { photo: { dataUrl: png, updatedAt: timestamp } });
  await page.goto(`/assets/${assetId}`);
  await expect(
    page.getByRole('img', { name: `Asset photo for ${assetCode}`, exact: true }),
  ).toHaveAttribute('src', png);
  await expect(
    page.getByText(
      'Asset details are read-only. Contact Admin or raise a support ticket to request a correction.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Raise a ticket', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit asset', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Assign asset|Transfer custody/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record return', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Choose asset photo', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Photo change reason', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save photo', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: join(process.cwd(), 'test-results', 'asset-photo-employee.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('img', { name: `Asset photo for ${assetCode}`, exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto(`/assets/${assetId}/edit`);
  await expect(
    page.getByRole('heading', { name: 'Admin access required', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Save asset|Save photo/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('failed photo save retains the local draft and reason for an explicit retry', async ({
  page,
}) => {
  const png = await syntheticPng(page);
  const state = await mockApi(page, {
    admin: true,
    onPut: async (route, write, current) => {
      if (current.writes.length === 1)
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'SYNTHETIC_UNAVAILABLE',
              message: 'Photo could not be saved. Please retry.',
            },
          },
        });
      else await acceptPhoto(route, write, current);
    },
  });
  await page.goto(`/assets/${assetId}`);
  await chooseSyntheticPhoto(page, png);
  await page
    .getByLabel('Photo change reason', { exact: true })
    .fill('Approved synthetic replacement');
  await page.getByRole('button', { name: 'Save photo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Photo could not be saved. Please retry.');
  await expect(page.getByText('Preview, not saved', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Photo change reason', { exact: true })).toHaveValue(
    'Approved synthetic replacement',
  );
  await expect(page.getByRole('button', { name: 'Save photo', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save photo', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Asset photo saved.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body).toEqual(state.writes[0].body);
  expect(state.writes[1].headers['if-match']).toBe('"7"');
  expect(state.unexpected).toEqual([]);
});
