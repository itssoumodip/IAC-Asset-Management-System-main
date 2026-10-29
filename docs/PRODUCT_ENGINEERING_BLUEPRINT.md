# IAC product engineering blueprint

Updated 28 October 2026, 21:42 IST.

## Build an operating system for company assets

The target is a company-grade asset and service platform, not a larger asset spreadsheet. This blueprint defines the full product, the access boundaries and the evidence needed before each release.

### What good looks like

**One traceable asset record**

Every asset has a permanent identity, current custodian, location, condition, financial review state and chronological evidence. Changes answer who, what, when and why. Registration, approval, custody and disposal are different decisions, not one editable status field.

**A different workspace for each job**

Employees see their equipment and requests. IT works the service queue. Registrars control the catalog and custody. Finance owns reviewed financial records. Executives see governed summaries, not administrative powers. Auditors inspect evidence without editing it.

**Reliable work at company scale**

Imports preview before commit; concurrent actions cannot overwrite each other; long lists page correctly; notifications have delivery evidence; failures are visible and recoverable. A 50,000-asset target must be measured with histories, attachments and concurrent users.

### Current implementation truth, 28 October

**Already present in the reviewed base**

NestJS/PostgreSQL API and React portal; Admin, IT Admin and Employee roles; MFA for privileged accounts; portal acceptance; asset catalog and QR labels; custody assignment/transfer/return with history and version checks; support tickets; master data; import review; audit records; SMTP outbox/retries; push and in-app announcements. Existing does not mean every path has been verified.

**Being improved for the demo**

Implemented in the feature branch: Finance and Executive roles, independent Finance review and amendments, approved-cost executive metrics, person-first Admin/Finance/Employee equipment views, server-paged unread notifications and Admin-only delivery health. Fresh local tests cover the incremental laptop then mouse mapping, role boundaries and retry evidence. This is verified single-organization demo work, not a complete SaaS release.

**Missing release gates**

No claim of proven multi-tenant isolation, enterprise SSO/SCIM, configurable approval routing, procurement/budgets, policy-approved depreciation, tested disaster recovery or production service-level capacity. Those are distinct product and infrastructure releases, not branding changes.

### Person-first equipment, one source of truth

**Admin adds a mouse to an existing laptop owner**

Open People & equipment, select the employee, choose Assign another item and select the available mouse. Confirm the visible recipient before assigning. The laptop assignment ID and version stay unchanged; the mouse becomes a separate current item for that same person. An incremental browser regression checks every step and another person’s equipment remains untouched.

**Finance and Employee views**

Finance sees linked items and reviewed-cost status without custody write actions. Employees see only their own items, confirm receipts and raise an item-specific issue. Admin-only custody powers are preserved; IT Admin remains the existing support role.

**Delivery evidence without exposing secrets**

Admin can filter pending, leased, SMTP-accepted and dead deliveries, inspect safe attempt codes, and spot late retries or expired leases. Message bodies, tokens and encrypted payloads are excluded. SMTP accepted does not mean inbox delivered. No blind resend action is included.

### Connected now versus configurable later

**Real application connections**

The implemented screens call the real local API and isolated PostgreSQL. Browser tests check persistence and role-separated views. The SMTP worker connects to a local fake-mail sink for tests, not real company recipients. HR, ERP, accounting, identity-provider, discovery and billing services have not been invented or connected.

**Configuration that exists today**

Departments, locations and reference values can be managed. Existing fixed asset/user/ticket fields, typed import templates, announcement audience/content and SMTP settings can be configured within their existing rules. This is not an arbitrary custom-field or approval engine.

**Still a roadmap, not a completed feature list**

Custom field schemas, configurable approval routing, editable/versioned operational email templates, SLA calendars, accounting policies, tenant isolation and billing remain missing. The repository feature-status matrix names current capability, existing configuration and later gaps separately.

### Delivery contract and release gates

**Demo release: by 29 October, 08:50 AM IST**

Target one coherent verified vertical slice with real database/API/browser evidence, reviewable fork PR, setup instructions, demo fixtures, screenshots and known issues. No upstream merge, live company data, paid deployment or real outgoing mail. Completion is acceptance-test based, never a percentage claim.

**Company pilot: after the demo**

Harden role boundaries, email templates and delivery visibility, operational monitoring, restore drills, permission review, onboarding and import reconciliation. Pilot with a named owner, a limited department and rollback criteria. Do not put company-wide records into an unverified environment.

**Enterprise/SaaS release: separate program**

Tenant boundaries, SSO, lifecycle provisioning, policy routing, retention, disaster recovery, support operations, performance envelopes, compliance review and commercial operations. Each needs a written acceptance gate, not an assumed overnight promise.

