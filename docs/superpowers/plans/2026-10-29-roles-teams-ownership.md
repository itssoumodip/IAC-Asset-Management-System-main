# Roles, Teams and Asset Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `ADMIN`/`IT_ADMIN`/`EMPLOYEE` model with global roles plus IT/Admin/Projects team memberships, team-owned assets with team-prefixed codes, project/grant tags and room-held asset types.

**Architecture:** Migration `017` adds teams, memberships, projects, per-team code counters and asset-type custody policy, and converts existing grants. A single pure module `apps/api/src/policy.ts` answers every permission question. All existing `admin()`/`staff()`/`requireRole()` checks are replaced by it, and `/me` exposes the resulting capabilities to the React UI.

**Tech Stack:** NestJS + `pg` (raw SQL), zod, PostgreSQL migrations in `apps/api/db/migrations`, `node:test` via `tsx --test`, React 19 + React Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-roles-teams-ownership-design.md`

## Global Constraints

- Global roles: `SUPER_ADMIN`, `FINANCE`, `EXECUTIVE`, `EMPLOYEE`. Team levels: `LEAD`, `MEMBER`. Roles are additive.
- Seeded teams (fixed UUIDs so the column default works): IT `00000000-0000-4000-8000-000000000001` (code `IT`, prefix `IT`), Admin `…0002` (code `ADM`, prefix `ADM`), Projects `…0003` (code `PRJ`, prefix `PRJ`, `requires_project=true`).
- Asset code format: `^IAC-[A-Z]{2,5}-[0-9]{6}$`. Prefix must equal the owning team's prefix at insert. Existing codes are never rewritten.
- Prefix: `^[A-Z]{2,5}$`, immutable once any asset code starts with `IAC-<prefix>-`.
- Finance fields: `purchaseDate, purchaseCost, currency, residualValue, depreciationMethod, usefulLifeYears, invoiceNumber, supplier, insurancePolicyNumber, insuranceExpiry, financePending`.
- Write-off statuses (need `asset.retire`): `Retired, Disposed, Sold, Lost, Stolen`.
- MFA is required for anyone with a role other than `EMPLOYEE` or any team membership.
- Errors: missing project → 422, prefix collision/edit-after-use → 409, room-held asset without location → 422, denial → existing 403 shape.
- User preference: **do not `git commit` or branch** unless the user asks. Checkpoint steps run tests only.
- Behaviour change to call out at rollout: current `IT_ADMIN` users today only see assets that have tickets. As IT Members they will see all assets and edit IT-owned ones.

## Review Focus

1. A user with two team memberships (e.g. IT Member + Admin Lead) editing an Admin asset: Lead rights must apply, not the first membership found. (Task 2 test `multi-team uses the level for the asset's team`.)
2. The last active `SUPER_ADMIN` demotes or disables themselves: must be refused, as today for `ADMIN`. (Task 3 test.)
3. A team Member PATCHes a mix of finance and non-finance fields: the whole request is refused with 403, and nothing is partially saved. (Task 4 test.)
4. Two concurrent creates in the same team get distinct sequential codes, and a create that fails validation doesn't burn a number. (Task 5 test.)
5. An existing install with assets created via `asset_number_seq` plus raw-SQL test inserts: the IT counter must start after the highest existing `IAC-IT-` number, so the first new code doesn't collide. (Task 1 test.)

---

### Task 1: Migration 017 — schema, seeds, conversion

**Files:**
- Create: `apps/api/db/migrations/017_roles_teams_ownership.sql`
- Modify: `infra/runtime-grants.sql`
- Test: `apps/api/test/roles-migration.integration.test.ts`

**Interfaces:**
- Produces tables: `teams(id, code, name, asset_code_prefix, requires_project, active, created_at, version)`, `team_memberships(user_id, team_id, level, granted_by, granted_at)` PK `(user_id, team_id)`, `projects(id, code, name, funder, grant_reference, start_date, end_date, active, version)`, `team_asset_counters(team_id PK, next_value bigint NOT NULL)`, `asset_type_policies(asset_type_code PK, requires_custodian boolean NOT NULL)`.
- Produces columns: `assets.owning_team_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES teams`, `assets.project_id uuid REFERENCES projects`.
- Produces triggers: `assets_code_prefix_check` (BEFORE INSERT), `teams_prefix_immutable` (BEFORE UPDATE OF asset_code_prefix).

