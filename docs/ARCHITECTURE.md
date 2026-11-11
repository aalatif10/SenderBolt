# SenderBolt - Architecture Report (v0.8.0)

Target runtime: **Node.js 12.22.x on Windows 7 (64-bit)**. Code is written in ES2018-style JavaScript
(no `?.`, `??`, or other post-Node-12 syntax) with promise chains.

## 1. Status

| Module | Status |
|---|---|
| Database schema + migrations | Done |
| Auth, sessions, CSRF, rate limiting | Done |
| Senders (backend + API) | Done |
| Leads and lists, importer, on-demand verifier (backend + API) | Done |
| Campaigns: wizard data, sequences (up to 5 follow-ups), Smart Split into sub-campaigns, lifecycle, dashboard data (backend + API) | Done |
| Projects: Project > Campaign > Batch hierarchy with roll-up analytics (backend + API) | Done |
| Web UI foundation: login/setup, Home, Project drill-down, Senders, Leads (vanilla JS, no build step) | Done. Inbox, Settings, campaign wizard screens: not started |
| Email templates (variables, fallbacks, spintax, safe escaping) | Done |
| Sending engine + scheduler (dry-run / live modes) | Done (live SMTP adapter not yet run against a real server) |
| Reply + bounce sync (IMAP), unified inbox, sentiment, manual reply, unsubscribe | Done (live IMAP adapter not yet run against a real mailbox) |
| Web UI (all screens) | Not started |
| DOMPurify HTML sanitizing, Excel import, open tracking | Not started |

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
      migrations/002_campaign_settings.sql   send window, time-zone offset, stop-on-reply, open tracking flags
      adapters/sqlite3.js       production driver (npm "sqlite3", prebuilt binaries)
      adapters/nodesqlite.js    test-only driver (Node 22 built-in), used in this sandbox
    http/router.js        request pipeline: headers, host allowlist, rate limit, CSRF, auth, body, handler
    routes/               thin HTTP handlers (no logic): index.js, auth.js, senders.js, leads.js, campaigns.js
    services/             business logic: auth, sessions, senders, leads, campaigns, audit
    security/rateLimiter.js   sliding-window limiter, bounded memory
    security/csrf.js          standalone CSRF middleware (router.js has the same checks inline)
    middleware/auth.js        standalone session middleware (for Express mounting later)
    lib/                  pure helpers: vault, password, tokens, cookies, email, csv, split, template, validate, throttle, health, net, text, http, errors
  test/                   run.js (unit), integration.js, leads.js, campaigns.js, e2e.js (real HTTP), helpers.js
