# SenderBolt

B2B email outreach and campaign management. See `docs/ARCHITECTURE.md` for the full design.

## Run it locally (Windows 7, Node 12.22.x)

Open **Command Prompt** in this folder, then:

```
node -v
npm install
npm test
npm run init
npm start
```

1. `node -v` should print `v12.22.x`.
2. `npm install` installs `sqlite3` (prebuilt binary, no compiler needed).
3. `npm test` should end with four "passed, 0 failed" lines. **If anything fails, copy the output to me.**
4. `npm run init` creates `.env` with random secrets. Open it, **back up `SENDERBOLT_MASTER_KEY`**, and note `SENDERBOLT_SETUP_TOKEN`.
5. `npm start` serves the API on http://127.0.0.1:3000 (there is no web UI yet).

## Try the API (optional)

Create your account (once), then log in. In Command Prompt with curl, or any REST client:

```
curl -X POST http://127.0.0.1:3000/api/auth/setup -H "Content-Type: application/json" -H "X-SB-Client: 1" -d "{\"email\":\"you@example.com\",\"password\":\"a-long-passphrase-123\",\"setupToken\":\"<token from .env>\"}"
```

Login returns a `csrfToken` and sets a session cookie. Send both on later POST/PATCH/DELETE calls.
