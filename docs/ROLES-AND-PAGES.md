# Roles and pages: the complete plan

**Status:** DRAFT v2 for owner approval, 2026-10-31. Base code: commit `46d3a74`.
**Source of truth:** the client requirements spec (sections referred to as "Spec §N") + the Zoho "Asset Management 2.0" screens.
**Rule:** nothing gets built until the owner approves this document. After approval, menu, pages and API permissions must match it exactly. Do not add pages, fields or flows that are not here.

---

## 0. Design rules for every page (no bad UI, nothing irrelevant)

1. **One job per page.** Each page has a clear title, one primary button (top right), and only the fields that role needs. No developer wording ("idempotency", "reference", ids) on screen.
2. **Same building blocks everywhere:** page header (title, short line, primary action) → filter bar → content (cards or table) → empty state that says what to do next.
3. **Lists:** photo/icon, main name in bold, secondary line muted, status as a coloured badge, actions on the right; clicking the row opens the record. Phone width: rows become cards.
4. **Record pages (asset, ticket, product):** Zoho style: header with name + status badges + Edit/⋮ menu, tabs under the header, a right-hand side panel with the key facts.
5. **Forms:** short sections, labels above fields, required fields marked, help text only where needed, errors next to the field. Long forms are split into steps.
6. **Numbers are clickable** (open the list behind them). Every list exports to Excel with the same filters.
7. **Role-correct data only:** fields a role may not see are not sent by the API, and the UI shows nothing in their place (no "hidden" labels, no empty columns).
8. **Phone and tablet first-class:** 375px wide, big tap targets, Scan reachable from every page.
9. **Visual style:** the existing "framed sheet" style (white sheet on soft grey, navy primary, 8px radius, 13–14px body text). No new colours or fonts per page.

---

## 1. Roles (Spec §7)

| # | Role | Who | Can see / do | Spec |
|---|---|---|---|---|
| R1 | **Super Admin** | System owner | Everything, all settings | §7 Admin / Senior Admin |
| R2 | **Executive** | CEO / directors | Everything, read-only | (owner request) |
| R3 | **Finance** | Accounts | Enters and sees purchase cost, purchase date, capitalisation date, depreciation, invoices | §7, §8 |
| R4 | **Team Lead** (IT / Admin / Projects) | Department head | Runs the team's assets, tickets, members; approves transfers and requests for the team | owner decision |
| R5 | **Team Member** (IT / Admin / Projects) | Department staff | Adds and looks after the team's assets; works tickets routed to the team (IT for IT, Admin for facility) | owner decision |
| R6 | **Store** | Store keeper | Receives assets, records store/rack, issues to users, manages stock | §7, §6 |
| R7 | **Technician** | Repair staff (internal or IT) | Only work orders assigned to them (and the assets on them) | §7, §10 |
| R8 | **Auditor** | Any user given audit rights (even a head-office senior) | Verification: scan, mark verified, gap report | §7, §9 |
| R9 | **Insurer** | External insurance contact | Only: asset name, photo, purchase price, purchase date, repair history [OPEN exact list] | §7 |
| R10 | **Procurement** | Buyer | Approved requests to buy, product catalog and stock levels, purchases (PO kept basic) [OPEN PO need] | §7, §11 |
| R11 | **Employee** | Every login | Own items (usage, warranty, serial; **never** price/depreciation), raise requests and complaints, confirm verification | §7, §9, §10 |

**Field-level permissions (Spec §7):** each role's visible and editable asset fields are a **setting** the Super Admin changes on the Field permissions page (P31). Giving someone Finance just to show price is not allowed: give their role the price field instead. Editing a field another role owns creates a **change request** that the owning role approves (P15).

A person may hold several roles; they see all their pages and a dashboard tab per role.

---

## 2. Page list

Legend: ✅ exists at 46d3a74 · 🔧 exists, redesign/changes · 🆕 new. "Spec" = requirement it serves.

