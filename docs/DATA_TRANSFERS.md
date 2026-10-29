# Excel and CSV import/export

Business forms support Excel `.xlsx` and UTF-8 `.csv`. Access follows the existing server roles and ownership checks. Employees can export their permitted asset details and create support tickets; importing a file never gives them asset editing rights.

## Choose the right tool

| Tool                      | Purpose                                                              | When changes are saved                                                          |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Export Excel / Export CSV | Download permitted list or detail records                            | Read-only                                                                       |
| Import / export form      | Export a draft or load one row into the selected business form       | After preview, **Load into form**, then the form's normal Save/Submit           |
| Bulk import               | Validate and apply multiple business records                         | After **Validate import**, explicit confirmation and **Apply validated import** |
| Import review             | Stage an original register with permanent Asset IDs and reconcile it | Staging, review and promotion are separate explicit actions                     |

Exports are reports rather than universal import templates. For an import, use the template from that exact form or bulk module; report columns can differ from accepted input columns. Keep permanent codes and version values intact.

## Files and limits

| Limit                         | Behavior                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| File size                     | Excel/CSV files must be nonempty and at most 2 MiB                                             |
| Shared reader                 | At most 500 data rows and 100 columns                                                          |
| Single-form import            | Exactly one data row                                                                           |
| Bulk import                   | 1 to 50 rows; complete preview request at most 60,000 UTF-8 bytes                              |
| Register staging              | 1 to 500 rows; complete staging request at most 60,000 bytes                                   |
| Prepared register/review JSON | File at most 60,000 bytes                                                                      |
| Export                        | At most 5,000 rows, 100 columns and 32,000 characters per cell; excessive results fail clearly |

Use a workbook with exactly one worksheet and plain cell values. Formula, hyperlink, rich-text, macro, embedded/external-link and encrypted workbook content is rejected. Archive expansion is bounded before parsing. Duplicate, empty and unsafe column headings are rejected. CSV supports quoted commas and multiline cells. Entirely blank rows are skipped; shorter rows receive blank trailing cells. Excel date cells become `YYYY-MM-DD`; keep reference codes, email addresses and identifiers as text.

Boolean cells use `true` or `false`. Bulk booleans use lowercase spelling. Lists such as roles and recipients use semicolons; single-form list fields also accept line breaks. Use current reference **codes**, not renamed display labels. Dates use `YYYY-MM-DD`, monetary values use decimal INR amounts with at most two fractional digits, and versions use current positive integers.

## Export records

Use **Export Excel** or **Export CSV** on the relevant page. Lists fetch every page matching the current filters, including records beyond **Load more**. More than 5,000 matching rows produces an error so the operator can narrow the filters. Exporting uses explicit field allowlists and the same authenticated API visibility as the screen.

| Screen                      | Export scope                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Asset catalog / Your assets | Current search, status, category and department filters; current role scope                                                   |
| Asset detail                | Selected asset; Admin-only financial/source-related columns remain Admin-only                                                 |
| Tickets                     | Current status/priority filters; own tickets or authorized staff queue                                                        |
| Ticket detail               | Selected ticket and all permitted updates; Employee export contains public updates only                                       |
| People & access             | All staff account pages; account identity, roles/state, verification/portal timestamps and version; no authentication secrets |
| Master Control              | Selected setup group and its current search/availability filters                                                              |
| Notification groups         | Complete current groups, enabled state and recipient list                                                                     |
| Audit trail                 | All pages matching the selected record type; already redacted API evidence                                                    |
| Import review               | Selected batch row report; reconciliation draft and current correction draft have separate exports                            |

CSV export escapes spreadsheet formula-leading values. Excel export writes text cells rather than executable formulas. Array report fields use semicolon-separated text; object report fields use JSON. These report representations do not expand the accepted import schema. Photos stay in the existing private image workflow and are not embedded in tabular exports.

## Load a single form

1. Open the desired create/edit/reply form and expand **Import / export form**.
2. Choose **Template Excel** or **Template CSV**, or export the current draft. Keep the `__form` column and its value. Selected-account, setup-entry, routing-group and register-reconciliation templates identify their specific context.
3. Fill exactly one row using only that form's editable field headers. Omitted columns leave those fields unchanged. Included blank optional text fields load a blank draft value; normal form/API validation determines whether it may be saved. Boolean fields require a value.
4. Choose **Import form file** and inspect **Review imported fields**. File selection stages a local preview only.
5. Choose **Load into form**, review the complete form, then use its normal Save/Submit action. Record selection, immutable identifiers, versions and approval confirmations are not imported as editable values.

