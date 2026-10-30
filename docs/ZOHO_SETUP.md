# Zoho People setup

Connects the asset portal to Zoho People (India data centre) so staff, departments and photos sync automatically. Read-only: the portal never changes anything in Zoho.

## 1. Create a Zoho Self Client (once)

1. Go to https://api-console.zoho.in and sign in as a Zoho administrator.
2. **Add Client** → **Self Client** → **Create**.
3. **Generate Code** tab:
   - Scope: `ZOHOPEOPLE.forms.READ`
   - Time duration: 10 minutes
   - Description: anything, e.g. `IAC asset portal`
   - Click **Create** and copy the code.
4. **Client Secret** tab: copy the **Client ID** and **Client Secret**.

## 2. Save the connection (one command)

The code from step 1.3 only works for 10 minutes. This command swaps it for a permanent key and saves everything into `.env` for you.

In a terminal in the project folder, run:

```bash
npm run zoho:token
```

It asks three questions. Paste each answer and press Enter:

1. **Client ID** – from the Client Secret tab.
2. **Client Secret** – from the Client Secret tab.
3. **Code** – the code you copied in step 1.3.

When it says **Saved … to .env**, you're done. If it says the code expired, generate a new code (step 1.3) and run the command again.

Keep `.env` secret and never commit it.

## 3. Restart the app

Stop the running app (Ctrl+C) and start it again:

```bash
npm run dev
```

## 4. First sync

1. Sign in as a Super Admin and open **Directory & Zoho**.
2. Click **Sync now** and wait for the run to show **Succeeded**.
3. Check a few people: name, employee ID, department, designation and photo.
4. Open **Match Zoho people to accounts**. Link any portal account whose email differs from Zoho (for example an office mailbox) to the right Zoho person.

After this, the sync runs automatically every night at 02:00 India time.

## How it behaves

- **New Zoho people** become directory entries: they can be given assets but cannot sign in until invited from People & access.
- **Matching:** by Zoho record first, then by email. It never changes anyone's login, roles or password.
- **Leavers:** people Zoho marks as inactive get a left date. Their assets appear under **To recover**, and Super Admins get an email. Nothing is returned automatically.
- **Photos:** resized, stripped of metadata and stored privately in the database.

## If something goes wrong

| Problem | Fix |
|---|---|
| Page says "not configured" | One of the three `ZOHO_*` values is missing; add it and restart. |
| Run fails with an auth error | Refresh token revoked or wrong region; redo steps 1–3. |
| Names, departments or photos look wrong | Zoho field names differ from the defaults; adjust `mapZohoRecord` in `apps/api/src/zoho.ts`. |
| Someone appears twice | Use **Match Zoho people to accounts** to link them. |
