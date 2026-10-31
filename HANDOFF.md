# Handoff

All work is uncommitted on `main` (owner prefers no commits until asked).

## Progress log

### Task 1 permissions fixes — DONE (2026-10-31)

Changed `apps/api/src/policy.ts`, `apps/api/src/domain-helpers.ts`, `apps/api/src/scan.ts`, `apps/api/test/policy.test.ts`, and `apps/api/test/ticket-routing.integration.test.ts`. Technician and Auditor cannot view private finance fields. Technicians are scoped to assets linked to tickets assigned to them across list, detail, and scan; Finance has `report.view`.

Migrations: none. Tests: lint passed; workspace typecheck passed; unit 329/329; web 78/78; touched integration suites 21/21; full baseline remains 209/212 with only the 3 known `data-transfers` failures.

Browser check: sign in as a Technician, open Asset catalog and scan an assigned-ticket asset; confirm it is visible without purchase cost, then try another asset and confirm not found. Sign in as Finance and open Reports.

## Task 1 permissions fixes (2026-10-31)

Task 1 is complete. Technician and Auditor no longer receive `asset.view_private`; Finance now receives `report.view`. Policy unit coverage verifies both restrictions and the restored Finance capability.

Tests: lint passed · workspace typecheck passed · unit/web 329/329 passed · integration 209/212 passed, with only the 3 known `data-transfers.integration.test.ts` failures (HTTP/auth transfer limits, department preview, invite outbox). No migration.

Browser check: sign in as a Technician, open an asset they can access, and confirm purchase cost and other private finance fields are absent; sign in as Finance and confirm Reports is available and opens successfully.

## Task 0 baseline (2026-10-31)

Task 0 is complete. Migrations 028–033 were applied to both the app and test databases. The approval workflow preserves direct edits by owning-team members/leads and Super Admins; cross-role protected-field edits continue to create change requests. API unit coverage for the approval-owner rule and the focused regression integration tests pass.

Tests: lint not rerun for this baseline-only fix · typecheck (API) passed · unit approval regression passed · web not rerun · integration 209/212 passed, with only the 3 known `data-transfers.integration.test.ts` failures:
- HTTP/auth transfer limits
- department preview
- invite outbox

Browser check: none required for this baseline task. Next task is Task 1 (permissions fixes), after owner confirmation.

## Built
Sub-projects A–F: roles and teams, Zoho People sync, asset kits, ticket routing, Finance review with local OCR, executive dashboard. Specs: `docs/superpowers/specs/2026-10-29-*.md`. Detailed log and every decision made: `.superpowers/sdd/2026-10-29-roles-teams-ownership/progress.md`. Zoho setup: `docs/ZOHO_SETUP.md`. Migration 027 (department rules: `team_view_grants`, type→team/handling-team mapping) applied to both databases.

## Last change (verified)
Each team now sees only its own assets (`assetScope` in `apps/api/src/domain-helpers.ts`). Super Admin, Finance and Executive see all; employees see assets assigned to them. `team-permissions.integration.test.ts` passes. Four older assertions were flipped to expect 404 for another team's asset (`asset-photos` and `domain` integration tests). Full integration run: 196 pass, only 3 known `data-transfers` failures remain.

## Completed: Phase 1 foundation

1. **Location hierarchy.** Migration 028 adds configurable Site, Zone, Building, Floor, Unit/Room, Store and Rack levels, parent validation, full paths, the Super Admin `/admin/locations` page, and recursive asset-list location filtering.
2. **Statuses.** Migration 029 adds Ready to Assign, In Use, Scrapped and Broken. Assignment writes In Use; Assigned and In Use share filters and dashboard counts; Ready to Assign is owning-team-lead/Super-Admin only; Broken cannot be assigned; Scrapped is terminal.
3. **Identifiers.** Migration 030 adds QR, BARCODE, NFC and RFID-ready identifiers with QR/barcode backfill, audited add/remove APIs, scan lookup for any identifier, asset detail Tags UI, and an NFC scan button when Web NFC is available.
4. **Store receiving.** Owning-team members and Super Admin can receive an unassigned asset into an active Store or Rack. The API records a RELOCATE movement and audit event; the asset detail has a path picker and scan output includes the full location path.
5. **Verification.** Location, status, scan/identifier, and receiving integration tests pass; the web suite and workspace typecheck pass.
6. **Asset detail tabs.** The asset detail now uses a new tab controller with Summary, Details, Tickets, Users and History tabs. Existing detail panels remain under Details, while the other tabs provide focused summary, ticket link, custody and timeline views.
7. **Phase 2 roles and field permissions.** Migration 031 registers Store, Auditor, Technician, Insurer and Procurement roles. Policy grants are least-privilege. Migration 032 adds the role-field permission table seeded with the Insurer defaults. Super Admins can manage rules at `/admin/field-permissions`; session-loaded Insurer projections apply the configured visible fields to asset list/detail queries.
8. **Phase 2 overwrite approvals.** Migration 033 adds audited asset change requests. Edits to protected fields owned by another role become pending requests; owning roles and Super Admins can approve or reject them with a reason at `/admin/change-requests`. Requests are rejected if the asset changed since submission.
9. **Locations tree UI.** The Locations admin screen now renders an indented expandable tree with ancestor-preserving search, safe move choices, and usable top-level creation.

