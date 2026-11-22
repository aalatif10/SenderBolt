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

## Sending

SenderBolt always sends for real (SMTP) and reads replies (IMAP). There is no test or simulation mode. Before a real campaign, use **Send me a test email** in the campaign wizard and `POST /api/senders/:id/test`, and start with ONE sender and a lead that is your own address.

`SENDERBOLT_SENDING=off` in `.env` is an emergency kill switch that stops the engine. If something fails to load, run `npm run doctor`.

Set `SENDERBOLT_PUBLIC_ORIGIN=https://your-domain` to get one-click unsubscribe links in emails.

## Using the web app

**Browser:** any current Chrome, Edge or Firefox. On Windows 7 use Chrome 109 or Firefox ESR 115 (the last versions that run there). Internet Explorer is not supported.

**First time**
1. Open http://127.0.0.1:3000. A "Create your account" screen appears once.
2. Enter your email, a password of 12+ characters, and the setup token from your `.env` (`SENDERBOLT_SETUP_TOKEN`).
3. You land on **Home**. From now on the same address shows the sign-in screen.


**Home**
- An amber strip appears only if the sending engine is switched off (`SENDERBOLT_SENDING=off`).
- A **Next step** card tells you what to do next (connect a sender, add leads, create a project).
- Four tiles: emails sent today vs. capacity, replies waiting, projects running, and anything needing attention. The **Campaign health** card counts critical problems and shows a badge for alerts you have not reviewed yet (**Mark all reviewed** clears it; a problem that returns shows as New again). Hover the small **i** next to any label to read what it means.
- **Projects** are shown as cards with progress, sent, replies, bounces and the next email time. Click one to open it. The page refreshes itself every 10 seconds.

**Projects and Campaigns (v1.9.1)**
- The home page is one view, **Projects and Campaigns**: project rows with their totals. Open a project with the arrow to see its campaigns in the shared campaign table: name, status, current state ("Next follow-up in 2h 10m"), created ("11 minutes ago"), progression, performance (Scheduled, Sent, Opened, Replied, Successful; hover each for what it means) and a **⋮** menu (Pause/Resume, Duplicate, Archive/Restore, Rename).
- In both places the progression is the segmented step bar: Initial email, Follow-up 1 to 5, with each step's state in the dark tooltip.
- A project row uses the same columns as a campaign row, but its numbers are the **totals over all its campaigns** (with one campaign it equals that campaign). Each campaign row underneath shows only its own numbers. Archived campaigns are left out of the totals.
- The **Project page** shows the same table with a filter bar (total count, search by name, Status and Email accounts multi-selects) plus checkboxes to move or delete campaigns in bulk.

**Inbox filters (v1.9)**
- Search by name, company or subject; multi-selects for Email accounts, Team members, Campaigns and Status (Successful, Not successful, Interested, More info, Not interested, Neutral). Status follows the reply tags: Successful = tagged Interested, Not successful = tagged Not interested or the person opted out / bounced. Tabs: All, Unread, Read, Interested, More info, Not interested, Neutral.

**New campaign, Sending step (v1.9)**
- One vertical flow: Sending days (Mon-Sun), Sending hours with Time zone, **Start on a specific day** (off = starts when you press Start, within your days and hours; on = pick the date), then accounts, Priority, Replies, Tracking and Smart Split.

