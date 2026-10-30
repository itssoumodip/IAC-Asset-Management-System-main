# Zoho People Sync, Asset Kits and Ticket Routing — Design (Sub-projects B, C, D)

Date: 2026-10-29 · Status: Approved by user in chat · Builds on sub-project A (roles, teams, ownership).

## B. Zoho People directory sync

Decisions: directory only (no automatic logins); exited holders are flagged for asset recovery; nightly sync plus a Super Admin "Sync now"; Zoho India data centre.

- **Directory people.** New user state `DIRECTORY`: a person who exists for custody but cannot sign in (sessions/login only accept `ACTIVE`). Directory users get the `EMPLOYEE` role so all existing assign/return/transfer code works. New columns on `users`: `zoho_record_id` (unique), `employee_code`, `manager_name`, `zoho_status`, `left_at`, `zoho_synced_at`.
- **Eligibility.** Assignment accepts `ACTIVE` accepted employees (as today) **and** `DIRECTORY` users who have not left. No custody email is sent to directory users (they have no portal); handover still records history.
- **Matching.** A Zoho record matches an existing user by `zoho_record_id`, else by lower-cased email. A match never changes an existing account's state, roles or password; it only fills directory fields. No match → create a `DIRECTORY` user. Departments are matched case-insensitively by name or created (code derived from the name, made unique).
- **Photos.** Each Zoho profile photo is downloaded during sync, resized and stripped of metadata by the existing image pipeline, and stored privately (`user_photos`). Shown as avatars (initials when absent). Unchanged photos are not re-downloaded; a failed photo never fails the run.
- **Manual link and matching report.** Super Admins can link a portal account to a Zoho employee (`POST /directory/link`) when emails differ, e.g. an office mailbox; later syncs keep them joined by record id. A matching report lists Zoho people without an account and accounts without a Zoho match.
- **Exits.** Zoho status other than Active (e.g. Resigned, Terminated, Inactive) sets `left_at` (once) and, for `DIRECTORY` users, keeps them non-eligible. Assets they still hold appear in a **To recover** list (`GET /directory/recover`), and a single digest email listing them goes to Super Admins through the existing outbox when new leavers with assets are found. Nothing is auto-returned. `ACTIVE` portal users who left are not disabled automatically; the digest says so.
- **Zoho API.** OAuth refresh-token flow against `https://accounts.zoho.in/oauth/v2/token`; employee records from `https://people.zoho.in/people/api/forms/employee/getRecords` paged by 200. Config in `.env`: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, optional `ZOHO_DC` (default `in`). Field names are mapped in one place (`EmployeeID`, `FirstName`, `LastName`, `EmailID`, `Department`, `Designation`, `Employeestatus`, `Reporting_To`, record id). Missing config → sync is disabled and the UI says so; nothing crashes.
- **Runs.** `zoho_sync_runs` table records start/finish, counts (created/updated/left/skipped), and error text. The worker runs a sync nightly (02:00 Asia/Kolkata) when configured; `POST /directory/sync` (Super Admin) starts one now; only one run at a time (advisory lock). `GET /directory/sync` returns status and the last runs.
- **UI.** Super Admin page **Directory & Zoho** (`/admin/directory`): status, Sync now, last runs, To recover list. People & access shows directory people with a "No login" badge and an Invite action (existing invite flow turns `DIRECTORY` into `INVITED`).

## C. Asset kits

Decision: parts move together.

- `assets.parent_asset_id` (nullable FK to assets). A part's parent must not itself be a part (one level). Parent and part must have the same owning team.
- **Attach** `POST /assets/:id/kit` `{partAssetId, reason}` (asset.custody for the team): part must be unassigned or held by the same person as the parent, and not terminal. **Detach** `DELETE /assets/:id/kit/:partId` `{reason}`. Both audited (`KIT_PART_ATTACHED` / `KIT_PART_DETACHED`).
- **Moving together.** Assign, reassign/transfer and return of a parent apply the same change to every attached part in the same transaction (each part gets its own assignment row and movement record). Assigning, transferring or returning a part directly while attached → 409 "This item is part of kit IAC-…; detach it first".
- Asset detail returns `kitParts` (code, description, type) and `kitParent` (id, code). UI: **Kit** panel on the asset page with Attach (by asset code) and Detach.