- [ ] **Step 1: Write the failing test** `roles-migration.integration.test.ts`, following the `_test`-DB guard pattern in `privileges.integration.test.ts`. Tests:
  - `seeds three teams with fixed ids and prefixes`: `SELECT code, asset_code_prefix, requires_project FROM teams ORDER BY code` deep-equals `[ADM/ADM/false, IT/IT/false, PRJ/PRJ/true]`.
  - `rejects asset whose code prefix does not match its team`: inserting `IAC-ADM-000001` with the default (IT) team rejects with SQLSTATE `23514`.
  - `allows a 3-letter prefix for its own team`: an insert of `IAC-ADM-<n>` with `owning_team_id=…0002` succeeds.
  - `refuses prefix change once used`: `UPDATE teams SET asset_code_prefix='ITX' WHERE code='IT'` rejects (SQLSTATE `23514`).
  - `blocks legacy role grants`: an `INSERT INTO user_roles … 'IT_ADMIN'` rejects.
  - `IT counter is past highest existing IAC-IT number`: `next_value` for IT is greater than `max(substr(asset_code,8)::int)` over `IAC-IT-%` assets.
  - `Printer and Networking are room-held`: `requires_custodian` is false for both.
  - `runtime role can use new tables`: after applying `runtime-grants.sql`, `SET LOCAL ROLE iac_runtime` can update `team_asset_counters` and insert into `team_memberships` and `projects`.
- [ ] **Step 2: Run to verify fail.** Run `npm run test:integration -w @iac/api` (after `npm run db:migrate -w @iac/api -- --test`). Expected: FAIL, `relation "teams" does not exist`.
- [ ] **Step 3: Write `017_roles_teams_ownership.sql`** inside `BEGIN; … COMMIT;`, with these exact decisions:
  - Widen the `roles` CHECK to the 7 codes. Insert `SUPER_ADMIN`, `FINANCE`, `EXECUTIVE`.
  - Drop the `assets.asset_code` CHECK from `001` (look up its generated name via `pg_constraint`) and add `CHECK (asset_code ~ '^IAC-[A-Z]{2,5}-[0-9]{6}$')`.
  - Convert legacy grants. For each `ADMIN` grant, insert `SUPER_ADMIN`. For each `IT_ADMIN` grant, insert an IT `MEMBER` membership plus `EMPLOYEE` (ON CONFLICT DO NOTHING). Write one `audit_events` row per converted user (`actor_kind='SYSTEM'`, `entity_type='user'`, `action='ROLE_MODEL_MIGRATED'`, `changes={"from":[…],"to":[…]}`, `request_id=gen_random_uuid()`). Then delete the legacy `user_roles` rows and add `CHECK (role_code NOT IN ('ADMIN','IT_ADMIN'))` on `user_roles`.
  - Initialise the IT counter as `greatest(<asset_number_seq last_value + 1 if is_called>, max existing IAC-IT number + 1, 1)`. ADM and PRJ start at 1.
  - Seed `asset_type_policies` with `('Printer', false)` and `('Networking', false)`. Missing rows mean `true`.
  - Raise errors with `ERRCODE = 'check_violation'` in both triggers.
  - Indexes: `(owning_team_id, status, id)`, `(project_id, id)`, `(location_id, id)` on assets, and `(team_id, level)` on team_memberships.
  - Projects: `code` unique, `CHECK(end_date IS NULL OR end_date >= start_date)`.
- [ ] **Step 4: Update `infra/runtime-grants.sql`.** INSERT,UPDATE on `teams, projects, team_asset_counters, asset_type_policies`. INSERT,UPDATE,DELETE on `team_memberships`.
- [ ] **Step 5: Run to verify pass.** Same command. Expected: new file PASS, and `privileges.integration.test.ts` still PASS.

### Task 2: Policy module

