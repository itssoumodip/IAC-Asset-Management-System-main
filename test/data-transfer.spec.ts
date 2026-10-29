import { expect, test, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const employeeId = '00000000-0000-4000-8000-000000000020';
const departmentId = '00000000-0000-4000-8000-000000000050';
const ticketId = '00000000-0000-4000-8000-000000000080';
const timestamp = '2026-01-01T00:00:00.000Z';
const session = {
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
type Write = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};
const csv = (headers: string[], values: string[][]) =>
  '\uFEFF' +
  [headers, ...values]
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
const assets = Array.from({ length: 37 }, (_, index) => ({
  id: `asset-synthetic-${index + 1}`,
  assetCode: `IAC-IT-${String(index + 1).padStart(6, '0')}`,
  description: `Synthetic laptop ${index + 1}`,
  category: 'IT Hardware',
  assetType: 'Laptop',
  condition: 'Good',
  status: 'Assigned',
  version: 99,
  currentAssignment: { userId: employeeId, acknowledgement: 'ACCEPTED', version: 3 },
  purchaseCost: 'PRIVATE_FINANCE_SENTINEL',
  rawFields: { forbidden: 'PRIVATE_SOURCE_SENTINEL' },
  internalNotes: 'PRIVATE_NOTE_SENTINEL',
  password: 'PRIVATE_PASSWORD_SENTINEL',
  roles: ['ADMIN'],
}));
async function mockApi(page: Page, { admin = false, failFirstCommit = false } = {}) {
  const state = {
    writes: [] as Write[],
    unexpected: [] as string[],
    exportPages: [] as string[],
    previews: 0,
    commits: 0,
    departments: [
      { id: departmentId, code: 'SYNTH', name: 'Synthetic Operations', active: true, version: 31 },
    ],
    ticket: {
      id: ticketId,
      ticketNumber: 80,
      subject: 'Synthetic support',
      description: 'Synthetic details',
      category: 'HARDWARE',
      priority: 'MEDIUM',
      status: 'OPEN',
      version: 1,
      reporterId: employeeId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
  // No application API request is allowed to fall through to the running app.
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    if (
      method === 'GET' &&
      (path === '/api/v1/notifications/unread-count' || path === '/notifications/unread-count')
    )
      return route.fulfill({ json: { unreadCount: 0 } });
    const json = async (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/v1/me')
      return json(
        admin
          ? { ...session, displayName: 'Synthetic Admin', roles: ['ADMIN', 'EMPLOYEE'] }
          : session,
      );
    if (method === 'GET' && path === '/api/v1/auth/csrf')
      return json({ csrfToken: 'synthetic-transfer-csrf' });
    if (method === 'GET' && path === '/api/v1/references')
      return json({
        departments: state.departments,
        locations: [],
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
      });
    if (method === 'GET' && path === '/api/v1/master-data')
      return json({ departments: state.departments, locations: [], values: [], kinds: [] });
    if (method === 'GET' && path === '/api/v1/transfers/definitions')
      return json({
        items: admin
          ? [
              {
                module: 'masters:departments',
                label: 'departments',
                columns: ['operation', 'code', 'name', 'active'],
                example: {
                  operation: 'create',
                  code: 'DEMO',
                  name: 'Synthetic department',
                  active: 'true',
                },
                description: 'Create approved synthetic departments.',
              },
            ]
          : [],
      });
    if (method === 'GET' && path === '/api/v1/assets') {
      if (url.searchParams.get('limit') === '100')
        state.exportPages.push(url.searchParams.get('cursor') ?? 'first');
      return json({
        items: url.searchParams.get('cursor') ? assets.slice(25) : assets.slice(0, 25),
        nextCursor: url.searchParams.get('cursor') ? null : 'synthetic-page-2',
      });
    }
    if (method === 'GET' && /^\/api\/v1\/assets\/[^/]+$/.test(path)) {
      const asset = assets.find((a) => a.id === path.split('/').pop());
      return json(
        asset ?? { error: { code: 'NOT_FOUND', message: 'Asset not found' } },
        asset ? 200 : 404,
      );
    }
    if (method === 'GET' && path === `/api/v1/tickets/${ticketId}`) return json(state.ticket);
    if (method === 'GET' && path === `/api/v1/tickets/${ticketId}/updates`)
      return json({ items: [], nextCursor: null });
    if (method !== 'GET') {
      const write = { method, path, body: request.postDataJSON(), headers: request.headers() };
      state.writes.push(write);
      if (admin && method === 'POST' && path === '/api/v1/transfers/preview') {
        state.previews++;
        const rows = write.body.rows as { code: string; name: string }[];
        return json({
          id: `synthetic-preview-${state.previews}`,
          module: 'masters:departments',
          rowCount: rows.length,
          valid: true,
          rows: rows.map((row, index) => ({
            rowNumber: index + 2,
            valid: true,
            errors: [],
            summary: `Create ${row.code}: ${row.name}`,
          })),
          warnings: ['Synthetic test data only.'],
        });
      }
      if (
        admin &&
        method === 'POST' &&
        /^\/api\/v1\/transfers\/synthetic-preview-\d+\/commit$/.test(path)
      ) {
        state.commits++;
        if (failFirstCommit && state.commits === 1)
          return json(
            {
              error: {
                code: 'SYNTHETIC_STALE',
                message: 'This preview expired. Validate again before applying.',
              },
            },
            409,
          );
        state.departments.push(
          {
            id: 'synthetic-department-two',
            code: 'BULK_A',
            name: 'Synthetic Bulk Alpha',
            active: true,
            version: 1,
          },
          {
            id: 'synthetic-department-three',
            code: 'BULK_B',
            name: 'Synthetic Bulk Beta',
            active: true,
            version: 1,
          },
        );
        return json({ rowCount: 2, skippedCount: 0, state: 'COMMITTED' });
      }
      if (
        admin &&
        method === 'PATCH' &&
        path === `/api/v1/master-data/departments/${departmentId}`
      ) {
        state.departments[0] = {
          ...state.departments[0],
          name: String(write.body.name),
          active: Boolean(write.body.active),
          version: 32,
        };
        return json(state.departments[0]);
      }
      if (!admin && method === 'POST' && path === '/api/v1/tickets') {
        state.ticket = { ...state.ticket, ...write.body };
        return json(state.ticket, 201);
      }
    }
    state.unexpected.push(`${method} ${path}`);
    await route.abort('blockedbyclient');
  });
  return state;
}
async function downloadFrom(page: Page, click: () => Promise<void>): Promise<Download> {
  const pending = page.waitForEvent('download');
  await click();
  return pending;
}
async function downloadText(file: Download) {
  const path = await file.path();
  expect(path).toBeTruthy();
  return readFile(path!, 'utf8');
}
async function importCsv(page: Page, label: string, name: string, content: string) {
  await page
    .getByLabel(label, { exact: true })
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
}

test('Admin bulk CSV preview requires explicit confirmation; expired preview can be revalidated and committed with receipt', async ({
  page,
}) => {
  const state = await mockApi(page, { admin: true, failFirstCommit: true });
  await page.goto('/master-control');
  await page.getByText('Bulk import departments', { exact: true }).click();
  await importCsv(
    page,
    'Bulk import file',
    'synthetic-departments.csv',
    csv(
      ['operation', 'code', 'name', 'active'],
      [
        ['create', 'BULK_A', 'Synthetic Bulk Alpha', 'true'],
        ['create', 'BULK_B', 'Synthetic Bulk Beta', 'true'],
      ],
    ),
  );
  await expect(
    page.getByText('synthetic-departments.csv · 2 rows ready for validation', { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByLabel('Import reason', { exact: true }).fill('Approved synthetic setup batch');
  await page.getByRole('button', { name: 'Validate import', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Import preview · 2 rows', exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/api/v1/transfers/preview',
    headers: { 'x-csrf-token': 'synthetic-transfer-csrf' },
    body: {
      module: 'masters:departments',
      filename: 'synthetic-departments.csv',
      reason: 'Approved synthetic setup batch',
      rows: [
        { operation: 'create', code: 'BULK_A', name: 'Synthetic Bulk Alpha', active: 'true' },
        { operation: 'create', code: 'BULK_B', name: 'Synthetic Bulk Beta', active: 'true' },
      ],
    },
  });
  expect(state.writes[0].body.sha256).toMatch(/^[a-f0-9]{64}$/);
  const apply = page.getByRole('button', { name: 'Apply 2 valid rows', exact: true });
  await expect(apply).toBeDisabled();
  await page.getByRole('checkbox', { name: /I reviewed these changes and authorize/ }).check();
  await apply.click();
  await expect(page.getByRole('alert')).toContainText(
    'This preview expired. Validate again before applying.',
  );
  expect(state.commits).toBe(1);
  await page.getByLabel('Import reason', { exact: true }).fill('Revalidated synthetic setup batch');
  await expect(apply).toHaveCount(0);
  await page.getByRole('button', { name: 'Validate import', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Import preview · 2 rows', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: /I reviewed these changes and authorize/ }),
  ).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await page.getByRole('checkbox', { name: /I reviewed these changes and authorize/ }).check();
  await apply.click();
  await expect(page.getByRole('status')).toHaveText(
    '2 records imported. 0 invalid rows skipped. Changes saved with an audit trail.',
  );
  expect(
    state.writes.filter((write) => write.path.endsWith('/commit')).map((write) => write.body),
  ).toEqual([{ confirmed: true }, { confirmed: true }]);
  expect(state.previews).toBe(2);
  expect(state.commits).toBe(2);
  await expect(page.getByRole('row').filter({ hasText: 'Synthetic Bulk Alpha' })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.screenshot({
    path: join(process.cwd(), 'test-results', 'data-transfer-master.png'),
    fullPage: true,
  });
});

test('single form CSV load and browser Excel roundtrip only populate editable fields; normal Save remains explicit', async ({
  page,
}) => {
  const state = await mockApi(page, { admin: true });
  await page.goto('/master-control');
  await page.getByRole('button', { name: 'Edit Synthetic Operations', exact: true }).click();
  const editor = page.locator('.master-editor');
  await editor.getByText('Import / export form', { exact: true }).click();
  const source = csv(
    ['__form', 'name', 'active', 'reason'],
    [
      [
        `master:departments:${departmentId}`,
        'Synthetic Updated Operations',
        'false',
        'Approved synthetic form change',
      ],
    ],
  );
  await importCsv(page, 'Import form file', 'synthetic-master-draft.csv', source);
  await expect(
    page.getByRole('heading', { name: 'Review imported fields', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Synthetic Operations');
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Load into form', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Synthetic Updated Operations',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Active for new records', exact: true }),
  ).not.toBeChecked();
  expect(state.writes).toEqual([]);
  await page.getByLabel('Name', { exact: true }).fill("'=Synthetic literal text");
  const csvDownload = await downloadFrom(page, () =>
    editor.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  );
  const exported = await downloadText(csvDownload);
  expect(exported.split(/\r?\n/)[0].replace(/^\uFEFF/, '')).toBe(
    '"__form","name","active","reason"',
  );
  expect(exported).not.toMatch(/password|secret|roles|emailVerifiedAt|portalAcceptedAt|"version"/);
  expect(exported).toContain("''=Synthetic literal text");
  await page.getByLabel('Name', { exact: true }).fill('Unsaved CSV replacement');
  await importCsv(page, 'Import form file', csvDownload.suggestedFilename(), exported);
  await expect(
    page.getByRole('heading', { name: 'Review imported fields', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load into form', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue("'=Synthetic literal text");
  expect(state.writes).toEqual([]);
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Updated Operations');
  const excelDownload = await downloadFrom(page, () =>
    editor.getByRole('button', { name: 'Export Excel', exact: true }).click(),
  );
  expect(excelDownload.suggestedFilename()).toMatch(/\.xlsx$/);
  await excelDownload.saveAs(join(process.cwd(), 'test-results', 'data-transfer-roundtrip.xlsx'));
  const excelPath = await excelDownload.path();
  expect(excelPath).toBeTruthy();
  await page.getByLabel('Name', { exact: true }).fill('Unapplied manual draft');
  await page.getByLabel('Import form file', { exact: true }).setInputFiles({
    name: excelDownload.suggestedFilename(),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await readFile(excelPath!),
  });
  await expect(
    page.getByRole('heading', { name: 'Review imported fields', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unapplied manual draft');
  await page.getByRole('button', { name: 'Load into form', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Synthetic Updated Operations',
  );
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Synthetic Updated Operations updated.');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: 'PATCH',
    path: `/api/v1/master-data/departments/${departmentId}`,
    body: {
      name: 'Synthetic Updated Operations',
      active: false,
      reason: 'Approved synthetic form change',
    },
    headers: { 'if-match': '"31"', 'x-csrf-token': 'synthetic-transfer-csrf' },
  });
  expect(Object.keys(state.writes[0].body).sort()).toEqual(['active', 'name', 'reason']);
  expect(state.unexpected).toEqual([]);
});

test('Employee exports all assigned records without private columns and imports a ticket form without asset editing or bulk access', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Your assets', exact: true })).toBeVisible();
  await expect(page.getByText('Bulk import assets', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Bulk import assignments', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Create asset|Edit asset/ })).toHaveCount(0);
  const file = await downloadFrom(page, () =>
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  );
  const exported = await downloadText(file);
  expect(exported.trim().split(/\r?\n/)).toHaveLength(38);
  expect(exported).toContain('IAC-IT-000037');
  expect(exported).not.toMatch(
    /PRIVATE_|purchaseCost|residualValue|rawFields|internalNotes|password|"roles"|"version"/,
  );
  expect(state.exportPages).toEqual(['first', 'synthetic-page-2']);
  expect(state.writes).toEqual([]);
  await page.goto('/tickets/new');
  await page.getByText('Import / export form', { exact: true }).click();
  await importCsv(
    page,
    'Import form file',
    'synthetic-ticket.csv',
    csv(
      ['__form', 'subject', 'description', 'category', 'priority', 'assetId'],
      [
        [
          'ticket-create',
          'Synthetic imported request',
          'Synthetic keyboard requires attention.',
          'HARDWARE',
          'MEDIUM',
          assets[0].id,
        ],
      ],
    ),
  );
  await expect(
    page.getByRole('heading', { name: 'Review imported fields', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Load into form', exact: true }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(
    'Synthetic imported request',
  );
  // Check the select's displayed value (the trigger button shows the selected option's label)
  await expect(page.getByLabel('Related asset (optional)', { exact: true })).toContainText(
    assets[0].assetCode,
  );
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Submit ticket →', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic imported request', exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/api/v1/tickets',
    body: {
      assetId: assets[0].id,
      subject: 'Synthetic imported request',
      description: 'Synthetic keyboard requires attention.',
      category: 'HARDWARE',
      priority: 'MEDIUM',
    },
  });
  expect(
    state.writes.some(
      (write) => write.path.includes('/assets') || write.path.includes('/transfers'),
    ),
  ).toBe(false);
  expect(state.unexpected).toEqual([]);
});
