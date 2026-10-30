# Handoff

All work is uncommitted on `main` (owner prefers no commits until asked).

## Built
Sub-projects A–F: roles and teams, Zoho People sync, asset kits, ticket routing, Finance review with local OCR, executive dashboard. Specs: `docs/superpowers/specs/2026-10-29-*.md`. Detailed log and every decision made: `.superpowers/sdd/2026-10-29-roles-teams-ownership/progress.md`. Zoho setup: `docs/ZOHO_SETUP.md`. Migration 027 (department rules: `team_view_grants`, type→team/handling-team mapping) applied to both databases.

## Last change (not fully verified)
Each team now sees only its own assets (`assetScope` in `apps/api/src/domain-helpers.ts`). Super Admin, Finance and Executive see all; employees see assets assigned to them. `team-permissions.integration.test.ts` passes. Four older assertions were flipped to expect 404 for another team's asset (`asset-photos` and `domain` integration tests). Full integration run: 196 pass, only 3 known `data-transfers` failures remain.

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
1. Run `npm run test:integration`. Expect 3 known pre-existing failures in `data-transfers.integration.test.ts` (51-row limit, department preview, invite outbox). Anything else is new: fix it.
2. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
3. Web: the asset catalog nav and other UI still gate on `asset.view_all`, which team members keep; only the server-side scope changed. Check that pages behave sensibly (another team's asset should show "not found").
4. Not yet tested: Playwright browser specs, Docker image build, real Zoho data.

## Known gaps
- 3 integration tests in `data-transfers.integration.test.ts` failed before this work began; leave them unless asked.
- Zoho field names and the photo download (`mapZohoRecord`, `fetchPhoto` in `apps/api/src/zoho.ts`) are untested against real Zoho; verify after the first Sync now.
- Scanned PDFs are not OCR'd (users are asked for a photo instead). The supplier guess is low confidence.
- The Docker image build and Playwright browser specs have not been run since the last changes.
- The production database user needs `infra/runtime-grants.sql` re-applied after migrations 017–025 (`team_view_grants` and `asset_type_policies` grants already present).

## Working rules (owner's preferences)
- Do not commit or create branches unless the owner asks.
- Write a failing test first, then the fix. Run the related test files, then the full suite once at the end.
- Integration tests need the database running (see Environment) and use `TEST_DATABASE_URL` from `.env`.
- Keep UI wording simple and plain; the owner is not a developer.

## Environment
- Database runs on port 55120 (Windows reserved 55432). Start it with `docker compose --env-file .env -f infra/compose.local.yml up -d`.
- App DB `iac_asset_management`; test DB `iac_asset_management_test`; both are migrated to 027.