**Files:**
- Create: `apps/api/src/policy.ts`
- Test: `apps/api/test/policy.test.ts` (add to the `test` script list in `apps/api/package.json`)

**Interfaces:**
- Produces:
  ```ts
  export type GlobalRole = 'SUPER_ADMIN' | 'FINANCE' | 'EXECUTIVE' | 'EMPLOYEE';
  export type TeamLevel = 'LEAD' | 'MEMBER';
  export interface TeamMembership { teamId: string; teamCode: string; level: TeamLevel }
  export interface PolicyActor { roles: string[]; teams?: TeamMembership[] }
  export type Action =
    | 'asset.view_all' | 'asset.view_private' | 'asset.create' | 'asset.edit' | 'asset.custody'
    | 'asset.retire' | 'asset.import' | 'asset.label' | 'asset.photo' | 'asset.finance_edit'
    | 'asset.change_team' | 'team.manage_members' | 'ticket.work' | 'announcement.send'
    | 'report.view' | 'system.admin';
  export const TEAM_SCOPED: ReadonlySet<Action>; // create, edit, custody, retire, import, label, photo, manage_members
  export const FINANCE_FIELDS: readonly string[]; // camelCase list from Global Constraints
  export const WRITE_OFF_STATUSES: ReadonlySet<string>;
  export function can(actor: PolicyActor, action: Action, teamId?: string): boolean;
  export function assertCan(actor: PolicyActor, action: Action, teamId?: string): void; // ForbiddenException('Insufficient permission')
  export function teamsFor(actor: PolicyActor, action: Action): 'ALL' | string[];
  export function capabilities(actor: PolicyActor): { global: Action[]; teams: Record<string, Action[]> };
  export function privileged(actor: PolicyActor): boolean; // MFA rule
  ```
- Rules, from the spec table:
  - `SUPER_ADMIN` can do everything.
  - LEAD: all `TEAM_SCOPED` actions for their team.
  - MEMBER: `create, edit, custody, label, photo` for their team.
  - Any team membership grants `view_all, view_private, ticket.work, announcement.send`.
  - `FINANCE`: `view_all, view_private, finance_edit`.
  - `EXECUTIVE`: `view_all, view_private, report.view`.
  - `report.view` is also granted to SUPER_ADMIN.
  - `asset.change_team` and `system.admin` are SUPER_ADMIN only.
  - A team-scoped action with no `teamId` returns true only for SUPER_ADMIN.

- [ ] **Step 1: Write the failing table-driven test.** Build an `expectations` array of `[label, actor, action, teamId, expected]` that covers every row of the spec table for SUPER_ADMIN, IT LEAD, IT MEMBER, FINANCE, EXECUTIVE and EMPLOYEE, against both the IT team id and the ADM team id. Also add:
  - `multi-team uses the level for the asset's team`: an actor with IT MEMBER and ADM LEAD gets `can(a,'asset.retire',ADM)===true` and `can(a,'asset.retire',IT)===false`.
  - `teamsFor returns ALL for super admin and own ids otherwise`.
  - `privileged false only for plain EMPLOYEE without teams`.
  - `assertCan throws 403`.
- [ ] **Step 2: Run** `npm test -w @iac/api`. Expected: FAIL, cannot find module `../src/policy`.
- [ ] **Step 3: Implement `policy.ts`.** Use a static `Record<Action, …>` rule table. No DB access.
- [ ] **Step 4: Run** `npm test -w @iac/api`. Expected: PASS.

### Task 3: Session, `/me`, MFA, bootstrap and user role administration

