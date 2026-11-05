## Phase 2 Daily asset work — Complete ✅

| Page | Route | Status |
|------|-------|--------|
| P2 My assets | `/my-assets` | ✅ Cards, Verify action |
| P8 Asset catalog | `/assets` | ✅ Zoho-style list, filters |
| P9 Asset page Zoho layout | `/assets/:id` | ✅ Zoho layout with tabs + sidebar |
| P10–P11 Add/edit with invoice | `/assets/new`, `/assets/:id/edit` | ✅ AssetEditor — details + finance fields; invoice uploaded on asset page |
| P13 Assign/transfer with approval | `/assets/:id/assign` | ✅ AssetAssignTransfer — Team Lead approval routing |
| P15 Approvals | `/approvals` | ✅ Approvals — approve/reject with reason |

## Phase 3 Store & inventory — In progress ✅

| Page | Route | Status |
|------|-------|--------|
| P16 Inventory | `/inventory` | ✅ Inventory API + component — product stock levels |
| P17 Store | `/store` | ✅ Store API — receive/issue assets |

### Backend API

- `GET /inventory` — list products with stock counts per category
- `POST /store/receive` — receive asset into store location
- `POST /store/issue` — issue asset from store to user
- `GET /store/returns` — list pending assignments

### Handoff notes
All work remains uncommitted on `main` (owner prefers no commits until asked).

## Built

- `apps/web/src/components/Store.tsx` — P17 Store page: store/rack locations table, receive into store, issue to user, returns waiting panel. Backend API already existed (`/store`, `/store/receive`, `/store/issue`, `/store/returns`).
- `apps/web/src/components/Maintenance.tsx` — P19 Preventive maintenance page: upcoming/overdue/all views, mini-stats, maintenance table.
- `apps/web/src/components/Verification.tsx` — P20 Verification page: auditor cycles, item-level found/not-found/wrong-place, complete cycle.
- `apps/api/src/verification.ts` — Verification API controller/service (`/verification/cycles`, `/verification/cycles/:id/items`, `/verification/cycles/:id/complete`).
- `apps/api/db/migrations/037_verification.sql` — `verification_cycles` and `verification_items` tables.
  Applied to app + test DBs (now at 038).
- `apps/api/db/migrations/038_depreciation.sql` — `capitalisation_date` on assets,
  `depreciation_schedules` table. Applied to app + test DBs (now at 038).
- `apps/api/src/depreciation.ts` — Depreciation API (`/depreciation`, `/depreciation/schedules`,
  `/depreciation/run`). Registered in app.module.ts.
- `apps/api/src/reports.ts` — Reports API (`/reports/fixed-asset-register`,
  `/reports/assets-by-location`, `/reports/warranty-expiry`, `/reports/ticket-response-times`,
  `/reports/verification`). Registered in app.module.ts.
- `apps/web/src/components/Depreciation.tsx` — P22 Depreciation page: register table, summary
  stats, run depreciation by year/method, Companies Act and Income Tax views.
- `apps/web/src/components/Reports.tsx` — P23 Reports page: fixed asset register, assets by
  location, warranty expiry, ticket response times, verification cycles tabs.
- `apps/api/src/insurance.ts` — Insurance API (`/insurance`, `/insurance/locations`). Registered
  in app.module.ts.
- `apps/api/src/procurement.ts` — Procurement API (`/procurement` list/create). Registered in
  app.module.ts.
- `apps/api/db/migrations/039_procurement.sql` — `purchases` table. Applied to app + test DBs
  (now at 039).
- `apps/web/src/components/Insurance.tsx` — P24 Insurance page: insured assets list, totals by
  location.
- `apps/web/src/components/Procurement.tsx` — P25 Procurement page: record purchase, purchase history.
- `apps/web/src/components/Maintenance.tsx` — P19 Preventive maintenance page.
- `apps/web/src/components/Verification.tsx` — P20 Verification page.
- `apps/api/src/verification.ts` — Verification API (`/verification/cycles`, items, complete).


