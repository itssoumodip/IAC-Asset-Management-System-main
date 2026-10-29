# Implemented REST API

Base /api/v1. CamelCase JSON; PostgreSQL uses snake_case. Credentialed cookies, exact APP_ORIGIN and signed X-CSRF-Token on all writes, including authentication. GET /auth/csrf bootstraps a token. Responses carry X-Request-Id. HttpOnly sessions store only a hash in PostgreSQL. Domain APIs require active/verified accounts, current portal notice and completed staff MFA.

| Route | Methods | Access and behavior |
|---|---|---|
| /auth/csrf | GET | Anonymous signed CSRF bootstrap |
| /auth/register | POST | Approved email only; generic202; strict Employee registration |
| /auth/verify-email | POST | Single-use token |
| /auth/login | POST | Returns200 with user, enrollment-required flag, or MFA challenge |
| /auth/invite/accept | POST | Single-use invitation sets password and verifies mailbox ownership |
| /auth/forgot-password, /auth/reset-password | POST | Generic request; single-use reset and session revocation |
| /auth/mfa/enroll, /auth/mfa/confirm | POST | Enrollment-only session; TOTP setup and recovery codes |
| /auth/mfa/verify, /auth/mfa/recover | POST | Password-created challenge plus code; replay protected |
| /auth/logout, /auth/logout-all | POST | Current/all own sessions revoked |
| /me | GET | Profile plus portalNoticeVersion/currentNoticeVersion/enrollmentOnly |
| /me/portal-acceptance | POST | {noticeVersion: currentNoticeVersion} |
| /users | GET | Admin; cursor/limit/q/state/role |
| /approved-emails, /invitations | POST | Admin approval/invite |
| /users/:id | PATCH | Admin state/roles changes, reason, version; final Admin protected |
| /users/:id/roles | PUT | Admin role replacement; existing sessions revoked |
| /references | GET | Controlled vocabulary, departments, locations |
| /references/:kind/:code | PUT | Admin compatibility route; same master allowlist, reason, version and fixed-workflow rules |
| /assets | GET, POST | Scoped catalog; Admin creates. Items include `lastLabelPrintedAt`; Admin filter `labelPrinted=no` lists assets never printed |
| /assets/:id | GET, PATCH | Scoped detail, Admin edits with reason; immutable Asset ID |
| /assets/:id/photo | GET, PUT | Same asset visibility for reads; Admin-only versioned photo replacement with reason |
| /scan/:assetCode | GET | Any signed-in user; case-insensitive Asset ID. Minimal view `{id,assetCode,category,assetType,manufacturer,model,department,location,status,hasPhoto,reportable,canViewFull}`; `reportable` is false for retired, lost or stolen assets; `404` if unknown |
| /scan/:assetCode/photo | GET | Same access as the scan view; `{dataUrl}` JPEG data URL or null |
| /asset-labels/prints | POST | Admin; `{assetIds:[1-500 unique uuids],layout: A4_24, A4_14 or THERMAL_50x25}`; records one print per asset, audited, idempotent; returns `{recorded,printedAt}` |
| /assets/:id/assignments, /assets/:id/reassign | POST | Admin atomic custody; key and asset If-Match |
| /assignments/:id/return | POST | Admin ends custody with condition/reason/location |
| /assignments/:id/acknowledgement | POST | Current assigned Employee accepts/disputes; assignment If-Match |
| /tickets | GET, POST | Own tickets or staff queue; optional own current asset; optional `photos` (up to 3 JPEG/PNG data URLs, re-encoded server-side) |
| /tickets/:id | GET | Reporter or staff |
| /tickets/:id/photos/:n | GET | Reporter or staff; `n` is 1-based; `{dataUrl}`; ticket detail carries `photoCount` |
| /tickets/:id/updates | GET, POST | Public reporter updates; staff may add/read internal notes |
| /tickets/:id/owner, /tickets/:id/status | PATCH | Staff; owner or Open/In Progress -> Completed with resolution |
| /dashboard | GET | Role-filtered assets/tickets/unknownCounts/import counts |
| /audit-events | GET | Admin redacted timestamped evidence; entityType/entityId filters |
| /notification-groups | GET | Admin {items:[{code,enabled,recipients:[{email,verifiedAt}]}],nextCursor:null} |
| /notification-groups/:code | PUT | Admin {enabled:true,recipients:[email]}; verified matching-role staff only |
| /imports | POST | Admin staging; exact declared 44- or 42-header rows and source/export fingerprints |
| /imports/:id | GET | Admin raw/normalized rows, issues and reconciliation |
| /imports/:id/review, /imports/:id/commit | POST | Admin control totals, explicit approval and batch version |
| /health | GET | DB connectivity, no sensitive details |