**Sending accounts (v1.9)**
- Accounts under Force continue count as active. Cards show the real time of the next email (days/hours/minutes) computed from the campaign's days, hours and time zone; the same time is used on campaigns and projects.
- Login or network problems never pause an account: it stays active, shows a connection alert and is retried automatically (15 min after a wrong password, 5 min after a network error). Inbox time-outs are retried with back-off (1, 2, 4, then 5 minutes) and do not stop sending.
- **Health healing**: a damaged score recovers gradually (+1 per calm day, +1 per 25 clean emails up to +2, +1 per reply, at most +4 a day, never above 100; a serious problem pauses healing that day).
- **Settings** (button on a card) groups everything for one account: Connection & credentials, Daily limit & warm-up, Sending pace, Protection & risk (with a plain risk summary and Force continue), Health healing, Identity & signature, Advanced.

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
7. **Quick actions on each card**: **Pause / Resume** in one click, and **Needs attention (n)** which lists exactly what is wrong. Long addresses are shortened with "…"; hover to see the full address.
8. In the side panel: **Replies detected** switch (off = replies still reach your Inbox but do not stop that person's follow-ups), **Protection level** (Low / Medium / High: how healthy an account must be to keep sending), and **Force continue** (keeps a below-threshold account sending for 72 hours; confirm first, it expires by itself).

**Leads** (menu: Leads)
1. **Lists** are folders for your contacts (a niche, market or location). Create one with **New list**, or choose **＋ New list…** while importing. Rename, **Export** (CSV) and **Delete** are at the top of each list.
2. **Import leads** takes a **CSV or Excel (.xlsx) file** (drag it in or click; needs a column called "email", optional first name / last name / company, any other columns are kept for your email text) or **pasted emails** in any mix of commas, spaces and lines. Using Excel? Save as CSV first. Duplicates, badly written addresses and people on the do-not-email list are skipped, and a report shows every skipped row and why.
3. **Check emails** verifies on demand (nothing runs in the background): choose only the unchecked ones, the whole list, or your selection. It confirms the address is written correctly and the domain has a mail server; it cannot prove the mailbox exists. A progress window shows the run and you can stop it any time.
4. The **stats bar** shows total, valid rate, valid, invalid, risky and not checked. Click a figure to filter the table. The **Details** column explains each result in plain words; "Role" marks shared mailboxes like info@.
5. Filter by **Valid / Bounced / Risky / Not checked** with the chips above the table, then select rows (or **Select all N in this view**) to **Remove** them or put them on the do-not-email list. Leads that are waiting in a running or paused campaign cannot be deleted.
6. **Do-not-email list** (second tab, also shown as **Unsubscriptions** in the menu): unsubscribes, bounces, complaints and "stop" replies land here automatically; add your own by pasting addresses (tab **Added by you**). Click a column title to sort; tick rows or the top checkbox (then **Select all N**) and choose **Remove from list / Unblock** (they can be emailed again, nothing else is lost) or **Delete** (permanent: the entry and the lead are erased). Both ask first because emailing someone who opted out can get your accounts reported. A new block takes effect immediately: people from that address who are still waiting in any running or paused campaign are stopped at once (bounced addresses show as Bounced, the rest as Unsubscribed), and nothing is ever sent to a blocked address.

**New campaign** (Home or a project page: **New campaign**)
1. **Emails** (content first): name the campaign, write the subject and message of the first email. Nothing else is on screen until you press **Add follow-up** under it (up to 5). For each follow-up type any whole number of days to wait (1 to 60) or tap a shortcut (2d, 3d, 5d, 7d, 14d, 30d). A blank follow-up subject is sent as "Re: <previous subject>" so it stays in the same conversation.
2. The toolbar gives font, size, bold, italic, underline, bullet and numbered lists, links (Ctrl+K), clear formatting and an **Insert field** menu ({{first_name|there}}, spintax). The preview on the right shows the email you are editing for an example person.
3. **Audience**: choose a lead folder and which address types to include. You see how many people will be emailed and how many are missing information that your emails use (for example an empty first name with no fallback).
4. **Sending**: choose sender accounts, **Start** (now or on a chosen date, like Hunter.io), **Priority** (follow-ups first, balanced, or new people first), the daily sending window (AM/PM), time zone, weekdays only and stop-on-reply. A reply stops follow-ups only for the person who replied. **Smart Split** cuts big lists into batches (for example 26 per batch) with the sizes shown live; **Shuffle** mixes people so colleagues from one company are not in the same batch.
5. **Send test** (on each email and on Review): sends that email to you with an example person filled in, so you can check formatting in a real inbox. The subject starts with [TEST]; nothing is added to any campaign.
6. **Review**: fix anything flagged, pick a project, then **Create campaign** (nothing is sent) or **Create and start**.
7. **Drafts are automatic**: everything is saved a moment after you stop typing (and on **Save draft**). Close the tab, reload or come back tomorrow: Home lists your drafts under **Drafts** and **Continue** resumes exactly where you stopped. If the same draft is open in two tabs, the second tab stops saving instead of overwriting the first.

**Inbox** (menu: Inbox)
1. Every reply from every account and campaign appears in one list, newest first. Filter by **Interested / More info / Not interested**, **Unread**, campaign or account, or search by name, company or subject. **Check for replies** looks at your mailboxes right now (it also happens in the background).
2. Click a conversation to read the whole thread: your emails, their replies, automatic out-of-office answers and delivery-failure notices. The colour tag is guessed from the words; click another tag to correct it.
3. Write in the box and press **Send reply**. It goes from the same account, in the same conversation. If the person opted out or the address bounced, replying is turned off. Replies are shown as plain text for safety. **Mark unread** brings a conversation back to the top of your unread list.

**Settings** (menu: Settings)
1. **Change password** (12+ characters). Other devices are signed out when you do.
2. **Where you are signed in** lists your browsers and devices; **Sign out other devices** ends all but this one.
3. **Default email signature**: added to emails from any account that has no signature of its own (an account's own signature, set on the Senders page, always wins).
4. **Sending hours** are chosen in 12-hour AM/PM.
5. **Recent activity** shows the last actions on your account.

**Safety notes:** your session ends after 2 hours of inactivity; passwords are never stored in the browser; everything the page shows from the server is displayed as plain text.

**Housekeeping (v1.9.2)**
- Unsubscriptions tabs: All, Added by you, Unsubscribed, Bounced, Complaints. A paused sending account is shown in red on Sending accounts and in Settings.
- Sender Settings is a set of cards: summary (status, today, health, replies), Connection & credentials, Daily limit & warm-up, Sending pace, Protection & risk, Health healing, Identity & signature, Advanced. Force continue refreshes the whole panel; the pause between emails is checked (shortest <= longest).
**Housekeeping (v1.9.6)**
- Sender settings drawer: **Pause / Resume sending** no longer closes it; the status, button, risk and summary update in place and anything you typed stays. **Test connection** now runs inline in the Connection card (button shows "Testing…" and cannot be clicked twice; the SMTP and IMAP result appears below it) instead of a pop-up. The sender cards on the Sending accounts page still open the pop-up result.

**Housekeeping (v1.9.5)**
- Sender settings drawer: a pinned summary (status, Pause/Resume, sent today, health, connection) stays on top and **Save changes / Remove sender** stay at the bottom. The settings are four collapsible cards: **Connection & reply tracking**, **Limits, pace & warm-up**, **Protection & health healing**, **Identity & signature** (with the tracking domain). Each card shows a one-line summary of its current state, even when closed. A red dot marks a problem inside the card (no App Password, connection problem, invalid limit or pause range, health below the pause line, high risk); an amber dot is a warning (waiting for the first inbox check, moderate risk, Force continue on). Cards with a problem open by themselves; **Expand all** opens everything. Nothing else about saving or the settings' behaviour changed.

**Housekeeping (v1.9.4)**
- Campaigns page: a project's ⋮ menu has **Pause** (or **Resume** when paused), which acts on every running (or paused) campaign in it; campaign rows already had the same. When you tick projects, the selection bar now appears **above** the table with **Pause** (and **Resume** if any selected project is paused) next to Archive, Delete and Clear. Projects with nothing to change are reported, not failed silently.

**Housekeeping (v1.9.3)**
- **Successful** is a manual outcome: in an Inbox conversation click **Successful** next to the reply tags (click again to undo). The Inbox Status filter has a **Successful** tab; **Not successful** now means opted out or bounced and not marked Successful, so it no longer overlaps **Not interested**. The campaigns table's Successful column counts these marks.
- **Queue → Next email** shows when each campaign's next email leaves (days/hours/minutes), and Status uses the same pills as Campaigns.
- Mail-server time-outs now say which step was slow (connecting, signing in, reading), name the mailbox and host:port, and after the 3rd failure in a row SenderBolt runs a DNS/TCP/TLS check and shows the finding in the account's sync message and in **Test connection**.

- A malformed answer from a mail server can no longer crash the server: that sync fails cleanly, the connection is closed and it is retried with back-off.
