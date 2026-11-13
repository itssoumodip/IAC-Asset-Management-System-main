# Plan: review fixes, usable Locations, a dashboard for every role

**For:** opencode. **Written:** 2026-10-30, after reviewing the uncommitted work.
**Read first:** `HANDOFF.md`, `CLAUDE.md`, `docs/client-requirements-gap-plan.md` (sections 5 and 6).

---

## 0. Where we are (review of the recent changes)

Our agreed order (gap plan section 5) was: 1 Phase 1, 2 asset page tabs, 3 roles and field permissions, 4 verification, 5 request cart, 6 maintenance and dashboard, 7 depreciation.

What is in the working tree now (uncommitted, 26 files changed, migrations 028–033):

| Step | Status | Notes |
|---|---|---|
| 1 Phase 1: location tree (028), statuses (029), tags (030), store receiving | Built | Locations page exists but is nearly unusable (section 1) |
| 2 Asset page tabs (`AssetDetailTabs.tsx`) | Built, partly | Tabs exist, but the Zoho layout in gap plan section 6 (right column, depreciation box, work orders and maintenance on Summary) is not done |
| 3 Roles + field permissions (031–033) | Built **ahead of order** | Insurer fields are still a guess until the client answers; must be reviewed (section 2) |
| 4–7 | Not started | |

Checks run on 2026-10-30: `npm run typecheck` clean, `npm run lint` clean, API unit 329/329, web 78/78. **Not yet run:** `npm run test:integration`, Playwright, a browser check by the owner.

**Problems found:**
1. Locations page shows almost nothing: the app database has only `DEMO_OFFICE` plus two test nodes ("hello" Store and "fd" Rack). There is no way to add many places at once, no asset list per place, and the page does not explain what to do.
2. Steps 2 and 3 were started before step 1 was usable. From now on: **one section at a time**, owner checks it in the browser, then the next.
3. Dashboards: `UserDashboard` in `apps/web/src/components/Dashboards.tsx` sends Super Admin, Finance and Executive to the same `AdminDashboard`, and the new roles (Store, Auditor, Technician, Insurer, Procurement) fall through to the plain employee screen.

---

## Rules (apply to every section)

- One section at a time. After each: run its tests and `npm run typecheck`, then **stop and report** so the owner can check it in the browser.
- Never rewrite `apps/web/src/components/Assets.tsx` (about 2,000 lines). Edit only the lines you need; new screens go in new files.
- Tests first. Never hand-pick asset codes in tests: use `allocateAssetCode(db, teamId, client)` from `apps/api/src/domain-assets.ts` inside `db.tx`.
- Vitest: no global `environment: 'jsdom'`; put `// @vitest-environment jsdom` at the top of the test files that need it.
- Migrations: next free number (034 onward), applied to both DBs (`npm run db:migrate -w @iac/api -- --test`, then `npm run db:migrate`). Grants in `infra/runtime-grants.sql`.
- Permissions are checked in the API (`apps/api/src/policy.ts`). Never show finance fields to roles that cannot see them.
- No commits, no branches, no scrap files. Report real test numbers; never call a new failure "pre-existing".

---

## 1. Make Locations usable

### 1.1 Bulk add by path (API)
Typing every node one by one is why the tree is empty. Add `POST /locations/bulk` (Super Admin) taking lines like:
```
Campus > Zone 1 > Tower A > Floor 3 > Flat 3B
Campus > Zone 1 > Tower A > Ground floor > Main store > Rack 1
Head Office > Floor 2 > IT store
```
Each line is a path; the level of each part is given by a header row or by position. Simplest rule: the request also sends `levels`, one per position, e.g. `["SITE","ZONE","BUILDING","FLOOR","UNIT"]`, or per line `levels` override. Existing nodes with the same name under the same parent are reused; missing ones are created. Dry run first.