Mutable resources use quoted numeric If-Match. Missing=428, stale=412. Asset/ticket creates, assignments/transfers/returns and import staging/commit use Idempotency-Key; same-key changed body=409. Staff/employee scope is checked before paging or replay. Lists return items/nextCursor. Inaccessible IDs=404; role denial=403. Errors: {error:{code,message,requestId,fields?}}.

## Spreadsheet transfers

See [DATA_TRANSFERS.md](DATA_TRANSFERS.md) for module columns, supported forms and file limits. XLSX/CSV parsing and downloads run in the browser; the API accepts allowlisted string-valued JSON rows, never workbook binaries.

| Route | Method | Behavior |
|---|---|---|
| /transfers/definitions | GET | Current role's module definitions: module, label, columns, example, description |
| /transfers/preview | POST | Validate up to 50 rows using existing commands, roll back business changes, retain restricted immutable provenance and validation results |
| /transfers/:id/commit | POST | Explicit `{ "confirmed": true }`; revalidate current access and versions, then atomically apply the stored preview |

Admin modules are `assets`, `people`, `assignments`, `notifications`, `masters:departments`, `masters:locations` and the reference kinds exposed in definitions. All portal users can import new `tickets` as their own reporter. Employee asset updates remain forbidden. Authentication/session/MFA/verification, portal acceptance and assignment acknowledgement cannot be imported. Audit and existing ticket history are export-only.

Example preview (normal session, current portal acceptance, staff MFA where applicable and CSRF required):

```json
{
  "module": "masters:departments",
  "filename": "departments.csv",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "reason": "Add approved department",
  "rows": [{"action":"CREATE","code":"EXAMPLE_DEPT","name":"Example department","active":"true"}]
}
```

The browser calculates the actual SHA-256 of the selected file; the repeated `a` value above is a schema illustration. Preview returns:

```json
{
  "id": "batch-uuid",
  "module": "masters:departments",
  "rowCount": 1,
  "valid": true,
  "rows": [{"rowNumber":1,"valid":true,"errors":[],"summary":"Validated"}],
  "warnings": ["Validation may consume sequence numbers; these are never reused."]
}
```

Summary and warning text are human-readable and may vary. Preview uses the normal domain operations in an outer transaction with row savepoints, then rolls back all business, audit and outbox changes. PostgreSQL sequences can still advance, so generated identifiers can have gaps. A separate transaction retains the actor, filename, file hash, exact submitted rows, reason and preview. Unknown headers are rejected before storage. Raw provenance is restricted and contains no imported credential columns.

Commit returns `{ "id": "batch-uuid", "state": "COMMITTED", "rowCount": 1, "results": [{ "rowNumber": 1, "id": "record-uuid", "summary": "Applied" }] }`. It is bound to the preview actor and expires after 30 minutes until committed. Current account, session, role, MFA, portal acceptance, record visibility and resource versions are checked again. A stale or failing row rejects the whole batch with `409`; no business rows, outbox messages or partial receipts persist. Invalid/expired previews require a new preview. Replaying an already committed ID returns its stored receipt after current authorization checks, without duplicating actions or email. Uploading the same file as a new preview is new intent, not a global file-hash deduplication key.

The HTTP JSON parser limit remains 64 KB; the UI enforces a conservative 60,000-byte request limit and 50 rows per bulk batch. Boolean cells use `true`/`false`, list cells use semicolons, actions use the uppercase values from definitions and updates require current versions. Blank optional bulk cells are omitted rather than clearing fields; notification recipients explicitly permit blank to clear a group. Asset CREATE generates a permanent ID; existing register IDs must use reviewed `/imports` staging. Imported assignment identity uses approved employee email, never Employee ID or name.