Supported form drafts include asset creation/editing, Admin assignment/transfer/return, an Employee discrepancy reason, ticket creation/reply/owner/completion resolution, onboarding, selected-account access changes, selected notification recipients, Master Control entries and register reconciliation. The template exposes only the fields permitted for that form. Internal IDs in selectors refer to existing approved records; they are not Employee reference numbers. Changing a ticket completion draft does not complete the ticket. Loading notification routing or register reconciliation clears the relevant explicit approvals.

Authentication, passwords, email verification, MFA/recovery data, portal acceptance and asset acknowledgement decisions are excluded. Employees must still explicitly accept/dispute receipt. Audit events and historical asset/custody/ticket evidence cannot be imported to fabricate past activity; ticket replies use the normal new-update workflow.

## Apply a bulk import

1. Open the appropriate page and expand **Bulk import**. Available modules reflect the signed-in user's permissions.
2. Download its current Excel/CSV template. Replace the synthetic example with approved records and current codes/versions.
3. Select a file of at most 50 records and enter the **Import reason** (up to 1,000 characters).
4. Choose **Validate import**. Inspect every result and warning. Invalid rows prevent Apply for the entire batch.
5. Confirm that the reviewed changes and their normal notifications are authorized, then choose **Apply validated import**.

Preview executes the normal business validations in rolled-back transactions; it applies no business changes and sends no mail. A restricted provenance record retains the actor, filename, SHA-256, exact submitted rows, reason and preview. Sequence numbers may advance during validation and are never reused, so gaps are expected.

A preview expires after 30 minutes and belongs to its originating account. Apply rechecks the current session, roles, ownership, references and record versions. All rows, their normal audit entries and queued notices commit together; a failing row rolls back the complete Apply. A retry of an already committed preview returns its stored receipt. If Apply encounters a network error, retry that existing preview rather than creating a new batch; a newly validated file creates a distinct operation. Expired or stale previews require correction and validation again.

Blank optional bulk cells are omitted and cannot clear existing fields. Bulk text is trimmed. Notification `recipients` is an explicit exception: a blank list replaces the group with no recipients. The `json:` correction-cell encoding described below belongs only to the register correction loader, not generic bulk imports.

### Bulk module columns and actions

Column names are case-sensitive. Only the listed module columns are accepted. Leave columns that do not apply to an action blank. Every row uses the batch's import reason for changes that require one.

| Module / page            | Columns                                                                                                          | Actions and requirements                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset catalog            | `action`, `assetCode`, `version`, asset fields below, `departmentCode`, `locationCode`                           | `CREATE` generates a permanent Asset ID: leave `assetCode` and `version` blank. `UPDATE` requires an existing `assetCode` and current `version`. Original register IDs must use Import review. Admin only.                                                             |
| People & access          | `action`, `email`, `displayName`, `version`, `state`, `roles`                                                    | `APPROVE`: action/email only. `INVITE`: action/email/optional displayName; creates or resends an invited Employee account and queues email on Apply. `UPDATE`: email/current version plus state and/or semicolon-separated roles; no display-name update. Admin only.  |
| Tickets                  | `subject`, `description`, `category`, `priority`, `assetCode`, `relatedTicketNumber`                             | Creates new tickets as the signed-in reporter. Subject/description/category/priority required. Linked asset must be in the reporter's own current custody; related ticket must be visible to the reporter. No action column or bulk history/status/owner overwrite.    |
| Asset custody            | `action`, `assetCode`, `assetVersion`, `employeeEmail`, `assignmentVersion`, `note`, `condition`, `locationCode` | `ASSIGN`: asset/current assetVersion, approved employee email, optional note. `TRANSFER`: also current assignmentVersion. `RETURN`: asset/current assetVersion/current assignmentVersion/condition, optional locationCode; leave employeeEmail/note blank. Admin only. |
| Notification groups      | `code`, `enabled`, `recipients`                                                                                  | Replaces `ADMIN` or `IT` group configuration. enabled required; recipients are semicolon-separated approved, active, verified staff with the matching role. Blank recipients clears the list. Admin only.                                                              |
| Departments              | `action`, `code`, `version`, `name`, `active`                                                                    | `CREATE` needs stable code/name; leave version blank. `UPDATE` needs existing code/current version. Admin only.                                                                                                                                                        |
| Locations                | `action`, `code`, `version`, `site`, `building`, `floor`, `room`, `active`                                       | `CREATE` needs stable code/site; leave version blank. `UPDATE` needs existing code/current version. Admin only.                                                                                                                                                        |
| Editable reference group | `action`, `code`, `version`, `label`, `active`                                                                   | `CREATE` or `UPDATE`; update needs current version. Codes remain permanent. Admin only.                                                                                                                                                                                |
| Fixed reference group    | `action`, `code`, `version`, `label`                                                                             | Existing-code `UPDATE` only, current version required; labels only. Workflow availability and behavior are unchanged. Admin only.                                                                                                                                      |

