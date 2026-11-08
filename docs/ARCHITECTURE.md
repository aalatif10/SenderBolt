# SenderBolt - Architecture Report (v0.2.0)

Target runtime: **Node.js 12.22.x on Windows 7 (64-bit)**. Code is written in ES2018-style JavaScript
(no `?.`, `??`, or other post-Node-12 syntax) with promise chains.

## 1. Status

| Module | Status |
|---|---|
| Database schema + migrations | Done |
| Auth, sessions, CSRF, rate limiting | Done |
| Senders (backend + API) | Done |
| Leads and lists, importer, on-demand verifier (backend + API) | Done |
| Smart Split engine (pure logic, tested) | Done, not yet wired to campaigns |
| Campaign service, sending engine, scheduler | Not started |
| Reply sync (IMAP), unified inbox, sentiment | Not started |
| Web UI (all screens) | Not started |
| Email sending (nodemailer), DOMPurify, Excel import | Not started (need packages) |

## 2. Folder structure

```
senderbolt/
  package.json            scripts + the single dependency (sqlite3 5.0.2)
  .env.example            documented configuration template (real .env is generated)
  .gitignore              keeps secrets and databases out of git
  scripts/init.js         generates .env with fresh secrets (never overwrites)
  docs/ARCHITECTURE.md    this file
  src/
    server.js             entry point: loads .env, opens app, listens, graceful shutdown
    app.js                composition root: db -> migrations -> services -> routes -> dispatcher
    config.js             env + .env parsing, fails fast on weak or missing secrets
    db/
      index.js            driver pick, PRAGMAs (WAL, FK, busy_timeout), serialized queries, transactions
      migrate.js          forward-only SQL migrations with checksums
      migrations/001_init.sql   full schema for all 5 modules
      adapters/sqlite3.js       production driver (npm "sqlite3", prebuilt binaries)
      adapters/nodesqlite.js    test-only driver (Node 22 built-in), used in this sandbox
    http/router.js        request pipeline: headers, host allowlist, rate limit, CSRF, auth, body, handler
    routes/               thin HTTP handlers (no logic): index.js, auth.js, senders.js, leads.js
    services/             business logic: auth, sessions, senders, leads, audit
    security/rateLimiter.js   sliding-window limiter, bounded memory
    security/csrf.js          standalone CSRF middleware (router.js has the same checks inline)
    middleware/auth.js        standalone session middleware (for Express mounting later)
    lib/                  pure helpers: vault, password, tokens, cookies, email, csv, split, throttle, health, net, text, http, errors
  test/                   run.js (unit), integration.js, leads.js, e2e.js (real HTTP), helpers.js
```

## 3. File responsibilities

### Core
- `src/server.js` - starts the HTTP server on `HOST:PORT` (default `127.0.0.1:3000`), sets header/request timeouts, handles SIGINT/SIGTERM.
- `src/app.js` - builds every service once and passes them as `deps` to routes. Single place to add new modules.
- `src/config.js` - reads `.env`; requires a 64-hex `SENDERBOLT_MASTER_KEY` and a 32+ char `SENDERBOLT_SESSION_SECRET`; builds the Host/Origin allowlists.

### Database (`src/db/`)
- `index.js` - every query goes through one serialized queue on a single connection, so a transaction can never interleave with other queries. PRAGMAs: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, `secure_delete=ON`. Use `db.transaction(fn)` and only the `tx` object inside it.
- `migrate.js` - applies `NNN_name.sql` files in order, each in a transaction, storing a SHA-256; editing an applied migration is refused.
- `001_init.sql` - tables: users, sessions, audit_log, senders, folders, leads, suppression, campaigns (main + sub via `parent_id`), campaign_steps (0 to 5), campaign_senders, campaign_leads, messages. CHECK constraints enforce limits even if app code is bypassed (e.g. `daily_limit BETWEEN 1 AND 500`). Every owned table has `user_id` (SaaS-ready).

### HTTP pipeline (`src/http/router.js`)
Order per request: security headers (CSP, nosniff, DENY framing, no-referrer, COOP/CORP, optional HSTS) -> Host allowlist (DNS-rebinding guard) -> global rate limit (600/min/IP) -> route match (404/405) -> for POST/PUT/PATCH/DELETE: required `X-SB-Client: 1` header, Origin check, `Sec-Fetch-Site` check -> session cookie auth -> per-session HMAC CSRF token -> JSON body parse with size limit and content-type check -> per-route rate limit -> handler. Errors never leak internals (only `AppError` messages are returned).