Add to `apps/api/src/locations.ts`:
```ts
const bulkInput = z
  .object({
    lines: z.array(z.object({ path: z.array(text(150)).min(1).max(8), levels: z.array(z.string()).min(1).max(8) })).min(1).max(500),
    dryRun: z.boolean().default(true),
    reason,
  })
  .strict();

async bulk(req: AuthRequest, body: unknown) {
  assertCan(req.user, 'system.admin');
  const data = parse(bulkInput, body);
  return this.db.tx(async (c) => {
    let created = 0, reused = 0;
    for (const line of data.lines) {
      if (line.path.length !== line.levels.length)
        throw new UnprocessableEntityException('Each part of a path needs a level');
      let parent: string | null = null;
      for (let i = 0; i < line.path.length; i++) {
        const [found] = await this.db.query(
          `SELECT id FROM locations WHERE lower(name)=lower($1) AND parent_id IS NOT DISTINCT FROM $2 AND level=$3`,
          [line.path[i], parent, line.levels[i]], c);
        if (found) { parent = found.id; reused++; continue; }
        const [row] = await this.db.query(
          'INSERT INTO locations(code,name,level,parent_id) VALUES($1,$2,$3,$4) RETURNING id',
          [`LOC-${randomBytes(4).toString('hex').toUpperCase()}`, line.path[i], line.levels[i], parent], c,
        ).catch(treeError);
        parent = row.id; created++;
      }
    }
    if (data.dryRun) throw new DryRun({ created, reused }); // roll back; see note
    await this.db.audit(c, req.user, 'location', null, 'LOCATIONS_BULK_CREATED', { created, reused, reason: data.reason });
    return { created, reused, dryRun: false };
  }).catch((e) => { if (e instanceof DryRun) return { ...e.result, dryRun: true }; throw e; });
}
```
`DryRun` is a small local `class DryRun extends Error { constructor(public result: object) { super('dry run'); } }` so the transaction rolls back on a dry run. Integration tests: dry run creates nothing; real run creates and reuses; a wrong level order returns 422.

### 1.2 Locations page (`apps/web/src/components/Locations.tsx`)
- Empty or nearly empty tree: show a clear empty state, "Add your first site", with two buttons: **Add a site** and **Paste many places**.
- **Paste many places** dialog: a textarea (one path per line, `>` between parts) plus a row of level selects (default Site, Zone, Building, Floor, Unit / Room). **Check** calls the dry run and shows "12 new, 3 already exist"; **Create** sends it for real.
- Each row: name, level badge, **asset count including everything inside** (change the API count to the subtree, see 1.3), and a **View assets** link to `/assets?locationId=<id>`.
- Indent children; show the path only in search results, not on every row (rows are crowded now).
- Deactivated nodes greyed out behind a "Show inactive" toggle.

### 1.3 Subtree counts (API)
In `tree()`, replace the direct `asset_count` with a subtree count:
```sql
WITH RECURSIVE sub(root, id) AS (
  SELECT id, id FROM locations
  UNION ALL
  SELECT sub.root, l.id FROM locations l JOIN sub ON l.parent_id = sub.id
)
SELECT sub.root AS id, count(a.id)::int AS asset_count
FROM sub LEFT JOIN assets a ON a.location_id = sub.id AND a.status <> ALL($1)
GROUP BY sub.root
```
Join this to the item list. Test: an asset in a Rack counts for its Store, Floor and Site.

### 1.4 Connect assets to places
- Asset create/edit form and the store-receive picker: a **searchable path picker** (type "3b" → "Campus › Tower A › Floor 3 › Flat 3B"). Put it in a new `apps/web/src/components/LocationPicker.tsx` and use it in place of the plain select; only swap the select lines in `Assets.tsx`.
- Asset list: the Location filter uses the same picker.
- Demo data: in `apps/api/src/cli.ts` seed (only the demo/seed command, never on real data), create a small tree `Demo campus › Tower A › Floor 1 › Demo room` and move `DEMO_OFFICE` under it.

**Stop here and report.**

---

## 2. Check the roles and field-permission work (already built)

1. Run `npm run test:integration`. Expected failures: only the 3 known `data-transfers` tests.
2. Insurer default fields must be exactly: asset name, photo, purchase price, purchase date, repair history. Must NOT include serial number, warranty, AMC, depreciation or other finance data. Verify with an integration test against `GET /assets` and `GET /assets/:id`, and also the Excel export (`fetchAllPages('/assets')` path) and scan (`apps/api/src/scan.ts`): every place that returns asset data must apply the same projection. Add a test for each path.
3. Change requests: a non-owner edit of a protected field must not change the asset until approved; approving after the asset changed returns 409. Test both.
4. Mark the Insurer field list as "pending client confirmation" in `HANDOFF.md`.

**Stop here and report.**

---

## 3. A proper dashboard for every role

Today (`apps/web/src/components/Dashboards.tsx`):
```ts
if (can(user, 'report.view')) return <AdminDashboard />;   // Super Admin, Finance, Executive (same screen)
if ((user?.teams ?? []).length > 0) return <TeamDashboard />;
if (can(user, 'ticket.work')) return <ITDashboard />;
return <EmployeeDashboard />;                                // also new roles
```

