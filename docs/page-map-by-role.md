# Page map: which pages each role gets

**Status:** draft for owner approval (2026-10-31). Once approved, build to match this; the menu and the API must agree with it.

Legend: ✅ exists today · 🆕 to build · ⏳ later phase (needs client answers or a later step). "Own" means only their own team / their own items.

## 1. Roles

| Role | Who | Notes |
|---|---|---|
| Super Admin | System owner | Everything |
| Executive (CEO) | Leadership | Sees everything, changes nothing |
| Finance | Accounts | Cost, invoices, depreciation; no custody changes |
| Team Lead (IT / Admin / Projects) | Head of a department team | Runs their team's assets and members |
| Team Member (IT / Admin / Projects) | Department staff | Adds and looks after their team's assets |
| Store | Store keeper | Receives, shelves and issues items |
| Technician | Repair staff | Only work orders assigned to them |
| Auditor | Physical verifier (can be any senior person) | Scans and verifies, read-only otherwise |
| Insurer | External insurance contact | Name, photo, price, purchase date, repair history only |
| Procurement | Buyer | Purchase views only (client may keep Zoho PO) |
| Employee | Everyone with a login | Their own items and requests |

A person can hold several roles (e.g. Team Lead + Employee). They see the union of pages, and a dashboard switcher.

## 2. Page list

| # | Page | Path | Purpose | State |
|---|---|---|---|---|
| 1 | Dashboard | `/dashboard` | Role dashboard(s) with a switcher | ✅ partly (see 3) |
| 2 | My assets | `/my-assets` | Items I hold, confirm receipt, report a problem | 🆕 (today inside the employee dashboard and `/assets`) |
| 3 | Asset catalog | `/assets` | Search and filter assets | ✅ |
| 4 | Asset page | `/assets/:id` | Tabs: Summary, Details, Work orders, Maintenance, Users, History | ✅ partly |
| 5 | Add / edit asset | `/assets/new`, `/assets/:id/edit` | Create and edit | ✅ |
| 6 | Assign / transfer | `/assets/:id/assign` | Hand over custody | ✅ |
| 7 | Scan | `/a/:assetCode` + scan button | QR / barcode / NFC lookup | ✅ |
| 8 | Print labels | `/assets/labels` | QR labels | ✅ |
| 9 | Support desk (work orders) | `/tickets` | Raise and work on problems | ✅ |
| 10 | My work | `/my-work` | Technician's assigned work orders | 🆕 |
| 11 | Requests | `/requests` | Ask for items (catalog + cart) | ⏳ step 5 |
| 12 | Approvals | `/approvals` | Approve requests, transfers, change requests | 🆕 (change requests exist at `/admin/change-requests`; requests and transfers come later) |
| 13 | Store | `/store` | Receive into store, what's on each store/rack, issue | 🆕 (receiving exists inside the asset page) |
| 14 | Verification | `/verification` | Auditor scan mode; users confirm their items | ⏳ step 4 |
| 15 | Maintenance | `/maintenance` | Preventive schedules, due list | ⏳ step 6 |
| 16 | Finance review | `/finance` | Invoices, cost, approve/reject | ✅ |
| 17 | Reports | `/reports` | Register, depreciation, verification, by location, insurer view, warranty; all to Excel | 🆕 (exports exist per page; depreciation ⏳ step 7) |
| 18 | Insurance view | `/insurance` | Insurer-only list and totals | 🆕 |
| 19 | Notifications | `/notifications` | Inbox | ✅ |
| 20 | Profile / security | `/profile`, `/security` | Own account, MFA | ✅ |
| 21 | My team | `/team/:teamId` | Members of my team | ✅ |
| 22 | Announcements | `/admin/announcements` | Send notices | ✅ |
| 23 | Locations | `/admin/locations` | Location tree | ✅ (needs usability fixes) |
| 24 | Master control | `/master-control` | Categories, types, statuses, ticket routing | ✅ |
| 25 | Teams & projects | `/admin/teams` | Teams, prefixes, projects/grants | ✅ |
| 26 | People & access | `/admin/users` | Users, roles, teams | ✅ |
| 27 | Directory & Zoho | `/admin/directory` | Zoho People sync | ✅ |
| 28 | Field permissions | `/admin/field-permissions` | Which fields each role sees | ✅ (Insurer list ⏳ client) |
| 29 | Import review | `/admin/imports` | Bulk import | ✅ |
| 30 | Audit trail | `/admin/audit` | Who changed what | ✅ |