**Files:**
- Modify: `apps/api/src/security.ts` (Actor, `resolveSession`, `SessionGuard`, `publicUser`; remove `staff`)
- Modify: `apps/api/src/auth.ts:521,649-935` (role enums, last-admin guard, MFA check, user list role filter)
- Modify: `apps/api/src/cli.ts:97,110` (bootstrap grants `SUPER_ADMIN` + `EMPLOYEE`)
- Test: `apps/api/test/auth.integration.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `TeamMembership`, `capabilities`, `privileged` from Task 2.
- Produces: `Actor.teams: TeamMembership[]`. `publicUser(user)` adds `teams` and `capabilities`. The role enum in auth zod schemas becomes `z.enum(['SUPER_ADMIN','FINANCE','EXECUTIVE','EMPLOYEE'])`.

- [ ] **Step 1: Write failing tests** in `auth.integration.test.ts`:
  - `session actor carries team memberships`: insert an IT MEMBER row. `resolveSession` returns `teams` deep-equal to `[{teamId: IT, teamCode:'IT', level:'MEMBER'}]`.
  - `team member without MFA is blocked by SessionGuard`: 403 `MFA enrollment or verification is required`.
  - `last active SUPER_ADMIN cannot remove own role`: 409, same message as today's ADMIN guard.
  - `legacy role names are rejected by role edit`: PUT roles `['IT_ADMIN']` → 422.
  - `/me includes capabilities.global` containing `system.admin` for SUPER_ADMIN.
- [ ] **Step 2: Run** `npm run test:integration -w @iac/api`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Load memberships in `resolveSession` with a second query joined to `teams` (keep the existing aggregate query unchanged).
  - `SessionGuard` uses `privileged(req.user)`.
  - Replace every `'ADMIN'` literal in `auth.ts` with `'SUPER_ADMIN'`, and the `staff(actor)` MFA check with `privileged(actor)`.
  - The `cli.ts` bootstrap check and insert use `SUPER_ADMIN`.
- [ ] **Step 4: Run** unit and integration tests. Expected: PASS. Fix existing auth tests that build actors with `ADMIN` by switching them to `SUPER_ADMIN`.

### Task 4: Replace role checks across domain services

**Files:**
- Modify: `apps/api/src/domain-helpers.ts:128-129,190-200,250-259,412-422` (delete `admin`/`staff`, rewrite `assetScope`, `assetColumns`, `ticketScope`)
- Modify: `apps/api/src/domain-assets.ts`, `domain.ts`, `domain-tickets.ts`, `domain-masters.ts`, `domain-import.ts`, `data-transfers.ts`, `labels.ts`, `asset-photos.ts`, `admin-dashboard.ts`, `scan.ts`, `push.ts`, `notifications.ts`
- Test: `apps/api/test/team-permissions.integration.test.ts` (new); update actor roles in the existing `*.integration.test.ts`

**Interfaces:**
- Consumes: `can`, `assertCan`, `teamsFor`, `FINANCE_FIELDS`, `WRITE_OFF_STATUSES` (Task 2). `Actor.teams` (Task 3).
- Produces: `assetScope(actor, values)` returns `'TRUE'` when `can(actor,'asset.view_all')`, else the existing own-assignment clause. `assetColumns(actor)` includes `privateAssetColumns` when `can(actor,'asset.view_private')`. `ticketScope` returns `'TRUE'` when `can(actor,'ticket.work')`. `/dashboard` `role` becomes the actor's primary role: first of `SUPER_ADMIN, FINANCE, EXECUTIVE`, then `TEAM` if they have any team, else `EMPLOYEE`.
- Mapping of current checks:

| Current check | New check |
|---|---|
| `requireRole(req,'ADMIN')` on asset create/edit/assign/reassign/return | `assertCan(actor, action, asset.owning_team_id)`, using the asset row locked inside the transaction |
| photo PUT | `asset.photo` |
| label prints | `asset.label` for every asset id in the batch |
| imports and non-ticket bulk transfers | `asset.import` (per row in Task 6) |
| masters write, audit events, notification groups | `system.admin` |
| ticket owner/status, internal notes, `staff()` in tickets/transfers | `ticket.work` |
| push broadcast | `announcement.send` |
| admin dashboard summary | `report.view` |

- `editAsset` rules:
  - If `changes` touches any `FINANCE_FIELDS`, require `asset.finance_edit`.
  - If it touches any other field, require `asset.edit` for the team.
  - If `changes.status` is in `WRITE_OFF_STATUSES` and differs from the current status, also require `asset.retire`.
  - All checks run before `patchObject`.
- `createAsset` with any finance field set → 403 `Finance fields are set by Finance` unless `asset.finance_edit`.
- Ticket notification recipients (`domain-tickets.ts:35`): group `ADMIN` maps to `SUPER_ADMIN`, and group `IT` maps to users with an IT team membership.

- [ ] **Step 1: Write failing tests** in `team-permissions.integration.test.ts`. Use the `make(roles)` helper pattern from `domain.integration.test.ts`, extended with a `teams` argument that also inserts `team_memberships`. Tests:
  - `IT member can edit IT asset but not ADM asset` (second call rejects 403).
  - `IT member sees every asset in list` (count equals the admin count for a tagged filter).
  - `member cannot retire, lead can` (status `Retired` with a disposal ref).
  - `finance edits purchaseCost but not description`.
  - `mixed finance and non-finance patch by member is rejected and nothing changes` (re-read: version unchanged).
  - `executive can list and read private columns but every write is 403`.
  - `employee still sees only own assigned assets`.
  - `IT notification group resolves to IT team members`.
- [ ] **Step 2: Run** `npm run test:integration -w @iac/api`. Expected: the new tests FAIL, and compilation errors where `admin`/`staff` are removed.
- [ ] **Step 3: Implement the mapping above.** `grep -rn "admin(\|staff(\|requireRole(req, 'ADMIN'\|'IT_ADMIN'" apps/api/src` must return only `requireRole(req,'EMPLOYEE')` in `acknowledge`.
- [ ] **Step 4: Update existing integration tests.** `ADMIN` actors become `SUPER_ADMIN`. `IT_ADMIN` actors become `EMPLOYEE` plus an IT MEMBER team.
- [ ] **Step 5: Run** `npm run typecheck && npm test && npm run test:integration` from the root. Expected: all PASS.

### Task 5: Owning team, project, per-team codes, room-held assets

**Files:**
- Modify: `apps/api/src/domain-helpers.ts` (`assetInput` adds `owningTeamId: uuid`, `projectId: uuid.nullable().optional()`; `assetPatch` adds them; `employeeAssetColumns` adds `owning_team_id`, `project_id`; `validateAsset` checks team active, project active, project-required, room rule)
- Modify: `apps/api/src/domain-assets.ts:119-200` (code allocation, team change, assign rule)
- Test: `apps/api/test/asset-ownership.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, `assertCan` (Task 2).
- Produces: `allocateAssetCode(db: Db, teamId: string, c: PoolClient): Promise<string>` in `domain-assets.ts`. It locks `team_asset_counters … FOR UPDATE`, formats `IAC-${prefix}-${padStart(6)}`, skips any code that already exists, increments `next_value` in the same transaction, and throws 409 `Asset code range exhausted` above 999999. It replaces the `asset_number_seq` loop and advisory lock.

