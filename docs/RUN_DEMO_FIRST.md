# Run the manager demo locally

Windows laptop: start with [Windows demo setup](WINDOWS_DEMO.md) for the minimal prerequisite check and PowerShell commands.

Use the complete source ZIP delivered with this checkpoint. The partial GitHub feature branch is not the runnable delivery. This is a local, single-organization demo with synthetic records, not a deployed production system.

## Before the meeting

You need a laptop with Node.js 24, npm, Docker Desktop/Engine running, an internet connection for the first dependency/container downloads, and a time-based authenticator app. The local commands can use Windows PowerShell with npm.cmd; only the Unix production helper needs a Unix shell. The source does not include default passwords, real company records, a hosted URL or a prepared login.

Check in a terminal:

```sh
node --version
npm --version
docker version
docker compose version
```

Node must report v24.x. Docker must show a responding server, not just an installed client. If one check fails, stop and fix that prerequisite before the meeting. Docker/container startup on PostgreSQL 17 has not been exercised in the delivery environment; do not assume it works because local PostgreSQL 14 tests pass.

## First setup

Extract the full ZIP into a new folder. Open a terminal in the folder containing package.json.

```sh
npm ci
npm run setup:local
npm run infra:up
npm run db:migrate
npm run seed:synthetic
npm run admin:bootstrap
npm run dev
```

Keep the final terminal open. Setup generates private local secrets, and preserves an existing .env. Use a new extracted folder to avoid accidentally reusing an operational configuration. Do not paste .env, passwords, authenticator setup keys or recovery codes into chat or a recording. Never point the test/demo commands at company production data.

Bootstrap asks for an email, display name and a new password of at least 12 characters in an interactive terminal. Password input is hidden. No email is sent by bootstrap. Synthetic seed creates four unassigned items (laptop, monitor, mouse and keyboard), departments and a location. Repeating the seed preserves the existing synthetic items rather than adding duplicates.

Open http://127.0.0.1:5173 on this same laptop. Always use 127.0.0.1, not localhost, because write requests validate the exact origin. Sign in using your new Admin account. Click Set up authenticator, add its setup key to your authenticator app as a time-based account, enter the current code, save recovery codes privately, then continue and accept the portal notice. After setup, take a minute to sign out and back in before presenting.

## Prepare the story, not live company data

In People & access, invite synthetic Employee and separate Finance/Executive accounts using distinct example.org addresses. Inspect their invitation messages in local Mailpit at http://127.0.0.1:18025. Mail goes only to this fake sink in the fresh generated configuration. Invitations start with Employee access. Select the synthetic account in People & access, add FINANCE or EXECUTIVE in the role controls with an explicit reason, then save. Each privileged account enrolls its own authenticator. Do not give the submitter the reviewer's account or bypass the independent reviewer check.

Admin can use the seeded mouse/keyboard or create additional items in Asset catalog, select the synthetic employee in People & equipment, and assign each item explicitly. Finance review requires the Admin to submit an asset version before the separate Finance account approves or returns it. Executive totals include approved acquisition cost only, not depreciation or book value. Use separate browser profiles/private windows to avoid swapping the wrong session while presenting. The detailed walkthrough is in DEMO_HANDOFF_2026_10.md.

No laptop-to-phone sharing is configured. A phone cannot open the laptop's 127.0.0.1 address. A hosted or network-accessible demo requires an approved environment and security setup; this delivery does not silently create one.

## Health checks and restarting

- Application: http://127.0.0.1:5173
- API schema readiness: http://127.0.0.1:3000/api/v1/ready must return status ready (HTTP 200).
- Fake inbox: http://127.0.0.1:18025
- Stop app processes with Ctrl+C. Stop containers with npm run infra:stop. The named DB volume remains. To restart, run npm run infra:up then npm run dev. Do not delete the volume or encryption keys to troubleshoot a login.
- If ports 5173, 3000, 55432, 11025 or 18025 are already busy, stop the conflicting local service before setup. Do not expose the DB, Mailpit or dev server to the public internet.

## What was verified

At the 28 October 2026 22:50 Asia/Calcutta checkpoint: 104/104 real PostgreSQL/API integration tests, 35/35 browser tests, 27 API unit tests and 62 web unit tests passed. A further fresh-Admin browser test verifies password sign-in, authenticator enrollment from the shown setup key, recovery-code save gate, portal notice and a second sign-in using one recovery code. These tests use synthetic accounts and local PostgreSQL 14. Interactive bootstrap was separately exercised through a real terminal against a fresh disposable database after all 18 migrations. It created only Admin/Employee roles and left MFA/notice completion required. User laptop prerequisites, PostgreSQL 17 containers and production HTTPS remain separate checks, not assumed results. No production data or real outbound email was used.

Latest 23:25 verification: 107/107 API/PostgreSQL integration tests, 27 API unit, 62 web unit, 2 setup checks; lint/typecheck/build passed. Browser checks passed as 37 workflow tests plus a separate 4-test expanded audit, including 70 role/viewport visits and narrower phone/tablet forms. See DEMO_HANDOFF_2026_10.md for exact scope and the local PostgreSQL JIT dependency caveat. These do not verify this Windows laptop or PostgreSQL 17 containers.
