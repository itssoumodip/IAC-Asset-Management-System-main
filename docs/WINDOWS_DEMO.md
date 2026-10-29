# Windows demo setup

This is the Windows-specific route for the complete source ZIP. It has not been executed on Windows. Application, database and browser workflows were verified on Linux with Node 24 and PostgreSQL 14. Docker Desktop/PostgreSQL 17 startup and native Windows dependencies still need a check on your laptop.

## First, check only the prerequisites

Open Windows PowerShell from Start. Run these one at a time; no administrator terminal is needed for these checks:

```powershell
node --version
npm.cmd --version
docker version
docker compose version
```

Node must show v24.x. Docker must report both client and server. If a command is missing or Docker's server cannot connect, send a screenshot of these version results only. Do not send passwords or .env. You do not need to guess what is installed.

If installation is needed, use the official pages:

- Node.js: https://nodejs.org/en/download . Choose version 24 LTS and the Windows installer matching your computer, not a different major version. Close/reopen PowerShell after installation.
- Docker Desktop: https://docs.docker.com/desktop/setup/install/windows-install . Start Docker Desktop after installation and use Linux containers. WSL 2 may need enabling/updating and a restart. Follow your company's IT policy; do not bypass blocked installation or hardware virtualization restrictions.

Docker Desktop is not automatically free for every work use. Its published terms require a paid subscription for larger enterprises and government entities. Check your organization's eligibility or existing license before accepting terms or installing. No purchase or license acceptance is included in this delivery.

Docker's WSL 2 backend can expose docker commands in ordinary Windows terminals without a separate Ubuntu installation: https://docs.docker.com/desktop/features/wsl/ . You can run the local demo commands below from PowerShell. A separate WSL terminal is only an alternative, not an extra required app setup step.

## Extract and start

Use File Explorer's Extract All on the complete ZIP. Do not run inside the compressed folder. Open the extracted folder containing package.json, right-click its blank area and choose Open in Terminal (or open PowerShell there). Keep it in a normal local folder rather than a synchronized/network drive.

Run one line at a time. Stop if a command reports an error. Do not continue down the list after a failed step.

```powershell
npm.cmd ci
npm.cmd run setup:local
npm.cmd run infra:up
npm.cmd run db:migrate
npm.cmd run seed:synthetic
npm.cmd run admin:bootstrap
npm.cmd run dev
```

The explicit npm.cmd avoids PowerShell trying npm.ps1 under a restrictive script policy. Do not change execution policy or run an unreviewed downloaded script. No double-click launcher, administrator rights escalation or automatic software installation is required by this runbook.

The first dependency/container downloads need internet. Bootstrap asks for your new Admin email, display name and a new password (12+ characters, hidden while typing). There are no default accounts. Keep the final terminal running and open http://127.0.0.1:5173 in Edge or Chrome on this same computer. The local fake inbox is http://127.0.0.1:18025 . Do not use localhost interchangeably with the configured origin.

Complete authenticator enrollment and save recovery codes privately, then accept the portal notice. See RUN_DEMO_FIRST.md for the demo story, separate Finance/Executive accounts and how to restart. Never share .env or authenticator keys. No company email is sent by the generated fresh local configuration. Existing .env files are preserved, so use a new extracted folder.

## If a step fails

Send the command name and last few error lines, after checking they contain no secrets. Useful checkpoints:

- npm.cmd ci: native Argon2/Sharp packages, corporate proxy/network restrictions or Windows architecture may need investigation. Do not disable antivirus or TLS verification to force an install.
- infra:up: Docker Desktop must be running in Linux-container mode. Do not install a second Docker Engine or change BIOS/IT settings without approval.
- db:migrate: check the Docker DB container is healthy. Do not substitute a production/company connection string.
- Login: use the new bootstrap account, exact 127.0.0.1 address and current authenticator code. Do not delete encryption keys or DB volumes to fix login.

Do not publicly expose the dev server, database or fake inbox. A phone's 127.0.0.1 is the phone itself, not this laptop. No hosted demo URL, remote laptop access, spending or deployment is included.

Official pages checked 28 October 2026. This guide is a grounded Windows route, not a claim that the Windows laptop is already ready.
