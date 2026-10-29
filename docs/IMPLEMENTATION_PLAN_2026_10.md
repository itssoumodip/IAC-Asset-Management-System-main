# Manager demo implementation plan

## Scope and guardrails
Improve this existing application through reviewable source changes. PR creation is explicitly held until the user asks. Preserve custody/history and permanent IDs. Synthetic demo/test data only. No upstream merge, paid hosting, production credentials or claim of certified multi-tenant SaaS/50k capacity.

## Ordered delivery
1. Restore a trustworthy baseline: fix stale final-admin regression payload and add required-reason coverage; run fresh lint/type/unit/build and database-backed checks.
2. Add Finance and Executive roles, with server-enforced least privilege. Finance reviews versioned asset financial submissions; executives receive read-only aggregate reports, not administrator powers.
3. Add a Finance queue and submit/approve/return interactions, audited transitions, explicit confirmation and concurrency guards. Approved financial records require a new submission for correction. Existing Admin field editing cannot silently bypass the Finance state.
4. Add role-appropriate Finance and Executive navigation/dashboard UI and regression tests for authorization, stale edits, validation, amendment and report reconciliation.
5. Fix notification history/unread pagination with explicit server filtering and load-more controls; add regression tests.
6. Run integration and browser interactions with synthetic data and local mail sink. Inspect screenshots at mobile and desktop. Profile a synthetic 50k dataset only if an isolated database is working; publish exact measurement conditions and gaps.
7. Update setup/release/demo documentation and deliver reviewable source plus a clear tested/not-tested summary; do not create the PR until the user asks. Any remaining dependency/security/performance/SaaS gates remain explicit.

## Not solved by naming it SaaS
Tenant isolation, tenant lifecycle, billing, custom domains, SSO provisioning, availability commitments, disaster recovery and accounting policy require separate acceptance. This release is a single-organization demo improvement, not a production SaaS certification.

## Demo acceptance
Admin registers/submits an asset; Finance sees pending work and approves or returns with a reason; Executive sees aggregate approved/pending coverage without write powers. Existing custody transfer remains intact. API tests deny forbidden direct requests. No real notification is sent. Proposed performance targets are not pass results until actually measured.
