import { expect, test, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';

const invited = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'invited.employee@example.test',
  displayName: 'Synthetic Invited Employee',
  roles: ['EMPLOYEE'],
  state: 'INVITED',
  emailVerifiedAt: null,
  portalAcceptedAt: null,
  version: 1,
};
const session = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'synthetic.admin@example.test',
  displayName: 'Synthetic Admin',
  roles: ['ADMIN', 'EMPLOYEE'],
  state: 'ACTIVE',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  portalAcceptedAt: '2026-01-01T00:00:00.000Z',
  portalNoticeVersion: '1',
  currentNoticeVersion: '1',
  mfaEnrolled: true,
  mfaRequired: false,
  version: 1,
};
const users = [
  invited,
  {
    ...invited,
    id: '00000000-0000-4000-8000-000000000003',
    email: 'active.employee@example.test',
    displayName: 'Synthetic Active Employee',
    state: 'ACTIVE',
    emailVerifiedAt: session.emailVerifiedAt,
    portalAcceptedAt: session.portalAcceptedAt,
  },
  {
    ...invited,
    id: '00000000-0000-4000-8000-000000000004',
    email: 'disabled.employee@example.test',
    displayName: 'Synthetic Disabled Employee',
    state: 'DISABLED',
  },
];

// Every application API call is intercepted before navigation. Unknown calls abort;
// this suite never reaches the operational API, database or SMTP worker.
async function mockApi(page: Page, onInvitation: (route: Route) => Promise<void>) {
  const unexpected: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (
      method === 'GET' &&
      (path === '/api/v1/notifications/unread-count' || path === '/notifications/unread-count')
    )
      return route.fulfill({ json: { unreadCount: 0 } });
    if (method === 'GET' && path === '/api/v1/me') {
      await route.fulfill({ json: session });
    } else if (method === 'GET' && path === '/api/v1/users') {
      await route.fulfill({ json: { items: users, nextCursor: null } });
    } else if (method === 'GET' && path === '/api/v1/transfers/definitions') {
      await route.fulfill({ json: { items: [] } });
    } else if (method === 'GET' && path === '/api/v1/references') {
      await route.fulfill({ json: { departments: [], locations: [], values: [] } });
    } else if (method === 'GET' && path === '/api/v1/auth/csrf') {
      await route.fulfill({ json: { csrfToken: 'synthetic-csrf-token' } });
    } else if (method === 'POST' && path === '/api/v1/invitations') {
      await onInvitation(route);
    } else {
      unexpected.push(`${method} ${path}`);
      await route.abort('blockedbyclient');
    }
  });
  return unexpected;
}

const resendName = `Resend invitation to ${invited.displayName}`;

test('only invited users can resend; pending requests prevent duplicates and explain replacement links', async ({
  page,
}) => {
  const posts: { body: unknown; csrf: string | undefined }[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unexpected = await mockApi(page, async (route) => {
    posts.push({
      body: route.request().postDataJSON(),
      csrf: route.request().headers()['x-csrf-token'],
    });
    await held;
    await route.fulfill({ status: 201, json: { message: 'Invitation queued.' } });
  });
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'People & access', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resend invitation to / })).toHaveCount(1);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Synthetic Active Employee' })
      .getByRole('button', { name: /Resend/ }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Synthetic Disabled Employee' })
      .getByRole('button', { name: /Resend/ }),
  ).toHaveCount(0);
  const resend = page.getByRole('button', { name: resendName, exact: true });
  await resend.click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText('Queuing...');
  await resend.dispatchEvent('click');
  await expect(page.getByRole('button', { name: /^Manage / }).first()).toBeDisabled();
  expect(posts).toEqual([
    {
      body: {
        email: invited.email,
        displayName: invited.displayName,
        designation: null,
        departmentId: null,
      },
      csrf: 'synthetic-csrf-token',
    },
  ]);
  release();
  await expect(page.getByRole('status')).toHaveText(
    'Invitation queued again. Earlier invitation links have been replaced.',
  );
  await expect(resend).toBeEnabled();
  expect(posts).toHaveLength(1);
  expect(unexpected).toEqual([]);
  await page.screenshot({
    path: join(process.cwd(), 'test-results', 'resend-invitation-desktop.png'),
    fullPage: true,
  });
});

test('resend failure is actionable and allows a successful retry', async ({ page }) => {
  const posts: unknown[] = [];
  const unexpected = await mockApi(page, async (route) => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'SYNTHETIC_UNAVAILABLE',
            message: 'Invitation could not be queued. Please retry.',
          },
        },
      });
    } else {
      await route.fulfill({ status: 201, json: { message: 'Invitation queued.' } });
    }
  });
  await page.goto('/admin/users');
  const resend = page.getByRole('button', { name: resendName, exact: true });
  await resend.click();
  await expect(page.getByRole('alert')).toContainText(
    'Invitation could not be queued. Please retry.',
  );
  await expect(resend).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(posts).toHaveLength(1);
  await resend.click();
  await expect(page.getByRole('status')).toHaveText(
    'Invitation queued again. Earlier invitation links have been replaced.',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(resend).toBeEnabled();
  expect(posts).toEqual([
    {
      email: invited.email,
      displayName: invited.displayName,
      designation: null,
      departmentId: null,
    },
    {
      email: invited.email,
      displayName: invited.displayName,
      designation: null,
      departmentId: null,
    },
  ]);
  expect(unexpected).toEqual([]);
});