## D. Ticket routing by team

Decision: asset tickets go to the asset's owning team; others by category mapping.

- `tickets.team_id` (NOT NULL after backfill; existing tickets → IT). New table `ticket_category_teams(category_code PK → TICKET_CATEGORY, team_id)`; unmapped categories route to IT.
- On create: `team_id` = asset's owning team if an asset is linked, else the category's mapped team, else IT.
- **Queues.** Ticket read/work scope for team users becomes their teams' tickets plus tickets they reported; Super Admin sees all. `ticket.work` actions (owner, status, internal notes) require membership of the ticket's team (or Super Admin). Owner candidates must be members of that team or Super Admins.
- **Routing changes.** Super Admin or a Lead of the current team can move a ticket to another team (`PATCH /tickets/:id/team` `{teamId, reason}`), audited.
- **Notifications.** New-ticket emails go to verified members of the routed team (plus the existing ADMIN group behaviour for Super Admins).
- **UI.** Ticket list shows a Team column and a team filter; staff see their teams' queue. Master Control → Teams & projects page gets a **Ticket categories** section mapping each category to a team.

## Testing

Each sub-project adds integration tests for its rules (sync mapping/exit flagging with a stubbed Zoho HTTP client; kit cascade on assign/return and part-direct-assign 409; routing on create, team-scoped queues, cross-team work denial) plus focused web tests. Migrations: B = 019, C = 020, D = 021.

## E. Finance review and invoices

Decisions: local OCR only (nothing is sent to an outside AI); assets are usable before approval but flagged.

- **States.** `assets.finance_status`: `PENDING` (default for new assets; existing `finance_pending=true` rows map to PENDING, others to APPROVED), `APPROVED`, `REJECTED` (with reason; the owning team fixes and resubmits → PENDING). `finance_pending` stays in sync for existing code and reports. Assignment is never blocked by finance status; the asset shows a "Pending Finance" badge.
- **Invoices.** `invoices` table (file stored privately in Postgres like asset photos: PDF/JPEG/PNG up to 10 MiB, sha256, uploaded_by, extracted_text, extracted_fields jsonb) linked to one or more assets (`invoice_assets`). Upload by the owning team or Finance; download by anyone who can see the asset's private columns.
- **Local extraction.** PDFs with a text layer: text via a PDF parser; images and scanned PDFs: OCR with Tesseract running on the server (language data shipped with the app, no network calls at run time). A rule-based extractor proposes `supplier`, `invoiceNumber`, `invoiceDate` (→ purchaseDate), `totalAmount` (→ purchaseCost), `gstin`, with a confidence per field. Extraction runs in the worker (OCR is slow) and the UI shows "Reading invoice…" until done.
- **Review queue.** Finance page `/finance` lists PENDING assets (filter by team/project), shows the invoice preview side by side with the proposed fields pre-filled into the finance form; Finance corrects, then **Approve** (writes the finance fields, sets APPROVED, audited `FINANCE_APPROVED`) or **Reject** with a reason (audited, team notified by email).
- **Permissions.** Approve/reject/edit finance fields: `asset.finance_edit`. Upload: `asset.edit` for the owning team or `asset.finance_edit`.

## F. Executive dashboard and UI polish

- **Greeting.** Signed-in home shows "Good morning / afternoon / evening, <first name>" (Asia/Kolkata time) with today's date and a one-line summary of what needs the user's attention.
- **Executive / Super Admin dashboard** (`report.view`): (1) assets by team and by status (counts and purchase value; bar + pie), (2) Needs attention: Pending Finance count, holders who left with assets (to recover), warranty/AMC expiring in 30 days, open HIGH-priority tickets, (3) spend by project/grant and by financial year (April–March), (4) ticket trends per team over 12 weeks (opened vs completed, median resolution time). Each tile links to the filtered list.
- **Scale.** All dashboard numbers come from single aggregate SQL queries with indexes; lists stay cursor-paginated; verify with a 50,000-asset synthetic seed (`npm run seed:scale`, test DB only) that the dashboard and catalog first page respond under 1 s locally.
- **Style.** Follows the existing taste-skill "framed sheet" direction (.taste-skill/direction.json tokens); charts use its chart colours.
