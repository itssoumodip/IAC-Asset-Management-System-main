# Implementation verification

Latest verification: 19 October 2026 in Asia/Kolkata. Local MVP implementation, not a production deployment. Checks below were actually executed by the implementation team against the delivered source. Independent reviewers performed source review and rechecked fixes; they did not independently run these commands. Earlier sections retain historical check records; the assignment section immediately below records the latest run.

## Assignment chooser and department setup — 19 October 2026

The latest run passed **49 unit/API-boundary tests and all 19 Edge browser cases**. The full browser run completed in 54.1 seconds and includes six new synthetic assignment cases, all prior photo/transfer/invitation cases and five real API/PostgreSQL/Mailpit workflows. ESLint, web TypeScript, scoped formatting and the API/web production build pass. The existing system.spec.ts formatting warning remains; that file was not changed in this task. The optional ExcelJS production-chunk warning is unchanged. The 48 integration tests passed in the previous transfer release; they were not rerun for these frontend-only source changes. Linux container builds and hosted CI were not rerun locally.

New browser coverage verifies the Admin catalog header and contextual assignment/transfer links; the Admin-only In Store chooser; explicit employee selection and confirmation with CSRF, idempotency and captured version; transfer reason and current-custodian exclusion; Employee route/UI denial; empty inventory guidance; stale version rejection without automatic retry; and disabling confirmation when a recipient loses portal eligibility after background refetch. Each new case intercepts every API request with synthetic responses and aborts unknown calls. Initial fixture-only failures used a visibility event on the wrong target; correcting the fixture and flushing its browser clock produced six passes and the final full suite passed 19/19. No live custody change or external email was exercised.

The owner-supplied department workbook was read without modification. Exact headers, plain values, unique codes/names, source IDs and the full file SHA-256 were checked before a dry-run reconciliation. Thirteen missing departments were created in one locked transaction; the existing IT department's ID, code, name, active state and version were retained. Source version cells were reference-only; new records use normal database versions. Each creation has an audit event containing source filename/hash, row, exact raw fields and resulting record. Independent review tightened Apply to the exact reviewed source and add-only 13-create/one-unchanged plan before execution. Private recovery data and helper scripts stay under work/ and are excluded from delivery.

Read-back confirmed **14 active departments and 13 corresponding creation audit events**, with two existing users, zero operational assets, four original import batches and all 176 source rows retained. No original source asset was promoted. Assignment requires a created asset or separately reviewed/promoted import plus an active, verified Employee account with accepted portal access; empty staging is not treated as inventory. The app API/web were restored after tests. No pending operational mail existed during restoration. The source ZIP contains only the explicit source allowlist, with no private workbook, employee records or configuration.

| Check | Result |
|---|---|
| npm run format:check | Application source passes; browser test/system.spec.ts formatting remains pending |
| npm run lint | Pass |
| npm run typecheck | Pass for API and web |
| npm test | 14 pass: 7 authentication/security units, 7 frontend API-boundary tests |
| npm run test:integration | 28 pass: 8 HTTP auth, 9 PostgreSQL domain, 7 master setup, 1 runtime permissions, 3 SMTP/worker recovery |
| npm run test:e2e | 5 pass in installed Microsoft Edge with real API/PostgreSQL/Mailpit |
| npm run build | API TypeScript compile and Vite web production bundle pass |
| npm audit --json | 0 known vulnerabilities across production and development dependencies at check time |
| Docker API and web image builds | Both pass on Linux images |
| Container smoke test | API health ok; web HTTP200; proxied API health ok; CSP header present; API uid1000; Linux Argon2 native load pass |
| Original source handling | Original workbook/documents read only; no source employee data imported |

Total: 47 automated tests passed, no skipped test in the final run. Browser screenshots are in docs/screenshots. An earlier repeat run encountered the shared test IP throttle; fixtures now reset only the two loopback-IP hashes inside the guarded isolated test database. Production throttling was not disabled. The TOTP replay regression stores the exact previously accepted code to avoid a clock-boundary false failure.

## Exercised behavior

Authentication checks include approved-only registration, injected-role rejection, email verification and reset single-use tokens, opaque HttpOnly session hashing, current-notice gate, reset revocation, MFA enrollment/session rotation, TOTP replay/recovery consumption, invite activation and user paging/offboarding. A separate unit regression checks the changed-hash login race and final-active-Admin protection.