Single-form spreadsheet loading has no separate write endpoint: **Load into form** populates a matching form draft, then the ordinary Save action and normal optimistic concurrency rules apply. List/detail exports use existing scoped GET routes, explicit column projections and fresh pagination (maximum 5,000 records, with an error instead of silent truncation). Exports of private financial values and internal ticket notes retain staff restrictions.

Existing installations must apply migration `007_data_transfers.sql` and reapply `infra/runtime-grants.sql` for production runtime INSERT/UPDATE rights. Provenance and committed receipts cannot be deleted or rewritten through the runtime role.

## Resend an invitation

Admin `POST /invitations` also resends an invitation to an existing `INVITED` account. People & access exposes this as **Resend invitation** on invited rows. Send the same email and optional display name:

```json
{"email":"employee@example.org","displayName":"Example Employee"}
```

The response is `201` with the same account ID. The transaction consumes previous unused invitation tokens, creates a new three-day token, records the audit event and queues the encrypted SMTP outbox message. Earlier links are rejected; an accepted link is single-use. Existing queued emails are not cancelled. Active or disabled accounts return `409`; an Employee cannot issue invitations (`403`). The normal Admin session, MFA, portal-acceptance and CSRF requirements still apply. The browser prevents concurrent resend clicks and reports queued status without claiming inbox delivery.

## Asset and support examples

POST /assets, Admin with Idempotency-Key:
```json
{"category":"IT Hardware","assetType":"Laptop","description":"New laptop","ownershipType":"Owned","status":"In Store","condition":"Good","riskLevel":"Low","amcApplies":false}
```
201 response includes id, assetCode, version and financePending. POST /assets/:id/assignments with asset If-Match and key: {"userId":"employee-uuid"}; omit a blank optional note. Employee POST /assignments/:id/acknowledgement: {"decision":"ACCEPTED"} or {"decision":"DISPUTED","reason":"Serial mismatch"}. Portal acceptance is separate.

POST /tickets with key:
```json
{"subject":"Laptop does not charge","description":"Charging indicator stays off.","category":"HARDWARE","priority":"MEDIUM","assetId":"assigned-asset-uuid"}
```
201 returns id/ticketNumber/status/version and notificationState QUEUED. Reply with ticket If-Match: {"body":"A replacement is ready.","visibility":"PUBLIC"}. Staff PATCH status with ticket version: {"status":"COMPLETED","resolution":"Replaced adapter and verified charging."}. Completion never changes custody; no reopen in MVP. Employee sees only public updates, even after asset return.

## Private asset photos

Employee asset fields are read-only: asset create/edit, custody changes and photo upload require `ADMIN`. An account with both Employee and Admin roles retains Admin rights. Assignment acknowledgement/dispute records are separate evidence and do not edit asset details.

`GET /assets/:id/photo` uses the same asset visibility as the detail endpoint, returning `{dataUrl:null,updatedAt:null}` before a picture is added. With a picture it returns a JPEG data URL and an ISO timestamp. Admins see all assets, Employees only their own current custody, and IT staff the technical asset scope permitted by related tickets. Anonymous reads return `401`, inaccessible assets `404`. Responses are private and `no-store`; there is no public image URL. The read locks the asset and checks visibility after acquiring the lock, so a concurrent completed return cannot expose a photo to its former custodian.

Admin `PUT /assets/:id/photo` requires `If-Match: "<current asset version>"`, the normal session/MFA/portal/CSRF guards, and a strict JSON body:

```json
{"dataUrl":"data:image/jpeg;base64,<canonical JPEG bytes>","reason":"Approved equipment photo"}
```

Only JPEG/PNG data URLs are accepted: at most 40 KiB decoded input, four million decoded pixels and one image/frame. SVG, mismatched signatures, noncanonical Base64, malformed images and unknown fields return `422`. The normal 64 KB request-body limit remains. The browser prepares an input file up to 10 MiB locally before sending it. The server independently decodes and re-encodes the picture as metadata-free JPEG, at most 640 × 480 pixels and 80 KiB. The required reason is trimmed and limited to 1,000 characters.

