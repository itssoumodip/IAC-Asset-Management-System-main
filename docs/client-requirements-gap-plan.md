# Client requirements: gap analysis and build plan

Source: client spec (Zoho "Asset Management 2.0" demo comparison). Checked against the current codebase on 2026-10-30.

**Short answer:** about 45% already exists. About 40% can be built on what we have in roughly 8 to 10 weeks of work. About 15% depends on client answers (open questions) or is later-phase (RFID, native app, accounting API).

## 1. Gap checklist

| # | Requirement | Status | What we have today |
|---|---|---|---|
| 1 | Barcode/QR scan shows asset, assigned user, expected location | **Exists** | Scan page, QR/barcode labels, asset detail with holder and location |
| 2 | NFC; RFID-ready identifiers | **Missing** | One `barcode` field per asset. Needs an identifiers table (type + value) |
| 3 | Location hierarchy (Zone/Building/Floor/Unit/Store/Rack) + per-location summaries | **Partial** | Flat locations: site, building, floor, room. No zones, stores, racks, or tree |
| 4 | Field-level permissions, configurable per role (incl. Insurer) | **Partial** | Finance fields hidden from non-finance (server-side). Fixed in code, not configurable. No Insurer, Store, Auditor, Technician or Procurement roles |
| 5 | Approval workflow for overwriting another role's data | **Missing** | Edits are audited with a reason, but not approved |
| 6 | Transfer approval + receiving-user confirmation | **Partial** | Receiver confirms (pending verification). No approver step before transfer |
| 7 | Depreciation starts at first assignment, never restarts | **Missing** | Method and useful life stored; no calculation, no auto start date |
| 8 | Purchase date vs capitalisation (first-use) date | **Partial** | Purchase date exists; first-use date does not |
| 9 | Companies Act / Income Tax depreciation + register export | **Missing** | Needs client answers on methods, rates, format |
| 10 | User periodic verification (email, confirm, escalation) | **Partial** | Employee confirms on assignment only. No periodic cycle or escalation |
| 11 | Auditor verification + user-vs-auditor gap report | **Partial** | `last_audit_date` field only. No auditor scan flow or report |
| 12 | Unit-level furniture tracking with history | **Partial** | Movement and assignment history exist; needs Unit level from item 3 |
| 13 | Scrap / Broken statuses | **Partial** | Retired, Disposed, Under Repair, Lost, Stolen exist. Add Scrapped, Broken, Ready to Assign, In Use |
| 14 | Preventive maintenance, warranty alerts, complaints/work orders | **Partial** | Tickets with team routing, warranty and AMC expiry dates, AMC expiry on dashboard. No PM schedules, no technician assignment, no expiry emails |
| 15 | Location-filtered dashboard | **Partial** | Executive and team dashboards exist; no location filters or value-by-location |
| 16 | Mobile-friendly / branded app | **Exists** (web) | Responsive PWA, installable with logo. Native store apps not built |
| 17 | Excel exports for all reports | **Partial** | Excel/CSV export for assets and people; new reports need exports |
| — | Invoice OCR auto-fill | **Exists** | Finance review with invoice upload and local OCR |
| — | Requests catalog with cart | **Missing** | Not built |
| — | Inventory (Products, Spares, Used Spares, stock) | **Missing** | Not built |
| — | Procurement / PO | **Missing** | Client said skip; confirm |
| — | Full audit trail | **Exists** | Every change audited with who, when, reason |
| — | Server-side access control | **Exists** | Policy module enforces on the API |
| — | REST API for future accounting link | **Exists** | Versioned REST API (`/api/v1`) |

## 2. Build plan (phases)

Each phase ends with tests passing and a demo.

### Phase 1: Foundation (about 2 to 3 weeks)
1. **Location hierarchy.** Tree table (parent, level type, code, name). Admin configures levels: Site, Zone, Building, Floor, Unit/Room, Store, Rack. Migrate current flat locations into the tree.
2. **Statuses.** Add Ready to Assign, In Use, Scrapped, Broken. Map old ones.
3. **Categories and subcategories.** Already admin-configurable; add the five client groups as seed data.
4. **Identifiers.** Table of identifiers per asset (QR, Barcode, NFC, RFID later). Scan looks up any type.
5. **Store receiving.** Store person receives an asset and records its rack/store location; scan shows where it is in the store.

### Phase 2: Roles and field-level permissions (about 2 weeks)
1. New roles: Store, Auditor, Technician, Insurer, Procurement (view only).
2. **Field visibility matrix** set by Admin in Master Control: per role, which asset fields are visible and editable. Enforced on the API (list, detail, export), not just hidden in the UI.
3. Insurer default: name, photo, purchase price, purchase date, repair history only.
4. **Override approval.** Editing a field owned by another role creates a change request; the owning role approves or rejects it; the audit trail records both.

### Phase 3: Depreciation and register (about 2 weeks, after client answers)
1. Capitalisation date set automatically at the first assignment, locked afterwards.
2. Nightly depreciation calculation (SLM and WDV, rates per category). No depreciation while never issued.
3. Asset Summary tab: purchase cost, current value, depreciated value, depreciation %, end-of-life date (finance roles only).
4. Fixed asset register export in Companies Act format; Income Tax block view.

### Phase 4: Verification and audit (about 1.5 weeks)
1. **User verification cycles** (every 3 or 6 months): email + in-app list "confirm the assets you hold"; reminders; escalation to their manager (Zoho manager link already exists).
2. **Auditor scan mode:** scan items, each marked verified by auditor + date.
3. **Gap report:** user-verified vs auditor-verified, pending counts, filters, Excel export.

### Phase 5: Transfers, maintenance, dashboards (about 2 weeks)
1. Transfer approval step before the receiver confirms.
2. **Preventive maintenance** schedules per asset/type, next due date, reminders; views Ongoing / Pending / Upcoming / Completed.
3. Tickets get "assigned technician"; technicians see only their work orders.
4. Warranty and AMC expiry emails to the holder a few days before.
5. **Location dashboard:** filter by zone/building/store; counts, purchase value, depreciated value per location; Excel export of every report.

### Later (not in this plan)
- Requests catalog with cart, Inventory/Spares, Procurement/PO (confirm need first; client uses Zoho PO).
- RFID readers, native App Store / Play Store apps (PWA covers mobile now).
- Accounting API link (Zoho Books).

## 3. Questions to ask the client before Phase 3

1. Exact fields the Insurer may see.
2. Depreciation methods (SLM/WDV), rates, and the register format (Companies Act, Income Tax).
3. Native branded app at launch, or is the installable web app enough?
4. Is invoice OCR needed at launch? (We already have it.)
5. Any procurement/PO feature needed, or keep Zoho for that?
6. Tags at launch: QR/barcode only, or NFC too?
7. Escalation rule when a user does not confirm: who, after how many days?

## 4. Notes

- This software is single-organisation today. The spec says "multi-tenant-safe"; if several companies will share one install, that is extra work (about 2 weeks) and should be confirmed.
- Estimates assume one developer with an AI assistant and include tests.