Sub-projects A–F: roles and teams, Zoho People sync, asset kits, ticket routing, Finance review with local OCR, executive dashboard. Specs: `docs/superpowers/specs/2026-10-29-*.md`. Detailed log and every decision made: `.superpowers/sdd/2026-10-29-roles-teams-ownership/progress.md`. Zoho setup: `docs/ZOHO_SETUP.md`.

ROLES-AND-PAGES.md (docs/ROLES-AND-PAGES.md): All 11 roles (R1–R11) added to the `roles` table and API policy. New actions: `store.operations`, `verification.perform`, `insurer.view`, `procurement.view`, `approvals.act`. P31 Field permissions & roles (`/admin/roles`) built. P18 Locations (`/locations`) built. P29 Categories (`/admin/categories`) built. P3 Scan NFC + location path built. P30 statuses (in Master Control).

Phase 1 Foundation complete; Phase 2 Daily asset work complete.

## Sign-in and email recovery (2026-11-03)

The database was rebuilt from the migrations, so every user was a Zoho People directory
stub (`state='DIRECTORY'`, no password, no verified email) and there were no active
admins. Login, "Forgot password" and `admin:bootstrap` all failed for that one reason:
none of them accept a directory stub. Nothing was queued in `notification_outbox`, so no
email was ever sent.

- `apps/api/src/cli.ts`: `bootstrapAdmin()` now adopts an existing, still-employed
  `DIRECTORY` record — it sets the password, `state='ACTIVE'`, the verified timestamp,
  grants Super Admin + Employee and approves the email — instead of failing on
  `users_email_key`. Active, disabled, invited and left accounts are still refused.
- Covered by `apps/api/test/bootstrap.integration.test.ts` (2 tests, both roll back).
- SMTP was checked directly against `smtp.gmail.com` and accepts mail; the worker only
  sends what is queued.
- Directory people still cannot self-activate: invite them from People & access
  (`/admin/users`), which queues the invitation email. That restriction is intentional.

## Schema repairs after the database rebuild (2026-11-03)

After the rebuild some pages showed "The server database is missing an update" even
though every migration had been applied. Postgres logs showed the queries referencing
columns that never existed, so the rebuild itself was not the cause.

- `apps/api/db/migrations/035_asset_type_categories.sql` adds
  `asset_type_policies.category_code` (default `Other`) and backfills the seeded asset
  types (Laptop, Desktop, Monitor, Printer, ...). Without it the Categories page and
  ticket routing queried a missing column. Applied to both the app and test databases.
- `apps/api/src/categories.ts`: category rows now read the quoted camelCase aliases
  directly. Postgres folds unquoted aliases to lowercase, so the subcategory list was
  keyed by `categorycode`/`assettypecode` and the page showed no asset types.
- `apps/api/src/approvals.ts` (`listTransfers`): `users.role_code` never existed; the
  requester role now comes from the highest-priority row in `user_roles`.
- `apps/api/src/scan.ts`: the location path referenced a recursive CTE (`loc_tree`) from
  outside its scope, so every QR scan returned the "missing update" error. The path is
  now built inside the lateral join and falls back to site/code for older locations that
  have no `name`.
- `apps/api/src/role-field.ts` (`allFields`): quoted the camelCase SQL aliases so the
  `/admin/roles` field-permissions grid reads `roleCode`, `fieldName`, `canView`,
  `canEdit` correctly (Postgres folds unquoted aliases to lowercase).
- `apps/web/src/components/RoleFieldPermissions.tsx`: edit now implies view — checking
  "Edit" auto-checks "View", unchecking "View" auto-unchecks "Edit", matching the rule
  "a field that cannot be viewed cannot be edited."
- `apps/web/src/components/AssetDetailZoho.tsx`: asset picture (camera/upload) now shown
  on the Summary tab, and Finance & invoices panel (status, upload, extraction) added
  below Depreciation.
- `apps/web/src/components/TeamAdmin.tsx`: restyled Teams page to match other admin pages
  (table-based layout, badges, consistent button styles) and added a "Manage members" link on each
  team row that navigates to `/team/:teamId` where Leads and Super Admins can add, promote or remove
  team members.

