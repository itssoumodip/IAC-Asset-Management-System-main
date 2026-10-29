# Production operations

Production is a separate release gate. This local implementation must pass the checks recorded in REVIEW.md and VERIFICATION.md. Configure organization-approved sender, recipient groups, domain, region and retention. Never load the original workbook directly into employee-facing data; staging/reconciliation is required.

Use an immutable API image (infra/Dockerfile target api) and web image (target web). API and worker share the release; override worker command to its compiled entry point. Run reviewed migrations with separate schema-owner credentials before starting the runtime role. Use an external TLS load balancer and private PostgreSQL; web proxy /api goes to api:3000. The original incoming protocol must be preserved by the TLS proxy. Set correct trusted proxy hops and exact APP_ORIGIN. Secure cookies cannot be tested on an HTTP production origin.

Do not deploy compose.local.yml: it is localhost-only infrastructure. Use runtime credentials that cannot ALTER tables or DELETE assets/history; REVOKE UPDATE/DELETE on audit/events/ticket updates/email attempts. Account for the explicitly mutable session/token/outbox and push-subscription tables. Store the VAPID private key and database encryption keys in a secret manager, keep the VAPID pair stable, use encrypted backups, managed PITR and a tested restore procedure. Run a controlled migration account separately.

Monitor readiness, worker heartbeat, oldest pending delivery, dead letters and error rates. SMTP acceptance is not proof of inbox delivery. Use approved verified sender and per-recipient messages. Keep auth-email encryption and TOTP keys in a secret manager, separate from database backups. Rotate via a tested re-encryption/migration procedure, never by silently changing the key.

Before launch: MFA for staff, role/IDOR review, dependency/container scan, sender SPF/DKIM/DMARC setup, restored-backup verification, load test, approved employee mappings, cutover reconciliation and signed operational ownership. Financial reports remain pending Finance method/residual policy. Daily signed audit exports to external immutable storage are an operational integration and must be configured before a tamper-evidence claim.

Rollback images only across compatible expand/contract schemas. Never run destructive down migrations automatically. After live writes, preserve custody, ticket, audit and outbox delta before any restore; suppress outbound email during restore. No automatic fallback to a stale workbook.

Apply infra/runtime-grants.sql on the dedicated app database using its migration owner. It creates a NOLOGIN role; provision a login separately through managed secrets. API/worker must use that restricted role and migrations must use the separate owner. The permission boundaries are checked by a PostgreSQL integration test.


Master Control upgrade: apply migration 004 with the migration owner, then reapply infra/runtime-grants.sql. The runtime needs INSERT/UPDATE on departments and locations as well as reference_values. Existing records and stable codes are retained; do not recreate or truncate the database to upgrade.

Single-server Docker Compose + Caddy deployment: see [DEPLOY_SINGLE_SERVER.md](DEPLOY_SINGLE_SERVER.md) and `infra/docker-compose.prod.yml`.

## Disposable restore drill

`npm run verify:restore:test` only accepts a loopback database whose name ends in `_test`. Stop test writers first. It needs PostgreSQL client binaries matching the server major version and test-owner permission to create a disposable database. It dumps synthetic data to a private temporary directory, restores into a new randomly named `_test` database, compares complete-row digests and counts for the selected core/evidence tables, checks custody/reference invariants and attempts a forbidden Finance-evidence mutation. It never starts a worker or dispatches mail. It deletes the temporary archive/database in its cleanup path; a failed cleanup must be investigated.

The 28 October local PostgreSQL14 drill passed. This does not certify the PostgreSQL17 container path, production point-in-time recovery, backup encryption, key recovery or RPO/RTO. Those remain separate release gates. Never point this script at production or reuse synthetic archives as backups.

## Liveness and readiness

`/api/v1/health` remains a database-connectivity liveness probe. `/api/v1/ready` additionally requires migration023 and the Finance columns used by this release. It returns only a generic503 when unavailable; no schema names or connection details are sent to callers. The production compose API healthcheck now uses readiness. This is a minimal release-schema check, not a comprehensive database-integrity, SMTP or worker-liveness check.

The production environment helper validates a hostname and single sender address, accepts the Google app password only in a hidden terminal prompt, creates a mode0600 file and never prints generated secrets. It does not verify sender ownership/provider policy or deploy anything. Back up keys through your approved secret manager, not terminal logs. `npm run test:setup` runs a disposable dummy-secret regression for these properties.

## Runtime dependency smoke

The API Docker image now runs `node scripts/verify-runtime.mjs` after its production-only, script-disabled install. The smoke uses generated synthetic input to check Argon2 hash/verify, Sharp JPEG encoding, XLSX extraction and text-PDF extraction from the compiled API. It touches no database, mailbox or outside service and fails the build if the selected native/optional dependencies do not work. Run it after `npm run build -w @iac/api` for a manual check.

A clean local Node24 `npm ci --omit=dev --ignore-scripts` install passed this smoke on 29 October. Docker is unavailable in the review environment, so the actual Debian image build, PostgreSQL17 compose start and target architecture still need their own release verification. A smoke on the developer host is not that verification.

## Upload envelope limits

The API allows up to6MiB of JSON only for designated upload routes with an allowed origin and a session-cookie field; ordinary routes/anonymous requests keep64KiB and ticket creation keeps1.5MiB. This cookie precheck only selects the parser budget, not authentication: normal sessions/CSRF/role checks still apply. Private invoice bytes remain capped at4MiB, with base64/JSON overhead inside6MiB. nginx's API fallback now permits the same6MiB envelope instead of rejecting valid invoices above2MiB; primary Caddy API routing goes directly to Node. Integration checks exercise actual6MiB errors, large in-budget schema rejection, and a cookie-name substring that must not enlarge the anonymous budget. A static proxy-route regression is not an executed nginx/container test.

## Database work budgets

Application connections now use PostgreSQL server-side budgets:30seconds per statement,5seconds waiting for locks and30seconds idle inside a transaction. Failed transaction work rolls back; a statement/lock/serialization/deadlock conflict returns a generic busy/review/retry response instead of exposing SQL. No automatic replay of arbitrary mutations is added. Stocktake snapshot creation has its own narrow serialization retry. A lost HTTP response may still mean a write committed, so check current state and retain existing idempotency keys when retrying. These budgets are safety limits, not throughput or latency commitments. Integration checks verify actual settings, timed statement rollback and lock contention/release.

Migrations use the same connection class and are bounded per statement as well. Review unusually large data migrations against a staging copy before release; do not disable limits on live traffic to make an unreviewed migration run. PostgreSQL connection setup/query cancellation remains separate from SMTP timeouts, and no lock is held while waiting for SMTP.
