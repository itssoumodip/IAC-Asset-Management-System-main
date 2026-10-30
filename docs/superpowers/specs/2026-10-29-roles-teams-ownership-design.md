# Roles, Teams and Asset Ownership — Design (Sub-project A)

Date: 2026-10-29
Status: Draft for review

## Context and goal

The portal is moving from an IT-only MVP to the company-wide asset register for
India Autism Center: 150+ users and 50,000+ assets owned by several operating
teams. Today it has three roles (`ADMIN`, `IT_ADMIN`, `EMPLOYEE`), asset codes
are hard-wired to `IAC-IT-NNNNNN`, and every asset must be held by a person.

This sub-project introduces the ownership and permission foundation that every
later sub-project depends on.

### Programme roadmap (each sub-project gets its own spec → plan → build)

| # | Sub-project | Depends on |
|---|---|---|
| **A** | **Roles, teams, asset ownership (this spec)** | — |
| B | Zoho People directory sync; custodians separate from portal users | A |
| C | Asset kits (laptop + charger + bag as parent/child, assigned together) | A |
| D | Ticket routing by owning team (IT problems → IT, furniture → Admin) | A |
| E | Finance review gate, invoice documents, invoice auto-fill | A |
| F | Executive dashboard, UI refresh (greeting etc.), scale hardening | A–E |

### Decisions made during brainstorming

- Departments are separated as **"see all, edit own"**: every operating team can
  view and scan all assets, but only change assets its team owns.
- Facility items normally live **in a room, optionally issued to a person**;
  personal equipment (laptop, mouse) must always be held by a person.
- Projects-team assets **must be tagged to a project/grant**; other teams may tag
  optionally.
- Teams have two levels: **Lead** and **Member**.
- New asset codes are **prefixed by owning team**: `IAC-IT-…`, `IAC-ADM-…`,
  `IAC-PRJ-…`. Existing codes and printed labels are unchanged.
- Model: **fixed global roles + team memberships**, evaluated by one central
  policy module (not a user-configurable permission matrix).

## Concepts

- **Global role** — applies across the system: `SUPER_ADMIN`, `FINANCE`,
  `EXECUTIVE`, `EMPLOYEE`. Roles are additive; a user may hold several.
- **Team** — an asset-operating group (initially IT, Admin, Projects). Owns
  assets and (in D) works tickets.
- **Team membership** — a user's level in a team: `LEAD` or `MEMBER`. A user may
  belong to more than one team.
- **Department** — the existing `departments` table: the organisational unit an
  employee works in (Therapy, Education, HR…). Not the same as a team. Its
  source of truth moves to Zoho People in sub-project B.
- **Owning team** — the team responsible for an asset record.
- **Project** — a project, grant or funded programme an asset was bought under.

## Permissions

"Own" means the asset's owning team is one where the actor holds the stated level.

| Capability | Super Admin | Team Lead | Team Member | Finance | Executive | Employee |
|---|---|---|---|---|---|---|
| View all assets, scan any QR | All | All | All | All | All (read-only) | Currently assigned to self |
| Create / edit asset (non-finance fields) | All | Own | Own | — | — | — |
| Assign, return, transfer, relocate | All | Own | Own | — | — | — |
| Retire / dispose / write off | All | Own | — | — | — | — |
| Bulk import assets | All | Own | — | — | — | — |
| Print labels | All | Own | Own | — | — | — |
| Edit asset photo | All | Own | Own | — | — | — |
| Edit finance fields | All | — | — | All | — | — |
| Add / remove team members, change level | All | Own team | — | — | — | — |
| Users, global roles, Master Control, system settings, notification routing | Yes | — | — | — | — | — |
| Confirm receipt, report discrepancy, raise ticket on own asset | Yes | Yes | Yes | Yes | Yes | Yes |

Finance fields: `purchase_date`, `purchase_cost`, `currency`, `residual_value`,
`depreciation_method`, `useful_life_years`, `invoice_number`, `supplier`,
`insurance_policy_number`, `insurance_expiry`, `finance_pending`. Team users can
see them but not change them. Approval and rejection by Finance is out of scope
here (sub-project E).

Ticket permissions keep current behaviour in A; per-team queues come in D. Until
then, any team member has today's `IT_ADMIN` ticket abilities.

Creating an asset on behalf of another team is not allowed; only Super Admin can
change an asset's owning team (with a reason, audited).

## Data model

New migration `017_roles_teams_ownership.sql`.

### Roles

- Insert `SUPER_ADMIN`, `FINANCE`, `EXECUTIVE` into `roles`; widen its CHECK.
- Existing `ADMIN` grants become `SUPER_ADMIN`. Existing `IT_ADMIN` grants become
  an IT team `MEMBER` membership plus `EMPLOYEE` if not already held.
- After conversion the legacy `user_roles` rows are removed (the conversion is
  recorded in `audit_events`). The `roles` rows stay so old audit references
  resolve, and a CHECK on `user_roles` prevents granting `ADMIN` or `IT_ADMIN`
  again. No code path grants or reads them.
- MFA, required today for `ADMIN`/`IT_ADMIN`, is required for every user holding
  any role other than `EMPLOYEE` or any team membership.

