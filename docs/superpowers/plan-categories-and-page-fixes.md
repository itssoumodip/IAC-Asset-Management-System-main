# Plan: team-owned categories + fixes to existing pages

**Written:** 2026-10-31 for opencode. **Status:** owner to approve the decisions in section 1.4 first.
**Read first:** `HANDOFF.md`, `CLAUDE.md`, `docs/page-map-by-role.md`, `docs/client-requirements-gap-plan.md`.

---

## 0. Problems found (checked in code and the app database on 2026-10-31)

| # | Problem | Where | Effect |
|---|---|---|---|
| P1 | Admin team cannot add any asset | `asset_type_policies` maps Chair, Table, Kitchen, Light to ADM, but those codes are **not** in `reference_values` (ASSET_TYPE has only Desktop, Laptop, Monitor, Networking, Other, Printer). The add form (`Assets.tsx` ~line 1514) drops types without an active reference value. | Admin's "Asset type" list is empty |
| P2 | Categories are not tied to teams | No table links `CATEGORY` to a team | IT can pick "Furniture"; Admin can pick "IT Hardware" |
| P3 | Subcategory is not tied to a category | `ASSET_TYPE` has no parent | Data like `Furniture / Other`, `Clinical/Therapy Equipment / Desktop` |
| P4 | No screen to manage type→team mapping | Only seeded in migration 027 | Every new type is unusable until a developer edits SQL |
| P5 | "Asset types kept by a person" sits on Teams & projects, away from the types themselves | `TeamAdmin.tsx` | Settings for one thing are split across pages |
| P6 | Locations page is nearly empty and hard to fill | `/admin/locations` | See `docs/superpowers/opencode-plan-review-locations-dashboards.md` section 1 |
| P7 | Photos missing in the asset list | `AssetList` in `Assets.tsx` (thumbnail fix was lost) | Grey boxes |
| P8 | Technician and Auditor can see finance fields | `asset.view_private` in `apps/api/src/policy.ts` | Breaks the client's rule |
| P9 | Finance lost `report.view` | `apps/api/src/policy.ts` | Finance has no reports dashboard |
| P10 | Same dashboard for Super Admin, Finance, Executive; new roles get the employee screen | `UserDashboard` in `Dashboards.tsx` | See the dashboards plan, section 3 |
| P11 | Asset page tabs only partly match the agreed layout | `AssetDetailTabs.tsx` | See gap plan section 6 |

This plan fixes P1–P5, P7–P9 and lists exact changes for every page. P6, P10, P11 follow the plans already written; the order is in section 4.

---

## 1. Team-owned categories and subcategories (fixes P1–P5)