## 3. Pages per role

| Page | Super Admin | Executive | Finance | Team Lead | Team Member | Store | Technician | Auditor | Insurer | Procurement | Employee |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard (their own kind) | Organisation | Executive | Finance | Team | Team | Store | My work | Audit | Insurance | Procurement | My assets |
| My assets | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Asset catalog | all | all (view) | all (view) | own team (+ shared) | own team (+ shared) | all (view) | only assets on their work orders | all (view) | insured items, limited fields | all (view) | — |
| Asset page | full | view | view + finance | own team full | own team | view + receive | view, no finance | view, no finance | limited fields | view | own items |
| Add / edit asset | ✅ | — | finance fields only | own team | own team | — | — | — | — | — | — |
| Assign / transfer | ✅ | — | — | own team | own team | ✅ | — | — | — | — | — |
| Scan | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Print labels | ✅ | — | — | own team | own team | ✅ | — | — | — | — | — |
| Support desk | all | view | — | own team queue | own team queue | — | assigned only | — | — | — | raise + own |
| My work | — | — | — | — | — | — | ✅ | — | — | — | — |
| Requests ⏳ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Approvals | all | — | finance items | own team | — | — | — | — | — | — | — |
| Store | ✅ | — | — | own team | own team | ✅ | — | — | — | — | — |
| Verification ⏳ | ✅ | view | — | own team | — | — | — | ✅ | — | — | confirm own |
| Maintenance ⏳ | ✅ | view | — | own team | own team | — | assigned | — | — | — | — |
| Finance review | ✅ | view | ✅ | — | — | — | — | — | — | — | — |
| Reports | all | all | finance + register | own team | — | store | — | verification | insurer report | purchase | — |
| Insurance view | ✅ | — | ✅ | — | — | — | — | — | ✅ | — | — |
| Notifications, Profile | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| My team | all teams | — | — | ✅ (manage) | view | — | — | — | — | — | — |
| Announcements | ✅ | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Locations, Master control, Teams & projects, People & access, Directory & Zoho, Field permissions, Import review, Audit trail | ✅ | — | — | — | — | — | — | Audit trail (view) | — | — | — |

**Page count by role** (menu items, not counting login screens): Super Admin 26 · Executive 12 · Finance 11 · Team Lead 15 · Team Member 12 · Store 10 · Technician 8 · Auditor 10 · Insurer 5 · Procurement 8 · Employee 7.

## 4. Menu layout

Same sidebar for everyone, with only allowed items shown:

- **Workspace:** Dashboard · My assets · Asset catalog · Scan · Support desk / My work · Requests · Approvals · Notifications
- **Operations:** Store · Verification · Maintenance · Print labels · My team
- **Finance & reports:** Finance review · Reports · Insurance view
- **Administration (Super Admin):** Locations · Master control · Teams & projects · People & access · Directory & Zoho · Field permissions · Import review · Audit trail · Announcements

## 5. Problems found in today's permissions (fix with this map)

1. `asset.view_private` includes **Technician** and **Auditor** (`apps/api/src/policy.ts`). That lets them see finance fields. The client said technicians see only their work orders. Remove both, unless the owner decides otherwise.
2. `report.view` no longer includes **Finance**, so Finance lost the reports dashboard. Add it back.
3. The new roles (Store, Technician, Auditor, Insurer, Procurement) land on the plain employee dashboard; each needs its own (section 3 of `docs/superpowers/opencode-plan-review-locations-dashboards.md`).

## 6. Owner decisions needed

1. Should Executive see the Support desk and Announcements? (Marked yes/view above.)
2. Can Store edit an asset's location only, or other fields too? (Marked: receive and issue only.)
3. Does Procurement need anything beyond viewing until the client answers the PO question? (Marked: view only.)
4. Can an Auditor see purchase price? (Marked: no.)