### `teams`

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `code` text unique | Permanent, e.g. `IT`, `ADM`, `PRJ` |
| `name` text unique | Renamable |
| `asset_code_prefix` text unique | `^[A-Z]{2,5}$`; immutable once any asset uses it |
| `requires_project` boolean | `true` for Projects |
| `active` boolean | Deactivated teams keep their assets; no new assets |
| `created_at`, `version` | |

Seeded: IT (`IT`), Admin (`ADM`), Projects (`PRJ`, `requires_project=true`).

### `team_memberships`

`(user_id, team_id)` PK, `level` in (`LEAD`,`MEMBER`), `granted_by`,
`granted_at`. Changes are audited. A team may have zero Leads (Super Admin then
covers Lead actions).

### `projects`

`id`, `code` unique and permanent, `name`, `funder` (nullable),
`grant_reference` (nullable), `start_date`, `end_date` (nullable; ≥ start),
`active`, `version`. Managed in Master Control by Super Admin. Inactive projects
can't be chosen for new tags but stay on existing assets.

### `assets` changes

- `owning_team_id uuid NOT NULL REFERENCES teams(id)` — backfilled to IT.
- `project_id uuid REFERENCES projects(id)` — nullable. Service enforces it is
  set when the owning team has `requires_project`.
- Replace the code CHECK with `^IAC-[A-Z]{2,5}-[0-9]{6}$`, and enforce in a
  trigger that the prefix matches the owning team's prefix at insert.
- Per-team sequence: a `team_asset_counters(team_id, next_value)` row, locked
  `FOR UPDATE` when allocating. The IT counter starts after the current maximum
  `IAC-IT-` number. Changing owning team does not rewrite the code (labels stay
  valid); the code records the original owner.
- Indexes: `(owning_team_id, status, id)`, `(project_id, id)`,
  `(location_id, id)`.

### Room vs person custody

- Asset types gain a `requires_custodian` flag, stored in a new
  `asset_type_policies(asset_type_code PK, requires_custodian boolean NOT NULL)`
  table keyed to `reference_values` rows of kind `ASSET_TYPE`, and editable in
  Master Control. Asset types without a row default to `true` (today's behaviour).
- Seeded `true` for personal IT equipment (laptop, desktop, mouse, keyboard,
  phone, tablet, headset, charger…); `false` for furniture, kitchen, fixtures,
  printers and shared devices. Super Admin reviews the seed list at rollout.
- `requires_custodian = true`: the asset is either assigned to a person or in
  store; the existing assignment flow is unchanged.
- `requires_custodian = false`: the asset must have a `location_id` while in
  service, and may optionally also have an open person assignment. The
  `asset_movements` `RELOCATE` kind records room moves.
- Who can receive custody stays as today (active, accepted Employee accounts)
  until sub-project B separates custodians from portal users.

## Enforcement

- New module `apps/api/src/policy.ts` exports `can(actor, action, resource?)`
  and `capabilities(actor)`. `Actor` gains `teams: {teamId, level}[]`, loaded
  with the session.
- Every existing `admin()` / `staff()` call site in `domain-*.ts`,
  `data-transfers.ts`, `labels.ts`, `asset-photos.ts`, `admin-dashboard.ts` and
  `scan.ts` is replaced by a named `can()` action. `admin()` and `staff()` are
  removed so no path bypasses the policy.
- List queries for team users are unchanged in visibility (see-all); write
  checks load the asset's `owning_team_id` inside the same transaction, using the
  existing optimistic `version` checks.
- Denials return the existing 403 shape; nothing reveals whether a hidden
  record exists to Employees.
- Bulk import validates owning team per row: each row's team must be one the
  actor leads (or the actor is Super Admin).

## UI

- `/me` returns `capabilities` and team memberships; components hide or disable
  actions accordingly. The server remains authoritative.
- Navigation per role: Executive sees catalog and reports read-only; Finance sees
  catalog with finance fields editable; team users see their working areas.
- Asset create/edit: **Owning team** (only teams the user can create in) and
  **Project** pickers; project is required when the team requires it. Asset code
  preview shows the team prefix.
- Catalog: filters for owning team and project; the column set includes both.
- Master Control: new **Teams** and **Projects** pages; asset type options show
  the **Must be held by a person** toggle.
- People & access: team memberships per user; Leads see a team page to manage
  their own members.

## Error handling

- Missing project for a `requires_project` team → 422 with field error.
- Prefix collision or edit after use → 409 with explanation.
- Assigning a `requires_custodian=false` asset without location → 422.
- Concurrent counter allocation is serialised by the row lock. Because the
  counter is updated in the same transaction as the asset insert, a rolled-back
  create does not consume a code.

## Testing

- Table-driven unit test of `can()` across every role × level × own/other team ×
  action, plus multi-role users.
- Integration tests (real Postgres) for: migration of existing roles and assets;
  per-team code allocation under concurrency; cross-team write denial; Finance
  field-only edits; Executive read-only; project requirement; room-held assets.
- Existing integration and Playwright suites updated from `ADMIN`/`IT_ADMIN` to
  the new roles and must stay green.
- `infra/runtime-grants.sql` updated for new tables.

## Out of scope

Zoho People sync and non-portal custodians (B), kits (C), ticket queues per team
(D), Finance approval workflow and invoice handling (E), executive charts and UI
redesign (F), and a user-configurable permission matrix.