- [ ] **Step 1: Write failing tests:**
  - `ADM lead creates IAC-ADM-000001 then 000002`.
  - `concurrent creates in one team get distinct codes` (`Promise.all` of 5 creates; the set size is 5).
  - `failed create does not consume a code` (an invalid category create rejects, then the next valid code equals the previous + 1).
  - `PRJ asset without projectId is 422 with field projectId`.
  - `inactive project cannot be tagged` (422).
  - `Printer without locationId is 422` on create and on edit-to-null.
  - `Printer at a location may also be assigned to a person`.
  - `only SUPER_ADMIN changes owningTeamId, reason audited, code unchanged`.
  - `member cannot create in another team` (403).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The `requires_custodian=false` check reads `asset_type_policies` and defaults to true when there's no row. A change of `owningTeamId` requires `asset.change_team` and writes audit action `ASSET_TEAM_CHANGED` with `{from,to,reason}`.
- [ ] **Step 4: Run** the integration suite. Expected: PASS.

### Task 6: Imports and bulk transfers respect teams and prefixes

**Files:**
- Modify: `apps/api/src/domain-import.ts:108,121,274-277` (regex `^IAC-[A-Z]{2,5}-\d{6}$`; promoted rows take `owning_team_id` from the prefix's team)
- Modify: `apps/api/src/data-transfers.ts` (asset module template adds `Owning Team Code`, `Project Code` columns; per-row `asset.import` for that team; finance columns need `asset.finance_edit`)
- Modify: `docs/DATA_TRANSFERS.md` (new columns)
- Test: `apps/api/test/data-transfers.integration.test.ts`, `apps/api/test/domain.integration.test.ts`

**Interfaces:**
- Consumes: `can`, `allocateAssetCode` (Task 5).

- [ ] **Step 1: Write failing tests:**
  - `IT lead bulk import with an ADM row fails validation on that row with code TEAM_NOT_PERMITTED`.
  - `register row IAC-ADM-000123 promotes into ADM team`.
  - `unknown prefix row is quarantined with UNKNOWN_TEAM_PREFIX`.
  - `approving pending finance metadata in register review requires asset.finance_edit`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Row errors use the existing per-row issue structure.
- [ ] **Step 4: Run** the integration suite. Expected: PASS.

### Task 7: Master Control and membership APIs

**Files:**
- Modify: `apps/api/src/domain-masters.ts` (kinds `teams`, `projects`; asset type `requiresCustodian`)
- Create: `apps/api/src/teams.ts` (controller + service for memberships; register it in `app.module.ts`)
- Modify: `docs/API.md`
- Test: `apps/api/test/masters.integration.test.ts`, `apps/api/test/teams.integration.test.ts`

**Interfaces:**
- Produces routes:
  - `POST /master-data/teams` with `{code, name, assetCodePrefix, requiresProject, reason}`, and `PATCH /master-data/teams/:code` (prefix change → 409 if used). The counter row is created with the team.
  - `POST /master-data/projects` with `{code, name, funder?, grantReference?, startDate, endDate?, reason}`, and `PATCH /master-data/projects/:code`.
  - `PATCH /master-data/ASSET_TYPE/:code` also accepts `requiresCustodian: boolean`, upserting `asset_type_policies`.
  - `references()` additionally returns `teams`, `projects` and `assetTypePolicies`.
  - `GET /teams/:id/members`, `PUT /teams/:id/members/:userId {level, reason}`, `DELETE /teams/:id/members/:userId {reason}`. All gated by `team.manage_members` for that team. Changes are audited and revoke the target user's sessions, as role edits do.

- [ ] **Step 1: Write failing tests:**
  - `super admin creates a team and its first asset code uses the new prefix`.
  - `duplicate prefix is 409`.
  - `IT lead adds a member to IT but gets 403 for ADM`.
  - `member cannot manage members`.
  - `membership change revokes target sessions`.
  - `asset type requiresCustodian toggle round-trips`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, following the existing `departments`/`locations` branch pattern in `createMaster`/`updateMaster`.
- [ ] **Step 4: Run** the integration suite. Expected: PASS.

### Task 8: Web — session capabilities and role-aware navigation

**Files:**
- Modify: `apps/web/src/types.ts` (`Role`, `TeamMembership`, `User.teams`, `User.capabilities`)
- Modify: `apps/web/src/session.tsx` (replace `hasRole`'s legacy union; add `can(user, action, teamId?)`, reading `capabilities`)
- Modify: `apps/web/src/App.tsx:58,215,260,320,430`, `components/Dashboards.tsx`, `Tickets.tsx`, `Scan.tsx`, `Notifications.tsx`, `PushAnnouncements.tsx`
- Test: `apps/web/src/session.test.ts`

**Interfaces:**
- Consumes: the `/me` `capabilities` shape from Task 3: `{ global: Action[]; teams: Record<teamId, Action[]> }`.
- Produces: `can(user: User | undefined, action: Action, teamId?: string): boolean`, mirroring the server's semantics (`global` grants the action for any team).

- [ ] **Step 1: Write the failing test** `session.test.ts`:
  - `global capability applies to any team`.
  - `team capability applies only to that team`.
  - `undefined user can nothing`.
- [ ] **Step 2: Run** `npm test -w @iac/web`. Expected: FAIL.
- [ ] **Step 3: Implement**, and swap every `hasRole(user,'ADMIN')` for the matching `can(...)`:
  - Admin routes use `system.admin`.
  - Catalog label uses `asset.view_all`.
  - Insights use `report.view`.
  - Staff ticket actions use `ticket.work`.
  - The role chips in App and profile display `SUPER ADMIN`, `FINANCE`, `EXECUTIVE`, `EMPLOYEE`, plus `IT · Lead` style team chips.
- [ ] **Step 4: Run** `npm test -w @iac/web && npm run typecheck`. Expected: PASS.

### Task 9: Web — asset form and catalog

**Files:**
- Modify: `apps/web/src/components/Assets.tsx`
- Modify: `apps/web/src/api.ts` (catalog query params `owningTeamId`, `projectId`), and `apps/api/src/domain-helpers.ts` `requestPage` (accept `owningTeamId`, `projectId` as uuids) with the filter applied in `domain-assets.ts` `assets()`
- Test: `test/team-assets.spec.ts` + `test/team-assets.playwright.config.ts` (mocked API, like `asset-photo.spec.ts`)

**Interfaces:**
- Consumes: `can` (Task 8); `references().teams/projects/assetTypePolicies` (Task 7).

- [ ] **Step 1: Write the failing Playwright test** (mocked API):
  - `Owning team picker lists only teams the user can create in`.
  - `Project becomes required for Projects team` (Save disabled until chosen, with the label `Project / grant (required)`).
  - `code preview shows IAC-ADM-…` for the Admin team.
  - `Location required hint for room-held types`.
  - `finance fields are read-only for a team member and editable for Finance`.
  - `catalog filters by team and project`.
  - `write actions hidden for Executive`.
- [ ] **Step 2: Run** `npx playwright test --config test/team-assets.playwright.config.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add server-side filter params to `requestPage`'s strict schema.
- [ ] **Step 4: Run** the same command, plus `npm run test:integration -w @iac/api`. Expected: PASS.

### Task 10: Web — Master Control and People & access

**Files:**
- Modify: `apps/web/src/components/MasterControl.tsx` (Teams page, Projects page, "Must be held by a person" toggle on Asset types)
- Modify: `apps/web/src/components/Admin.tsx:37-410,488` (role checkboxes `EMPLOYEE, FINANCE, EXECUTIVE, SUPER_ADMIN`; Team memberships section with team + level + reason)
- Create: `apps/web/src/components/TeamMembers.tsx` (Lead's own-team page, route `/team/:teamId`, nav entry shown when `can(user,'team.manage_members',teamId)`)
- Test: `test/team-admin.spec.ts` + config (mocked API)

**Interfaces:**
- Consumes: the Task 7 routes.

- [ ] **Step 1: Write the failing tests:**
  - `super admin creates team with prefix; prefix field locked after use` (mock returns `prefixInUse:true`).
  - `project create requires start date`.
  - `lead sees only own team page`.
  - `membership change asks for reason and warns sessions will be revoked`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, reusing the existing `ui.tsx` Field/table components and patterns.
- [ ] **Step 4: Run.** Expected: PASS.

### Task 11: End-to-end, docs, full verification

**Files:**
- Modify: `test/system.spec.ts`, `test/assignment-discovery.spec.ts`, `test/data-transfer.spec.ts`, `test/qr-scan.spec.ts`, `test/resend-invitation.spec.ts`, `test/asset-photo.spec.ts` (role names)
- Modify: `README.md` (roles section, upgrade note including the IT_ADMIN visibility change, migration 017 + reapply `infra/runtime-grants.sql`), `docs/SYSTEM_DESIGN_AND_USER_GUIDE.md` (permission table from the spec)

- [ ] **Step 1: Add to `test/system.spec.ts`** `IT member cannot edit Admin-team chair; Admin lead can retire it`, end to end against the test DB.
- [ ] **Step 2: Run the full gate** from the root: `npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:e2e && npm run build`. Expected: all PASS.
- [ ] **Step 3: Final grep gate.** `grep -rn "IT_ADMIN\|'ADMIN'" apps test --include=*.ts --include=*.tsx` returns only migration-related test assertions and the `user_roles` CHECK test.
