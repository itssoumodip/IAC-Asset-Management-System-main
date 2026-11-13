# Plan: a dashboard for every role, with its own data

**Written:** 2026-10-31 for opencode. Replaces section 3 of `opencode-plan-review-locations-dashboards.md`.
**Read first:** `HANDOFF.md`, `CLAUDE.md`, `docs/page-map-by-role.md`, `docs/superpowers/plan-categories-and-page-fixes.md` (section 2.10 platform rules).

---

## 1. Principles (industry level)

1. **Own data only.** Every number is computed on the server inside the caller's scope: `assetScope` for assets, team scope for tickets, field permissions for money. A Technician's dashboard can never count another person's work; an Insurer never receives serial numbers.
2. **Every number is clickable.** Each card links to the list it came from with the same filters (e.g. "12 overdue" → `/tickets?view=overdue&team=IT`). Drill-down is how people trust a dashboard.
3. **Same filters everywhere** (top bar): date range (This month / Quarter / Year / Custom), location (path picker, includes everything inside), team (only teams the user may see). Filters persist in the URL.
4. **Switcher for people with several roles** (e.g. Team Lead + Employee): tabs at the top; last choice remembered (localStorage wrapped in try/catch).
5. **Fast:** each dashboard is one API call returning all its cards, < 500 ms at 50k assets (scale seed). Heavy totals use indexed queries; if needed a 5-minute cache per scope key. Show "Updated 2 min ago".
6. **Actionable:** a "Needs your attention" list at the top of every dashboard with the 5 most urgent things for that role, each with a button that does the action.
7. **Export:** every card's data exports to Excel with the same filters and field rules.
8. **Empty states teach:** a new Store person with no stores sees "No stores yet. Ask an administrator to add one in Locations", not zeros.
9. **Accessible charts:** each chart has a table view toggle and text labels; colours never the only signal; works at 375px (cards stack).

## 2. Layout (same frame for all)

```
[ Good morning, Name ]                     [ Role tabs ]   [ Date ] [ Location ] [ Team ]
[ KPI ][ KPI ][ KPI ][ KPI ]                ← 4 headline numbers, each clickable
[ Needs your attention (5 items with action buttons) ]
[ Chart / list ]            [ Chart / list ]
[ Chart / list ]            [ Recent activity ]
```

## 3. Dashboards per role

### 3.1 Organisation (Super Admin)
- **KPIs:** total assets · total purchase value · open tickets (overdue in red) · assets not verified in 90 days
- **Needs attention:** pending change requests, finance reviews older than 7 days, SLA breaches today, users waiting for access, Zoho sync errors
- **Charts:** assets by location (top level, drill into children) · assets by team and status · tickets opened vs closed (weekly) · SLA compliance % by team
- **Lists:** recent audit events (who changed what) · system health (last Zoho sync, email outbox failures, backup date if available)

### 3.2 Executive (CEO)
- **KPIs:** asset value (purchase) · value added this year · % assets in use vs idle in store · SLA compliance %
- **Needs attention:** high-value items unassigned > 30 days, P1 tickets open, warranties/AMCs expiring in 30 days on high-value items
- **Charts:** value by site/building · spend by month and by project/grant · ticket volume trend and customer rating (CSAT) · utilisation by category
- Read-only; no action buttons except "Open".

### 3.3 Finance
- **KPIs:** pending finance review (count, oldest age) · purchase value this year · assets missing cost or invoice · current (depreciated) value *(after depreciation step; until then hidden)*
- **Needs attention:** oldest pending reviews, rejected items waiting for correction, invoices with failed OCR
- **Charts:** purchases by month · value by location · value by category · warranty/AMC expiring next 90 days (count and value)
- **Lists:** latest invoices uploaded; disposals/scrap this year (value written off)

### 3.4 Team (Team Lead and Team Member; Lead sees a few more cards)
- Scope: assets owned by the user's teams (+ shared-view teams for Admin/Projects); tickets routed to their teams.
- **KPIs:** team assets · in store ready to assign · open team tickets (overdue in red) · items awaiting the receiver's confirmation
- **Needs attention:** unassigned team tickets (button: Take it), tickets about to breach SLA, assets Broken/Under repair, returns waiting to be received
- **Charts:** team assets by status · tickets by problem type this month · workload per team member (Lead only)
- **Lists:** recently assigned items · warranty expiring for team items · team members with most open tickets (Lead only)

### 3.5 Store
- Scope: locations of level STORE/RACK the person manages (setting per store; Super Admin assigns), plus items without a location.
- **KPIs:** items in my stores · received this week · issued this week · items waiting to be received (no location)
- **Needs attention:** returns waiting to be received, items without a rack, items in store > 90 days
- **Charts:** stock by store and rack (drill down) · ins/outs per day
- **Lists:** latest movements (in/out/relocate) with who and when

### 3.6 My work (Technician)
- Scope: tickets assigned to me only; assets on those tickets only; no finance fields.
- **KPIs:** assigned to me · overdue · waiting (user/vendor) · resolved this week
- **Needs attention:** tickets nearest to SLA breach (sorted by "fix by")
- **Lists:** my queue (one tap: Start / Waiting / Resolve) · items at the vendor and expected back date · my average fix time and rating this month