Successful replacement returns `200` with `{dataUrl,updatedAt,assetVersion}` and an ETag for the new asset version. Missing/stale versions return `428`/`412`; non-Admins cannot upload (`403`). `asset_photos` stores one picture per asset (`asset_id` primary/foreign key, bounded `content bytea`, fixed JPEG MIME, SHA-256, updating user and timestamp). Picture replacement, asset version increment and `ASSET_PHOTO_UPDATED` audit share a transaction. Audit contains only byte size, hash and reason; original picture bytes, metadata and filenames are not retained. Replacing a photo does not change custody, catalog details or permanent Asset IDs.

## Import contract

POST /imports accepts `filename` (basename only), `sourceSha256` (CSV-export SHA-256), `sourceWorkbookSha256` (original XLSX SHA-256), `exportedAt`, optional `sourceLayout`, and `rows`. `exportedAt` cannot be in the future. A batch contains 1 to 500 rows and the browser enforces a 60,000-byte JSON request limit. The HTTP API remains JSON; the browser also accepts values-only XLSX or CSV and constructs this staging request after explicit selection and review. XLSX uses the actual file's workbook hash and a deterministic quoted CSV values hash; CSV uses the selected file hash and requires the original workbook hash supplied by the operator. Split oversized exports into separately fingerprinted batches while retaining the true original-workbook fingerprint. No file selection or staging promotes records.

`sourceLayout` defaults to `REGISTER_44`, whose exact 44 headers are defined in source-map.json. Declare `REGISTER_42` for the register layout with those same headers except `Comment Type`, `Custodian Login ID` and `Custodian Login ID (Manual)`, plus `Column1`. Every row must match the declared header set exactly; missing, extra and mixed-layout headers are rejected. Export displayed values rather than formula strings. Source layout is retained in `reconciliation.sourceLayout`.

Staging preserves each raw source-header object unchanged, including `Column1`; it does not pad the 42-column layout with invented comments or emails. All staged rows initially remain restricted with `REVIEW_REQUIRED`. Missing emails do not authorize name or Employee ID matching. A nonblank `Column1` produces `UNMAPPED_SOURCE_FIELD` during review and stays quarantined pending owner reconciliation; its meaning is never guessed or silently dropped.

POST /imports/:id/review (batch If-Match):
```json
{"reason":"Asset Manager reviewed export and exceptions","acceptFinancePending":true,"rows":[{"rowNumber":1,"fields":{"departmentId":"approved-department-uuid","custodianEmail":"approved@example.org"}}],"expectedAssetCodes":["IAC-IT-000001"],"expectedTotalCost":"1000.00","expectedUnknownPurchaseCost":0}
```
Examples use placeholder UUIDs/emails; real values must reference approved records. Each supplied review row replaces that row's complete correction set: omitted fields have no override and normalize from the original source. A supplied empty `fields` object intentionally resets prior corrections for that row; rows absent from the request retain stored corrections. Raw source is never rewritten. Controls reconcile exact ID set, known-cost sum to the paisa and explicit missing-cost count. Missing financial metadata stays pending. Invalid preferred manual AR email quarantines instead of falling back. Rows with operational exceptions stay restricted. Commit {"reviewed":true} with batch version/key promotes eligible reviewed rows only and never overwrites live records. Raw source fields and dated legacy depreciation caches remain restricted Admin data.


### Browser upload and review controls

Open `/admin/imports` as an Admin with completed MFA and portal access. Select the exact register layout, then a plain-value XLSX/CSV source (or retained prepared staging JSON) and choose **Stage import for review** after checking its preview. CSV requires the original workbook SHA-256; XLSX calculates it from the selected file. In the opened batch, optionally select **Review controls (.json)** to fill the expected IDs, known-cost total, missing-cost count and correction array. Excel/CSV correction drafts and reconciliation form drafts are also available; specified correction values export as `json:<JSON value>` to preserve null, empty strings and primitive types while blank cells mean omitted. Loading a draft clears prior Finance/promotion approvals and submits nothing. The controls JSON uses this separate shape; this example contains synthetic data only:

