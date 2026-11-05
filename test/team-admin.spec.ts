import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-01-01T00:00:00.000Z';
const itId = '00000000-0000-4000-8000-000000000001';
const admId = '00000000-0000-4000-8000-000000000002';
const session = {
  id: '00000000-0000-4000-8000-000000000030',
  email: 'synthetic.admin@example.test',
  displayName: 'Synthetic Admin',
  state: 'ACTIVE',
  emailVerifiedAt: timestamp,
  portalAcceptedAt: timestamp,
  portalNoticeVersion: '1',
  currentNoticeVersion: '1',
  mfaEnrolled: true,
  mfaRequired: false,
  version: 1,
};
const people = {
  superAdmin: {
    roles: ['SUPER_ADMIN', 'EMPLOYEE'],
    teams: [],
    capabilities: { global: ['system.admin', 'team.manage_members', 'asset.view_all'], teams: {} },
  },
  itLead: {
    roles: ['EMPLOYEE'],
    teams: [{ teamId: itId, teamCode: 'IT', level: 'LEAD' }],
    capabilities: { global: ['asset.view_all'], teams: { [itId]: ['team.manage_members'] } },
  },
};
const references = {
  values: [{ kind: 'ASSET_TYPE', code: 'Printer', label: 'Printer', active: true, version: 1 }],
  departments: [],
  locations: [],
  teams: [
    {
      id: itId,
      code: 'IT',
      name: 'IT',
      assetCodePrefix: 'IT',
      active: true,
      version: 1,
      prefixInUse: true,
    },
    {
      id: admId,
      code: 'ADM',
      name: 'Admin',
      assetCodePrefix: 'ADM',
      active: true,
      version: 1,
      prefixInUse: false,
    },
  ],
  assetTypePolicies: [{ assetTypeCode: 'Printer', requiresCustodian: false }],
};

async function mockApi(page: Page, who: keyof typeof people) {
  const writes: { method: string; path: string; body: any }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') {
      writes.push({ method, path, body: request.postDataJSON() });
      await route.fulfill({ status: 200, json: { ok: true } });
    } else if (path === '/api/v1/me') await route.fulfill({ json: { ...session, ...people[who] } });
    else if (path === '/api/v1/references') await route.fulfill({ json: references });
    else if (path === '/api/v1/auth/csrf')
      await route.fulfill({ json: { csrfToken: 'synthetic' } });
    else if (path === `/api/v1/teams/${itId}/members`)
      await route.fulfill({
        json: {
          items: [
            {
              userId: 'u1',
              displayName: 'Asha Rao',
              email: 'asha@example.test',
              level: 'MEMBER',
              grantedAt: timestamp,
            },
          ],
        },
      });
    else await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return writes;
}

test('super admin creates team with prefix; prefix field locked after use', async ({ page }) => {
  const writes = await mockApi(page, 'superAdmin');
  await page.goto('/admin/teams');
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
  await expect(page.getByLabel('Asset code prefix for IT')).toHaveAttribute('readonly', '');
  await page.getByLabel('New team code').fill('LIB');
  await page.getByLabel('New team name').fill('Library');
  await page.getByLabel('New team asset code prefix').fill('LIB');
  await page.getByLabel('Reason for new team').fill('New library team');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect
    .poll(() => writes.find((w) => w.path === '/api/v1/master-data/teams')?.body)
    .toMatchObject({ code: 'LIB', name: 'Library', assetCodePrefix: 'LIB' });
});

test('lead sees only own team page', async ({ page }) => {
  await mockApi(page, 'itLead');
  await page.goto(`/team/${itId}`);
  await expect(page.getByText('Asha Rao')).toBeVisible();
  await page.goto(`/team/${admId}`);
  await expect(page.getByText('You can only manage teams you lead.')).toBeVisible();
  await page.goto('/admin/teams');
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toHaveCount(0);
});

test('membership change asks for reason and warns sessions will be revoked', async ({ page }) => {
  const writes = await mockApi(page, 'itLead');
  await page.goto(`/team/${itId}`);
  await expect(
    page.getByText('Saving signs that person out so the change applies straight away.'),
  ).toBeVisible();
  await page.getByLabel('Employee email').fill('new.person@example.test');
  const add = page.getByRole('button', { name: 'Add to team' });
  await expect(add).toBeDisabled();
  await page.getByLabel('Reason for membership change').fill('Joined IT');
  await add.click();
  await expect
    .poll(() => writes.find((w) => w.method === 'POST')?.body)
    .toMatchObject({ email: 'new.person@example.test', level: 'MEMBER', reason: 'Joined IT' });
});
