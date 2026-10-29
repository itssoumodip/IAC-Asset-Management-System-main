# IAC Asset Management Platform

A local MVP implementation of the approved IAC asset custody and support plan: React/TypeScript, NestJS, PostgreSQL, revocable cookie sessions and durable SMTP notifications. Includes Employee, Admin and IT/Admin workflows, reviewed imports and timestamped audit. This is ready for local evaluation; production provisioning and organization policy configuration remain separate.

## October demo improvements

See [demo walkthrough](docs/DEMO_HANDOFF_2026_10.md) and [implemented/configurable/missing matrix](docs/FEATURE_STATUS_2026_10.md). This branch adds Finance/Executive workflows, person equipment views and delivery-health evidence. It is not a certified multi-tenant SaaS release.

## Deployment

- [Deploy to Oracle Cloud Infrastructure](docs/DEPLOY_ORACLE_CLOUD.md)
- [Generic single-server Docker deployment](docs/DEPLOY_SINGLE_SERVER.md)
- [Production operations and release guidance](docs/PRODUCTION.md)

For the complete delivery and meeting setup, start with [Run the manager demo locally](docs/RUN_DEMO_FIRST.md).

Windows users: [PowerShell setup and prerequisite check](docs/WINDOWS_DEMO.md).

## Start locally

Requirements: Node.js 24, npm, Docker Desktop/Engine. Run in this directory:

```powershell
npm ci
npm run setup:local
npm run infra:up
npm run db:migrate
npm run seed:synthetic
npm run admin:bootstrap
npm run dev
```