Domain checks exercise concurrent custody (one winner), immutable IDs, DTO allowlists, idempotent replay/mismatch, employee/IT projections, filtered pagination, acknowledgement ownership, retained ticket history after return, internal note isolation, staff-only completion and resolution, atomic outbox rollback and import reconciliation/manual-email priority. The runtime-role test verifies positive reference INSERT/UPDATE and denies inventory deletion, audit mutation, ticket-history deletion and schema creation.

Worker checks submit to local Mailpit, reclaim an expired lease, persist the sent Message-ID, and recover after simulated SMTP connection failure. SMTP acceptance is not proof of delivery to a real inbox. Browser checks use randomized synthetic test accounts and verify Employee access/asset/ticket flow, Admin asset creation/assignment and ticket ownership/reply/completion, CSRF/role denials and loaded mobile layout without page overflow.

## Deliberate implementation refinements

An emailed invitation token proves mailbox ownership when accepted and records verification with password setup; no second verification email is sent. Registration retains separate email verification. Current portal notice comes from the API. Staff notification recipients must be verified active users with the matching role. Import review reconciles exact IDs, known purchase-cost total and explicit missing-cost count, retaining both source workbook and CSV hashes. The original plan is preserved; docs/API.md documents implemented contracts.

## Release limits

No production deployment, external SMTP delivery, real employee onboarding or source-data cutover was performed. Hosting/domain/TLS, SMTP sender/recipient groups, identity cleanup, branding and retention need IAC configuration. Finance must settle residual values/depreciation before valuation features. The production DB permission script is provided and tested in isolation; production accounts must actually use it. Managed backups/PITR and a timed restore drill, target-load measurements, signed external immutable audit export and organization monitoring remain production gates. Hosted GitHub CI status is separate from the local checks reported here. Container smoke used local HTTP development configuration; production TLS was not tested. No claim of a full penetration test or accessibility certification is made.


## Master Control verification — 18 October 2026

The final browser run passed all five cases in Microsoft Edge (33.6 seconds). This includes real Admin creation of departments, locations and categories; selecting those records on an asset; deactivating a category; retaining that inactive category during an unrelated asset edit; fixed workflow choices; Employee API/UI denial; and a loaded 390px Master Control page without document overflow. Screenshots and test identities use synthetic data only. The curated desktop screenshot is docs/screenshots/master-control-desktop.png.

All 28 isolated PostgreSQL/local Mailpit integration tests and 14 unit/API-boundary tests passed. The seven new master cases cover role restrictions, duplicate races, required versions and reasons, immutable codes, fixed workflow labels, custom ticket categories, optional vocabularies, legacy values and inactive historical selections. The restricted-runtime test also checks department/location writes and deletion denial. Lint, TypeScript and the final production build pass. format:check reports only test/system.spec.ts; its formatter step remains pending.

Independent source review found no remaining confirmed actionable defect. Browser verification exposed a rapid ticket reply/completion version race; mutations now await active-query refresh before controls re-enable, preserving optimistic conflict protection. Positioned table scroll wrappers contain hidden header labels, and the final mobile width check passes. Both fixes were read back by the reviewer.

Migration 004 was applied to the existing local development database and the isolated test database without deleting records. After verification, the normal application was restarted against iac_dev. The Master Control page and API health return HTTP200, anonymous master management returns401, and the existing local Admin account remains active. No production deployment or external email was performed. Production runtimes must reapply infra/runtime-grants.sql after migration to obtain department/location INSERT/UPDATE permissions.


## Register layout compatibility — 18 October 2026

Added an explicitly declared REGISTER_42 layout while retaining the default REGISTER_44 contract. Synthetic integration verifies exact headers, untouched raw source objects, unresolved identity quarantine, explicit review controls and blocked promotion when no rows are eligible. Latest run: 14 unit/API-boundary tests and 29 PostgreSQL/local Mailpit integration tests passed; lint and production build passed. The build includes both TypeScript projects. The earlier five browser cases were not rerun. The existing test/system.spec.ts formatting warning remains pending.

Independent focused review identified a stale controls-file read race. Generation and batch/version guards now discard obsolete results and errors on newer selection, navigation, version change or unmount. Scoped web types, lint and formatting passed; synthetic in-memory cases exercised reversed completion, batch/version changes, unmount and stale failure. Actual import staging/review is an operational check recorded separately; no real source records are bundled with the code.

Local restart exposed a Windows reserved-port conflict. Compose now supports DB_PORT (default 55432), and local connection settings can select an available loopback port while retaining the existing database volume. Existing secrets were preserved and excluded from delivery. PostgreSQL and local Mailpit report healthy after the change.


