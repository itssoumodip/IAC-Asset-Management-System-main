You are working on the IAC asset management system (monorepo: `apps/api` NestJS + raw SQL via `Db` + zod; `apps/web` React 19 + React Query + Vite; migrations in `apps/api/db/migrations`). Read `HANDOFF.md`, `CLAUDE.md` and `docs/client-requirements-gap-plan.md` ("Phase 1: Foundation") first.

# Hard rules (read twice, a previous attempt was thrown away for breaking these)

1. **Small steps.** Do ONE part below, run its tests plus `npm run typecheck`, and only then start the next part. Never leave the repo in a non-compiling state.
2. **Never rewrite a whole big file.** `apps/web/src/components/Assets.tsx` is about 2,000 lines. Edit only the lines you need. Put new screens in NEW files (e.g. `apps/web/src/components/Locations.tsx`). After every edit to a `.tsx` file run `npm run typecheck -w @iac/web`.
3. **Do not commit, do not create branches.** No scrap files (`temp.ts`, `fix-*.js`).
4. **Tests first** for each part. Integration tests use `TEST_DATABASE_URL` from `.env`.
5. **Never insert assets with hand-picked codes in tests** (e.g. `IAC-IT-990001`). Use `allocateAssetCode(db, teamId, client)` from `apps/api/src/domain-assets.ts` inside `db.tx`, or `DomainService.createAsset`.
6. **Vitest:** do NOT set `environment: 'jsdom'` globally. Put `// @vitest-environment jsdom` at the top of the test files that need it (the Excel tests break under jsdom).
7. Permissions are enforced in the API (`apps/api/src/policy.ts`). Do not change who can see finance fields.
8. Migrations: next free number. Apply to both DBs: `npm run db:migrate -w @iac/api -- --test` then `npm run db:migrate`. New tables need grants in `infra/runtime-grants.sql` (no DELETE on users, assets, tickets).
9. Keep accessible names that `test/*.spec.ts` uses (grep before renaming).
10. New CSS goes at the end of `apps/web/src/styles.css` in one commented block; must work at 375px width.

# Already done (uncommitted): check it, do not redo it

- `apps/api/db/migrations/028_location_tree.sql`: `location_levels` table (SITE, ZONE, BUILDING, FLOOR, UNIT, STORE, RACK), `locations.parent_id/level/name`, and a trigger that blocks loops and wrong level order and fills `level`/`name` for old flat inserts.
- `apps/api/src/locations.ts`: `GET /locations/tree`, `POST /locations`, `PATCH /locations/:id` (If-Match; Super Admin only; deactivate blocked while children or assets remain). Registered in `app.module.ts`.
- `domain-masters.ts` `references()` now returns each location's `path` ("Site › Building › Floor"), `level`, `parentId`.
- Tests: `apps/api/test/locations.integration.test.ts`.

**Step 0:** run `npm run db:migrate -w @iac/api -- --test`, then the locations test (`cd apps/api && npx tsx --test test/locations.integration.test.ts` with `TEST_DATABASE_URL` set) and `npm run typecheck`. Fix anything failing before moving on. Then apply to the app DB with `npm run db:migrate`.

# Part 1: show paths everywhere

- `apps/web/src/types.ts`: add `path?: string; level?: string; parentId?: string | null` to `LocationReference`.
- `apps/web/src/components/References.tsx` `locationLabel()`: return `item.path || item.name || …` (one-line change). That makes every location picker show the full path.
- Asset list: add a **Location** filter that includes everything under the chosen place. API: `locationId` filter in the assets list query uses a recursive subtree (`WITH RECURSIVE`); keep `assetScope`. Integration test first.

# Part 2: Locations page

New file `apps/web/src/components/Locations.tsx`, route `/admin/locations`, link in the Administration nav for Super Admin. Expandable tree from `GET /locations/tree`: each row shows name, level badge, asset count; actions **Add inside** (level select limited to inner levels), **Rename**, **Move** (parent picker), **Deactivate** (show the API's 409 message). Search box filters by path. Reason field required for each change. Vitest for: add-inside offers only inner levels.

# Part 3: Statuses

Add **Ready to Assign**, **In Use**, **Scrapped**, **Broken** (migration: extend `assets_status_check` and insert `reference_values` kind STATUS). Rules: assigning sets In Use; return sets In Store; Ready to Assign only from In Store (Lead/Super Admin); Scrapped is terminal like Retired (Lead only, reason); Broken cannot be assigned. Treat `Assigned` and `In Use` the same everywhere (`canAssign`, `canTransfer`, dashboards, filters). Do not rewrite old rows. Integration tests for each rule.

# Part 4: Tags (QR / barcode / NFC / RFID-ready)

Table `asset_identifiers(asset_id, kind CHECK IN ('QR','BARCODE','NFC','RFID'), value, created_at, created_by)`, unique `(kind,value)`, backfill QR = asset code and BARCODE = existing `barcode`. `apps/api/src/scan.ts` looks up any kind and still accepts plain codes. Asset detail gets a small "Tags" section (add/remove, reason, audited) in a NEW component file imported into `Assets.tsx`. Scan page: "Scan NFC tag" button only when `'NDEFReader' in window`.

# Part 5: Store receiving

"Receive into store" action: pick a STORE or RACK location (path picker), note; sets `location_id`, writes an `asset_movements` row (kind `RELOCATE`), audited; owning-team members + Super Admin. Scan shows the store/rack path clearly. Integration test first.

# Finish

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`. Allowed failures: only the 3 known `data-transfers` tests. Report the real numbers; do not call a new failure "pre-existing". Update `HANDOFF.md` with what you did and what is left.