### Services (`src/services/`)
- `auth.js` - first-user setup (optional `SENDERBOLT_SETUP_TOKEN`), login with per-IP and per-account limits, escalating lockout (5 failures: 15 min, doubling, max 24 h), identical errors for unknown users, timing-equalized dummy hash, fresh session per login, password change revokes other sessions.
- `sessions.js` - random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored. 2 h idle, 12 h absolute, max 10 per user. CSRF token = HMAC of the session hash.
- `senders.js` - validation and CRUD. App passwords encrypted with AES-256-GCM (random IV, AAD bound to `sender:<id>`), never returned or logged. Gmail host/port preset; custom SMTP hosts must be public FQDNs on ports 25/465/587/2525 (IMAP 143/993). `daily_limit` 1 to 500 in code and DB. `capacityToday()` combines limit, warm-up ramp, health and status. `getCredentials()` is internal-only for the future sending engine.
- `leads.js` - folders; import from CSV (header aliases, custom columns, BOM, `,` `;` tab) or pasted text; duplicates and suppressed emails skipped; role-address flag; list/search/sort (whitelisted columns, escaped LIKE); stats incl. valid rate; CSV export with formula-injection neutralization; suppression list; **manual verifier** (syntax + DNS MX, 8 parallel lookups, per-domain cache, 5 s timeout). Transient DNS failures never mark a lead invalid.
- `audit.js` - append-only log with automatic redaction of keys like password/token/secret.

### Pure libraries (`src/lib/`)
`vault.js` (AES-256-GCM), `password.js` (scrypt N=32768, async variants), `tokens.js`, `cookies.js` (strict serializer), `email.js` (syntax, role, CRLF guard), `csv.js` (parser + formula-injection guard), `split.js` (seeded shuffle, domain spreading, batch split, preview sizes), `throttle.js` (500 cap, warm-up, delays), `health.js` (0 to 100 score, auto-pause below 50), `net.js` (public-hostname / SSRF guard), `text.js`, `http.js`, `errors.js`.

## 4. HTTP API (all JSON, all `/api`, all need a session unless noted)

| Method + path | Purpose |
|---|---|
| GET `/auth/status` (public) | `{needsSetup}` |
| POST `/auth/setup` (public) | create the first (owner) account |
| POST `/auth/login` (public) / `/auth/logout` | session cookie + CSRF token |
| GET `/auth/me`, POST `/auth/password` | profile, change password |
| GET/POST `/senders`, GET/PATCH/DELETE `/senders/:id`, POST `/senders/:id/status` | sender CRUD |
| GET/POST `/folders`, PATCH/DELETE `/folders/:id` | folders |
| GET `/folders/:id/leads`, `/stats`, `/export`; POST `/folders/:id/import` | leads |
| GET `/stats`, POST `/leads/delete`, POST `/leads/verify` | global stats, bulk delete, manual verify |
| GET/POST `/suppression`, POST `/suppression/remove` | suppression list |

Every state-changing call needs headers `X-SB-Client: 1` and `X-CSRF-Token: <from login/me>`.

## 5. Security controls in place

- AES-256-GCM credentials, row-bound; scrypt password hashes; session tokens stored hashed.
- Parameterized SQL only (placeholder lists built from counts; sort columns whitelisted).
- IDOR-proof: every query scoped by `user_id`; foreign ids return the same 404 as missing ids.
- CSRF: SameSite=Strict + Origin + Sec-Fetch-Site + custom header + per-session token.
- Brute force: IP and account rate limits + lockout; global limiter; per-route limiters; body size caps.
- Injection: CSV formula neutralization (import values and export), CRLF/header-injection checks, control-character stripping, cookie value allowlist.
- SSRF: SMTP/IMAP/tracking hosts must be public FQDNs on mail ports.
- Strict CSP and clickjacking/MIME headers; Host allowlist; errors don't leak internals; audit log with redaction.

## 6. Known gaps (honest list)

1. **`sqlite3` adapter has never executed.** I couldn't install packages here; it is written to the documented API. Run `npm test` on your machine first. The test suite uses whichever driver is installed.
2. **Not run on Node 12.** Tests ran on Node 22. I scanned for newer syntax and found none, but real confirmation is `npm test` on your PC. `sqlite3@5.0.2` is my best-knowledge pin for Node 12; if `npm install` fails, tell me the error.
3. **No HTML sanitizing yet.** DOMPurify (needs `jsdom`) is for signatures and inbound replies; to be added with the inbox. Signature HTML is stored raw and must not be rendered until then.
4. **Connect-time DNS check for hosts** (anti-rebinding) is not done; only the hostname format is validated.
5. **No UI, no sending engine, no IMAP.** The data model for them already exists.
6. Verification means "domain can receive mail", not "mailbox exists" (by design; see leads.js header).
7. Login rate limits are in memory (reset on restart); fine for one user, swap for a shared store before multi-node SaaS.
8. Run behind HTTPS (and set `SENDERBOLT_SECURE_COOKIES=1`) before exposing beyond localhost.

## 7. Next steps (suggested order)

1. Campaign service (wizard data, sequences, Smart Split wiring, sub-campaigns) + routes.
2. Sending engine: queue with idempotency keys, throttling, sender rotation, nodemailer.
3. IMAP reply sync + bounce handling + unified inbox + sentiment rules.
4. Web UI (vanilla JS + clean CSS, tooltips) served with the existing CSP.