## Gmail SMTP preparation — 18 October 2026

Added a three-mode prepare/verify/activate helper with hidden private input, exact Gmail TLS on port 465 configuration, sanitized errors, SMTP authentication-only verification and atomic SMTP-only environment merging. Independent static review found no confirmed actionable defect. Nine new synthetic cases cover validation, grouped app passwords, quoted/multiline values, duplicate assignments and preservation of unrelated configuration. The latest unit/API-boundary total is 23; all 23 pass. Lint, API typecheck and production build pass. Scoped formatting passes for changed source; the existing browser-test formatting warning remains.

All 29 integration tests passed with deliberately Gmail-like SMTP settings in the parent process. The integration runner overrides them to local Mailpit and blank credentials before tests start; the browser runner applies the same isolation. The five prior browser cases were not rerun.

A credential-free TLS connection to smtp.gmail.com:465 succeeded with certificate validation. No account authentication or external email was performed. Sender settings are prepared only in an ignored private draft; an owner-entered Google app password, successful authentication verification and explicit activation remain pending. Active SMTP continues to use local Mailpit. No private SMTP files are included in source or archives.

## Resend invitation verification — 18 October 2026

Added the explicit **Resend invitation** action beside invited accounts in People & access. The existing API rotates the token and queues the message; no backend endpoint or role policy changed. The expanded HTTP test verifies the same account ID, rejection of the old link, acceptance and single-use of the replacement link, Employee denial, and rejection of active and disabled accounts.

Latest executed checks: **23 unit/API-boundary tests, 29 isolated PostgreSQL/local Mailpit integration tests, and two synthetic Edge browser tests passed**. Lint and production build passed; the build compiles both TypeScript projects. Scoped formatting and lint passed for changed source and new tests. The existing test/system.spec.ts formatting warning remains unchanged. The five earlier full browser workflows were not rerun for this change.

Run the new browser checks against an existing web server with `npx playwright test --config test/resend.playwright.config.ts`. The config starts no API or worker and reads no private environment file. All `/api/v1/` calls are intercepted with synthetic responses; unknown calls abort. The tests verify invited-only visibility, pending/duplicate-click protection, request payload and CSRF, success feedback, and retry after failure. Their screenshot contains only synthetic identities. Integration tests continue to force Mailpit and clear inherited SMTP credentials.

The running Admin page was checked without clicking its live resend action. Separately, the owner-supplied Google app password passed authentication-only verification and private SMTP activation, and the app was restarted. This supersedes the earlier preparation-only state above. No external invitation was sent as part of verification; SMTP authentication does not establish inbox delivery. Private credentials, employee records and SMTP files remain excluded from source and archives. Production invitation links still require an approved reachable application origin.

## Asset photos and read-only employee details — 18 October 2026

Latest run: **23 unit/API-boundary tests, 36 isolated integration tests and three synthetic Edge photo browser cases passed**. Lint, API/web TypeScript checks and production build passed. Full format:check reports only the pre-existing test/system.spec.ts warning, which remains unchanged. Installing the image dependency reported zero known vulnerabilities. Earlier full browser workflows and resend browser cases were not rerun in this change; Linux container builds/smoke checks above predate the image dependency and were not repeated.

The six new HTTP cases use a real local Nest application and isolated PostgreSQL. They cover private/missing-photo reads, anonymous and unrelated-user denial, Admin-only PUT, Origin/CSRF, JPEG conversion/dimension/size/metadata bounds, IT ticket scope, unsafe and malformed image rejection, version/reason checks, atomic replacement and audit redaction. A real lock-wait interleaving verifies that photo access is rejected after a concurrent return commits. The first run exposed an inactive legacy reference in the test fixture; unique active synthetic references fixed setup and the rerun passed all 36 cases with no cancellation or skip.

The added domain regression proves Employee and IT-only catalog edits/assignments return403 and leave the stored asset unchanged. Runtime-grant checks exercise photo insert, update and read while denying deletion. The three browser cases verify Admin selection is preview-only, explicit reason/save, request JPEG/CSRF/version, refetch persistence, Employee viewing without edit/upload/custody controls, direct edit-route denial, a loaded 390px page without overflow and save failure/retry. All browser API requests are mocked and unknown requests abort. Run them with `npx playwright test --config test/asset-photo.playwright.config.ts` against an existing web server.

Migration005 was applied to the local development and isolated test databases without changing existing asset records. No real asset picture was supplied or uploaded; owners can now add them from each asset's **Asset picture** panel. Testing used generated synthetic images/identities and local Mailpit; no external email was sent. Source artifacts contain neither private pictures nor configuration. Database backups and retention must include asset_photos; production must reapply explicit runtime grants after migration.