### Proposed policies, not settled decisions

**Recommended defaults**

Deny access unless granted; separate registrar and Finance reviewer; no self-approval; executives are read-only; require reasons on financial, custody and privilege changes; retain old evidence; use soft retirement rather than deleting assets; show unknown data as unknown.

**Decisions the organization must own**

Who may approve purchases/disposals, approval thresholds, reassignment authority, employee visibility across departments, ticket SLA clocks/escalation recipients, depreciation method and useful lives, tax treatment, fiscal periods, data retention, recovery targets and identity provider. Implementation may propose safe defaults but must not silently establish company accounting or HR policy.

## Who can see and do what

Use explicit permissions behind each screen and API. Hiding a button is not authorization. Roles may be combined, but a combined role must not bypass self-approval or departmental boundaries.

### Role-specific viewpoints

**Employee / custodian**

Home: my assets, pending acknowledgements, my tickets and notifications. Read own active custody, safe scan information and own ticket history; acknowledge assignment, report an issue, add public updates and request return/transfer. Cannot see purchase costs, all employees, internal IT notes, other people’s tickets, approval controls or bulk export. Existing base role; return/transfer request approvals are a later policy workflow, not an unrestricted employee action.

**IT technician / service lead**

Home: assigned/unassigned tickets, aging work, priority, blocked requests and asset service history. Claim/reassign tickets within policy; record diagnosis, public/internal updates, resolution and evidence. Technical edits should be limited to approved technical fields. No user-role administration, Finance approval or financial exports. Existing IT_ADMIN grants broad ticket visibility; department/team scoping and lead-versus-technician split need a later release.

**Asset registrar / asset manager**

Home: inventory quality, unassigned stock, acknowledgements, movements and Finance handoff. Register/import assets, maintain technical catalog, assign/transfer/return custody, print labels and submit Finance amendments. Cannot self-approve Finance. Current ADMIN performs these tasks but also has wider powers; a separate ASSET_MANAGER permission set is the recommended pilot split.

**Finance reviewer / controller**

Home: submitted and returned records, missing invoices, amendments and approved financial coverage. Read necessary asset/invoice fields; approve or return with a reason; amend through a new review cycle. No custody moves, ticket internals, user-role edits or catalog-wide technical changes. Demo role FINANCE is being built; later add document evidence, batch review controls, approval limits and accounting exports.

**Executive / CEO / CFO viewpoint**

Home: approved acquisition value, Finance coverage, operational exposure, utilization and service health. Read aggregate trends with definitions, freshness and authorized department drill-downs. No mutation controls, private employee details or internal ticket text. CFO access to detailed finance exports is a separate permission, not implied by EXECUTIVE. Demo summary role is being built.

**Department manager**

Home: department equipment, requests, custody exceptions and service/SLA risks. Approve team requests only where policy grants it; see department summaries, not organization-wide financial/personnel exports. Proposed later role with explicit department membership and delegated approval limits.

**Auditor / compliance**

Home: evidence search, lifecycle chronology, approval trail, custody reconciliation, privileged changes and export manifests. Read-only, time-bounded, scoped export permission with redaction and an export audit event. Proposed later role; never reuse ADMIN just to provide evidence access.

**Organization administrator**

Home: people/access, masters, integration settings, policies, failed jobs and security review. Invite/disable accounts, assign approved roles, revoke sessions and maintain organization settings. Existing ADMIN; preserve final-active-admin safety. A security admin’s power to grant roles is separate from permission to approve their own business transaction.

**SaaS platform operator**

Separate control plane for tenant provisioning, service health, subscription state and support tooling. No routine access to tenant records. Break-glass access needs customer approval, expiry and an auditable reason. Not present; never implement as an unrestricted cross-company Admin account.

### Permission and data model

**Enforce four dimensions**

An action permission (asset.read, custody.transfer, finance.approve, ticket.assign, user.role.manage, audit.export), a resource scope (own/team/department/organization/tenant), a field policy (technical/financial/personnel/internal note), and a workflow condition (state, version, reviewer independence, approval limit). Check all four on the server and on export/download endpoints.

**Guard the boundaries**

No direct-object-reference leaks through IDs, QR scans, photo downloads, exports, reports or cached pages. Privilege changes revoke stale sessions. Test every role against every mutation and sensitive read. Finance/Executive require privileged MFA without inheriting IT support access.

**Account lifecycle**

Approved identity/invitation, email verification, required MFA, portal acceptance, first-run role home, role changes with reason, deactivation, session revocation and custody reassignment review. SSO/SCIM later must preserve audit identity and avoid duplicate employees.