Asset fields accepted by the bulk catalog module:

```text
category, assetType, description, manufacturer, model, serialNumber, barcode,
configuration, graphics, ownershipType, assetOwner, status, condition, riskLevel,
warrantyExpiry, amcApplies, amcExpiry, purchaseDate, purchaseCost, currency,
residualValue, depreciationMethod, usefulLifeYears, invoiceNumber, supplier,
insurancePolicyNumber, insuranceExpiry, lastAuditDate, nextAuditDate, disposalDate,
disposalMethod, disposalReference, dataWipeRequired, remarks, commentType
```

Creation requires category, assetType, description, ownershipType, status, condition and riskLevel. Department/location references use `departmentCode` and `locationCode`, which resolve existing master records. No raw financial calculation policy is inferred from a file. The domain validates permissible status/custody transitions and controlled choices on both preview and Apply.

People roles are `EMPLOYEE`, `IT_ADMIN` and `ADMIN`; update state is `ACTIVE` or `DISABLED`. Existing account verification and final-active-Admin protection still apply. An invitation does not grant staff roles or verified/MFA/portal-accepted state.

Editable reference groups are `CATEGORY`, `ASSET_TYPE`, `OWNERSHIP`, `CONDITION`, `RISK`, `DEPRECIATION_METHOD`, `DISPOSAL_METHOD`, `COMMENT_TYPE` and `TICKET_CATEGORY`. Fixed groups are `STATUS`, `TICKET_STATUS`, `TICKET_PRIORITY` and `DATA_WIPE`. Retired choices remain historical and cannot become new selections merely because a file names them.

## Original register staging

Use **Import review** for an original register carrying permanent Asset IDs. Generic bulk catalog `CREATE` cannot take those IDs, and generic `UPDATE` does not preserve the register's raw source provenance.

Choose the 44-column or 42-column register template in Import review. The exact 44 headers are mapped in [source-map.json](source-map.json). The 42-header layout removes `Comment Type`, `Custodian Login ID` and `Custodian Login ID (Manual)` and adds `Column1`. Missing/extra headers are rejected. Do not discard `Column1`, invent missing fields, or match a custodian name/Employee ID to a login.

Select a single-sheet, values-only Excel file or CSV. The loader preserves parsed source values and builds the staging bundle:

- Excel: `sourceWorkbookSha256` is the selected XLSX bytes' SHA-256; `sourceSha256` fingerprints canonical CSV values in the detected register-header order, with every cell quoted, embedded quotes doubled, CRLF separators and a trailing CRLF.
- CSV: `sourceSha256` is the selected CSV bytes' SHA-256; enter the approved original workbook fingerprint in **Original workbook SHA-256**. The current value is used when the asynchronous file read finishes and may be corrected before staging.
- Both: retain the source filename, detected layout, generated export timestamp and raw header-keyed rows. Prepared JSON bundles with these existing metadata fields remain accepted.

The resulting complete request must be at most 60,000 bytes even when the input file is under 2 MiB. Oversized requests fail before staging. Split into smaller, separately fingerprinted source files and retain the approved original workbook fingerprint for CSV slices. The loader never silently truncates a file or promotes a row.

Choose **Stage import for review**. All new rows remain restricted until the explicit review/promotion workflow. Invalid manual email overrides retain priority and produce an exception rather than falling back. Nonblank `Column1` remains an unmapped-field exception. Existing assets are never overwritten by promotion. Required eligible employee/onboarding/reference and Finance decisions are rechecked by the normal import service.

### Reconciliation and corrections