```

## 3. File responsibilities

### Core
- `src/server.js` - starts the HTTP server on `HOST:PORT` (default `127.0.0.1:3000`), sets header/request timeouts, handles SIGINT/SIGTERM.
- `src/app.js` - builds every service once and passes them as `deps` to routes. Single place to add new modules.
- `src/config.js` - reads `.env`; requires a 64-hex `SENDERBOLT_MASTER_KEY` and a 32+ char `SENDERBOLT_SESSION_SECRET`; builds the Host/Origin allowlists.

### Database (`src/db/`)
- `index.js` - every query goes through one serialized queue on a single connection, so a transaction can never interleave with other queries. PRAGMAs: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, `secure_delete=ON`. Use `db.transaction(fn)` and only the `tx` object inside it.
- `migrate.js` - applies `NNN_name.sql` files in order, each in a transaction, storing a SHA-256; editing an applied migration is refused.
- `001_init.sql` - tables: users, sessions, audit_log, senders, folders, leads, suppression, campaigns (main + sub via `parent_id`), campaign_steps (0 to 5), campaign_senders, campaign_leads, messages. CHECK constraints enforce limits even if app code is bypassed (e.g. `daily_limit BETWEEN 1 AND 500`, tightened to 400 by triggers in 004). Every owned table has `user_id` (SaaS-ready).

### HTTP pipeline (`src/http/router.js`)
Order per request: security headers (CSP, nosniff, DENY framing, no-referrer, COOP/CORP, optional HSTS) -> Host allowlist (DNS-rebinding guard) -> global rate limit (600/min/IP) -> route match (404/405) -> for POST/PUT/PATCH/DELETE: required `X-SB-Client: 1` header, Origin check, `Sec-Fetch-Site` check -> session cookie auth -> per-session HMAC CSRF token -> JSON body parse with size limit and content-type check -> per-route rate limit -> handler. Errors never leak internals (only `AppError` messages are returned).

### Services (`src/services/`)
- `auth.js` - first-user setup (optional `SENDERBOLT_SETUP_TOKEN`), login with per-IP and per-account limits, escalating lockout (5 failures: 15 min, doubling, max 24 h), identical errors for unknown users, timing-equalized dummy hash, fresh session per login, password change revokes other sessions.
- `sessions.js` - random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored. 2 h idle, 12 h absolute, max 10 per user. CSRF token = HMAC of the session hash.
- `senders.js` - validation and CRUD. App passwords encrypted with AES-256-GCM (random IV, AAD bound to `sender:<id>`), never returned or logged. Gmail host/port preset; custom SMTP hosts must be public FQDNs on ports 25/465/587/2525 (IMAP 143/993). `daily_limit` 1 to 400 in code and DB triggers. `capacityToday()` combines limit, warm-up ramp, health and status (all ramp rules are pure functions in `lib/throttle.js`). `getCredentials()` is internal-only for the future sending engine.
- `leads.js` - folders; import from CSV (header aliases, custom columns, BOM, `,` `;` tab) or pasted text; duplicates and suppressed emails skipped; role-address flag; list/search/sort (whitelisted columns, escaped LIKE); stats incl. valid rate; CSV export with formula-injection neutralization; suppression list; **manual verifier** (syntax + DNS MX, 8 parallel lookups, per-domain cache, 5 s timeout). Transient DNS failures never mark a lead invalid.
- `audit.js` - append-only log with automatic redaction of keys like password/token/secret.

### Campaigns (`src/services/campaigns.js`, `src/routes/campaigns.js`)
- **Model:** a *main* campaign (`parent_id` NULL) owns the sequence and settings. With Smart Split it has *sub-campaigns* (`parent_id` = main), each holding one batch of leads plus its own copy of the sequence, so the sending engine only reads "my campaign's steps". Without a split, the main campaign holds the leads itself. The main status is derived from its parts (any error > any active > any paused > draft > completed).
- **Wizard data:** up to 6 emails (first + 5 follow-ups; a blank follow-up subject means "Re: first subject"), delays 1-60 days, send window (hours, UTC offset, weekdays only), stop-on-reply, open tracking (off by default). Senders: 1-20 accounts, ownership verified.
- **Lead selection:** from a folder or explicit ids. Excludes `invalid` leads, suppressed addresses, optionally role addresses, and (default) leads already in an active/paused campaign. Max 50,000 leads and 500 parts.
- **Smart Split:** `split-preview` returns exact part sizes (e.g. 26/26/26/2), the seed, and how many contacts of one company still share a part (0 whenever mathematically avoidable). Passing the same `seed` to `POST /campaigns` reproduces the exact split; "Shuffle Leads" = ask for a new seed.
- **Start:** drafts only. Re-checks suppression (late unsubscribes are removed), assigns each lead one sender round-robin (one lead always keeps the same sender, needed for threading), schedules `next_send_at`, and returns an estimate (max emails, daily capacity, minimum days). Refuses paused/disabled senders.
- **Lifecycle:** pause/resume work on a whole campaign or on one part; delete only the main campaign and only when nothing is active (everything cascades, sent-message history is kept with its link cleared). Sequence/senders/settings are editable only in draft; renaming is always allowed.
- **Dashboard data:** `GET /api/campaigns` returns main campaigns with sub-campaign summaries, per-filter counts for the filter bar (all/active/paused/completed/draft/error), search, sender filter, and per campaign: totals, per-status counts, emails sent, `done`, `progress_pct`, and `next_send_at` (only while active). Main stats are the sum of its parts; each part also has its own.
- **Template preview:** renders a step for a sample or a real lead, shows which variables are missing.

### Sending engine and inbox (v0.4)
| File | Role |
|---|---|
| `src/db/migrations/003_engine.sql` | sender runtime columns (throttle, errors, IMAP cursor), message kind/step/attempts/read state, lead status note |
| `src/engine/sendEngine.js` | `tick()`: for every usable sender (active, healthy, not throttled, reply tracking OK) sends at most ONE due email. At-most-once delivery: a `sending` row with unique key `cl:<lead>:s:<step>` is written before SMTP; leftovers after a crash are marked failed and NOT retried. Errors are classified (`lib/sendErrors.js`): auth -> pause sender; quota -> sender waits; bad recipient -> bounce + suppress; policy -> stop lead; transient -> backoff 5/15/60/240/720 min, 5 attempts. Handles window, weekdays, UTC offset, daily limit, warm-up, merge-field check, threading (`Re:`, In-Reply-To, References), signature, unsubscribe footer + headers |
| `src/engine/inboxSync.js` | reads each sender's mailbox read-only: first sync only baselines (no history import); matches replies/bounces to OUR sent emails by Message-ID (fallback: sender address); reply -> stop sequence + sentiment; "stop" phrases -> suppression + end other sequences; out-of-office -> keep going, push next email +3 days; hard bounce -> bounced + suppressed + invalid; policy -> lead error; soft -> ignored; UIDVALIDITY reset handled |
| `src/engine/scheduler.js` | timers: send tick 5 s, reply sync 60 s, health hourly; recovers interrupted sends at start; nothing starts in mode `off` |
| `src/engine/mailer.js`, `mailbox.js` | SMTP (nodemailer, TLS enforced, cert verified) and IMAP (`imap` + `mailparser`, INBOX read-only) adapters, each with a no-network dry-run twin |
| `src/services/inbox.js`, `routes/inbox.js` | conversations list (sentiment / unread / campaign / sender / search filters), thread, mark read, manual sentiment, manual reply (same sender, threaded, refused for suppressed contacts). Plain text only |
| `src/services/unsubscribe.js`, `routes/public.js` | public `/u/:token`: GET shows a confirm page (scanners prefetch links), POST (button or RFC 8058 one-click) suppresses the address everywhere |
| `src/services/senderTest.js` | "Test connection": SMTP + IMAP login with friendly errors; arms reply tracking |
| `src/services/campaignState.js`, `senderHealth.js` | derived campaign status + auto-complete; 30-day health score with auto-pause below 50 |
| `src/lib/sentiment.js`, `bounce.js`, `sendErrors.js`, `unsub.js`, `html.js` | reply classifier (quoted text stripped), DSN parser, SMTP error classifier, signed unsubscribe tokens, html<->text helpers |

**Sending modes** (`SENDERBOLT_SENDING` in `.env`): `off` (engine stopped), `dry-run` (default: the whole flow runs, the mailer only logs; mailbox returns nothing), `live` (real SMTP + IMAP; sending is blocked for a sender until its mailbox is armed and synced in the last 15 minutes, because replies must be detectable).

### Projects (v0.5)
| File | Role |
|---|---|
| `src/db/migrations/004_projects.sql` | `projects` table; `campaigns.project_id` (main campaigns only; batches belong through their main campaign); every pre-existing campaign gets its own project; **daily cap lowered to 400** (existing senders clamped, DB triggers enforce it) |
| `src/services/projects.js`, `routes/projects.js` | project CRUD (archive/delete refused while anything is sending; delete removes its campaigns and batches); roll-up analytics `batch -> campaign -> project`; campaign drill-down with batches and a per-step funnel |

Hierarchy: **Project** (container, e.g. "Q4 domain push") > **Campaign** (a variant: own sequence, leads, senders, settings) > **Batch** (a Smart Split part, mostly invisible to the user). Creating a campaign without `project_id` creates a project of the same name automatically.
Metric definitions: `emailed` = leads that got an email (or were rejected while sending); `replied` = real replies only (not out-of-office/bounces); rates are % of `emailed`. **Opens are not tracked yet** and are returned as `opens: null, opens_tracked: false`; the UI must say "not tracked", never show 0.

### Warm-up (v0.7.1) - `lib/throttle.js`, `migrations/005_warmup.sql`
Warm-up is a per-sender volume ramp (no peer network). It is **optional**: `warmup_enabled = 0` means the sender uses its configured limit (max 400) from day one.
| Rule | How it works |
|---|---|
| Paces | `standard`: 5/day, +25% per ramp day (400/day on ramp day 21). `gentle`: 3/day, +15% per ramp day (day 36). Never above the configured limit |
| Idle-safe | The ramp position (`rampIndex`) counts only UTC days on which the sender really sent. Paused weeks, holidays or empty campaigns do not advance it, and a long gap can never cause a jump to full volume |
| No token days | A day advances the ramp only if the sender used at least half of that day's allowance (1 email on a 30-email day does not count). The day in progress is never counted early, so the limit cannot rise mid-day |
| One day boundary | Ramp and daily counter both use the UTC date (the old rule mixed 24h blocks with UTC midnight and could allow about 2x in 24h) |
| Health-aware | `senderHealth.recompute` sets `warmup_penalty` from the 7-day hard-bounce rate (needs 20+ sends): 2% -> 2 steps back, 4% -> 4, 6% -> 6 (about 20% less volume per step, never below the starting amount). It clears by itself once bounces age out. Auto-pause below health 50 is unchanged |
| Counter | `sendEngine._onSuccess` stores `warmup_days` inside the send transaction. It also counts while warm-up is off, so an account that has been sending at volume counts as warmed up if the switch is turned on later |
The API adds read-only `warmup_day`, `warmup_reaches_day`, `warmup_slowed` (null/false when warm-up is off). Existing senders keep their progress (migration 005 converts the old calendar clock, minus one day).

### Web UI (v0.6) - `public/` served by `src/http/static.js`
| File | Role |
|---|---|
| `src/http/static.js` | serves `/public` for GET/HEAD only: extension allowlist, decoded + realpath-confined paths (no traversal/symlink escape), no dotfiles/directories, `no-cache`. Plugged into the dispatcher as the fallback for non-`/api` paths, so Host allowlist, rate limit, CSP and nosniff/DENY headers still apply |
| `public/index.html`, `favicon.svg` | the single page; only same-origin scripts/styles (CSP `script-src 'self'; style-src 'self'`) |
| `public/css/tokens.css`, `app.css` | design tokens (colours, spacing, type; automatic dark mode) and components. Tooltips are pure CSS (`data-tip`), keyboard accessible |
| `public/js/dom.js` | **safe DOM builder `h()`**: strings become text nodes; `innerHTML`, inline handlers and non-local links are impossible. Inline SVG icons |
| `public/js/api.js` | fetch wrapper: `X-SB-Client` + `X-CSRF-Token`, 30 s timeout, one retry for GET network blips, 401 -> sign-in, 429 -> friendly wait message. CSRF token lives in memory only |
| `public/js/ui.js`, `format.js`, `strings.js` | toasts, modals/confirm, slide-over, status pills, tiles, progress, sentiment bar, visibility-aware polling; number/time formatting; ALL wording in one file (translation-ready) |
| `public/js/screens/login.js`, `home.js`, `project.js`, `soon.js` | sign-in/first-run setup, Home, project + campaign drill-down, placeholder for unbuilt screens |
| `public/js/screens/senders.js` (v0.7) | Senders screen: summary tiles, account cards, add-sender dialog (Gmail / other SMTP) that auto-runs the connection test, settings slide-over (limit <= 400, warm-up, delays, plain-text signature escaped client-side, App Password replacement, pause/remove). Uses `/api/senders*` and `/api/engine/status` only; the server stays the authority for every limit |
| `src/services/senders.js` (v0.7) | `list/get` now add read-only `sent_today` (today UTC only), `limit_today` (warm-up aware), `remaining_today`, `warmup_day`, `hard_cap`; the password is still never returned |
| `public/js/screens/leads.js` (v0.8) | Leads screen, routes `#/leads` (lists) and `#/leads/suppression`. Folder list; import dialog (CSV file via FileReader with drag and drop, or pasted text; Excel is refused with instructions); stats strip whose tiles filter the table; searchable, sortable, paged table with plain-language verifier notes; bulk delete / do-not-email; "Check emails" scope dialog + progress run (500 per request, honours 429 Retry-After, stoppable, one run at a time); do-not-email tab (paged, add by paste, remove with warning). Display only: the server stays the authority for validity and limits |
| `public/js/app.js` | boot, auth flow, sidebar, hash router, test-mode / offline banners, unread badge |
| `scripts/demo.js` (`npm run demo`) | opt-in sample data with a RANDOM one-time password; refuses live mode, non-localhost binding and databases with a real account |
| `test/ui.js` | static-serving traversal attacks, header checks, source scan forbidding unsafe DOM APIs / inline code / external resources, demo-script safety |