## Workflows, screens and communication

Design the entire path, including what happens when a person is absent, a record changes or delivery fails. The following is the target product map; only the marked demo slice is an overnight implementation target.

### Asset lifecycle and approvals

**Request → procure → receive**

Target: employee/department request with justification; policy-based approver; procurement order/vendor reference; receiving inspection and invoice evidence; duplicate serial/barcode detection; permanent asset code. Base starts at catalog creation/import. Procurement, budgets, purchase approval and vendor management are later modules, not Finance cost review.

**Register → Finance review → approve**

Demo: registrar creates a catalog record and submits its current version with a reason. Finance sees the queue and necessary fields, enters/verifies INR cost/date/invoice/supplier, then approves or returns with a reason. Different reviewer required; concurrent/stale versions rejected. Preserve evidence on every transition. Later: invoice attachment malware checks, approval thresholds, batch review, re-review deadlines and delegated reviewers.

**Assign → acknowledge → transfer → return**

Preserve existing locked/versioned custody. One open assignment per asset. Transfer closes the old assignment and records the new holder, actor and reason. Pending acknowledgement and disputed custody must be visible. Later: approved employee requests, handover checklist/signature, due dates, loan/lease reservations, offboarding reconciliation and overdue escalation.

**Maintain → audit → retire → dispose**

Tickets link to assets and service evidence. Target: maintenance schedules, warranty/AMC reminders, stocktake campaigns, found/missing reconciliation and exception ownership. Disposal requires independent approval, financial write-off policy, data-wipe evidence, vendor/certificate details and final immutable history. Base has status/date fields, not proof of a complete disposal approval program.

**Amendment and correction**

Do not silently overwrite approved financial history. Demo keeps last approved financial snapshot in executive totals while a new amendment is submitted/reviewed. Registrar cannot bypass review with ordinary financial edits after submission. Corrections require reasons, versions and chronological events. Later add period locks, reversal/correction policy and financial evidence export.

### Service desk ownership and escalation

**Raise and triage**

Employee enters subject/category/priority, asset link, description and allowed evidence. Show confirmation and a ticket number; avoid duplicate submissions. IT triage verifies category/impact/urgency and assigns an owner. Target required owner or explicit unassigned queue, team routing and acknowledgement clock. Base has tickets and ownership/status, not a configurable service catalog.

**Work, communicate and resolve**

Statuses need legal transitions, an accountable owner, public updates separated from internal notes, safe attachments and an explicit resolution. Target waiting-on-user/vendor states, linked problems/changes, reopen window, customer acceptance and knowledge articles. Do not mark completed just because an email was sent.

**SLA and escalation policy**

Propose clocks for first response and resolution by impact/urgency, business hours/holidays, paused-state rules, reminder/escalation ladder and backup owner. Show due/breached status and audit timer changes. Exact clock lengths and recipients require company policy; do not invent a one-hour SLA or send managers unsolicited mail.

### Email and notification product

**Template catalog and preview**

Target versioned branded templates with subject, plain text and accessible HTML, variable validation, safe URL construction and preview using synthetic data. Templates: invite, verify/reset, assignment/acknowledgement, transfer/return, ticket created/assigned/public update/resolved/reopened, Finance submitted/returned/approved/amended, warranty due, import summary and delivery failure. Existing code has event-specific text payloads and outbox template labels; a template-management screen is missing.

**Example message contracts**

Finance returned: asset code, reviewer-visible correction reason, safe portal link, no unrelated invoice/personnel data. Assignment: asset identity, holder action and due policy, no purchase cost. Ticket update: ticket number and public update only; never internal notes. Reset/invite: expiring single-use link, no password. These are proposed content contracts, not messages authorized for live delivery.

**Delivery operations**

Existing SMTP worker has queued deliveries, attempts, retry delays (1, 5, 15, 60, 360 minutes), recipient/event evidence and deduplication keys. Target visible queued/sent/failed state, dead-letter review, manual safe retry, provider IDs, bounce/complaint ingestion, suppression and per-tenant rate limits. Queued is not delivered, accepted by SMTP is not read.

**In-app history and preferences**

Demo priority: cursor pagination so old unread announcements remain reachable, total/unread counts across the complete authorized scope, idempotent read actions and attachment authorization. Later: transactional versus optional preferences, channel choices, digest/timezone settings and quiet hours. Security/approval messages must not disappear because marketing notifications are disabled.

### Screens and UX acceptance

**Workspace map**

