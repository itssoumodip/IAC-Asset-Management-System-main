You are the coding agent for the IAC Asset Management System. This is industry-level software; correctness matters more than speed.

## Status
Task 0 (Baseline) is DONE and verified by the owner: typecheck and lint clean, unit 329 + web 78, integration 209 pass with only the 3 known `data-transfers` failures.

## Your job
Implement **all remaining tasks (1 to 9)** of `docs/superpowers/MASTER-PLAN.md`, in order, without waiting for "continue" between tasks. Read MASTER-PLAN completely first, then every document it lists in section 1.

## How to run through the tasks
For **each** task, in order:
1. Re-read that task's section in MASTER-PLAN and the detailed plan it points to.
2. Write failing tests, then the code, until they pass.
3. Run `npm run typecheck`, `npm run lint`, `npm test`, and the integration test files you touched.
4. **Gate:** do not start the next task unless all of these pass. If you cannot make them pass after a real attempt, STOP and report (see below); do not skip ahead, do not weaken or delete tests.
5. Append the task report (MASTER-PLAN section 6 format) to `HANDOFF.md` under "Progress log", including what the owner should click to check it.

After Task 4, Task 7 and Task 9, also run the **full** `npm run test:integration` and `npm run build`. Only the 3 known `data-transfers` failures are allowed.

## Addition to Task 1
TECHNICIAN currently has `asset.view_all`, so technicians see every asset. A technician may see only the assets linked to tickets assigned to them, and never finance fields. Enforce in the API (asset list, asset detail, scan, export) with integration tests: a technician sees an asset on their own ticket, gets 404 for any other asset, and never receives purchase cost. Keep AUDITOR without `asset.view_private` and FINANCE with `report.view`.

## Defaults already decided (do not ask)
- Approvals: team members/leads edit their own team's assets directly; approval only when one role edits a field another role owns.
- Categories: Office Equipment and Security & ELV → IT; Projects may use Furniture, Kitchen Equipment, Electrical Equipment, Other; Team Leads add subcategories in their own categories; only Super Admin creates or moves categories.
- Tickets and SLAs: `plan-categories-and-page-fixes.md` section 2.10 defaults (impact × urgency priority, business-hours SLAs, 3-business-day auto-close, optional CSAT).
- Executive read-only everywhere; Store edits location/custody only; Procurement view-only; Auditor sees no prices.

## Stop only when
- A task's checks cannot be made to pass,
- The plan conflicts with the code in a way that needs a business decision,
- Or something needs real data, a secret or the client's answer.
In those cases, stop, write the report with the exact question, and wait.

## Rules (from MASTER-PLAN section 3, repeated because they matter most)
- Never rewrite `apps/web/src/components/Assets.tsx`; edit only needed lines; new UI in new files; typecheck after every `.tsx` edit.
- Never hand-pick asset codes in tests (`allocateAssetCode` or `createAsset`).
- Never set `environment: 'jsdom'` globally in vitest; use `// @vitest-environment jsdom` per file.
- Business rules are database settings with admin screens, not hard-coded.
- Permissions and field rules enforced on the server everywhere (lists, detail, exports, scan, dashboards, notifications).
- Migrations from 034, applied to both databases; grants in `infra/runtime-grants.sql`.
- No commits, no branches, no scrap files. Honest test numbers; never call a new failure "pre-existing".

## When everything is done
Run the full gate (`npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`), then give one final summary: each task DONE/BLOCKED, test numbers, migrations applied, and a short browser checklist per role.