### 3.1 Routing
Replace with one clear map (first match wins; people with several roles get a **dashboard switcher** at the top listing every dashboard they may see):
```ts
const DASHBOARDS = [
  { key: 'admin',     label: 'Organisation', show: (u) => u.roles.includes('SUPER_ADMIN'), el: <AdminDashboard /> },
  { key: 'executive', label: 'Executive',    show: (u) => u.roles.includes('EXECUTIVE'),   el: <ExecutiveDashboard /> },
  { key: 'finance',   label: 'Finance',      show: (u) => u.roles.includes('FINANCE'),     el: <FinanceDashboard /> },
  { key: 'team',      label: 'My team',      show: (u) => (u.teams ?? []).length > 0,      el: <TeamDashboard /> },
  { key: 'store',     label: 'Store',        show: (u) => u.roles.includes('STORE'),       el: <StoreDashboard /> },
  { key: 'technician',label: 'My work',      show: (u) => u.roles.includes('TECHNICIAN'),  el: <TechnicianDashboard /> },
  { key: 'auditor',   label: 'Audit',        show: (u) => u.roles.includes('AUDITOR'),     el: <AuditorDashboard /> },
  { key: 'insurer',   label: 'Insurance',    show: (u) => u.roles.includes('INSURER'),     el: <InsurerDashboard /> },
  { key: 'me',        label: 'My assets',    show: () => true,                             el: <EmployeeDashboard /> },
];
```
Remember the chosen tab in `localStorage` (wrapped in try/catch). New dashboards go in a new file `apps/web/src/components/RoleDashboards.tsx`.

### 3.2 What each dashboard shows

| Dashboard | Cards / lists | API |
|---|---|---|
| **Organisation** (Super Admin) | existing AdminDashboard + **assets by location** (top-level sites/buildings: count, purchase value) + pending change requests count | existing `/dashboard` + new `/dashboard/locations` |
| **Executive** | existing ExecutiveDashboard (already built) | existing `/dashboard/executive` |
| **Finance** | pending finance review count + oldest; purchase value total; this year's purchases; assets missing cost or invoice; warranty/AMC expiring in 60 days; value by location | new `/dashboard/finance` |
| **My team** | existing TeamDashboard; add **open requests/tickets for my team** and **items in store ready to assign** | existing `/dashboard/team` |
| **Store** | items in store by Store/Rack; received this week; items waiting to be received (no location); recent movements | new `/dashboard/store` |
| **My work** (Technician) | tickets assigned to me by status; overdue; recently closed | new `/dashboard/technician` (only tickets assigned to the caller) |
| **Audit** | assets not verified in 90 days by location; verified this month; (verification cycles come in step 4) | new `/dashboard/audit` |
| **Insurance** | count and total purchase price of insured items by location; recent repairs. Uses only Insurer-visible fields | new `/dashboard/insurer` (apply the Insurer projection) |
| **My assets** (everyone) | items I hold, items waiting for my confirmation, my open tickets, "Report a problem" | existing `/dashboard` employee part |

### 3.3 API pattern
Add the new endpoints to `apps/api/src/executive-dashboard.ts` (reuse its helpers and `assetScope`). Each checks its role in the API, for example:
```ts
@Get('dashboard/finance')
finance(@Req() req: AuthRequest) {
  if (!req.user.roles.some((r) => ['FINANCE', 'SUPER_ADMIN'].includes(r))) throw new ForbiddenException();
  return this.service.finance(req);
}
```
and `/dashboard/locations` (value by place, subtree totals):
```sql
WITH RECURSIVE sub(root, id) AS (
  SELECT id, id FROM locations WHERE parent_id IS NULL
  UNION ALL SELECT sub.root, l.id FROM locations l JOIN sub ON l.parent_id = sub.id
)
SELECT r.id, r.name, count(a.id)::int AS assets, coalesce(sum(a.purchase_cost),0) AS purchase_value
FROM sub JOIN locations r ON r.id = sub.root
LEFT JOIN assets a ON a.location_id = sub.id AND a.status <> ALL($1)
GROUP BY r.id, r.name ORDER BY assets DESC
```
`purchase_value` is returned only to roles that may see finance fields.

### 3.4 Tests
- API integration: each endpoint returns 403 for the wrong role; Technician sees only their own tickets; Insurer response contains no serial number, warranty or depreciation; location totals include nested places.
- Web vitest (jsdom per file): the switcher shows exactly the dashboards a user's roles allow; a plain employee sees only "My assets".

**Stop here and report.**

---

## 4. Finish the asset page (gap plan section 6)

Only after sections 1–3 are checked by the owner. Follow `docs/client-requirements-gap-plan.md` section 6 exactly: right column (barcode/QR, key facts, current user card), Summary with Work orders, Recent maintenance (placeholder), and the Depreciation box (Finance/Admin only, no made-up numbers). Work in `AssetDetailTabs.tsx`, not `Assets.tsx`.

---

## Finish (after each section)

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`. Allowed failures: only the 3 known `data-transfers` tests. Update `HANDOFF.md` with what you did, what the owner should click to check it, and what is left.