Employee home / my equipment / ticket form / ticket detail; IT service queue / work detail; registrar catalog / asset detail / custody / imports; Finance queue / review / history; executive summary / department comparison; Admin people / masters / policies / delivery health / audit. Screens must explain why an action is unavailable and link to the next owner, not expose forbidden controls.

**Every screen must handle real states**

Loading, empty, partial/unknown data, validation, no permission, offline, session expiry, stale version, pending action, success and retryable failure. Preserve entered work on errors. Confirm high-impact actions with a clear summary and reason. Responsive forms/tables, keyboard focus, labels, contrast and reduced-motion support are acceptance criteria.

## Engineering, verification and release

A feature is complete when it is usable, permission-safe, observable and recoverable. This backlog separates functional breadth from production evidence.

### Real company data and configuration

**Configuration without a code fork**

Target organization-owned configuration for departments/locations, asset categories/types/status labels, ticket taxonomy, business hours, required fields, notification templates and approval routing. Version every configuration change, preview its effect and protect reserved system states. Existing reference masters are a foundation; arbitrary custom fields and workflow builders are not already present.

**Custom fields with governance**

Propose typed fields (text, number, date, enum, reference), per-category applicability, required-at-stage rules, role-level visibility, validation, searchable/indexed choices, export labels and retirement without deleting historical values. Do not allow unbounded free-form JSON to become an unqueryable substitute for a schema. Changes need migration/compatibility tests and a field owner.

**Import real data safely**

Use a mapping wizard, sample validation, duplicate detection, preview/quarantine, provenance, actor-bound commit, reconciliation totals and an error workbook. Preserve original values alongside normalized data. Support unknown/missing values honestly. Base has transfer previews and quarantine/import evidence; add mapping/configuration only with tested limits. Current source transfer cap is 500 rows and browser export cap is 5,000; larger jobs need an asynchronous path, not a hidden truncated result.

**Policy rules must be constrained**

Use a validated rule model with allowed fields/operators, explicit priority, fallback owner, escalation path, simulation and versioned effective dates. Examples: cost threshold needs two reviewers; department request routes to its manager. These are proposed examples, not approved company rules. Prevent cycles, self-approval and a configuration change granting its author new approval authority.

**Public product patterns, not blind copying**

Learn lifecycle/financial administration and service-desk breadth from AssetExplorer and GLPI, and custody/asset accountability patterns from Snipe-IT. Reuse public ideas; inspect license and security before reusing code. Public search and opened sources identify github.com/morluto/rea and rea.tools as a matching REA: Reverse Engineer Anything project. This is a grounded candidate, not confirmation of the exact repository intended. No package has been installed or run. Its analysis framework is optional; it does not replace company requirements or acceptance tests.

### Reporting and financial truth

**Governed reporting**

Asset register with as-of filters; custody/department/location reconciliation; Finance pending/returned/approved coverage; asset aging, warranty/AMC, missing data; ticket ownership, aging and SLA; audit and import exception reports. Filtered exports need the same authorization as the UI, recorded actor/filter/time and row limits or background jobs.

**Accounting boundaries**

Demo uses INR approved acquisition cost, not spend, budget variance or net book value. Last approved snapshot stays in totals during amendment. Depreciation needs policy-approved methods, useful lives, residual values, capitalization thresholds, in-service dates, fiscal calendars, disposal/revaluation and period locking. Do not calculate convincing but unapproved financial figures.

**Executive trust**

Show metric definitions, scope, freshness, missing-data counts, drill-down permission and approved versus provisional values. Avoid employee-level data in summary access. Compare periods only when the source history supports them; do not invent historical trends from current rows.

### Security and recovery

**Access and application controls**

Deny-by-default server policy; MFA for privileged roles; final-admin protection; CSRF/session/cookie hardening; rate limits and audit; validation/parameterized SQL; file type/size/image sanitization; least-privilege runtime DB role; no secrets committed. Review dependency advisories with compatible upgrades and rerun regression suites.

**Operational readiness**

Structured request IDs and error logs, health/readiness checks, queue age/failure metrics, DB pool saturation, slow-query tracking, alert ownership and deployment rollback. Use migration backups and compatibility checks. Backups are not recovery proof: restore into a fresh environment and verify assets, custody, approvals, attachments and mail evidence.

**Recovery and retention decisions**

Set company-owned RPO/RTO, backup encryption/retention/location, restore drill frequency, incident contacts and audit/data retention. Test accidental role removal, failed migration, SMTP outage, corrupted/missing attachment and database outage. Avoid irreversible deletion while retention/legal requirements are unresolved.

### SaaS architecture gates

**Tenant isolation before onboarding companies**