### A. Everyone
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P1 | **Dashboard** | `/dashboard` | Role dashboard(s) with tabs (section 4); location filter Zone/Building/Store | 🔧 | §12 |
| P2 | **My assets** | `/my-assets` | Cards: photo, name, code, since date, warranty end; **Confirm received**; **Report a problem**; **Verify my assets** when a verification cycle is open | 🆕 | §7, §9 |
| P3 | **Scan** | top-bar button → `/a/:code` | Camera scan QR / barcode / NFC → asset name, photo, **assigned user**, **expected location (full path)**, status; actions allowed for the role (report problem, receive, verify, open) | 🔧 (add NFC, path) | §4 |
| P4 | **Requests** | `/requests`, `/requests/new` | Catalog cards (image, name, model, In/Out of stock, +) → quantity → **cart** with expected date, remarks → **Create request**; list of my requests with status | 🆕 | §10 |
| P5 | **Support / Work orders** | `/tickets`, `/tickets/new`, `/tickets/:id` | Raise a complaint from an item or a place; follow status; reply; confirm fixed. Team/technician side in P12 | 🔧 | §10 |
| P6 | Notifications | `/notifications` | Inbox | ✅ | |
| P7 | Profile & security | `/profile`, `/security` | Own account, MFA | ✅ | |