```json
{
  "expectedAssetCodes": ["IAC-IT-000001"],
  "expectedTotalCost": "1000.00",
  "expectedUnknownPurchaseCost": 0,
  "corrections": [
    {
      "rowNumber": 1,
      "fields": { "custodianEmail": "approved@example.org" }
    }
  ]
}
```

Controls files are limited to 60,000 bytes. The helper checks basic ID, count, amount and correction shapes, captures the current batch version, and ignores additional top-level operator metadata such as `rowCount` or `worksheetRows`. `rowNumber` is the one-based position within this batch, not an Excel worksheet row number. The API still validates every correction and reconciles the exact source ID set and totals.

Loading controls clears previous Finance and promotion confirmations; it never submits review, accepts Finance policy, or commits assets. Inspect the populated values, enter the review reason, explicitly accept pending Finance metadata where approved, then choose **Apply review and revalidate**. Resolve reported exceptions through approved source/master/identity decisions. Duplicate source IDs block review; live inventory collisions stay quarantined. Only after reconciling the result should the Admin confirm and choose **Promote eligible reviewed rows**. Imported custody remains pending employee acknowledgement and queues assignment notices through the configured SMTP outbox.

## Differences from the planning contract

Invitation token acceptance itself proves mailbox ownership, records that verification and sets the password; it does not send a second verification email. Registration still uses a separate verification link. Login returns200 for all eligible flow branches; inspect flags. /me exposes the configurable notice version. Notification groups use verified staff recipients, not unchecked distribution aliases. Review controls include original workbook hash and explicit missing-cost reconciliation. Asset detail includes a bounded latest50 history: Admin movements or only Employee's own current assignment events. Full audit is Admin-only. These choices are implemented and tested; the original planning documents remain unchanged.

## Master Control

Admins manage shared setup at `/master-control`. Every write requires a nonempty `reason`; updates also require `If-Match` using the current resource version. Codes are permanent. Deactivation hides an option from new selections and preserves historical records; an unchanged inactive value is allowed when editing an existing asset. No master delete endpoint is provided.

Migration006 retires `CONDITION/Unknown` and `RISK/Unknown` with version increments and system audit entries. New or changed references cannot select these inactive values; existing unchanged historical values remain supported. Master Control defaults to active entries, with explicit All/Inactive filters available for history. Optional empty selections are labelled **Not set**. Source rows and missing-data reconciliation are unchanged.

| Route | Methods | Behavior |
|---|---|---|
| /master-data | GET | Admin-only complete setup: `kinds`, `values`, `departments`, `locations`, including inactive entries and versions |
| /master-data/departments | POST | Create `{code,name,active?,reason}` |
| /master-data/departments/:id | PATCH | Edit `{name?,active?,reason}`; immutable code |
| /master-data/locations | POST | Create `{code,site,building?,floor?,room?,active?,reason}` |
| /master-data/locations/:id | PATCH | Edit `{site?,building?,floor?,room?,active?,reason}`; immutable code |
| /master-data/:kind | POST | Create `{code,label,active?,reason}` for editable kinds |
| /master-data/:kind/:code | PATCH | Edit `{label?,active?,reason}`; URL-encode the stable code |

Editable kinds: `CATEGORY`, `ASSET_TYPE`, `OWNERSHIP`, `CONDITION`, `RISK`, `DEPRECIATION_METHOD`, `DISPOSAL_METHOD`, `COMMENT_TYPE`, `TICKET_CATEGORY`. Fixed kinds: `STATUS`, `TICKET_STATUS`, `TICKET_PRIORITY`, `DATA_WIPE`. Fixed kinds permit display-label changes only; their codes and availability protect custody, completion and priority rules. Unknown kinds, custom workflow codes and fixed-kind deactivation are rejected. Updates return the new version and ETag; stale updates return 412. Duplicate master codes return 409. Changes and their reasons are recorded in the audit trail.

`GET /references` remains available to authenticated portal users for form choices and historical labels, now including inactive department/location records and version metadata. Only Admins can write master data. For example:

