import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-01-01T00:00:00.000Z';
const itId = '00000000-0000-4000-8000-000000000001';
const admId = '00000000-0000-4000-8000-000000000002';
const prjId = '00000000-0000-4000-8000-000000000003';
const oldId = '00000000-0000-4000-8000-000000000004';
const projectOne = '00000000-0000-4000-8000-0000000000a1';
const projectOld = '00000000-0000-4000-8000-0000000000a2';
const deptId = '00000000-0000-4000-8000-0000000000d1';
const locId = '00000000-0000-4000-8000-0000000000e1';

const create = 'asset.create' as const;
const viewAll = 'asset.view_all' as const;
const finance = 'asset.finance_edit' as const;

type Caps = { global: string[]; teams: Record<string, string[]> };
const baseSession = {
  id: '00000000-0000-4000-8000-000000000020',
  email: 'synthetic.user@example.test',
  displayName: 'Synthetic User',
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

const users: Record<string, { roles: string[]; teams: unknown[]; capabilities: Caps }> = {
  // Member of IT and Admin (can create), view-only in Projects.
  member: {
    roles: ['EMPLOYEE'],
    teams: [
      { teamId: itId, teamCode: 'IT', level: 'MEMBER' },
      { teamId: admId, teamCode: 'ADM', level: 'MEMBER' },
      { teamId: prjId, teamCode: 'PRJ', level: 'MEMBER' },
    ],
    capabilities: {
      global: [],
      teams: { [itId]: [viewAll, create], [admId]: [viewAll, create], [prjId]: [viewAll] },
    },
  },
  // Member of Admin only.
  adminOnly: {
    roles: ['EMPLOYEE'],
    teams: [{ teamId: admId, teamCode: 'ADM', level: 'MEMBER' }],
    capabilities: { global: [], teams: { [admId]: [viewAll, create] } },
  },
  // Member of every team that can create, including the project team.
  projects: {
    roles: ['EMPLOYEE'],
    teams: [{ teamId: prjId, teamCode: 'PRJ', level: 'MEMBER' }],
    capabilities: { global: [], teams: { [prjId]: [viewAll, create] } },
  },
  finance: {
    roles: ['FINANCE', 'EMPLOYEE'],
    teams: [],
    capabilities: { global: [viewAll, create, finance], teams: {} },
  },
  // Finance without any asset.edit: may only change finance fields.
  financeOnly: {
    roles: ['FINANCE', 'EMPLOYEE'],
    teams: [],
    capabilities: { global: [viewAll, 'asset.view_private', finance], teams: {} },
  },
  // Team lead holding asset.import for its own team, but not system.admin.
  lead: {
    roles: ['EMPLOYEE'],
    teams: [{ teamId: itId, teamCode: 'IT', level: 'LEAD' }],
    capabilities: {
      global: [],
      teams: { [itId]: [viewAll, create, 'asset.edit', 'asset.import'] },
    },
  },
  executive: {
    roles: ['EXECUTIVE', 'EMPLOYEE'],
    teams: [],
    capabilities: { global: [viewAll, 'report.view'], teams: {} },
  },
};

const values = [
  ['CATEGORY', 'IT_HARDWARE', 'IT Hardware'],
  ['ASSET_TYPE', 'Laptop', 'Laptop'],
  ['ASSET_TYPE', 'Projector', 'Projector'],
  ['OWNERSHIP', 'Owned', 'Owned'],
  ['CONDITION', 'Good', 'Good'],
  ['RISK', 'Low', 'Low'],
  ['STATUS', 'In Store', 'In Store'],
  ['DEPRECIATION_METHOD', 'SLM', 'Straight line'],
].map(([kind, code, label]) => ({ kind, code, label, active: true, version: 1 }));

const references = {
  values,
  departments: [{ id: deptId, name: 'Operations', code: 'OPS', active: true, version: 1 }],
  locations: [
    { id: locId, code: 'R1', site: 'Kolkata', room: 'Room 1', active: true, version: 1 },
  ],
  teams: [
    team(itId, 'IT', 'IT', 'IT', false, true),
    team(admId, 'ADM', 'Admin', 'ADM', false, true),
    team(prjId, 'PRJ', 'Projects', 'PRJ', true, true),
    team(oldId, 'OLD', 'Retired team', 'OLD', false, false),
  ],
  projects: [
    project(projectOne, 'GR1', 'Grant One', true),
    project(projectOld, 'GR0', 'Closed Grant', false),
  ],
  assetTypePolicies: [{ assetTypeCode: 'Projector', requiresCustodian: false }],
};

function team(
  id: string,
  code: string,
  name: string,
  assetCodePrefix: string,
  requiresProject: boolean,
  active: boolean,
) {
  return { id, code, name, assetCodePrefix, requiresProject, active, version: 1, prefixInUse: true };
}
function project(id: string, code: string, name: string, active: boolean) {
  return {
    id,
    code,
    name,
    funder: null,
    grantReference: null,
    startDate: '2026-01-01',
    endDate: null,
    active,
    version: 1,
  };
}

const catalog = [
  asset('00000000-0000-4000-8000-000000000101', 'IAC-IT-000001', itId, null),
  asset('00000000-0000-4000-8000-000000000102', 'IAC-PRJ-000001', prjId, projectOne),
];
function asset(id: string, assetCode: string, owningTeamId: string, projectId: string | null) {
  return {
    id,
    assetCode,
    description: `Synthetic ${assetCode}`,
    category: 'IT_HARDWARE',
    assetType: 'Laptop',
    status: 'In Store',
    condition: 'Good',
    owningTeamId,
    projectId,
    version: 1,
    currentAssignment: null,
  };
}

async function mockApi(page: Page, who: keyof typeof users) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const listQueries: URLSearchParams[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== 'GET') {
      writes.push({ method, path, body: request.postDataJSON() });
      if (method === 'POST' && path === '/api/v1/assets') {
        await route.fulfill({ status: 201, json: { ...catalog[0], id: catalog[0].id } });
        return;
      }
    }
    if (method === 'GET' && path === '/api/v1/me') {
      await route.fulfill({ json: { ...baseSession, ...users[who] } });
    } else if (method === 'GET' && path === '/api/v1/references') {
      await route.fulfill({ json: references });
    } else if (method === 'GET' && path === '/api/v1/assets') {
      listQueries.push(url.searchParams);
      const teamFilter = url.searchParams.get('owningTeamId');
      const projectFilter = url.searchParams.get('projectId');
      const items = catalog.filter(
        (item) =>
          (!teamFilter || item.owningTeamId === teamFilter) &&
          (!projectFilter || item.projectId === projectFilter),
      );
      await route.fulfill({ json: { items, nextCursor: null } });
    } else if (method === 'GET' && path.startsWith('/api/v1/assets/')) {
      const found = catalog.find((item) => path === `/api/v1/assets/${item.id}`);
      if (found) await route.fulfill({ json: { ...found, timeline: [] } });
      else await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'No' } } });
    } else if (method === 'GET' && path === '/api/v1/auth/csrf') {
      await route.fulfill({ json: { csrfToken: 'synthetic-team-csrf' } });
    } else if (method === 'GET') {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else {
      await route.abort('blockedbyclient');
    }
  });
  return { writes, listQueries };
}