Open [the application](http://127.0.0.1:5173). Use 127.0.0.1 consistently because browser write requests require the configured exact origin. Synthetic seed creates four repeatable unassigned equipment records (laptop, monitor, mouse, keyboard) and reference records only. Bootstrap prompts for your first Admin email/name/password with hidden password input; there are no default accounts or bundled passwords. Sign in, enroll an authenticator, save recovery codes and accept portal access. Approve/invite Employee emails in People & access; local-demo notifications are captured in Mailpit at http://127.0.0.1:18025 instead of going to real recipients. Admin creates/assigns assets; Employee verifies details and opens tickets; staff replies and completes them. Admins use Master Control to manage departments, locations and shared asset/ticket options. Codes remain permanent; deactivate retired choices to preserve history. Workflow status labels can be renamed while their behavior stays fixed.

setup:local preserves an existing .env and generates random local DB/encryption/CSRF secrets otherwise. .env is excluded from source control and the delivery archive. Keep those keys to decrypt stored MFA/email envelopes. The generated local configuration uses the loopback Mailpit container for safe email testing. Existing .env files are preserved, so inspect existing SMTP settings before starting a demo. Production requires a separately approved real provider. Workbook loading is explicit and requires reviewed source exports and reconciled controls. Finance review is available. Admin creates asset details and may enter financial values as a draft. After Admin explicitly submits the current version, a separate Finance reviewer checks and approves the financial section. The submitter cannot approve their own record. Depreciation and accounting calculations remain pending policy.

If Windows reports that port 55432 is reserved, choose an available loopback port, set DB_PORT in your private .env, and use that same port in DATABASE_URL, MIGRATION_DATABASE_URL and TEST_DATABASE_URL. Restart the local containers and app; the named database volume is retained. Do not disable Windows port protections or remove the volume.

## Upload an asset register

1. Preserve the original workbook. As an Admin, open [Import review](http://127.0.0.1:5173/admin/imports), choose the 42- or 44-column register template, and prepare a single-sheet, values-only `.xlsx` or UTF-8 `.csv` with those exact headers. The 42-column layout omits `Comment Type` and both `Custodian Login ID` columns and retains `Column1`. Prepared staging JSON bundles remain supported.
2. Select the file and inspect its row count before choosing **Stage import for review**. Excel selection calculates the original workbook SHA-256 and a canonical CSV-values fingerprint. CSV selection calculates the selected CSV fingerprint; enter the approved original workbook SHA-256 separately. Files may contain 1 to 500 data rows and be up to 2 MiB, but the resulting staging request must be at most 60,000 bytes. Larger requests fail clearly; split them into separately fingerprinted source files while preserving the original workbook fingerprint. Prepared JSON is limited to 60,000 bytes.
3. Review the restricted batch. Use **Import / export form** for reconciliation values, a row-corrections Excel/CSV table, or the retained **Review controls (.json)** loader. Export the current correction draft or batch report when needed. Loading clears prior Finance/promotion approvals and submits no review. Inspect exact Asset IDs, known-cost total, missing-cost count, corrections and the review reason.
4. Explicitly approve pending Finance metadata, choose **Apply review and revalidate**, reconcile exceptions, then separately confirm **Promote eligible reviewed rows**. Existing assets are never overwritten; unresolved rows stay restricted. See the [transfer guide](docs/DATA_TRANSFERS.md#original-register-staging) and [import API examples](docs/API.md#import-contract).

Raw source fields are preserved in restricted staging. Imported financial values remain unapproved drafts pending separate Finance review. Missing comments/emails are not invented. Nonblank `Column1` remains quarantined as `UNMAPPED_SOURCE_FIELD`; employee names and Employee IDs never establish account identity. Only approved active, verified portal employees can receive imported custody. Portal acceptance and asset acknowledgement remain separate. Promotion queues custody notices through the configured SMTP outbox; delivery depends on the configured provider.

## Excel and CSV across business forms

Lists and details offer **Export Excel** and **Export CSV** within the signed-in user's access scope. List exports include all matching pages, with a 5,000-row cap that reports an error instead of silently truncating. Business forms offer **Import / export form**: download that form's template, select a one-row file, inspect its preview, choose **Load into form**, and then use the normal Save/Submit action.

**Bulk import** is available for Admin assets, custody, people, notification routing and Master Control, plus new support tickets for portal users. Download the module template, select up to 500 rows, enter a reason and choose **Validate import**. The preview shows valid and invalid rows. Explicit confirmation applies only valid rows and reports skipped invalid rows; current permissions and record versions are checked again. Email is off by default for these batches and must be explicitly enabled. Authentication credentials, portal acceptance and asset acknowledgements remain explicit individual actions; audit/history is export-only. See [docs/DATA_TRANSFERS.md](docs/DATA_TRANSFERS.md) for columns, actions, limits and register correction encoding.

Updating an existing installation requires migration 007 via `npm run db:migrate`. Production operators must reapply `infra/runtime-grants.sql` for the new restricted transfer provenance table.

## Assign assets to employees

As an Admin, open **Asset catalog → Assign asset** to choose equipment that is **In Store** without current custody. You can also use **Assign asset** directly on a catalog row. Select an eligible employee, optionally add a handover note, then choose **Confirm assignment**. The existing asset version and server authorization are checked before custody is saved. Assignment records history and queues the normal custody notification; the employee confirms receipt separately.

Recipients need an active Employee account, verified email and accepted portal access. **People & access** handles onboarding; loading more employees retrieves additional matching records. Existing custody offers **Transfer custody**, which requires a reason and a different employee. Employees can view their own assigned assets but cannot assign or edit catalog records.

If the chooser is empty, create an asset or complete the separate reviewed register promotion process first. Staged import rows are not yet inventory. Department setup is available in **Master Control → Departments**; department IDs and codes remain permanent.

## Master options

Master Control shows active entries by default. Migration 006 retires the `Unknown` condition and risk choices from new selections while retaining their permanent codes for historical records. Optional blank selectors show **Not set**. Data wipe keeps **Yes**, **No** and **Not Applicable**; missing source data is never filled with invented values.

## Asset details and laptop photos

Employees can view only assets currently assigned to them. Asset details and pictures are read-only; editing, assignment, return and photo upload are Admin actions, enforced by the API as well as the UI. Employees can still confirm receipt, report a discrepancy or raise a ticket without changing the asset record.

To add a laptop picture, open the asset as an Admin, find **Asset picture**, choose a JPEG or PNG (up to 10 MiB), inspect the local preview, enter **Photo change reason**, then choose **Save photo**. Selecting a file does not upload it. Saving replaces the current picture, advances the asset version and records an audit event. Photos are resized, stripped of metadata and stored privately in PostgreSQL. Employees see the saved picture for reference. Until a photo is added, laptop assets show a clearly labelled generic illustration.

Apply migration 005 with `npm run db:migrate` when updating an existing installation. Production migration owners must also reapply `infra/runtime-grants.sql`; photos are included in database backup and retention procedures. No public upload directory or external image host is required.

## QR labels and scan-to-report

Each asset has a QR label that opens `/a/<Asset ID>` in this portal. **Printing (Admin):** open **Print labels**, filter and select assets (**Not printed yet** finds new ones), choose A4 24-up, A4 14-up or a 50 x 25 mm thermal roll, set **Start at label #** to reuse a partly used sheet, then **Print** at 100% scale (no fit-to-page). After printing, choose **Yes, record print** so the catalog shows when each label was last printed. Up to 500 labels per run.

**Scanning:** staff can use the phone camera app or the in-app **Scan** button (falls back to typing the asset ID when the camera is unavailable). Signed-out users sign in first and return to the asset. Signed-in staff can see the current custodian's name, designation, department, assignment status and date, along with the asset's department and location. Email addresses, account IDs, handover notes and previous custodians are not shown on the scan page. Admins maintain designation and department in **People & access**. The scan page also offers **Report a problem**, which opens a ticket for that asset with up to 3 photos (resized on the device, metadata removed). Retired, lost or stolen assets cannot be reported from the scan page.

**Installing the app:** the portal is an installable web app. On Android Chrome use **Install app** in the top bar; on iPhone Safari use Share, then **Add to Home Screen**. The camera needs HTTPS (or localhost). The app needs a network connection; API responses are never cached offline.

Migrations 008, 010, and 011 add scan/ticket photo/label history, employee designation/department fields, and encrypted PWA push subscriptions. Run `npm run db:migrate` when updating an existing installation. Production migration owners must also reapply `infra/runtime-grants.sql`; ticket photos, label print history, and push subscriptions are included in database backup and retention procedures.

## Gmail SMTP setup

Use the private interactive helper for an approved Gmail/Google Workspace sender. Run `npm run email:gmail -- prepare` when no private draft exists, then `npm run email:gmail -- verify` to enter the Google app password in a hidden prompt and check authentication without sending mail. An existing prepared draft can go straight to verification. Activation is explicit and changes only SMTP settings; it does not restart the worker. See [docs/GMAIL_SMTP.md](docs/GMAIL_SMTP.md) for Google requirements, private files, activation and reachable invitation links.

The integration and browser runners use isolated test SMTP settings and do not use the operational SMTP credentials, so automated tests do not send external mail.

To resend a pending invitation, open **People & access → Staff accounts** and choose **Resend invitation** beside an **invited** account. The button queues a fresh invitation and replaces earlier invitation links. Active and disabled accounts do not offer this action. A queued confirmation records the request; actual delivery depends on the SMTP worker and provider.

## Checks

Create the isolated test database once after infra is up:

```powershell
docker compose --env-file .env -f infra/compose.local.yml exec -T db createdb -U iac_local iac_test
```

setup:local includes TEST_DATABASE_URL for iac_test. If an older .env lacks it, add the same local connection with only the final database name changed to iac_test. Never point tests at operational data. Then:

```powershell
npm run db:migrate -w @iac/api -- --test
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
```

Integration tests use real PostgreSQL and isolated SMTP test settings. Browser tests start their own API/worker/web against iac_test, not iac_dev, and create synthetic accounts with randomized passwords. Keep ports 3000/5173 free before browser tests. Local browser tests use installed Microsoft Edge; CI installs Chromium. Test artifacts may contain synthetic credentials in traces; they are excluded from delivery.

## Source map

- apps/api/src: authentication, security, SQL services/controllers, transactional domain and email worker
- apps/api/db/migrations: versioned database schema, immutable history/Asset ID triggers and source vocabulary
- apps/api/test: unit, HTTP authentication, SQL custody/import and worker recovery tests
- apps/web/src: named components, role dashboards, real forms and React Query API adapters
- test/system.spec.ts: real browser Employee/Admin workflows and security denials
- test/resend-invitation.spec.ts: synthetic browser checks for resend visibility, pending state and retry; run against an existing web server with `npx playwright test --config test/resend.playwright.config.ts` (all API calls are mocked)
- test/asset-photo.spec.ts: synthetic Admin photo upload and Employee read-only browser checks; run with `npx playwright test --config test/asset-photo.playwright.config.ts` against an existing web server (all API calls are mocked)
- infra: local PostgreSQL, SMTP configuration, container build and production proxy
- docs/API.md: implemented routes, examples and deliberate contract refinements
- docs/DATA_TRANSFERS.md: Excel/CSV form drafts, bulk templates, scoped exports and register review
- docs/PRODUCTION.md: configuration and deployment gates
- REVIEW.md and VERIFICATION.md: code review, fixes and actual checks

Employee access is current custody only; support history remains visible to the ticket reporter after return. IT/Admin can handle all tickets but cannot assign inventory or manage roles. Current roles are checked server-side. Portal notice acceptance and asset acknowledgement have separate evidence. Internal notes and private financial/source fields are excluded from Employee responses.

Stop local services with npm run infra:stop. This preserves the development database volume. Production must use approved hosting, TLS/domain, sender/groups, mapped employee identities, retention, restricted DB grants and restore/load testing. See docs/PRODUCTION.md; this repository does not deploy automatically.

Latest assignment checks (19 October 2026): 49 unit/API-boundary tests and all 19 Edge browser cases pass, along with lint, TypeScript and the production build. The 48 isolated integration results from the transfer release remain recorded; they were not rerun for this UI-only change. Browser results and limits are in VERIFICATION.md, and the independent review is in REVIEW.md. The existing test/system.spec.ts formatting warning remains pending; changed application source formatting passes.