## Unknown option retirement — 18 October 2026

Migration006 was applied to local development and isolated test databases. The operational read-back reports zero active Unknown choices, two retained historical codes and two system retirement audit entries. All four import batches and 176 source rows remain present; Data wipe still has Yes, No and Not Applicable. Asset/source records were not rewritten.

All 36 isolated integration tests passed after migration, including existing historical-value and inactive-new-selection cases. Production build passed and compiles API/web TypeScript. Scoped ESLint and Prettier passed for the three changed frontend files. No new tests were added for placeholder wording or filter defaults; earlier unit/browser results above were not rerun for this narrow change. The pre-existing test/system.spec.ts formatting warning remains unchanged. No external email was sent. Independent static read-back found no remaining actionable defect.

## Excel/CSV business transfers — 18 October 2026

Latest executed checks: **49 unit/API-boundary tests, 48 isolated PostgreSQL/local Mailpit integration tests and all 13 Edge browser cases passed (110 total)**. The unit total is 16 API/security/SMTP-helper cases plus 33 web cases, including 26 new file/pagination regressions. The integration total includes 12 new transfer cases and expanded restricted-runtime permissions. The final full browser run passed 13/13 in 46.2 seconds: five real API/database workflows, two mocked invitation cases, three mocked photo cases and three mocked transfer cases. All mocked API requests use synthetic responses and reject unexpected calls.

The first full browser run exposed an obsolete assertion expecting an inactive category in the default active-only filter. The minimal assertion now checks absence under Active and visibility under Inactive; the targeted workflow and subsequent full suite passed. The existing system.spec.ts formatting was preserved as requested. Full format:check still reports only that pre-existing file; application source formatting passes. ESLint, API/web TypeScript and production build pass. npm audit --json reports zero known vulnerabilities. ExcelJS is loaded on demand; Vite reports a large optional spreadsheet chunk (approximately 937 KB minified / 271 KB gzip). This warning does not fail the build. Linux container builds and smoke checks above were not repeated for these dependencies.

New units cover strict CSV quoting/BOM/UTF-8, formulas and literal leading apostrophes, unsafe headers, cell/file/table limits, ZIP expansion safety, XLSX values-only restrictions, date/boolean conversion, export limits, download cleanup and complete filtered pagination without silent truncation. Browser checks exercise actual CSV and Excel downloads/reimports, explicit draft load and normal Save, bulk preview/confirmation/expiry retry/receipt, a 37-record Employee export and Employee asset editing restrictions. The screenshot and generated roundtrip workbook contain synthetic data only and are excluded from the source archive.

Transfer integration checks cover role/ownership/CSRF boundaries, scoped hidden-reference errors, unknown/credential header rejection, mixed-row validation with no business writes, raw provenance, preview rollback including outbox/tokens, all-or-none commit, concurrent/version failure rollback, actor binding and expiry, committed receipt replay without duplicated notifications, generated IDs, verified email custody and duplicate invitation rejection. The runtime-role regression verifies transfer insert/read/receipt update and denies deletion; database triggers preserve provenance. Preview can advance PostgreSQL sequences despite rollback; gaps are intentional and values are never rewound.

Migration007 was applied to local development and isolated test databases without modifying existing business records. Read-only operational aggregates verified two users, zero assets, one ticket, four source import batches containing 176 rows, zero promoted source rows and zero new operational transfer batches. No real source import, invitation or other external email was performed in this change. Test launchers keep the `_test` database and local Mailpit guards and clear inherited SMTP credentials. Existing private configuration and employee data remain excluded from source, logs and delivery archives. The normal development app is restored after browser testing; production installations must apply migrations and explicit runtime grants before using transfer writes.

Single-form loading does not imply permission to save: existing API authorization, versions, reasons and explicit approvals remain authoritative. Bulk batches are capped at 50 rows and 60,000-byte JSON requests; exports stop with an error above 5,000 scoped records. Register XLSX/CSV uses the existing restricted staging/review/reconciliation/promotion workflow, not direct catalog overwrites. Correction spreadsheets preserve primitive values with json: encoding; each supplied correction row replaces its entire correction set and an empty supplied object resets prior overrides while preserving raw source. Authentication credentials, MFA, portal acceptance and acknowledgement decisions are excluded. Audit and existing history remain export-only.

## 29 October, 01:02 IST: bounded concurrency, dispatch and runtime review