async function choose(page: Page, id: string, option: string) {
  await page.locator(`#${id}`).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('Owning team picker lists only teams the user can create in', async ({ page }) => {
  await mockApi(page, 'member');
  await page.goto('/assets/new');
  await page.locator('#owningTeamId').click();
  await expect(page.getByRole('option')).toHaveText(['Select team', 'IT (IT)', 'Admin (ADM)']);
});

test('Project becomes required for the Projects team', async ({ page }) => {
  await mockApi(page, 'projects');
  await page.goto('/assets/new');
  // A single permitted team is preselected.
  await expect(page.getByText('Project / grant (required)', { exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: 'Create asset', exact: true });
  await expect(save).toBeDisabled();
  await page.locator('#projectId').click();
  await expect(page.getByRole('option')).toHaveText(['Select project', 'Grant One (GR1)']);
  await page.getByRole('option', { name: 'Grant One (GR1)', exact: true }).click();
  await expect(save).toBeEnabled();
});

test('Project is optional for a team that does not require one', async ({ page }) => {
  await mockApi(page, 'adminOnly');
  await page.goto('/assets/new');
  await expect(page.getByText('Project / grant', { exact: true })).toBeVisible();
  await expect(page.getByText('Project / grant (required)', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create asset', exact: true })).toBeEnabled();
});

test('code preview shows IAC-ADM-… for the Admin team', async ({ page }) => {
  await mockApi(page, 'member');
  await page.goto('/assets/new');
  await choose(page, 'owningTeamId', 'Admin (ADM)');
  await expect(page.getByText('IAC-ADM-…', { exact: true })).toBeVisible();
  await choose(page, 'owningTeamId', 'IT (IT)');
  await expect(page.getByText('IAC-IT-…', { exact: true })).toBeVisible();
});

test('Location required hint for room-held types', async ({ page }) => {
  await mockApi(page, 'adminOnly');
  await page.goto('/assets/new');
  const hint = 'A location is required because this asset type is held in a room.';
  await expect(page.getByText(hint)).toHaveCount(0);
  await choose(page, 'assetType', 'Projector');
  await expect(page.getByText(hint)).toBeVisible();
  const save = page.getByRole('button', { name: 'Create asset', exact: true });
  await expect(save).toBeDisabled();
  await choose(page, 'locationId', 'Kolkata / Room 1');
  await expect(save).toBeEnabled();
  await choose(page, 'assetType', 'Laptop');
  await expect(page.getByText(hint)).toHaveCount(0);
});

test('finance fields are read-only for a team member and editable for Finance', async ({
  page,
}) => {
  const { writes } = await mockApi(page, 'adminOnly');
  await page.goto('/assets/new');
  for (const id of ['purchaseCost', 'residualValue', 'invoiceNumber', 'supplier', 'purchaseDate'])
    await expect(page.locator(`#${id}`)).not.toBeEditable();
  // Demo values must not leak finance data into a member's create request.
  await page.getByRole('button', { name: 'Fill demo values', exact: true }).click();
  await page.getByRole('button', { name: 'Create asset', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ owningTeamId: admId });
  for (const key of [
    'purchaseDate',
    'purchaseCost',
    'currency',
    'residualValue',
    'depreciationMethod',
    'usefulLifeYears',
    'invoiceNumber',
    'supplier',
    'insurancePolicyNumber',
    'insuranceExpiry',
    'financePending',
  ])
    expect(writes[0].body).not.toHaveProperty(key);
});

test('Finance can edit finance fields and sends them on create', async ({ page }) => {
  const { writes } = await mockApi(page, 'finance');
  await page.goto('/assets/new');
  await choose(page, 'owningTeamId', 'IT (IT)');
  for (const id of ['purchaseCost', 'residualValue', 'invoiceNumber', 'supplier'])
    await expect(page.locator(`#${id}`)).toBeEditable();
  await page.getByRole('button', { name: 'Fill demo values', exact: true }).click();
  await page.getByRole('button', { name: 'Create asset', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ owningTeamId: itId, purchaseCost: '45999.00' });
});

test('catalog filters by team and project', async ({ page }) => {
  const { listQueries } = await mockApi(page, 'member');
  await page.goto('/assets');
  await expect(page.getByRole('link', { name: 'IAC-IT-000001', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'IAC-PRJ-000001', exact: true })).toBeVisible();
  await choose(page, 'filter-team', 'Projects (PRJ)');
  await expect(page.getByRole('link', { name: 'IAC-IT-000001', exact: true })).toHaveCount(0);
  await expect.poll(() => listQueries.at(-1)?.get('owningTeamId')).toBe(prjId);
  await choose(page, 'filter-project', 'Grant One (GR1)');
  await expect.poll(() => listQueries.at(-1)?.get('projectId')).toBe(projectOne);
  expect(listQueries.at(-1)?.get('owningTeamId')).toBe(prjId);
  await expect(page.getByRole('link', { name: 'IAC-PRJ-000001', exact: true })).toBeVisible();
});

test('write actions are hidden for Executive', async ({ page }) => {
  const { writes } = await mockApi(page, 'executive');
  await page.goto('/assets');
  await expect(page.getByRole('link', { name: 'IAC-IT-000001', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create asset', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Assign asset', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Print label/ })).toHaveCount(0);
  await expect(page.locator('header.page-heading .actions')).toHaveCount(0);
  await page.goto('/assets/00000000-0000-4000-8000-000000000101');
  await expect(page.getByRole('heading', { name: 'Synthetic IAC-IT-000001' })).toBeVisible();
  await expect(page.locator('header.page-heading .actions')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit asset', exact: true })).toHaveCount(0);
  await page.goto('/assets/new');
  await expect(page.getByRole('heading', { name: 'Access required' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create asset', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('Finance can open edit and saves only finance fields', async ({ page }) => {
  const { writes } = await mockApi(page, 'financeOnly');
  await page.goto('/assets/00000000-0000-4000-8000-000000000101');
  await expect(page.getByRole('link', { name: 'Edit asset', exact: true })).toBeVisible();
  await page.goto('/assets/00000000-0000-4000-8000-000000000101/edit');
  await expect(page.getByRole('heading', { name: 'Edit asset' })).toBeVisible();
  await expect(page.locator('#description')).toBeDisabled();
  await expect(page.locator('#remarks')).toBeDisabled();
  await expect(page.locator('#purchaseCost')).toBeEditable();
  await page.locator('#purchaseCost').fill('1234.50');
  await page.locator('#reason').fill('Invoice received');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PATCH');
  expect(Object.keys(writes[0].body).sort()).toEqual(['purchaseCost', 'reason']);
});

test('Import review is hidden from team leads', async ({ page }) => {
  await mockApi(page, 'lead');
  await page.goto('/assets');
  await expect(page.getByRole('link', { name: 'IAC-IT-000001', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import review' })).toHaveCount(0);
  await page.goto('/admin/imports');
  await expect(page.getByRole('heading', { name: 'Access required' })).toBeVisible();
});