```json
{"code":"THERAPY","name":"Therapy services","reason":"Approved department setup"}
```

Create a category with `POST /master-data/CATEGORY`:

```json
{"code":"Therapy Devices","label":"Therapy devices","reason":"Approved asset classification"}
```

Deactivate it with `PATCH /master-data/CATEGORY/Therapy%20Devices`, `If-Match: "1"`:

```json
{"active":false,"reason":"Replaced by the revised classification"}
```

## Invoice evidence

- `POST /finance/assets/:id/invoices`: Admin/Finance, CSRF and asset `If-Match` required. JSON `{filename,data}` with canonical base64 PDF/XLSX up to 4 MiB. Returns evidence ID/hash and suggested values. Does not update the asset or approve it. Per-asset cap 50 distinct files, duplicate bytes reuse the same ID.
- `GET /finance/assets/:id/invoices`: Admin/Finance private evidence metadata and extraction.
- `GET /finance/assets/:id/invoices/:evidence`: Admin/Finance authenticated attachment download, no-store/nosniff.
- Finance review accepts optional `invoiceEvidenceId` for a same-asset retained file. Approval history records its immutable ID/hash.

See `INVOICE_EVIDENCE.md` for formats, limits, review and operational gates.

## Workflow inbox

`GET /notifications/workflow` accepts `filter=ALL|UNREAD`, `limit` (1-100) and opaque `cursor`. Returns account-scoped workflow notices with actual permitted target paths, counts and `nextCursor`. `POST /notifications/workflow/:id/read` and `POST /notifications/workflow/read-all` require CSRF. Repeated reads are idempotent; another user's or currently inaccessible notice is 404. `/notifications/unread-count` includes announcements and workflows. See `WORKFLOW_NOTIFICATIONS.md` for recipient rules, event coverage and limits.

Executive summary includes `activity`, 12 zero-filled Monday-start Kolkata weeks with `approvalEvents`, `ticketsCreated`, `ticketsCompleted`, and `partialWeek`. It counts recorded events, including repeat approvals of an amended asset, not purchases, money or historical backlog. Scope definitions travel with the response. No ticket/private invoice text or user identity is returned.

## Stocktake

Admin only: `GET/POST /stocktake`, `GET /stocktake/:id` (after asset-code cursor, limit), `POST /stocktake/:id/observations` (assetCode, outcome SEEN/NOT_FOUND/MISMATCH, note, UUID requestKey), `POST /stocktake/:id/close` (reason), `GET /stocktake/:id/assets/:asset/history` (after observation-ID cursor, limit). Mutations require CSRF, observations/close require run If-Match. Create freezes a snapshot and optionally accepts departmentId/locationId. No inventory/custody/Finance mutations follow from observations. See `STOCKTAKE.md`.

## Lifecycle attention

Admin-only `GET /lifecycle/expiry` supports window DUE30/DUE90/EXPIRED/MISSING, after asset-code cursor and limit. `GET /lifecycle/recovery` supports name/email q, after user-ID cursor and limit. Both are read-only, live and scoped. No automatic renewal/reminder/return or account/HR mutation. See `LIFECYCLE_ATTENTION.md`.

## Admin financial draft and independent Finance review (29 October update)

Admin may enter initial purchase, invoice, residual, depreciation-method and insurance metadata in asset create/edit and operational import. New values are drafts, not Finance approval. Admin explicitly submits the current asset version; saving alone does not route it to Finance. IT_ADMIN alone cannot create inventory. After any Finance submission exists, Admin catalog changes to financial values are blocked; Finance review handles corrections. This includes insurance fields as well as cost, purchase date, invoice, supplier, residual, method and useful life.

A separate FINANCE reviewer checks/edits and approves the financial section. Required approval values remain cost, purchase date, invoice number, supplier and reason. Optional residual, configured method, useful life and insurance fields are nullable. Currency remains INR. No depreciation calculation is added. Return cannot change financial values. Complete approved financial metadata is retained in immutable Finance event details. Self-approval, stale-version checks and prior approved acquisition-cost snapshot protection remain.