Current suite: 123/123 integration cases on isolated PostgreSQL14 and local Mailpit, lint and both TypeScript projects pass. At preceding90e2a65, production build and32API/62webunits passed. Browser results are splits:14Finance/new-module,22otherworkflow,4visualaudit tests (70settledvisits). They precede backend-only retry/recipient-authorization changes; a combined invocation timed out and is not treated as a full pass.

A short restricted-runtime 50k synthetic mixed probe completed279reads plus25Financeapprovals,6XLSXextractions,1fullstocktakecreation,5observations and close with no failed request/reconciliation mismatch. Runtime6.85sec,mutationp953.01sec. A prior probe surfaced40001 at stocktake creation; regression now covers rolled-back retry success and exhausted retries leaving no count. Short warm local conditions are not sustained production capacity, broad file/import/custody contention, WAN performance or an SLA.

Clean `npm ci --omit=dev --ignore-scripts` on Node24 passed Argon2hash/verify,Sharpencode,XLSX/textPDF compiled extraction. Docker build now includes this smoke but Docker itself is unavailable, leaving Debian/container/architecture/Pg17/Windows paths unverified. Queued ticket dispatch tests cover revoked support roles, disabled recipients, stale owners and email reuse; Finance email reuse is also suppressed. All SMTP evidence is local Mailpit, not a production inbox.

## 29 October, 01:34 IST: current browser and restore checkpoint

At b065ee1 (code a5dab89), all49browser tests completed in three splits:23Finance/QR,22otherworkflows and4visualaudits, including70settledrole/viewportvisits. FreshAdmin authenticator/portal/recovery sign-in passed. First workflow invocation had21passes and a dashboard500 caused by the local PostgreSQL14 installation missing libLLVM-14.so.1; direct reproduction returned58P01. Repeating with the documented local-only PGOPTIONS=-c jit=off passed22/22. That is a local environment caveat, not a production JIT or hardware certification. No source logic was relaxed to hide it.

127isolated integration,lint/types/build passed immediately before these browser splits. New selected22table logical restore matched fullrowdigests and6integritychecks with restored Finance/invoice/stocktake immutable mutation denial. Aggregate result is docs/evidence/restore-drill-2026-10-29.json. The restricted-runtime50k probe with30secstatement/5seclock budgets completed2336baselineHTTPreads then307reads+38mutations withzeroerrors,persistedreconciliation,7.30secmixedelapsed and3.77secwritep95. Aggregate result is docs/evidence/mixed-runtime-probe-2026-10-29.json. Neither local drill establishes production capacity,recovery encryption,PITR,RPO/RTO or an SLA.

## Staff-directory cursor precision - 29 October 2026, 02:48 IST

The staff directory now encodes the database's exact microsecond creation timestamp in its next-page cursor rather than rounding through a JavaScript Date. Five staff rows created inside one millisecond reproduced silent skipping: the old code returned only two rows with a page size of one. The regression now retrieves all five without duplicates and checks that the internal cursor field is absent from public items. Current portal-notice fields are preserved.

Current source checks: 132/132 PostgreSQL/local Mailpit integration tests, 32 API unit tests, 62 web unit tests, lint, API/web TypeScript and production builds pass. Targeted staff-directory tests pass 3/3. The test process uses the documented local PostgreSQL 14 JIT workaround; this does not verify PostgreSQL 17, Docker, Windows, real SMTP delivery or production capacity. Browser tests were not rerun for this server-only cursor change at this checkpoint.

## Fresh-database browser verification - 29 October 2026, 02:57 IST

Current source passed 50 browser cases in three completed splits: 23 Finance/QR, 23 photo/assignment/data-transfer/equipment/invitation/auth/master/ticket, and four visual-audit cases covering 70 settled role/viewport visits. The Finance notification test selector now targets the announcement Unread count, avoiding an ambiguity with the distinct workflow Unread control. Representative desktop People & access and mobile Finance pixels were inspected and remain readable with no visible overlap.

A preliminary run against the repeatedly reused local test database timed out while paging more than 1,100 accumulated dead-delivery fixtures. The replacement runs use a fresh disposable database migrated through 023. One fresh setup attempt used the wrong working directory for TypeScript decorators, so no schema was applied; corrected workspace migration succeeded before the recorded passing runs. A combined run exceeded the external execution limit during visual testing; all four visual cases were rerun in a separate completed run. All browser runs use the documented local PostgreSQL 14 JIT workaround. These are local browser results, not a deployed production or physical device/printer certification.