The reconciliation form accepts one-row Excel/CSV drafts for `expectedAssetCodes`, `expectedTotalCost`, `expectedUnknownPurchaseCost` and `reason`. It is tied to the selected batch/version. The expected ID list must reconcile the exact permanent ID set; known cost reconciles to the paisa, with a separate missing-cost count. The retained **Review controls (.json)** loader can populate those controls together with the correction array; see [API examples](API.md#browser-upload-and-review-controls).

The separate correction Excel/CSV template uses a plain, one-based `rowNumber` within this batch plus these allowed field headers:

```text
assetCode, custodianEmail, category, assetType, description, manufacturer, model,
serialNumber, barcode, configuration, graphics, ownershipType, departmentId,
locationId, assetOwner, status, condition, riskLevel, warrantyExpiry, amcApplies,
amcExpiry, purchaseDate, purchaseCost, currency, residualValue, depreciationMethod,
usefulLifeYears, invoiceNumber, supplier, insurancePolicyNumber, insuranceExpiry,
lastAuditDate, nextAuditDate, disposalDate, disposalMethod, disposalReference,
dataWipeRequired, remarks, commentType
```

Correction tables load the editable JSON draft; they do not submit review. Unknown fields, duplicate/out-of-range row numbers, unsupported value types and excessive arrays are rejected. Unlike generic bulk catalog imports, approved register corrections use existing department/location UUID fields (`departmentId`, `locationId`) and can include the permanent ID/custodian corrections permitted by the existing review API. The raw source row remains unchanged.

At **Apply review and revalidate**, every supplied correction row replaces that row's complete stored override set. Include every override you want to retain for a supplied row. Fields omitted from that row's set carry no override and return to raw-source normalization; rows absent from the submitted correction array retain their previously stored corrections. A table row containing only `rowNumber` becomes `fields:{}` and intentionally resets all overrides for that row when review is applied. These replacement rules also apply to corrections loaded from JSON. Loading a table replaces the editable correction draft but saves nothing until explicit review.

Use the current-correction export to preserve the actual drafted `[{rowNumber,fields}]` array as a flat Excel/CSV table. Every specified field is encoded with `json:` followed by its JSON value; omitted fields are blank. This preserves null, empty strings and value types without confusing them with omitted corrections:

| Correction cell               | Loaded value                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Blank                         | Field omitted from this row's replacement override set; use raw-source normalization |
| `json:null`                   | Explicit JSON null; clears only where the API permits a nullable field               |
| `json:""`                     | Explicit empty string; normal API text validation may reject it                      |
| `json:"Approved description"` | Exact text                                                                           |
| `json:"json:literal"`         | Text beginning with the reserved `json:` prefix                                      |
| `json:false`                  | Boolean false                                                                        |
| `json:5`                      | Number, for usefulLifeYears                                                          |

Plain nonblank text remains supported. Plain `amcApplies` uses true/false and plain `usefulLifeYears` uses an integer from 1 to 100. Encoding preserves a draft; it does not override domain validation or change the replacement rules above. The current-draft export rejects malformed JSON/row shapes, unsupported field keys, strings over 5,000 characters and invalid primitive types instead of silently dropping fields.

Loading reconciliation, review controls or correction tables clears Finance and promotion approvals. Review the draft, enter evidence, explicitly approve operational import with pending Finance metadata where authorized, then choose **Apply review and revalidate**. Inspect the updated eligible/quarantined counts and exceptions. Only then confirm reconciliation and choose **Promote eligible reviewed rows**. Portal access acceptance and custody acknowledgement remain separate individual evidence.

## Deployment and API notes

Apply migration 007 with `npm run db:migrate`; production operators must reapply [runtime-grants.sql](../infra/runtime-grants.sql). The restricted transfer table retains submitted provenance and the committed receipt. Include it in approved backup/retention procedures. No import/export action changes SMTP configuration.

Generic bulk REST routes are `GET /api/v1/transfers/definitions`, `POST /api/v1/transfers/preview` and `POST /api/v1/transfers/:id/commit` with `{confirmed:true}` for Apply. Normal session, MFA, portal and CSRF checks remain in force. Register staging/review/commit continues to use `/api/v1/imports`; single-form imports continue to use the original business endpoint only after Save/Submit. See [API.md](API.md) for the full route contract.

### Financial drafts and review

Admin may import financial draft values for new catalog records. They are not approved values. Explicit submission to a separate Finance reviewer is still needed. After submission, financial catalog edits are blocked, including insurance metadata; Finance checks and approves corrections.
