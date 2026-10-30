# Handoff

All work is uncommitted on `main` (owner prefers no commits until asked).

## Built
Sub-projects A–F: roles and teams, Zoho People sync, asset kits, ticket routing, Finance review with local OCR, executive dashboard. Specs: `docs/superpowers/specs/2026-10-29-*.md`. Detailed log and every decision made: `.superpowers/sdd/2026-10-29-roles-teams-ownership/progress.md`. Zoho setup: `docs/ZOHO_SETUP.md`.

## Last change (not fully verified)
Each team now sees only its own assets (`assetScope` in `apps/api/src/domain-helpers.ts`). Super Admin, Finance and Executive see all; employees see assets assigned to them. `team-permissions.integration.test.ts` passes. Four older assertions were flipped to expect 404 for another team's asset (`asset-photos` and `domain` integration tests). The full integration run was stopped before finishing.

## Next steps
1. Run `npm run test:integration`. Expect 3 known pre-existing failures in `data-transfers.integration.test.ts` (51-row limit, department preview, invite outbox). Anything else is new: fix it.
2. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
3. Web: the asset catalog nav and other UI still gate on `asset.view_all`, which team members keep; only the server-side scope changed. Check that pages behave sensibly (another team's asset should show "not found").
4. Not yet tested: Playwright browser specs, Docker image build, real Zoho data.

## Planned next: make team access easy to give

Only team members (Member or Lead of IT, Admin or Projects) can add assets; plain Employees only see their own. Today a Super Admin can't put someone in a team from People & access.

1. **People & access (`apps/web/src/components/Admin.tsx`):** in each person's editor, add a **Teams** section. List their current teams with level, allow adding (team + Member/Lead + reason) and removing. Use the existing API: `POST /teams/:id/members` `{email, level, reason}`, `PUT /teams/:id/members/:userId` `{level, reason}`, `DELETE /teams/:id/members/:userId` `{reason}`. `GET /users` already returns `teams` per user. Super Admin only. Changes sign the person out so they take effect.
2. **Teams & projects (`apps/web/src/components/TeamAdmin.tsx`):** add a **Manage members** link on each team row to `/team/:teamId`.
3. **Employee home (`apps/web/src/components/Dashboards.tsx`):** add a **My assets** card: count of items held, the list (code, type, description), items awaiting confirmation, and open tickets. Use the existing assets list endpoint (employees already see only their own) and tickets list.
4. Once someone is a team member, **Add asset** appears automatically (capability `asset.create` for that team). No API change is needed.
5. Optional: move the **Teams & projects** page (`/admin/teams`) into **Master Control** as a tab, and remove its separate nav item. Its sections (projects/grants, room-held asset types, ticket category → team, rare new teams) are one-time setup.

## Planned next: department rules (approved by owner)

1. **Each team adds only its own kinds of items.** Map each asset category/type to a team in Master Control (e.g. Laptop, Desktop, Mouse, Printer → IT; Chair, Table, Kitchen, Light → Admin; Projects may use Admin's facility types for grant purchases). The Add/Edit asset form offers only the types mapped to the chosen owning team; the API rejects others with 422 `This asset type belongs to another team`. Super Admin can override.
2. **Shared viewing between Admin and Projects.** Add a team-to-team "can view" setting (e.g. table `team_view_grants(viewer_team_id, owner_team_id)`), seeded ADM↔PRJ. Extend `assetScope` in `apps/api/src/domain-helpers.ts` to include assets owned by teams the user's teams may view. Viewing only: edit/assign/retire stay owner-team-only (`assertCan` on owning team is unchanged). IT is not shared: IT sees only IT; ADM/PRJ never see IT items.
3. **Facility problems always go to Admin.** In ticket routing (`createTicket` in `apps/api/src/domain-tickets.ts`), when a ticket is about an asset, route by the asset type's handling team rather than the owning team. Facility types (chair, table, etc.) route to Admin even if Projects owns them; IT types route to IT. Add a "handled by team" field next to the type→team mapping in item 1 (default = mapped team, Admin for facility types). Non-asset tickets keep the category→team mapping.
4. **Team dashboard.** For team members, show a dashboard of their teams' items, plus shared-view teams for ADM/PRJ: counts by status, value, items needing attention (pending Finance, warranty/AMC expiring, holders who left), and open tickets for their team. Reuse `apps/api/src/executive-dashboard.ts` queries with a team filter; new endpoint `GET /dashboard/team` (any team member, scoped to their teams).
5. Tests: type→team enforcement; ADM user sees PRJ assets but cannot edit them; PRJ user cannot see IT assets; Projects-owned chair ticket routes to Admin; team dashboard counts only scoped items.

## Known gaps

- 3 integration tests in `data-transfers.integration.test.ts` failed before this work began; leave them unless asked.
- Zoho field names and the photo download (`mapZohoRecord`, `fetchPhoto` in `apps/api/src/zoho.ts`) are untested against real Zoho; verify after the first Sync now.
- Scanned PDFs are not OCR'd (users are asked for a photo instead). The supplier guess is low confidence.
- The Docker image build and Playwright browser specs have not been run since the last changes.
- The production database user needs `infra/runtime-grants.sql` re-applied after migrations 017–025.

## Working rules (owner's preferences)

- Do not commit or create branches unless the owner asks.
- Write a failing test first, then the fix. Run the related test files, then the full suite once at the end.
- Integration tests need the database running (see Environment) and use `TEST_DATABASE_URL` from `.env`.
- Keep UI wording simple and plain; the owner is not a developer.

## Environment
- Database runs on port 55120 (Windows reserved 55432). Start it with `docker compose --env-file .env -f infra/compose.local.yml up -d`.
- App DB `iac_asset_management`; test DB `iac_asset_management_test`; both are migrated to 025.
