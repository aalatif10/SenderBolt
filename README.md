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
2. `npm install` installs `sqlite3` (prebuilt binary), plus `nodemailer` (and the optional `imap` + `mailparser`, needed only for reply tracking in live mode; if they fail to install the app still runs).
3. `npm test` should end with eleven "passed, 0 failed" lines. **If anything fails, copy the output to me.**
4. `npm run init` creates `.env` with random secrets. Open it, **back up `SENDERBOLT_MASTER_KEY`**, and note `SENDERBOLT_SETUP_TOKEN`.
5. `npm start`, then open **http://127.0.0.1:3000** in your browser. That is the SenderBolt web app.

## Try the API (optional)

Create your account (once), then log in. In Command Prompt with curl, or any REST client:

```
curl -X POST http://127.0.0.1:3000/api/auth/setup -H "Content-Type: application/json" -H "X-SB-Client: 1" -d "{\"email\":\"you@example.com\",\"password\":\"a-long-passphrase-123\",\"setupToken\":\"<token from .env>\"}"
```

Login returns a `csrfToken` and sets a session cookie. Send both on later POST/PATCH/DELETE calls.

## Sending modes

`SENDERBOLT_SENDING` in `.env`:

- `dry-run` (default): the engine runs the whole flow (throttling, follow-ups, replies tables) but **no email is sent and no mailbox is read**. Safe for testing; the console prints what it would send.
- `live`: real SMTP/IMAP. First test with ONE sender and a lead that is your own address. Use `POST /api/senders/:id/test` first.
- `off`: engine stopped.

Set `SENDERBOLT_PUBLIC_ORIGIN=https://your-domain` to get one-click unsubscribe links in emails.

## Using the web app

**Browser:** any current Chrome, Edge or Firefox. On Windows 7 use Chrome 109 or Firefox ESR 115 (the last versions that run there). Internet Explorer is not supported.

**First time**
1. Open http://127.0.0.1:3000. A "Create your account" screen appears once.
2. Enter your email, a password of 12+ characters, and the setup token from your `.env` (`SENDERBOLT_SETUP_TOKEN`).
3. You land on **Home**. From now on the same address shows the sign-in screen.

**Try it with sample data (optional, safe)**
Use a separate database so your real data is untouched. In Command Prompt:
```
set SENDERBOLT_DB_FILE=data\demo.db
npm run demo
npm start
```
`npm run demo` prints a demo email and a **random one-time password** (there is no built-in password anywhere). It creates two fake Gmail senders, 40 fake leads on reserved `.example` domains and a project with two campaigns, one already running. It refuses to run in `live` mode, when the server is open to the network, or on a database that already holds a real account. To get a new demo password later: `npm run demo -- --reset-password`.
Close the window and start normally (without the `set` line) to go back to your real data.

**Home**
- A blue **Test mode** strip means nothing real is sent (see "Sending modes"). It disappears in live mode.
- A **Next step** card tells you what to do next (connect a sender, add leads, create a project).
- Four tiles: emails sent today vs. capacity, replies waiting, projects running, and anything needing attention. Hover the small **i** next to any label to read what it means.
- **Projects** are shown as cards with progress, sent, replies, bounces and the next email time. Click one to open it. The page refreshes itself every 10 seconds.

**Projects, campaigns and drill-down**
- A **project** groups related **campaigns** (for example two versions of an email). The project page adds the numbers of all its campaigns together.
- Click a campaign row to open the side panel: replies and bounces, how many emails went out at each step, and its batches.
- **Start / Pause / Resume** buttons are on each campaign row and always ask first. **Edit**, **Archive** and **Delete** are at the top of a project (running campaigns must be paused first).
- **Opens** show "Not tracked" on purpose: open tracking is unreliable, so replies are the number to trust.

**Senders** (menu: Senders)
1. Click **Add sender**. Choose **Gmail**, type the address and a Google **App Password** (the box explains how to create one: turn on 2-Step Verification, then Security -> App passwords). Your normal Gmail password does not work and is never needed.
2. Set the name recipients will see and **Emails per day**. The maximum is **400** (a 100-email safety buffer under Gmail's limit); the screen refuses anything higher. **Warm-up is optional** (a switch per sender). On: the account starts at a handful per day and grows, but only on days it is really used (idle days do not count) and it slows down by itself if emails start bouncing. Off: it uses your full daily limit from day one, which suits accounts that already send regularly. Pick **Standard** (about 3 weeks) or **Gentle** (about 5 weeks) in Settings.
3. **Add and test connection** saves the account (the password is encrypted and never shown again) and immediately checks that sending and reply detection work, in plain words.
4. Each card shows status (Active / Warming up / Paused / Needs attention), health, **Sent today / today's limit**, whether replies are detected, and the next email time. Hover anything with a dotted outline or an **i** for an explanation.
5. **Settings** opens a side panel: daily limit, warm-up, pause between emails (random looks most natural), plain-text signature, tracking domain, replace the App Password, **Pause/Resume**, and **Remove** (blocked while a running or paused campaign uses the account).
6. Campaigns rotate emails evenly across their accounts, so more accounts means more emails per day with less load on each.

**Leads** (menu: Leads)
1. **Lists** are folders for your contacts (a niche, market or location). Create one with **New list**, or choose **＋ New list…** while importing. Rename, **Export** (CSV) and **Delete** are at the top of each list.
2. **Import leads** takes a **CSV file** (drag it in or click; needs a column called "email", optional first name / last name / company, any other columns are kept for your email text) or **pasted emails** in any mix of commas, spaces and lines. Using Excel? Save as CSV first. Duplicates, badly written addresses and people on the do-not-email list are skipped, and a report shows every skipped row and why.
3. **Check emails** verifies on demand (nothing runs in the background): choose only the unchecked ones, the whole list, or your selection. It confirms the address is written correctly and the domain has a mail server; it cannot prove the mailbox exists. A progress window shows the run and you can stop it any time.
4. The **stats bar** shows total, valid rate, valid, invalid, risky and not checked. Click a figure to filter the table. The **Details** column explains each result in plain words; "Role" marks shared mailboxes like info@.
5. Select rows to **Delete** them or put them on the do-not-email list. Leads that are waiting in a running or paused campaign cannot be deleted.
6. **Do-not-email list** (second tab): unsubscribes, bounces and "stop" replies land here automatically; add your own by pasting addresses; **Remove** asks first because emailing someone who opted out can get your accounts reported.

**Coming next:** Inbox and Settings screens, and the campaign builder. Until they exist, those menu items show a short notice; the features already work through the API.

**Safety notes:** your session ends after 2 hours of inactivity; passwords are never stored in the browser; everything the page shows from the server is displayed as plain text.