### B. Assets
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P8 | **Asset catalog** | `/assets` | Zoho-style list: photo, **Asset ID + name/model**, brand, category, subcategory, barcode/QR, owned by / held by, status. Search; filters: status, category, subcategory, **location (path)**, team, project. "+ Add asset". Export. Everyone in R1–R8, R10 sees **all assets**; fields shown follow field permissions; Insurer sees insured items with their fields only | 🔧 | §3, §7, §12 |
| P9 | **Asset page** | `/assets/:id` | **Zoho layout** (section 3) | 🔧 | §5, §8, §10 |
| P10 | **Add asset (2 steps)** | `/assets/new` | **Step 1 Details:** owning team → category → subcategory (team's own only), name, brand, model, serial, product (from catalog, optional), location (path picker), project/grant, warranty end + extension, AMC (yes/expiry), photo. **Step 2 Purchase & invoice:** upload invoice (PDF/photo) → **auto-fill** supplier, invoice no., date, amount (OCR, user checks before saving), purchase date, purchase cost. Finance fields editable only by roles allowed; others can attach the invoice and Finance completes it. "Save and add another". | 🔧 (invoice step new) | §8, §13 |
| P11 | Edit asset | `/assets/:id/edit` | Same sections as P10, only fields the role may edit; protected fields → "Request change" | 🔧 | §7 |
| P12 | **Work orders (team / technician)** | `/tickets?view=…` | Queue tabs: Unassigned · Mine · Team · Overdue · Waiting · Resolved; Take it; assign technician; statuses; asset panel; work log, parts, repair cost; resolution; requester notified | 🔧 | §10 |
| P13 | **Assign / transfer / return** | `/assets/:id/assign` | Choose person (search) or unit/room; note. **Transfer needs approval** (Team Lead) **and receiver confirmation**; return to store records it; reissue recorded in history | 🔧 (approval new) | §5 |
| P14 | Print labels | `/assets/labels` | QR/barcode labels | ✅ | §4 |

### C. Approvals
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P15 | **Approvals** | `/approvals` | One inbox with tabs: **Requests** (approve/reject per item), **Transfers** (approve before receiver confirms), **Change requests** (field overwrites by another role), **Verification escalations**. Each row: who, what, when, before→after, Approve / Reject with reason | 🆕 | §5, §7, §9, §10 |

### D. Store and inventory
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P16 | **Inventory** | `/inventory` | Tabs **Products · Spares · Used spares** (Zoho). Products list: image, product, brand, category, subcategory, vendors, **status In/Out of stock**, **total stock** (= assets of that product In Store/Ready to Assign), in use, total. Filter by stock level. "+ Add product". Click → product page with every asset of that product and where each is | 🆕 | §11 |
| P17 | **Store** | `/store` | **Receive** (scan/select asset → choose Store/Rack path → saved), **Issue** to a user, **Returns** waiting; stock by store → rack with count, purchase value, current value (value only for allowed roles) | 🆕 | §6 |
| P18 | **Locations** | `/locations` | Tree Site › Zone › Building › Floor › Unit/Room › Store › Rack (levels configurable); each node: assets count, purchase value, current value, "View assets"; Unit view shows its furniture and history (§5 furniture-in-units). Super Admin edits; others view | 🆕 | §2, §5, §6 |

### E. Maintenance and verification
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P19 | **Preventive maintenance** | `/maintenance` | Views **Ongoing · Pending · Upcoming · Completed · All**; columns Maintenance ID, date, Asset ID, asset name, type, start date, assigned to; schedules per asset or per subcategory (every 6 / 12 months), next due computed, reminders | 🆕 | §10 |
| P20 | **Verification** | `/verification` | **Auditor mode:** pick a location, scan items, mark found / not found / wrong place. **Cycles:** start a user verification cycle (every 3/6 months), see who confirmed, escalations to superiors. **Gap view:** user-verified vs auditor-verified with pending counts and filters | 🆕 | §9 |

### F. Finance and reports
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P21 | **Finance review** | `/finance` | Items waiting for cost/invoice; invoice upload with auto-read; approve/reject | ✅ | §8, §13 |
| P22 | **Depreciation** | `/depreciation` | Per asset: purchase date, **capitalisation date (auto at first assignment, locked)**, method, rate, current value, depreciated value; run by period; Companies Act and Income Tax views [OPEN methods/rates] | 🆕 | §8 |
| P23 | **Reports** | `/reports` | Fixed asset register (Companies Act format), depreciation, verification (user vs auditor), assets by location, insurer schedule, maintenance, warranty/AMC expiry, tickets and response times. Each with filters and **Excel export** | 🆕 | §8, §9, §12 |
| P24 | **Insurance view** | `/insurance` | Insurer-only list: asset name, photo, purchase price, purchase date, repair history; totals by location; export | 🆕 | §7 |
| P25 | **Procurement** | `/procurement` | Approved requests to buy, out-of-stock products, basic purchase record (supplier, date, qty, amount) [OPEN full PO] | 🆕 | §11 |

### G. Administration (Super Admin)
| # | Page | Path | Contents and actions | State | Spec |
|---|---|---|---|---|---|
| P26 | People & access | `/admin/users` | Users, roles, team membership | ✅ | §7 |
| P27 | Directory & Zoho | `/admin/directory` | Zoho People sync, link accounts | ✅ | |
| P28 | Teams & projects | `/admin/teams` | Teams, code prefixes, projects/grants | 🔧 | |
| P29 | **Categories** | `/admin/categories` | Category → subcategories; which team owns each category; who handles its problems; the 5 client groups seeded (Heavy machinery, Furniture, IT, Outdoor, Mobility) | 🆕 | §3 |
| P30 | Master control | `/master-control` | Other lists: statuses (Active, Ready to Assign, In Use, In Store, Scrapped, Broken…), conditions, location levels, ticket problem types, SLA times | 🔧 | §5 |
| P31 | **Field permissions & roles** | `/admin/roles` | Per role: which asset fields are visible / editable; which pages; Insurer list adjustable | 🆕 | §7 |
| P32 | Import review | `/admin/imports` | Bulk import from Excel | ✅ | §1 |
| P33 | Announcements | `/admin/announcements` | Notices | ✅ | |
| P34 | Audit trail | `/admin/audit` | Every change: who, what, when, before→after | ✅ | §14 |

**Total: 34 pages** (14 exist as they are or with small changes, 20 new or redesigned).

---

## 3. Asset page in detail (P9, Zoho parity + client additions)

**Header:** ‹ Asset ID · name + model (e.g. "iPhone 17 Pro Max") · status badges (e.g. Active, Ready to Assign) · **Edit** · ⋮ (Assign/Transfer, Return, Receive into store, Print label, Report a problem, Scrap/Mark broken). Buttons only if the role may do them.

**Tabs:**
1. **Summary:** Work orders (open; empty: "No work order found…"), Recent maintenance (+ add), **Depreciation** box: Purchased cost, Current value, Depreciated value, Depreciation %, End of life, Expense cost (only roles with these fields).
2. **Product details:** all fields the role may see, two columns, grouped (Identity · Location · Purchase · Warranty & AMC · Other).
3. **Work orders:** all, open and closed.
4. **Maintenance:** schedule, next due, history.
5. **Asset users:** everyone who held it (name, from, to, how it ended).
6. **History:** every event: created, assigned, transferred, returned, received into store, moved (old → new location), repaired, verified (by user / by auditor), status changes, scrapped.

**Right panel:** barcode / QR with the code under it; Serial number, Product, Model, Category, Subcategory, **Location path**, Tags (QR/NFC/RFID); **Current user** card (photo, name, role/department) or "In store at Rack 3" or "In Flat 3B".

---

## 4. Dashboards (P1), each with its own data (Spec §12)

All dashboards: 4 headline numbers (clickable), "Needs your attention" (top 5 with action buttons), charts/lists, **location filter (Zone / Building / Store)**, date filter. Values only for roles allowed to see money.

| Role | Headline numbers | Needs your attention | Charts / lists |
|---|---|---|---|
| Super Admin | assets · purchase value · current value · open work orders | change requests, transfers to approve, overdue work orders, verification escalations, sync errors | per zone/building/store: types, counts, purchase and current value; tickets trend |
| Executive | purchase value · current value · % in use vs in store · SLA % | high-value idle items, critical tickets, expiring warranties | value by site/building, spend by month, utilisation by category |
| Finance | waiting for review · purchases this year · current value · missing invoice/cost | oldest reviews, assets missing capitalisation | purchases by month, value by location/category, depreciation this period |
| Team Lead | team assets · ready to assign · open team work orders · waiting approval | requests and transfers to approve, tickets near deadline | team assets by status, workload per member |
| Team Member | team assets · ready to assign · my open work orders · items to confirm | unassigned tickets (Take it), broken items | tickets by type, recently assigned |
| Store | in my stores · received this week · issued this week · without location | returns to receive, items without rack, out-of-stock products | stock by store → rack, movements |
| Technician | assigned to me · overdue · waiting · done this week | nearest deadlines | my queue, items at vendor |
| Auditor | to verify · verified by me · not found · wrong place | locations not visited this cycle | user-verified vs auditor-verified by location |
| Insurer | insured items · total purchase price · repairs this year | — | value by location, recent repairs |
| Procurement | approved requests to buy · out-of-stock products · purchases this month | requests waiting longest | stock levels by product |
| Employee | items I hold · to confirm · open complaints · open requests | confirm received items, verify my assets, replies waiting | my items with Report a problem |

---

## 5. Who sees which page

✓ full · V view only · O own team / own records · — none

| Page | SA | Exec | Fin | Lead | Member | Store | Tech | Audit | Insurer | Proc | Emp |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| P2 My assets | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| P3 Scan | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| P4 Requests | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| P5 Support (raise/follow) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| P8 Asset catalog | ✓ | V | V | ✓ (edit own) | ✓ (edit own) | V | O (on my tickets) | V | V (own fields) | V | — |
| P9 Asset page | ✓ | V | V+finance | ✓ own | ✓ own | V+receive | O | V | V (own fields) | V | O (my items) |
| P10–P11 Add/edit | ✓ | — | finance fields | own team | own team | location only | — | — | — | — | — |
| P12 Work orders queue | ✓ | V | — | O | O | — | O (mine) | — | — | — | — |
| P13 Assign/transfer | ✓ | — | — | O + approve | O | issue/return | — | — | — | — | confirm |
| P14 Labels | ✓ | — | — | O | O | ✓ | — | — | — | — | — |
| P15 Approvals | ✓ | — | finance fields | O | — | — | — | — | — | — | — |
| P16 Inventory | ✓ | V | V | ✓ | ✓ | ✓ | — | V | — | ✓ | — |
| P17 Store | ✓ | V | — | O | O | ✓ | — | — | — | — | — |
| P18 Locations | ✓ | V | V | V | V | V | — | V | — | — | — |
| P19 Maintenance | ✓ | V | — | O | O | — | O | — | — | — | — |
| P20 Verification | ✓ | V | — | O | — | — | — | ✓ | — | — | own items |
| P21 Finance review | ✓ | V | ✓ | — | — | — | — | — | — | — | — |
| P22 Depreciation | ✓ | V | ✓ | — | — | — | — | — | — | — | — |
| P23 Reports | ✓ | ✓ | ✓ | O | — | stock | — | verification | insurer | procurement | — |
| P24 Insurance view | ✓ | V | ✓ | — | — | — | — | — | ✓ | — | — |
| P25 Procurement | ✓ | V | V | V | — | V | — | — | — | ✓ | — |
| P26–P34 Admin | ✓ | — | — | — | — | — | — | Audit trail V | — | — | — |
| P6–P7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## 6. Menu

- **Workspace:** Dashboard · My assets · Requests · Support · Notifications
- **Assets:** Asset catalog · Work orders · Approvals · Print labels
- **Inventory & store:** Inventory · Store · Locations
- **Maintenance & audit:** Maintenance · Verification
- **Finance & reports:** Finance review · Depreciation · Reports · Insurance · Procurement
- **Administration:** People & access · Directory & Zoho · Teams & projects · Categories · Field permissions & roles · Master control · Import review · Announcements · Audit trail
- **Top bar (every page):** Scan · profile menu

---

## 7. Build phases (after approval)

| Phase | Pages | Why first |
|---|---|---|
| 1 Foundation | P29 Categories, P18 Locations, P30 statuses, P31 roles & field permissions, P3 Scan (path, NFC) | Everything else depends on these |
| 2 Daily asset work | P8 catalog, P9 asset page, P10–P11 add/edit with invoice step, P13 transfers with approval, P2 My assets, P15 Approvals | What users touch every day |
| 3 Store & inventory | P16 Inventory, P17 Store, P4 Requests, P25 Procurement (basic) | Stock and requests |
| 4 Work orders & maintenance | P5, P12, P19 | Complaints and preventive maintenance |
| 5 Verification | P20 | Audit cycles |
| 6 Finance | P22 Depreciation, P23 Reports, P24 Insurance, P21 updates | Needs client answers |
| 7 Dashboards | P1 for every role | Uses data from all phases (simple versions earlier, full here) |

---

## 8. Open questions for the client (Spec [OPEN] items)

1. Exact Insurer fields (§7).
2. Depreciation methods (SLM/WDV), rates, register format (§8).
3. Native branded app at launch, or is the installable web app enough (§4)?
4. Any PO feature needed beyond the basic purchase record (§11)?
5. Escalation rule when a user does not confirm verification: who, after how many days (§9)?
6. Verification cycle: every 3 or 6 months (§9)?

## 9. Owner decisions (internal)

1. Team members fix things themselves, or a separate Technician role, or both? (Draft: both: IT/Admin members work their team's queue; Technician role for repair staff who see only assigned work.)
2. Should Store be a separate person, or Team Members do store work? (Draft: separate role; Team Members can also receive.)
3. Can the Auditor see purchase price? (Draft: no.)
4. Employees see only My assets, not the full catalog? (Draft: yes.)

## 10. Before any building starts

- The databases are at migration **034**; this code (46d3a74) only knows up to **027**. Roll the databases back to 027 first (or restore the matching code).
- Commit this document so a reset does not delete it.
