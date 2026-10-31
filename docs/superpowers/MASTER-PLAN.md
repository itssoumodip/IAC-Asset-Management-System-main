# MASTER PLAN: start here

**Project:** IAC Asset Management System, built to industry level for 150+ users and 50k+ assets (and a client site with a hospital, apartments and a stadium area).
**Written:** 2026-10-31. **For:** the coding agent (opencode). Read this file fully before touching code.

---

## 1. Read these first (in this order)

1. `CLAUDE.md`: project tools and conventions.
2. `HANDOFF.md`: what exists, environment, known gaps.
3. This file.
4. Detailed plans this file points to:
   - `docs/page-map-by-role.md`: roles, pages per role, menu.
   - `docs/superpowers/plan-categories-and-page-fixes.md`: categories by team, fixes to existing pages, tickets (2.9), industry defaults (2.10).
   - `docs/superpowers/plan-dashboards.md`: a dashboard for every role.
   - `docs/superpowers/opencode-plan-review-locations-dashboards.md` section 1: Locations usability.
   - `docs/client-requirements-gap-plan.md` sections 5–6: client build order and the asset page layout.

If two documents disagree, **this file wins**, then the detailed plan for that part.

---

## 2. Stack and environment

- Monorepo: `apps/api` (NestJS, raw SQL via `Db`, zod validation, policy in `apps/api/src/policy.ts`), `apps/web` (React 19, React Query, Vite), `infra` (Docker, Caddy, `runtime-grants.sql`).
- Database: PostgreSQL in Docker on port **55120**. App DB `iac_asset_management`, test DB `iac_asset_management_test` (URLs in `.env`). Start: `docker compose --env-file .env -f infra/compose.local.yml up -d`.
- Migrations: `apps/api/db/migrations`, run by `npm run db:migrate` (app) and `npm run db:migrate -w @iac/api -- --test` (test). Both DBs are at migration **033** today.
- Commands: `npm run lint` · `npm run typecheck` · `npm test` · `npm run test:integration` · `npm run build`.
- Single test file: `cd apps/api && npx tsx --test test/<name>.integration.test.ts` (with `TEST_DATABASE_URL` exported from `.env`).

---

## 3. Non-negotiable rules

A previous run was **thrown away** for breaking these. Follow every one.