## Project / grant teardown (2026-11-04)

Owner decided the Project / grant tagging is not needed. Removed everywhere:

- `apps/api/db/migrations/036_remove_projects.sql` — drops `assets_project` index, `assets.project_id`
  column, `projects` table, `teams.requires_project` column. Applied to both app and test DBs (now at 036).
- `apps/api/src/master-teams.ts` — removed `projectCreate`/`projectPatch` schemas, project
  create/update branches, and `teamAndProjectLists`; replaced with team-only `teamLists` +
  `createTeam`/`updateTeam`.
- `apps/api/src/domain-masters.ts` — master-data dispatches `kind: 'teams'` only.
- `apps/api/src/domain-helpers.ts` — removed `projectId` from `assetInput`, page filter params,
  `employeeAssetColumns`, and `validateOwnership` (project active-check + `requires_project`
  enforcement dropped).
- `apps/api/src/domain-assets.ts`, `apps/api/src/finance.ts` — project filter column removed
  from catalog and finance queue; `project_id` dropped from finance queue SELECT.
- `apps/api/src/executive-dashboard.ts` — removed `spendByProject` query and payload entry
  (spend by financial year retained).
- `apps/api/src/scale-seed.ts` — dropped project seeding and `project_id` from synthetic assets.
- `apps/api/src/cli.ts` — no change ("project folder" wording only, untouched).
- `apps/web/src/types.ts` — removed `Asset.projectId`, `TeamReference.requiresProject`,
  `ProjectReference`, `References.projects`, `FinanceQueueItem.projectId`.
- `apps/web/src/components/Assets.tsx` — removed project filter, detail row, editor field,
  body send/clear and `requiresProject` validation.
- `apps/web/src/components/AssetEditor2Step.tsx` — deleted (was already dead code).
- `apps/web/src/components/TeamAdmin.tsx` — removed Projects & grants panel, NewProject form,
  "Project required" column, and `requiresProject` checkbox on new team.
- `apps/web/src/components/ExecutiveDashboard.tsx` — removed "Spend by project" panel and type.
- `apps/web/src/components/RoleFieldPermissions.tsx` — dropped `projectId` from Location field
  group and label map.
- `apps/web/src/App.tsx` — nav link renamed "Teams".
- Tests pruned: `asset-ownership`, `executive-dashboard`, `team-masters`, `team-permissions`,
  `roles-migration` (removed project rows/assertions); `team-assets.spec.ts` and
  `team-admin.spec.ts` (Playwright) dropped project filter, editor field and project-create test.
- `docs/ROLES-AND-PAGES.md` untouched (spec still documents P10/P28 — reconcile with owner).

## Known gaps

- Zoho field names and the photo download (`mapZohoRecord`, `fetchPhoto` in `apps/api/src/zoho.ts`) are untested against real Zoho; verify after the first Sync now.
- Scanned PDFs are not OCR'd (users are asked for a photo instead). The supplier guess is low confidence.
- The Docker image build and Playwright browser specs have not been run since the last changes.
- The production database user needs `infra/runtime-grants.sql` re-applied after migrations 017–025.
- Docs/ROLES-AND-PAGES.md still documents P10 (project/grant on add-asset) and P28 (Teams & projects); reconcile with owner since the feature is removed.
- Admin bootstrap not yet done; requires interactive TTY (no env/password args).

## Working rules (owner's preferences)

- Do not commit or create branches unless the owner asks.
- Write a failing test first, then the fix. Run the related test files, then the full suite once at the end.
- Integration tests need the database running (see Environment) and use `TEST_DATABASE_URL` from `.env`.
- Keep UI wording simple and plain; the owner is not a developer.

## Environment

- Database runs on port 55120 (Windows reserved 55432). Start it with `docker compose --env-file .env -f infra/compose.local.yml up -d`.
- App DB `iac_asset_management`; test DB `iac_asset_management_test`; both are migrated to 035.