DOMPurify is needed only when the Inbox screen renders reply HTML (planned: sanitize in the browser, show in a sandboxed iframe); the UI built so far renders no server HTML at all.

### Pure libraries (`src/lib/`)
`template.js` (`{{var|fallback}}`, `{a|b}` spintax; values HTML-escaped and never re-scanned; subject mode strips line breaks), `validate.js` (integer / id-list coercion).
`vault.js` (AES-256-GCM), `password.js` (scrypt N=32768, async variants), `tokens.js`, `cookies.js` (strict serializer), `email.js` (syntax, role, CRLF guard), `csv.js` (parser + formula-injection guard), `split.js` (seeded shuffle, domain spreading, batch split, preview sizes), `throttle.js` (400 cap, warm-up ramp: paces, send-day index, bounce penalty; delays), `health.js` (0 to 100 score, auto-pause below 50), `net.js` (public-hostname / SSRF guard), `text.js`, `http.js`, `errors.js`.

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
| GET `/folders/:id/lead-ids?status=&search=` | every matching lead id (max 50,000) so the UI can verify a whole list without paging |
| GET `/stats`, POST `/leads/delete`, POST `/leads/verify` | global stats, bulk delete (refused with 409 for leads waiting in a running/paused campaign; same for deleting a folder), manual verify |
| GET/POST `/suppression`, POST `/suppression/remove` | suppression list |
| GET `/campaigns?status=&q=&sender_id=&page=` | dashboard list with filter counts, progress, next send |
| POST `/campaigns`, GET/PATCH/DELETE `/campaigns/:id`, GET `/campaigns/:id/leads` | create (optionally split), detail, edit, delete, per-lead status |
| POST `/campaigns/split-preview`, POST `/templates/preview` | wizard: split sizes + conflicts; rendered email preview |
| GET/POST `/projects`, GET/PATCH/DELETE `/projects/:id` | projects with roll-up totals (`?archived=1`, `?q=`); detail includes each campaign |
| GET `/campaigns/:id/analytics` | drill-down: campaign totals, batches, per-step funnel |
| POST `/campaigns/:id/start`, `/pause`, `/resume` | lifecycle (main campaign or a single part); start also returns non-blocking `warnings` |
| GET `/inbox?sentiment=&unread=1&campaign_id=&sender_id=&q=&limit=&offset=` | conversations, counts per sentiment, unread |
| GET `/inbox/threads/:id`, POST `/inbox/threads/:id/read`, POST `/inbox/threads/:id/reply` | thread (text only), read state, manual reply |
| POST `/inbox/messages/:id/sentiment`, POST `/inbox/sync` | manual sentiment, check replies now |
| POST `/senders/:id/test`, GET `/engine/status` | test SMTP/IMAP login; engine mode, last tick, per-sender reply-tracking state |
| GET/POST `/u/:token` (public, no session) | unsubscribe confirm page / action |

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

