#!/usr/bin/env bash
# Creates .env.production on the server. Secrets are generated here and never leave the server.
# Usage (from the project folder on the server): bash scripts/setup-production-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.production ]; then
  echo ".env.production already exists - not overwriting it."
  exit 1
fi

read -r -p "Domain (e.g. assets.indiaautismcenter.org or 13-233-45-67.sslip.io): " DOMAIN
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$DOMAIN" != *.* ]] || [[ "$DOMAIN" == *..* ]]; then
  echo 'Enter a hostname only, without a scheme, path or whitespace.' >&2
  exit 1
fi

read -r -p "Sender email (e.g. it@indiaautismcenter.org): " MAIL
if [[ ! "$MAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo 'Enter a single valid sender email address.' >&2
  exit 1
fi
read -r -s -p "Google app password (typing is hidden): " SMTPPW
echo
SMTPPW=${SMTPPW// /}
if [[ ! "$SMTPPW" =~ ^[A-Za-z0-9]{16}$ ]]; then
  echo 'Google app password must contain 16 letters or digits; spaces are allowed between groups.' >&2
  exit 1
fi

secret() { openssl rand -hex 32; }

umask 077
cat > .env.production <<ENV
DOMAIN=${DOMAIN}
ACME_EMAIL=${MAIL}
POSTGRES_OWNER_PASSWORD=$(secret)
POSTGRES_APP_PASSWORD=$(secret)
TOTP_ENCRYPTION_KEY=$(secret)
AUTH_MAIL_ENCRYPTION_KEY=$(secret)
CSRF_SECRET=$(secret)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=${MAIL}
SMTP_PASSWORD=${SMTPPW// /}
SMTP_FROM=IAC Asset Portal <${MAIL}>
PORTAL_NOTICE_VERSION=1
ENV

echo
echo "Created .env.production"
echo "Secrets were saved privately and were not printed. Store .env.production in an approved secret manager."
echo "Keep the encryption keys safe; losing them can prevent MFA login and queued-email decryption."
echo "Next: docker compose --env-file .env.production -f infra/docker-compose.prod.yml up -d --build"