### 1.1 The rule (plain words)
- Every **category** belongs to one or more **teams** (e.g. IT Hardware → IT; Furniture → Admin and Projects).
- Every **subcategory** (today's "asset type", e.g. Laptop) belongs to exactly **one category**.
- When a team member adds or edits an asset, they see **only their team's categories**, and only the subcategories of the chosen category.
- The API enforces the same rule (422 with a clear field error). Super Admin can override with a reason (audited).
- Each category has a **handled-by team** for tickets (furniture problems go to Admin even if Projects owns the chair). This replaces the per-type `handling_team_id`.
- "Must be held by a person" stays per subcategory (`requires_custodian`).

### 1.2 Database: migration `034_category_teams.sql`
```sql
BEGIN;
-- Which teams may use a category, and who handles its tickets.
CREATE TABLE category_policies(
  category_code text PRIMARY KEY,
  handling_team_id uuid NOT NULL REFERENCES teams(id),
  version int NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE category_teams(
  category_code text NOT NULL REFERENCES category_policies(category_code) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id),
  PRIMARY KEY (category_code, team_id)
);
-- A subcategory belongs to exactly one category.
ALTER TABLE asset_type_policies ADD COLUMN category_code text REFERENCES category_policies(category_code);

-- P1: the types mapped in 027 must exist as real subcategories.
INSERT INTO reference_values(kind,code,label) VALUES
  ('ASSET_TYPE','Chair','Chair'),('ASSET_TYPE','Table','Table'),
  ('ASSET_TYPE','Kitchen','Kitchen appliance'),('ASSET_TYPE','Light','Light')
ON CONFLICT DO NOTHING;

-- Seed (owner confirms in 1.4). IT = ...0001, ADM = ...0002, PRJ = ...0003
INSERT INTO category_policies(category_code, handling_team_id) VALUES
  ('IT Hardware',                 '00000000-0000-4000-8000-000000000001'),
  ('Software License',            '00000000-0000-4000-8000-000000000001'),
  ('Security & ELV',              '00000000-0000-4000-8000-000000000001'),
  ('Office Equipment',            '00000000-0000-4000-8000-000000000001'),
  ('Furniture',                   '00000000-0000-4000-8000-000000000002'),
  ('Kitchen Equipment',           '00000000-0000-4000-8000-000000000002'),
  ('Electrical Equipment',        '00000000-0000-4000-8000-000000000002'),
  ('Vehicle',                     '00000000-0000-4000-8000-000000000002'),
  ('Clinical/Therapy Equipment',  '00000000-0000-4000-8000-000000000003'),
  ('Other',                       '00000000-0000-4000-8000-000000000002');
INSERT INTO category_teams(category_code, team_id)
SELECT category_code, handling_team_id FROM category_policies;
-- Projects may also buy Admin's facility categories with grant money.
INSERT INTO category_teams(category_code, team_id)
SELECT c, '00000000-0000-4000-8000-000000000003'
FROM unnest(ARRAY['Furniture','Kitchen Equipment','Electrical Equipment','Other']) c
ON CONFLICT DO NOTHING;

-- Subcategory -> category.
UPDATE asset_type_policies SET category_code = CASE asset_type_code
  WHEN 'Laptop' THEN 'IT Hardware' WHEN 'Desktop' THEN 'IT Hardware' WHEN 'Monitor' THEN 'IT Hardware'
  WHEN 'Networking' THEN 'IT Hardware' WHEN 'Printer' THEN 'Office Equipment'
  WHEN 'Chair' THEN 'Furniture' WHEN 'Table' THEN 'Furniture'
  WHEN 'Kitchen' THEN 'Kitchen Equipment' WHEN 'Light' THEN 'Electrical Equipment' END;
INSERT INTO asset_type_policies(asset_type_code, requires_custodian, category_code)
VALUES ('Other', false, 'Other')
ON CONFLICT (asset_type_code) DO UPDATE SET category_code = excluded.category_code;
COMMIT;
```
Grants (`infra/runtime-grants.sql`): `INSERT,UPDATE ON category_policies`, `INSERT,UPDATE,DELETE ON category_teams`.
Keep `asset_type_policies.owning_team_id` / `handling_team_id` for one release (read-only, unused); note in HANDOFF that a later migration drops them.

Also add the client's groups as categories (inactive until the owner turns them on): `Heavy Machinery`, `Outdoor`, `Mobility` → handled by ADM.

### 1.3 API
**References** (`references()` in `apps/api/src/domain-masters.ts`) add:
```ts
categoryPolicies: [{ categoryCode, handlingTeamId, teamIds: string[], version }],
assetTypePolicies: [{ assetTypeCode, requiresCustodian, categoryCode }], // categoryCode added
```

**Validation** in `validateOwnership` (`apps/api/src/domain-helpers.ts`), replacing the per-type team check:
```ts
const [cat] = await db.query(
  `SELECT p.category_code, array_agg(t.team_id) AS teams
     FROM category_policies p LEFT JOIN category_teams t USING (category_code)
    WHERE p.category_code=$1 GROUP BY p.category_code`, [data.category], c);
if (!cat) throw fieldIssue('category', 'This category is not set up yet. Ask an administrator.');
if (!cat.teams.includes(owningTeamId) && !overrideBySuperAdmin)
  throw fieldIssue('category', 'This category belongs to another team');
const [type] = await db.query(
  'SELECT category_code FROM asset_type_policies WHERE asset_type_code=$1', [data.assetType], c);
if (!type || type.category_code !== data.category)
  throw fieldIssue('assetType', 'Choose a subcategory of the selected category');
```
- Only check when category, subcategory or owning team **changes** (old assets with odd data stay editable, as the legacy-printer rule does today).
- Super Admin override: allowed only with `overrideReason` in the body; audited as `ASSET_CATEGORY_OVERRIDE`.
- Same check in Excel import (`data-transfers.ts`) and register import (`domain-import.ts`): row-level errors, not 500s.

**Ticket routing** (`createTicket` in `domain-tickets.ts`): asset tickets go to the asset's category `handling_team_id`; fall back to the existing category→team mapping, then IT.

**Management endpoints** (new file `apps/api/src/categories.ts`):
- `GET /categories`: categories with teams, handling team, subcategories, asset counts.
- `PUT /categories/:code/teams` `{ teamIds, handlingTeamId, reason }`: Super Admin.
- `POST /categories/:code/subcategories` `{ code, label, requiresCustodian, reason }`: Super Admin, or a **Team Lead of a team that owns the category** (rule from the owner: each team adds its own item types).
- `PATCH /subcategories/:code` `{ label?, active?, requiresCustodian?, categoryCode?, reason }`: same permission; moving to another category only Super Admin.
- Removing a team from a category is blocked (409) while that team still owns assets in it; show the count.

**Tests (integration, write first):**
1. IT member creating an asset with category Furniture → 422 `category`.
2. Laptop under Furniture → 422 `assetType`.
3. Admin member can create Chair / Furniture (proves P1 fixed).
4. Projects can create Chair / Furniture (shared category).
5. Super Admin override needs `overrideReason`; it is audited.
6. Editing an old mismatched asset's description still works; changing its category re-checks.
7. A ticket on a Projects-owned chair goes to Admin.
8. Team Lead adds a subcategory to their own category (201) but not to IT's (403).
9. Excel import row with the wrong category for the team → row error, others still import.

### 1.4 Owner decisions (confirm before building)
1. Office Equipment (printers, copiers): IT or Admin? (Draft: IT.)
2. Security & ELV (CCTV, access control): IT or Admin? (Draft: IT.)
3. Which Admin categories may Projects use? (Draft: Furniture, Kitchen, Electrical, Other.)
4. Can Team Leads add subcategories, or only Super Admin? (Draft: Team Leads, in their own categories.)

---

## 2. Changes to existing pages

### 2.1 Add / edit asset (`/assets/new`, `/assets/:id/edit`)
- Field order: **Owning team → Category → Subcategory**. Category lists only the team's categories; Subcategory lists only that category's subcategories. Changing the team clears a category that no longer fits; changing the category clears the subcategory.
- If a team has no categories yet: show "Your team has no categories yet. Ask an administrator to set them up in Categories." instead of an empty dropdown.
- Super Admin: a small "Override team rule" checkbox that shows all categories and asks for a reason.
- Put the cascade in a new component `apps/web/src/components/CategoryPicker.tsx`; in `Assets.tsx` replace only the category and asset-type field blocks with `<CategoryPicker .../>`.
- Label "Asset type" becomes "Subcategory" everywhere in the UI (API names unchanged).

### 2.2 Asset catalog (`/assets`)
- Category filter shows only categories of the teams the user can see; Subcategory narrows to the chosen category.
- Restore the **photo thumbnail**: the photo endpoint returns JSON `{ dataUrl }`, so fetch it with React Query (key `['asset-photo', id]`, `enabled: hasPhoto`) and render the data URL; fall back to the subcategory's first two letters (P7).
- Add a Location filter using the shared location picker (from the locations plan).

### 2.3 New page: Categories (`/admin/categories`)
Replaces "Asset types kept by a person" on Teams & projects (P5) and the Category / Asset type tabs in Master Control.
- One card per category: name, teams (chips, editable by Super Admin), handled-by team, asset count, active toggle.
- Inside each card: subcategories table (name, "held by a person" toggle, asset count, active), and **Add subcategory**.
- A "Needs fixing" panel listing assets whose subcategory is not under their category, or whose category is not owned by their team, with a link to edit each one. No automatic changes to old data.
- Visible to Super Admin (all) and Team Leads (their own categories, add subcategories only).

### 2.4 Teams & projects (`/admin/teams`)
- Remove the "Asset types kept by a person" panel (moved to Categories).
- Ticket category routing stays here (non-asset tickets only); add a note "Asset tickets follow the category's handled-by team (set in Categories)".

### 2.5 Master control (`/master-control`)
- Hide the CATEGORY and ASSET_TYPE tabs and link to Categories instead, so there is one place to manage them.

### 2.6 Permissions (`apps/api/src/policy.ts`)
- Remove TECHNICIAN and AUDITOR from `asset.view_private` (P8), unless the owner decides otherwise in `docs/page-map-by-role.md` section 6.
- Add FINANCE back to `report.view` (P9).
- Unit tests in `apps/api/test/policy.test.ts`.

### 2.7 Sidebar (`apps/web/src/App.tsx`)
Follow `docs/page-map-by-role.md` section 4: groups Workspace / Operations / Finance & reports / Administration; show only allowed items; add **Categories** under Administration.

### 2.8 Locations, dashboards, asset page
Follow the existing plans exactly:
- Locations: `docs/superpowers/opencode-plan-review-locations-dashboards.md` section 1.
- Dashboards per role: same file, section 3, using the role list in `docs/page-map-by-role.md`.
- Asset page layout: `docs/client-requirements-gap-plan.md` section 6.

### 2.9 Tickets: raising and working on them (`/tickets`, `/tickets/new`, `/tickets/:id`)

**Today:** subject, description, category, priority (Low/Medium/High), status (Open / In progress / Completed), team, "Assign to staff", "Move to team", resolution text, one photo, conversation with visibility. Asset tickets go to the category's handled-by team (section 1.3), so IT receives IT problems and Admin receives furniture and facility problems.

**Missing, to build:**

#### A. Raising a ticket (employee side)
1. **Start from the item:** "Report a problem" on My assets, on the asset page and after a scan, opens the form with the asset already filled in. The asset picker lists **my own items first**, then others I can see.
2. **No item? Pick a place:** for facility problems (leaking tap, broken light, AC), choose a **location** with the shared path picker instead of an asset. Routed to the location's handling team (default Admin).
3. **Problem type** (one tap, replaces the free category for asset tickets): Not working · Damaged / broken · Missing part · Software / login · Needs service · Other. Category is filled from the asset's category automatically.
4. **Impact question:** "Can you still work?" Yes / Partly / No → sets priority (Low / Medium / High); the user can still change it. Add **Urgent** priority for "No, and others are affected".
5. **Up to 5 photos or a short video** (today: one photo). Reuse `image-sanitize.ts` limits.
6. **When can someone come?** free text (e.g. "after 2 pm"), and a contact number (prefilled from profile).
7. **Duplicate warning:** if this asset already has an open ticket, show it and offer "Add a comment there instead".
8. **Raise for someone else:** team members can raise on behalf of an employee (reporter = that employee, created_by = the team member).
9. After submit: ticket number, expected response time (from SLA, see C), and a link to follow it.

#### B. Receiving and working (IT / Admin team side)
1. **Queue views with counts:** Unassigned · Mine · My team · Overdue · Waiting · Resolved, plus filters (priority, problem type, location, asset category). Bulk actions: assign, change priority, move team.
2. **Take it** button (assign to me) and **Assign to** (team members only; the owner must be in the ticket's team).
3. **More statuses:** Open → In progress → **Waiting for user** / **Waiting for parts or vendor** (clock paused) → **Resolved** (user asked to confirm) → **Closed**. Plus **Reopened** and **Cancelled** (by reporter, with reason). Map today's COMPLETED to Resolved/Closed in the migration.
4. **Asset panel inside the ticket:** asset code, photo, holder, location path, warranty / AMC status with expiry, and **previous tickets on this asset** (repeat failures stand out).
5. **Actions on the asset from the ticket:** mark the asset **Under Repair** or **Broken**; **send to vendor** under warranty/AMC (vendor name, reference, date sent, date back); **give a replacement** (assign a spare item to the user, linked to the ticket); return the original when fixed.
6. **Work log:** internal note vs reply to the user (keep the existing visibility switch, label it clearly), time spent, parts used, **repair cost** (cost is visible only to finance-allowed roles and feeds the Insurer's repair history).
7. **Resolution:** resolution type (Fixed · Replaced · Vendor repaired · No fault found · Not repairable → asset Scrapped) and a note.
8. **Requester confirms:** "Is it fixed?" Yes closes it; No reopens it. Auto-close after 3 working days with no answer. Optional 1–5 rating.

#### C. Response times (SLA) and escalation
- Per team and priority, in Master control: response time and fix time (draft: Urgent 1 h / 4 h, High 4 h / 1 day, Medium 1 day / 3 days, Low 2 days / 5 days; working hours only).
- Ticket shows "Respond by" and "Fix by"; overdue tickets turn red in the queue.
- When a deadline passes: notify the assignee, then the Team Lead; shown on the team dashboard.

#### D. Notifications
Requester gets in-app + email on: received, assigned, waiting for you, resolved, closed. Assignee gets: assigned to you, user replied, overdue. Use the existing outbox (`db.notify`).

#### E. Database (migration after 034)
- `tickets`: add `location_id`, `problem_type`, `created_by`, `contact_note`, `respond_by`, `resolve_by`, `first_response_at`, `resolved_at`, `closed_at`, `resolution_type`, `rating`, `vendor_name`, `vendor_ref`, `vendor_sent_at`, `vendor_back_at`, `replacement_asset_id`; widen the status check to `OPEN, IN_PROGRESS, WAITING_USER, WAITING_VENDOR, RESOLVED, CLOSED, REOPENED, CANCELLED` and rewrite the completion check to use `RESOLVED`/`CLOSED`; priority adds `URGENT`.
- `ticket_attachments(ticket_id, id, content, mime, sha256, created_by, created_at)`, max 5 per ticket.
- `ticket_work(ticket_id, id, minutes, parts text, cost numeric(14,2), created_by, created_at)`.
- `ticket_slas(team_id, priority, respond_minutes, resolve_minutes)` seeded with the draft values.
- Existing tickets keep their data; `COMPLETED` rows become `CLOSED`.

#### F. Tests
Integration: asset ticket from IT Hardware goes to IT, chair goes to Admin, location-only ticket goes to the location's team; owner must be in the team (422); duplicate warning endpoint; status rules (cannot close without resolution; reopen only by reporter); SLA dates set by priority; overdue query; repair cost hidden from roles without finance rights; replacement assignment creates a normal assignment. Web vitest: impact answer sets priority; duplicate warning shows; queue tabs show counts.

#### G. Owner decisions
1. SLA times (draft above) and working hours.
2. Auto-close after how many days? (Draft: 3 working days.)
3. Should the user rating be on? (Draft: optional.)

---

## 2.10 Decisions: industry-level defaults (owner approved direction, 2026-10-31)

**Principle:** nothing in this section is hard-coded. Every rule is a **setting** an administrator changes in the app (Master control → Service settings / Categories / Field permissions), stored in the database, audited, and seeded with the defaults below. Code reads settings; it never contains a team name, a time or a role list for business rules.

### Tickets (ITIL-aligned)
1. **Ticket kinds:** Incident (something broke), Service request (need something: access, new item, move), Problem (repeat cause behind several incidents, team-only). Each kind has its own form fields and SLA.
2. **Priority = Impact × Urgency** (matrix, configurable):

   | | Urgency: work stopped | Urgency: slowed down | Urgency: can wait |
   |---|---|---|---|
   | **Impact: many people / a whole site** | P1 Critical | P2 High | P3 Medium |
   | **Impact: one team** | P2 High | P3 Medium | P4 Low |
   | **Impact: one person** | P3 Medium | P4 Low | P4 Low |

   The employee answers two plain questions ("Who is affected?", "Can you work?"); the system sets priority; agents may change it with a reason (audited).
3. **SLA policies** per team × priority × ticket kind, measured on a **business-hours calendar** (per site: working days, hours, public holidays) with the clock **paused** while waiting for the user or a vendor. Defaults:

   | Priority | First response | Resolution |
   |---|---|---|
   | P1 Critical | 30 min | 4 business hours |
   | P2 High | 2 business hours | 1 business day |
   | P3 Medium | 1 business day | 3 business days |
   | P4 Low | 2 business days | 5 business days |
4. **Escalation chain** (configurable per team): at 75% of SLA warn the assignee; at breach notify the Team Lead; at 2× breach notify the department head / Super Admin. Breaches are recorded for reports.
5. **Assignment:** manual by default; optional round-robin or least-busy auto-assignment per team (setting).
6. **Lifecycle:** New → Assigned → In progress → Waiting (user / vendor / parts) → Resolved → Closed; Reopened; Cancelled. Resolved auto-closes after **3 business days** (setting) with a reminder at day 2; reopening within 7 days goes back to the same assignee.
7. **Satisfaction (CSAT):** one-tap 1–5 on close, optional comment, reported per team/agent. Optional, never required.
8. **Knowledge:** resolution notes can be saved as a short help article per category (phase 2 of tickets), suggested when a user types a similar subject.
9. **Reports:** volume, SLA compliance %, mean time to respond/resolve, reopen rate, top failing assets and categories, CSAT; all exportable to Excel.

### Categories and teams
10. Category → team ownership, handled-by team and which other teams may use it are **settings in the Categories page**, seeded as: Office Equipment → IT, Security & ELV → IT, Projects may use Furniture / Kitchen / Electrical / Other.
11. Team Leads add subcategories in their own categories; only Super Admin creates categories or moves them between teams. Every change audited.

### Role permissions
12. Roles are **configurable permission sets**, not fixed code: Super Admin can create a role, choose its actions (from `policy.ts` actions) and its visible/editable fields (field permissions). Built-in roles (Executive, Finance, Store, Technician, Auditor, Insurer, Procurement) are seeded defaults and can be adjusted.
13. Defaults: Executive read-only everywhere including support desk; Store edits location/custody only; Procurement view-only until the PO question is answered; Auditor sees existence/location/condition, not prices (Finance can grant per audit if needed); Technician sees only assets on their work orders, no finance fields.

### Platform requirements (apply to every feature)
14. **Audit:** every create/change/delete of business data and every setting change, with who, when, before/after, reason.
15. **Server-side enforcement** of every permission and field rule, including exports, scan, dashboards and notifications.
16. **Scale:** lists paginated by cursor, indexed filters, tested with the scale seed (50k+ assets).
17. **API-first:** every screen uses the versioned REST API (`/api/v1`) so accounting (e.g. Zoho Books) and other systems can integrate later.
18. **Exports:** every list and report exports to Excel with the same filters and field rules.
19. **Accessibility and mobile:** keyboard-usable, screen-reader labels, works at 375px.

---

## 3. Rules for opencode
- One part at a time, in the order in section 4. After each part: its tests + `npm run typecheck`, then **stop and report** what the owner should click to check it.
- Never rewrite `Assets.tsx`; new UI goes in new files; replace only the lines you must.
- Tests first. Never hand-pick asset codes in tests (`allocateAssetCode` or `createAsset`).
- Vitest: `// @vitest-environment jsdom` per file, never globally.
- Migrations from 034, applied to both databases; grants updated.
- No commits, no branches, no scrap files. Real test numbers only.

## 4. Order
1. **2.6 Permissions** (small, safe).
2. **1 Categories model** (migration, API, tests) + **2.1 Add/edit form** + **2.3 Categories page** + **2.4 / 2.5** clean-ups. Owner checks: an IT member sees only IT categories; an Admin member can add a chair.
3. **2.2 Asset catalog** fixes (photos, filters).
3b. **2.9 Tickets** in three parts, stopping after each: (i) raising: A + D; (ii) receiving: B + E; (iii) SLA and escalation: C.
4. **Locations** usability.
5. **2.7 Sidebar** + **dashboards per role**.
6. **Asset page** layout.

Final gate after each part: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build` (only the 3 known `data-transfers` failures allowed). Update `HANDOFF.md`.