## Completed: department rules (all 5)

1. **Each team adds only its own asset types.** Migration 027 maps each asset type to owning/handling team (Printer→IT, Chair→ADM, etc.). `validateOwnership` in `domain-helpers.ts` rejects mismatched types with 422; Super Admin can override; PRJ may use ADM facility types. Web Add/Edit asset form (`apps/web/src/components/Assets.tsx`) offers only the selected owning team's types.

2. **Shared viewing Admin↔Projects.** `team_view_grants` seeded ADM↔PRJ. `assetScope` extended to include assets owned by teams the user's teams may view (IT excluded). Edit/assign/retire stay owner-team-only (`assertCan` unchanged). Verified by `team-permissions.integration.test.ts`.

3. **Facility tickets route to Admin.** `createTicket` in `domain-tickets.ts` routes by asset type's `handling_team_id`. Projects-owned chair ticket routes to Admin. Verified by ticket routing + team-permissions integration tests.

4. **Team dashboard.** `GET /dashboard/team` endpoint in `executive-dashboard.ts` (reuses executive queries with team filter). `TeamDashboard` UI component in `ExecutiveDashboard.tsx`; `UserDashboard` routes team members to it. Verified by integration test.

5. **Tests.** All type→team enforcement, shared viewing, ticket routing, and team dashboard tests pass in `team-permissions.integration.test.ts`.

## Completed: make team access easy to give

1. **People & access (`Admin.tsx`):** Teams section in each person's editor — lists current teams with level, add (team + Member/Lead + reason), change level, remove. Super Admin only. Changes revoke target sessions via API.
2. **Teams & projects (`TeamAdmin.tsx`):** Manage members link on each team row to `/team/:teamId`.
3. **Employee home (`Dashboards.tsx`):** `EmployeeDashboard` shows My assets (assigned count, list, pending confirmations, open tickets). Team members see `TeamDashboard` instead.
4. **Add asset appears automatically** for team members via `asset.create` capability (no API change needed).

## Remaining next steps
1. The final integration run is complete: 212 tests, 209 passed, and the 3 expected failures remain in `data-transfers.integration.test.ts` (HTTP/auth transfer limits, department preview, invite outbox).
2. Lint, workspace typecheck, unit/web tests, and production build pass.
3. Web: the asset catalog nav and other UI still gate on `asset.view_all`, which team members keep; only the server-side scope changed. Check that pages behave sensibly (another team's asset should show "not found").
4. The asset detail tabs have focused component coverage; browser-level tab navigation and the Tickets page's asset filtering still need Playwright/API coverage.
5. Not yet tested: Playwright browser specs, Docker image build, real Zoho data.
6. Phase 2 role administration UI is still basic; field-visibility API/UI, persistence, Insurer projection enforcement, and overwrite approvals are in place.
7. Periodic verification/auditor mode, request cart, transfer approval, maintenance alerts, location dashboards, and depreciation/register remain.

## Known gaps
- 3 integration tests in `data-transfers.integration.test.ts` remain known pre-existing failures; leave them unless asked.
- Zoho field names and the photo download (`mapZohoRecord`, `fetchPhoto` in `apps/api/src/zoho.ts`) are untested against real Zoho; verify after the first Sync now.
- Scanned PDFs are not OCR'd (users are asked for a photo instead). The supplier guess is low confidence.
- The Docker image build and Playwright browser specs have not been run since the last changes.
- The production database user needs `infra/runtime-grants.sql` re-applied after migrations 017–030 (`team_view_grants`, `asset_type_policies`, and `asset_identifiers` grants are present).

## Working rules (owner's preferences)
- Do not commit or create branches unless the owner asks.
- Write a failing test first, then the fix. Run the related test files, then the full suite once at the end.
- Integration tests need the database running (see Environment) and use `TEST_DATABASE_URL` from `.env`.
- Keep UI wording simple and plain; the owner is not a developer.

## Environment
- Database runs on port 55120 (Windows reserved 55432). Start it with `docker compose --env-file .env -f infra/compose.local.yml up -d`.
- App DB `iac_asset_management`; test DB `iac_asset_management_test`; both are migrated to 027.