Choose tenant model explicitly. A shared-schema design requires tenant keys on every relevant table, tenant-scoped unique constraints/foreign keys, server-side tenant resolution, query enforcement or RLS, tenant-bound jobs/files/cache/session contexts and cross-tenant attack tests. Existing organization-wide data cannot be called multi-tenant because it has departments.

**Tenant administration and service operations**

Provisioning, domains/SSO, memberships, policies, export/delete/retention, quotas, audit access, billing/entitlements and support are separate control-plane concerns. Meter resources without disclosing customer records. Billing/payment processing and paid services require a later explicit business decision.

**Scale and resilience**

Synthetic benchmark target: 50,000 assets plus realistic assignments/events/tickets and concurrent role workflows. Measure page/query p50/p95, response size, import throughput, queue delay, DB CPU/IO and explain plans under documented hardware/data/concurrency. Add indexes based on plans, use cursor pagination and background exports. A local 50k test proves only those conditions, not production capacity or availability.

### Verification matrix and acceptance gates

**Authorization and privacy**

Positive/negative tests for every role and sensitive endpoint; employee isolation, Finance-versus-IT boundaries, executive read-only access, attachment/export authorization, session revocation, MFA and no self-approval. Later cross-tenant tests must cover direct IDs, aggregates, jobs and storage, not only list endpoints.

**Workflow and concurrency**

Create/submit/return/resubmit/approve/amend; required reason and finance fields; future/invalid dates; double submit; duplicate retry; stale asset/review versions; simultaneous reviewers; rollback on failure; approved totals while amendments wait. Preserve one-open-custody and existing transfer/acknowledgement regression tests.

**Notification and import reliability**

Old unread item beyond first page; cursor tie ordering; total/read counts; unauthorized attachment; SMTP failure/retry/deduplication; no internal notes in mail; no real outbound test messages. Import limits, preview side-effect freedom, duplicate identities, actor binding, atomic commit and idempotent receipt.

**Browser and demo checks**

Run actual role screens and interactions with a database, not mocks alone. Inspect desktop/mobile pixels; keyboard navigation, required fields, error/retry states, stale conflicts and hidden forbidden actions. Test build/setup from a clean clone and record exact versions, command results and known failures.

### Ordered implementation and handoff

**Now: foundation plus a verified vertical slice**

Repair baseline tests and establish isolated DB/fake mail; implement Finance/Executive migration/API/UI; add permission/concurrency/history tests; fix notification pagination; make compatible security fixes; run real browser checks. Expand only after the critical slice is verified. Preserve existing custody behavior.

**Before the 08:50 delivery cutoff**

Freeze risky feature work early enough for final tests. Deliver fork PR without merge, migration/setup/demo instructions, synthetic fixtures, screenshots, measured results and a clear completed/incomplete checklist. If a feature fails verification, label it unfinished or exclude it from the demonstrated path. A known red test is never represented as green.

**Next release backlog, in order**

1. Split registrar/security admin, harden privacy, delivery health and recovery. 2. Policy routing, SLA ownership/escalation, email template catalog, evidence documents and approved reports. 3. Stocktake/offboarding/maintenance/disposal approvals and procurement. 4. Tenant isolation, SSO/SCIM, service operations and commercial readiness. Reorder with company risk and pilot feedback, not feature-count targets.

### Evidence and reference basis

**Code basis**

Original base commit a16ff287ac9bfdb0fa76eb7d71845efc18104f58, reviewed on 28 October 2026. API: auth/security, domain assets/tickets/import, data transfers, db/outbox, worker, notifications and dashboard modules; web role routes/screens; migrations and runtime grants. Work-in-progress implementation is separate from reviewed-base capability.

**Fresh checks so far**

Checkpoint 28 October, 21:31 IST: 94 real DB/API integration tests, 27 API unit tests, 62 web unit tests and all 32 Chrome browser tests passed. Lint, TypeScript and production build passed. Test counts are evidence for exercised paths, not proof of all future workloads. No production data or real outgoing mail was used.

### Measured scale checkpoint, not a capacity promise

**50,000 synthetic assets, rolled back**

One local PostgreSQL 14 connection, warm-cache query probe, 20 samples per query. The actual catalog projection/order had p95 1.97 ms; exact asset lookup 0.18 ms; matching contains-search predicate 16.99 ms; status counts 6.42 ms. Source script and EXPLAIN evidence are included in the branch.

**What remains unproven**

No concurrent HTTP users, production hardware, large histories, photos, imports, backups or recovery in this query probe. Contains search still scans rows. Tenant isolation, billing, SSO, policy-approved finance and configurable routing remain separate SaaS release gates.