1. **One task at a time** (section 5). Finish it, run its tests and `npm run typecheck`, then **STOP and report** to the owner with: what changed, what to click in the browser to check it, test numbers. Wait for "continue".
2. **Never rewrite large files.** `apps/web/src/components/Assets.tsx` is about 2,000 lines: edit only the lines you need. New screens and components go in **new files**. Run `npm run typecheck -w @iac/web` after every `.tsx` edit; never leave the app not compiling.
3. **Tests first** for every behaviour (failing test, then code, then green).
4. **Never hand-pick asset codes in tests** (e.g. `IAC-IT-990001`). Use `allocateAssetCode(db, teamId, client)` from `apps/api/src/domain-assets.ts` inside `db.tx`, or `DomainService.createAsset`.
5. **Vitest:** never set `environment: 'jsdom'` globally (the Excel tests break). Put `// @vitest-environment jsdom` at the top of test files that need it.
6. **Permissions on the server.** Every permission and field rule is enforced in the API (lists, detail, exports, scan, dashboards, notifications). The web only hides buttons.
7. **Settings, not hard-coding.** Business rules (team ownership, SLA times, roles' rights, visible fields) live in database settings with admin screens and seeded defaults (plan-categories 2.10).
8. **Every change audited** with who, when, before/after, reason (`db.audit`).
9. **Migrations:** next free number (**034** onwards), applied to **both** databases. Grants for new tables in `infra/runtime-grants.sql` (least privilege; never DELETE on users, assets, tickets).
10. **Scale:** cursor pagination, indexed filters, every list/dashboard checked against the scale seed (50k assets).
11. **UI:** use components in `apps/web/src/components/ui.tsx`; new CSS at the end of `apps/web/src/styles.css` in one commented block per feature; works at 375px width with no sideways scroll; keyboard and screen-reader labels.
12. **Keep accessible names used by `test/*.spec.ts`** (grep before renaming).
13. **No commits, no branches, no scrap files** (`temp.ts`, `fix-*.js`).
14. **Honest reporting:** real test numbers. Only the 3 known `data-transfers` integration failures are allowed; never call a new failure "pre-existing".
15. If something in a plan conflicts with the code, follow the code's existing pattern and **ask the owner** instead of inventing a new design.

---

## 4. Current state (2026-10-31)

Built and uncommitted: location tree (028), statuses (029), tags (030), roles (031), field permissions (032), change requests (033), store receiving, asset page tabs (partial), Locations page (hard to use). Typecheck, lint and unit tests pass; **integration tests and browser checks not yet done**.

Known problems (detail in plan-categories section 0):
- Admin team cannot add any asset (types mapped to Admin are missing from the type list).
- Categories are not tied to teams; subcategories are not tied to categories.
- Asset list photos missing.
- Technician and Auditor can see finance fields; Finance lost reports.
- Dashboards: same for Super Admin, Finance, Executive; new roles get the employee screen.
- Tickets lack most help-desk features.

---

## 5. Tasks in order (stop after each)

### Task 0: Baseline
- Run `npm run test:integration` and report the real result. Fix any new failure caused by migrations 028–033 before anything else.
- **Done when:** only the 3 known `data-transfers` failures remain.

### Task 1: Permissions fixes
- `policy.ts`: remove TECHNICIAN and AUDITOR from `asset.view_private`; add FINANCE back to `report.view`. Unit tests.
- **Check:** a Technician cannot see purchase cost on any asset (API and UI).

### Task 2: Categories owned by teams
- Follow plan-categories sections 1.1–1.3 (migration 034, API rules, ticket routing by category, 9 integration tests) using the defaults in 2.10 (Office Equipment and Security & ELV → IT; Projects may use Furniture, Kitchen, Electrical, Other; Team Leads add subcategories).
- **Check:** an IT member sees only IT categories when adding an asset; an Admin member can add a chair; a laptop cannot be filed under Furniture.

### Task 3: Categories page and form
- Plan-categories 2.1 (Team → Category → Subcategory cascade in a new `CategoryPicker.tsx`), 2.3 (new `/admin/categories` page with "Needs fixing" list), 2.4 and 2.5 clean-ups.
- **Check:** create a subcategory as a Team Lead; it appears in the add-asset form for that team only.

### Task 4: Asset catalog fixes
- Plan-categories 2.2: photo thumbnails (fetch the JSON photo endpoint), category/subcategory filters by team, location filter.
- **Check:** photos show in the list; filters only offer the user's categories.

### Task 5: Locations usable
- Locations plan section 1: bulk add by path with dry run, subtree asset counts, "View assets", shared `LocationPicker.tsx` in asset form/receive/filters, demo tree in the seed command.
- **Check:** paste 5 paths, see the tree, open "View assets" for a building.

### Task 6: Sidebar by role
- `docs/page-map-by-role.md` sections 3–4: grouped menu, only allowed items, new Categories link.
- **Check:** log in as each test role; the menu matches the page map.

### Task 7: Dashboards (5 parts, stop after each)
- `plan-dashboards.md` section 7 order: (1) frame + `GET /dashboards` + My assets + Team; (2) Technician + Store; (3) Finance + Executive; (4) Organisation; (5) Audit, Insurance, Procurement (placeholders where data is not built yet, never fake numbers).
- **Check:** each role sees only its own data; every number opens the matching filtered list.

### Task 8: Tickets (3 parts, stop after each)
- Plan-categories 2.9 with 2.10 rules 1–9: (1) raising (start from item or place, problem type, impact × urgency priority, photos, duplicate warning, on behalf) + notifications; (2) receiving (queue views, Take it, statuses, asset panel, vendor/replacement, work log, resolution, confirm/reopen, CSAT); (3) SLA calendars and escalation.
- **Check:** a broken chair ticket goes to Admin with the right priority and a "fix by" time; IT can take, resolve and the user can reopen.

### Task 9: Asset page layout
- `docs/client-requirements-gap-plan.md` section 6, in `AssetDetailTabs.tsx` (not `Assets.tsx`): header, right column (barcode/QR, key facts, current user), Summary (work orders, recent maintenance, depreciation box for finance roles only, no fake numbers).

### Later (do not start without the owner)
Verification cycles and auditor scan mode, request cart, preventive maintenance, depreciation and fixed-asset register (needs client answers), RFID hardware.

---

## 6. Report format after every task

```
Task N: <name>: DONE / BLOCKED
Changed: <files>
Migrations: <numbers> (applied to app + test DB: yes/no)
Tests: lint ✓/✗ · typecheck ✓/✗ · unit x/y · web x/y · integration x/y (failures: …)
Check in the browser: <steps for the owner>
Open questions: <if any>
```
Update `HANDOFF.md` after each task with the same information.