### 3.7 Audit (Auditor)
- Scope: assets in the locations/teams assigned to the audit (setting); no prices.
- **KPIs:** to verify this cycle · verified by me this cycle · not found · mismatches (found in the wrong place)
- **Needs attention:** locations not visited this cycle, items not found
- **Charts:** user-confirmed vs auditor-verified (gap report) by location
- **Lists:** my recent scans · discrepancies to resolve
- Verification cycles arrive in step 4; until then show "last verified" data only.

### 3.8 Insurance (Insurer)
- Scope: only Insurer-visible fields (field permissions).
- **KPIs:** insured items · total purchase price · items added this year · repairs this year
- **Charts:** value by location · repairs by category
- **Lists:** high-value items · recent repairs (date, item, repair cost if allowed)
- Export: insurer schedule to Excel.

### 3.9 Procurement (until the PO decision)
- **KPIs:** approved requests waiting to be bought (after the request cart) · items out of stock in the catalog · purchases this month
- Read-only list of recent purchases with supplier and value.

### 3.10 My assets (every employee, also shown to other roles as a tab)
- **KPIs:** items I hold · waiting for my confirmation · my open tickets · my pending requests (after the request cart)
- **Needs attention:** confirm received items (button), answer tickets waiting for me, verification due (step 4)
- **Lists:** my items with photo, code, since date and a **Report a problem** button · my tickets with status and "fix by"

## 4. API

New file `apps/api/src/dashboards.ts` (move the existing `/dashboard/executive` and `/dashboard/team` logic in, keep their URLs):

| Endpoint | Who | Returns |
|---|---|---|
| `GET /dashboards` | any user | the list of dashboards this user may open (drives the tabs) |
| `GET /dashboards/organisation` | Super Admin | 3.1 |
| `GET /dashboards/executive` | Executive, Super Admin | 3.2 |
| `GET /dashboards/finance` | Finance, Super Admin | 3.3 |
| `GET /dashboards/team` | team members | 3.4 (Lead-only cards omitted for members) |
| `GET /dashboards/store` | Store, Super Admin | 3.5 |
| `GET /dashboards/my-work` | Technician | 3.6 |
| `GET /dashboards/audit` | Auditor, Super Admin | 3.7 |
| `GET /dashboards/insurance` | Insurer, Finance, Super Admin | 3.8 |
| `GET /dashboards/procurement` | Procurement, Super Admin | 3.9 |
| `GET /dashboards/me` | any user | 3.10 |

All take `from`, `to`, `locationId`, `teamId` (zod-validated; `locationId` includes the subtree). Each returns:
```ts
{
  updatedAt: string,
  kpis: { key: string; label: string; value: number | null; unit?: 'count' | 'INR' | 'percent'; tone?: 'ok' | 'warn' | 'bad'; link: string }[],
  attention: { key: string; text: string; link: string; action?: { label: string; method: 'POST'; path: string } }[],
  charts: { key: string; title: string; kind: 'bar' | 'line' | 'donut'; rows: { label: string; value: number; link?: string }[] }[],
  lists: { key: string; title: string; rows: Record<string, unknown>[]; link: string }[],
}
```
- Access check via a new policy action per dashboard (e.g. `dashboard.finance`) so roles stay configurable (plan 2.10 rule 12).
- Money values (`INR`) are `null` for callers without finance field rights; the web shows "—".
- Location totals use the recursive subtree query from the locations plan.

## 5. Web

- New file `apps/web/src/components/RoleDashboards.tsx`: the frame (greeting, tabs from `GET /dashboards`, filter bar, KPI row, attention list, chart/list grid) and one small component per dashboard that only maps the API shape to cards. Charts: simple accessible SVG bars/lines (no heavy chart library), each with a "Show as table" toggle.
- `UserDashboard` in `Dashboards.tsx` becomes just `<RoleDashboards />`; keep the existing components until the new ones replace them, then delete the dead code.
- KPI, attention and list links go to existing pages with query filters; add any missing query filters to those pages (e.g. `/tickets?view=overdue`).

## 6. Tests

API integration (one file per group, tests first):
- Each endpoint returns 403 to roles without the dashboard action.
- Scope: a Team Member's numbers exclude other teams' assets; a Technician sees only their tickets; Store counts only their stores; Insurer response contains no serial, warranty, AMC or depreciation keys (check the JSON).
- Money is `null` for roles without finance rights.
- Location filter includes nested places; date filter bounds are inclusive.
- `GET /dashboards` lists exactly the dashboards the user's roles allow.
- Performance: with the scale seed (`npm run seed:scale` or the existing scale-seed command), each endpoint answers in under 500 ms (log the time; fail above 1 s).

Web vitest (`// @vitest-environment jsdom` per file): tabs match `GET /dashboards`; a card links to the right filtered URL; money shows "—" when null; empty state text when a list is empty.

## 7. Order (stop after each and let the owner check in the browser)

1. API frame + `GET /dashboards` + **My assets** (everyone) + **Team**.
2. **Technician (My work)** and **Store**.
3. **Finance** and **Executive**.
4. **Organisation** (Super Admin).
5. **Audit** and **Insurance** and **Procurement** (some cards wait for verification / request cart / PO decision; show "Coming after …" placeholders, never fake numbers).

## 8. Rules for opencode

Same as `plan-categories-and-page-fixes.md` section 3: one part at a time; never rewrite `Assets.tsx`; tests first; no hand-picked asset codes; jsdom per file only; no commits; real test numbers; update `HANDOFF.md` with what the owner should click to check each dashboard.