1. **Campaign work has not yet been run on Node 12 + `sqlite3`.** Foundation, senders and leads were confirmed on Windows 7 / Node 12.22 by the project owner. The campaign module is new: run `npm test` again after pulling.
2. **Live SMTP/IMAP adapters are untested against real servers.** The engine, sync and every failure path are tested with fakes; `nodemailer`, `imap` and `mailparser` calls follow their docs but have not been run against Gmail. Start with dry-run, then one sender and one lead to yourself. Their exact versions in `package.json` also need confirming on Node 12 (`npm install`).
3. **No HTML sanitizing yet.** Email bodies and signatures are stored as written. DOMPurify (needs `jsdom`) will clean them, and inbound replies, before anything is rendered in the UI (always in a sandboxed iframe). Until then never inject stored HTML into a page.
3b. Windows/time zones are enforced; "weekdays only" means Mon-Fri in the campaign's UTC offset. Daily limits reset at UTC midnight.
3c. Open tracking (`track_opens`) is stored but not implemented. Unsubscribe links use the app's public origin, not the tracking domain. Replies landing in Gmail's Spam folder are not seen (INBOX only). If a sender goes down, its assigned leads wait for it (the campaign shows `error` only when no waiting lead has a usable sender).
3d. Inbox shows plain text only; HTML replies are stored but never exposed until DOMPurify is added.
4. **Connect-time DNS check for hosts** (anti-rebinding) is not done; only the hostname format is validated.
5. **Web UI is partial**: Inbox, Settings and the campaign builder screens are still to build (Home, Projects, Senders and Leads are done).
6. Verification means "domain can receive mail", not "mailbox exists" (by design; see leads.js header). The checker never produces `catch_all`, so the Leads screen's Risky tile (risky + catch-all) is effectively risky only.
6b. Imports are CSV or pasted text only; Excel files must be saved as CSV (Excel import is not built).
7. Login rate limits are in memory (reset on restart); fine for one user, swap for a shared store before multi-node SaaS.
8. Run behind HTTPS (and set `SENDERBOLT_SECURE_COOKIES=1`) before exposing beyond localhost.

## 7. Next steps (suggested order)

1. Live test with one real Gmail App Password (dry-run first).
2. Remaining web screens (campaign builder next, then Inbox + DOMPurify, Settings) (vanilla JS + clean CSS, tooltips) served with the existing CSP.
