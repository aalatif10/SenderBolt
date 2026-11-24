'use strict';
// The sending engine. tick() is called every few seconds by the scheduler and sends at most ONE
// email per eligible sender per tick (the sender's own throttle delay does the pacing).
//
// Guarantees (each one is covered by tests):
//  * At-most-once delivery: a 'sending' row (unique idempotency key) is written BEFORE the SMTP call,
//    so a crash can never cause a duplicate email. After a restart, an interrupted send is marked
//    failed and its lead flagged 'error' instead of being retried blindly.
//  * Right party blamed: login/quota problems pause the SENDER (the lead keeps its place); bad
//    addresses bounce and suppress the LEAD; network errors retry with backoff.
//  * Never mail someone who opted out, replied, bounced, or whose campaign was paused: all of that is
//    re-checked immediately before every send, inside the same transaction that claims the send.
//  * Never exceed a sender's daily limit (hard cap 400, warm-up ramp), send window, or health floor.
//  * Replies must be monitorable: a sender whose mailbox cannot be read is not allowed to send.
var crypto = require('crypto');
var vault = require('../lib/vault');
var tpl = require('../lib/template');
var sanitize = require('../lib/sanitize');
var withSignature = require('../services/settings').withSignature;
var split = require('../lib/split');
var throttle = require('../lib/throttle');
var email = require('../lib/email');
var html = require('../lib/html');
var unsub = require('../lib/unsub');
var track = require('../lib/track');
var health = require('../lib/health');
var classify = require('../lib/sendErrors').classify;
var capacityToday = require('../services/senders').capacityToday;
var senderHealth = require('../services/senderHealth');
var images = require('../services/images');
var state = require('../services/campaignState');
var settingsLib = require('../services/settings');
var stateLib = state;

var DAY = 86400000;
var MAX_ATTEMPTS = 5;
var BACKOFF_MIN = [5, 15, 60, 240, 720];
var STREAK_LIMIT = 5;               // default (medium protection); each sender's level can change it, see lib/health.js
var STREAK_PAUSE_MS = 30 * 60000;
var SEND_TIMEOUT_MS = 45000;
var CANDIDATES_PER_TICK = 25;
var gate = require('../lib/senderGate');
var trackingOk = gate.trackingOk;
var SYNC_FRESH_MS = gate.SYNC_FRESH_MS;
var RECONCILE_EVERY_MS = 30000;

function utcDate(t) { return new Date(t).toISOString().slice(0, 10); }
function nextUtcMidnight(t) { var d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
function hash32(n) { return (Math.imul(n | 0, 2654435761) >>> 0); }

// Is campaign c (window settings) allowed to send at time t? Hours are local = UTC + offset.
function inWindow(c, t) {
  var local = new Date(t + c.utc_offset_min * 60000), hour = local.getUTCHours();
  if (hour < c.window_start_hour || hour >= c.window_end_hour) return false;
  var mask = c.active_days ? c.active_days : (c.weekdays_only ? 62 : 127);
  if (!(mask & (1 << local.getUTCDay()))) return false;
  return true;
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { var e = new Error('Sending timed out'); e.code = 'ETIMEDOUT'; reject(e); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

function mapLimit(items, limit, fn) {
  var i = 0, active = [];
  function worker() { if (i >= items.length) return Promise.resolve(); var it = items[i++]; return fn(it).then(worker); }
  for (var k = 0; k < Math.min(limit, items.length); k++) active.push(worker());
  return Promise.all(active);
}

function SendEngine(db, deps) {
  this.db = db;
  this.key = deps.key;
  this.mailer = deps.mailer;
  this.now = deps.now || Date.now;
  this.secret = deps.unsubSecret || '';
  this.publicOrigin = deps.publicOrigin || '';
  this.requireReplyTracking = !!deps.requireReplyTracking;
  this.concurrency = deps.concurrency || 4;
  this.sendTimeoutMs = deps.sendTimeoutMs || SEND_TIMEOUT_MS;
  this.log = deps.log || function () {};
  this.running = false;
  this.lastTickAt = null;
  this.lastError = null;
  this._steps = {};
  this._reconciledAt = 0;
}
var E = SendEngine.prototype;

// Decrypt the sender's password and hand the message to the SMTP transport (with a hard timeout).
E.deliver = function (sender, mail) {
  var creds;
  try {
    creds = { host: sender.smtp_host, port: sender.smtp_port, secure: !!sender.smtp_secure, user: sender.username,
      pass: vault.decrypt(sender.password_enc, this.key, 'sender:' + sender.id) };
  } catch (e) { var err = new Error('Could not decrypt sender password'); err.code = 'EDECRYPT'; return Promise.reject(err); }
  return withTimeout(this.mailer.send(creds, mail), this.sendTimeoutMs);
};

// ---------- startup recovery ----------
// Any message still 'sending' means the process died mid-send. We cannot know whether it was
// delivered, so it is NOT retried (a duplicate cold email is worse than one missed email).
E.recoverInterrupted = function () {
  var self = this, t = this.now();
  return this.db.all("SELECT id, campaign_lead_id FROM messages WHERE status = 'sending'").then(function (rows) {
    return rows.reduce(function (p, r) {
      return p.then(function () {
        return self.db.transaction(function (tx) {
          return tx.run("UPDATE messages SET status = 'failed', error_class = 'interrupted', error = 'Interrupted before delivery was confirmed' WHERE id = ?", [r.id]).then(function () {
            if (!r.campaign_lead_id) return null;
            return tx.get('SELECT campaign_id FROM campaign_leads WHERE id = ?', [r.campaign_lead_id]).then(function (cl) {
              return tx.run("UPDATE campaign_leads SET status = 'error', next_send_at = NULL, status_note = 'Delivery state unknown after a restart; not retried to avoid a duplicate' WHERE id = ? AND status = 'active'", [r.campaign_lead_id])
                .then(function () { return cl ? state.completeIfDone(tx, cl.campaign_id, t) : null; });
            });
          });
        });
      });
    }, Promise.resolve()).then(function () { return rows.length; });
  });
};

// ---------- tick ----------
E.tick = function () {
  var self = this;
  if (this.running) return Promise.resolve({ skipped: true });
  this.running = true;
  var t = this.now(), stats = { sent: 0, failed: 0, skipped: 0, senders: 0 };
  this._steps = {};
  function finish(v) { self.running = false; self.lastTickAt = t; return v; }
  return this._reconcile(t).then(function () {
    return Promise.all([
      self.db.all("SELECT id, user_id, window_start_hour, window_end_hour, utc_offset_min, weekdays_only, active_days, start_at FROM campaigns WHERE status = 'active'"),
      self.db.all('SELECT user_id, prefs FROM user_settings')
    ]);
  }).then(function (rs) {
    var camps = rs[0], guards = {};
    rs[1].forEach(function (u) { guards[u.user_id] = settingsLib.guardOf(settingsLib.readPrefs(u.prefs)); });
    // A campaign is open only when its own window AND the owner's system guardrail (if on) are open at the same moment.
    var open = camps.filter(function (c) { return (!c.start_at || c.start_at <= t) && inWindow(c, t) && (!guards[c.user_id] || inWindow(guards[c.user_id], t)); }).map(function (c) { return c.id; }).slice(0, 800);
    if (!open.length) return stats;
    return self.db.all("SELECT * FROM senders WHERE status = 'active' AND (next_send_at IS NULL OR next_send_at <= ?)", [t]).then(function (senders) {
      // Protection level decides the health floor; a "force continue" override lifts it for a while.
      senders = senders.filter(function (s) { return !health.isBelowFloor(s, t) && trackingOk(s, t, self.requireReplyTracking); });
      stats.senders = senders.length;
      return mapLimit(senders, self.concurrency, function (s) {
        return self._processSender(s, t, open, stats).catch(function (e) { self.lastError = e.message; self.log('sender ' + s.id + ': ' + e.message); });
      }).then(function () { return stats; });
    });
  }).then(finish, function (e) { self.lastError = e.message; finish(); throw e; });
};

E._processSender = function (sender, t, openIds, stats) {
  var self = this, tries = 0;
  if (capacityToday(sender, utcDate(t), t) <= 0) return Promise.resolve();
  function next() {
    if (tries++ >= CANDIDATES_PER_TICK) return Promise.resolve();
    return self._nextCandidate(sender.id, t, openIds).then(function (c) {
      if (!c) return null;
      return self._attempt(sender, c, t, stats).then(function (outcome) { if (outcome === 'skipped') { stats.skipped++; return next(); } return null; });
    });
  }
  return next();
};

// The sending priority is a SYSTEM preference (Settings -> System preferences), the same for every campaign of the owner.
E._priorityFor = function (senderId) {
  return this.db.get('SELECT us.prefs AS prefs FROM senders s LEFT JOIN user_settings us ON us.user_id = s.user_id WHERE s.id = ?', [senderId]).then(function (r) {
    return settingsLib.readPrefs(r && r.prefs).priority_mode;
  }, function () { return 'followups_first'; });
};

E._nextCandidate = function (senderId, t, openIds) {
  var self = this;
  return this._priorityFor(senderId).then(function (mode) { return self._nextCandidateBy(senderId, t, openIds, mode); });
};

E._nextCandidateBy = function (senderId, t, openIds, mode) {
  // mode comes from a whitelist (readPrefs), never from user text, so it is safe to pick the ORDER BY expression from it
  var order = mode === 'new_first' ? '(cl.current_step > 0)' : mode === 'balanced' ? 'cl.next_send_at' : '(cl.current_step = 0)';
  return this.db.get(
    'SELECT cl.id AS cl_id, cl.campaign_id, cl.lead_id, cl.current_step, c.user_id, c.track_opens, l.email, l.domain, l.first_name, l.last_name, l.company, l.custom ' +
    "FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id JOIN campaigns c ON c.id = cl.campaign_id " +
    "WHERE cl.sender_id = ? AND cl.status = 'active' AND cl.next_send_at <= ? AND c.status = 'active' AND c.id IN (" + openIds.map(function () { return '?'; }).join(',') + ') ' +
    // Priority: follow-ups before new first emails (default), the opposite, or simply the oldest due first.
    'ORDER BY ' + order + ', cl.next_send_at, cl.position, cl.id LIMIT 1', [senderId, t].concat(openIds));
};

E._stepsFor = function (campaignId) {
  var self = this;
  if (this._steps[campaignId]) return Promise.resolve(this._steps[campaignId]);
  return this.db.all('SELECT step_no, delay_days, subject, body_html FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [campaignId]).then(function (rows) {
    self._steps[campaignId] = rows; return rows;
  });
};

// Stop working on a lead (opted out, bad data, ...). Only touches leads that are still 'active'.
E._finishLead = function (c, status, note, t) {
  return this.db.transaction(function (tx) {
    return tx.run("UPDATE campaign_leads SET status = ?, status_note = ?, next_send_at = NULL WHERE id = ? AND status = 'active'", [status, note, c.cl_id])
      .then(function () { return state.completeIfDone(tx, c.campaign_id, t); });
  });
};

E._compose = function (sender, c, step, history) {
  var vars = tpl.leadVars(c), rnd = split.mulberry32(hash32(c.cl_id * 16 + c.current_step));
  var prev = history.length ? history[history.length - 1] : null, missing = [], subject;
  if (!step.subject && prev) subject = 'Re: ' + String(prev.subject || '').replace(/^(re:\s*)+/i, '');
  else {
    var s = tpl.render(step.subject, vars, { html: false, rnd: rnd });
    subject = s.text; missing = missing.concat(s.missing);
    if (!subject && !s.missing.length) missing.push('subject');
  }
  var b = tpl.render(sanitize.clean(step.body_html), vars, { html: true, rnd: rnd });
  b.missing.forEach(function (m) { if (missing.indexOf(m) === -1) missing.push(m); });

  var link = !c.test && this.publicOrigin && this.secret ? unsub.url(this.publicOrigin, unsub.make(this.secret, c.cl_id)) : null;
  var footer = link
    ? '<p style="font-size:12px;color:#777">If you would rather not receive these emails, <a href="' + link + '">unsubscribe</a> (all my emails), or reply with the words stop campaign to stop this email series.</p>'
    : '<p style="font-size:12px;color:#777">If you would rather not receive these emails, reply with the words stop campaign and I will stop this email series.</p>';
  var pixel = c.track_opens && !c.test && this.publicOrigin && this.secret
    ? '<img src="' + track.url(this.publicOrigin, track.make(this.secret, c.cl_id, c.current_step)) + '" width="1" height="1" alt="" style="border:0;width:1px;height:1px">' : '';
  var bodyHtml = b.text + (sender.signature_html ? '<br>' + sanitize.clean(sender.signature_html) : '') + footer + pixel;
  var mailto = '<mailto:' + sender.email + '?subject=stop%20campaign>';
  var headers = { 'List-Unsubscribe': link ? '<' + link + '>, ' + mailto : mailto };
  if (link) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  var ids = history.map(function (h) { return h.message_id_hdr; }).filter(Boolean);
  var messageId = '<' + crypto.randomBytes(12).toString('hex') + '.' + c.cl_id + '@' + email.domainOf(sender.email) + '>';
  var mail = {
    from: { name: sender.from_name || '', address: sender.email }, to: c.email, subject: subject, html: bodyHtml, text: html.htmlToText(bodyHtml),
    headers: headers, messageId: messageId, inReplyTo: ids.length ? ids[ids.length - 1] : null, references: ids
  };
  return { mail: mail, missing: missing };
};

E._attempt = function (sender, c, t, stats) {
  var self = this, steps, composed, claim;
  return this.db.get('SELECT 1 AS x FROM suppression WHERE user_id = ? AND email = ?', [c.user_id, c.email]).then(function (sup) {
    if (sup) return self._finishLead(c, 'unsubscribed', 'On the suppression list', t).then(function () { return 'skipped'; });
    if (!email.checkSyntax(c.email).ok) return self._finishLead(c, 'error', 'Invalid email address', t).then(function () { return 'skipped'; });
    return self._stepsFor(c.campaign_id).then(function (st) {
      steps = st;
      var step = steps[c.current_step];
      if (!step) return self._finishLead(c, 'completed', null, t).then(function () { return 'skipped'; });
      return self.db.all("SELECT subject, message_id_hdr FROM messages WHERE campaign_lead_id = ? AND direction = 'out' AND status = 'sent' AND step_no IS NOT NULL ORDER BY step_no", [c.cl_id]).then(function (history) {
        return withSignature(self.db, c.user_id, sender).then(function (snd) { return self._attemptSend(snd, c, t, stats, steps, step, history); });
      });
    });
  });
};

E._attemptSend = function (sender, c, t, stats, steps, step, history) {
  var self = this, composed, claim;
  return Promise.resolve().then(function () {
        composed = self._compose(sender, c, step, history);
        if (composed.missing.length) {
          return self._finishLead(c, 'error', 'Missing merge field: ' + composed.missing.join(', '), t).then(function () { return 'skipped'; });
        }
        // Pictures written as sbimg:<id> become inline (CID) parts of this one message.
        return images.embed(self.db, c.user_id, composed.mail.html).then(function (emb) {
          composed.mail.html = emb.html;
          if (emb.attachments.length) composed.mail.attachments = emb.attachments;
          return self._claim(sender, c, composed.mail, steps, t);
        }).then(function (cl) {
          claim = cl;
          if (!claim.ok) return 'skipped';
          return self.deliver(sender, composed.mail).then(function (res) {
            stats.sent++;
            return self._onSuccess(sender, c, steps, claim, composed.mail, res).then(function () { return 'sent'; });
          }, function (err) {
            stats.failed++;
            return self._onFailure(sender, c, steps, claim, err).then(function () { return 'failed'; });
          });
        });
  });
};

// Write the 'sending' row (or revive a retryable failed one) and re-validate everything, atomically.
E._claim = function (sender, c, mail, steps, t) {
  var key = 'cl:' + c.cl_id + ':s:' + c.current_step, self = this;
  return this.db.transaction(function (tx) {
    return tx.get('SELECT cl.status AS st, cl.current_step AS step, c.status AS cst FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = ?', [c.cl_id]).then(function (row) {
      if (!row || row.st !== 'active' || row.cst !== 'active' || row.step !== c.current_step) return { ok: false };
      // Last line of defence: the block list is read again in the same transaction that claims the send, so an address blocked
      // while this email was being prepared (images, templates) is never sent to.
      return tx.get('SELECT 1 AS x FROM suppression WHERE user_id = ? AND email = ?', [c.user_id, c.email]).then(function (sup) {
        if (!sup) return null;
        return tx.run("UPDATE campaign_leads SET status = 'unsubscribed', next_send_at = NULL, status_note = 'On the suppression list' WHERE id = ? AND status = 'active'", [c.cl_id])
          .then(function () { return state.completeIfDone(tx, c.campaign_id, t); }).then(function () { return { ok: false }; });
      }).then(function (blocked) {
      if (blocked) return blocked;
      return tx.get('SELECT id, status, attempts FROM messages WHERE idempotency_key = ?', [key]).then(function (ex) {
        var vals = [mail.messageId, mail.inReplyTo, mail.subject, mail.html, mail.text, mail.from.address, mail.to];
        if (!ex) {
          return tx.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, message_id_hdr, in_reply_to, subject, body_html, body_text, from_addr, to_addr, step_no, attempts, kind, created_at) " +
            "VALUES (?,?,?,?,'out','sending',?,?,?,?,?,?,?,?,?,1,'email',?)", [c.user_id, c.cl_id, sender.id, c.lead_id, key].concat(vals, [c.current_step, t])).then(function (r) { return { ok: true, id: r.lastID, attempts: 1 }; });
        }
        if (ex.status === 'failed' && ex.attempts < MAX_ATTEMPTS) {
          return tx.run("UPDATE messages SET status = 'sending', attempts = attempts + 1, error = NULL, error_class = NULL, sender_id = ?, message_id_hdr = ?, in_reply_to = ?, subject = ?, body_html = ?, body_text = ?, from_addr = ?, to_addr = ? WHERE id = ?",
            [sender.id].concat(vals, [ex.id])).then(function () { return { ok: true, id: ex.id, attempts: ex.attempts + 1 }; });
        }
        if (ex.status === 'sent') {          // already delivered earlier but the lead was not advanced: repair, never resend
          return self._applySuccess(tx, c, steps, t).then(function () { return { ok: false }; });
        }
        return tx.run("UPDATE campaign_leads SET status = 'error', next_send_at = NULL, status_note = 'Duplicate-send guard: this step was already attempted' WHERE id = ? AND status = 'active'", [c.cl_id])
          .then(function () { return state.completeIfDone(tx, c.campaign_id, t); }).then(function () { return { ok: false }; });
      });
      });
    });
  });
};

E._applySuccess = function (tx, c, steps, t) {
  var next = c.current_step + 1;
  if (next >= steps.length) {
    return tx.run("UPDATE campaign_leads SET status = 'completed', current_step = ?, last_sent_at = ?, next_send_at = NULL, status_note = NULL WHERE id = ? AND status = 'active'", [next, t, c.cl_id])
      .then(function () { return state.completeIfDone(tx, c.campaign_id, t); });
  }
  return tx.run("UPDATE campaign_leads SET current_step = ?, last_sent_at = ?, next_send_at = ?, status_note = NULL WHERE id = ? AND status = 'active'",
    [next, t, t + steps[next].delay_days * DAY, c.cl_id]);
};

E._onSuccess = function (sender, c, steps, claim, mail, res) {
  var self = this, t2 = this.now(), today = utcDate(t2);
  var delay = throttle.nextDelayMs({ mode: sender.delay_mode, fixedSec: sender.delay_fixed_sec, minSec: sender.delay_min_sec, maxSec: sender.delay_max_sec });
  return this.db.transaction(function (tx) {
    return tx.run("UPDATE messages SET status = 'sent', sent_at = ?, message_id_hdr = ?, error = NULL, error_class = NULL WHERE id = ?", [t2, (res && res.messageId) || mail.messageId, claim.id])
      .then(function () { return self._applySuccess(tx, c, steps, t2); })
      .then(function () { return tx.get('SELECT * FROM senders WHERE id = ?', [sender.id]); })
      .then(function (fresh) {
        // Ramp progress: rampIndex() decides (from the fresh row) whether the previous send day earned a step.
        // It is always recomputed here, so idle days never advance it. It also counts while warm-up is off,
        // so an account that has been sending at volume is treated as warmed up if warm-up is switched on later.
        var idx = throttle.rampIndex(fresh, today);
        return tx.run('UPDATE senders SET sent_today = CASE WHEN sent_today_date = ? THEN sent_today + 1 ELSE 1 END, sent_today_date = ?, warmup_days = ?, next_send_at = ?, error_streak = 0, last_error = NULL, connection_error = NULL, connection_error_at = NULL, warmup_started_at = COALESCE(warmup_started_at, ?) WHERE id = ?',
          [today, today, idx, t2 + delay, t2, sender.id]);
      });
  });
};

E._onFailure = function (sender, c, steps, claim, err) {
  var self = this, t2 = this.now(), cls = classify(err), today = utcDate(t2);
  var detail = String((err && (err.response || err.message)) || '').replace(/\s+/g, ' ').slice(0, 300);
  var delay = throttle.nextDelayMs({ mode: sender.delay_mode, fixedSec: sender.delay_fixed_sec, minSec: sender.delay_min_sec, maxSec: sender.delay_max_sec });
  var connIssue = cls.kind === 'auth' || cls.network === true;
  var senderSide = connIssue || cls.kind === 'quota';
  var attempts = senderSide ? Math.max(0, claim.attempts - 1) : claim.attempts;     // sender-side failures do not use up the lead's retries
  return this.db.transaction(function (tx) {
    var p = tx.run("UPDATE messages SET status = 'failed', error = ?, error_class = ?, attempts = ? WHERE id = ?", [cls.message + (detail ? ' [' + detail + ']' : ''), cls.kind, attempts, claim.id]);
    if (connIssue) {
      // Wrong/revoked App Password or the server cannot be reached: the sender stays ACTIVE (never paused, health untouched),
      // the problem is shown on the account, and the engine retries after a back-off (15 min for login, 5 min for network).
      return p.then(function () {
        return tx.run('UPDATE senders SET connection_error = ?, connection_error_at = ?, last_error = ?, next_send_at = ? WHERE id = ?',
          [cls.message, t2, cls.message, t2 + (cls.kind === 'auth' ? 15 : 5) * 60000, sender.id]);
      });
    }
    if (cls.kind === 'quota') {
      var daily = /daily|quota|per day|24/i.test(detail);
      var until = daily ? nextUtcMidnight(t2) : t2 + 3600000;
      return p.then(function () {
        return tx.run('UPDATE senders SET sent_today = CASE WHEN ? THEN daily_limit ELSE sent_today END, sent_today_date = CASE WHEN ? THEN ? ELSE sent_today_date END, next_send_at = ?, last_error = ? WHERE id = ?',
          [daily ? 1 : 0, daily ? 1 : 0, today, until, 'Provider sending limit reached; resumes ' + (daily ? 'tomorrow (UTC)' : 'in 1 hour'), sender.id]);
      });
    }
    // The connection itself worked (the server answered), so the sender's failure streak resets.
    function senderOk() { return tx.run('UPDATE senders SET next_send_at = ?, error_streak = 0 WHERE id = ?', [t2 + delay, sender.id]); }
    if (cls.kind === 'recipient') {
      return p.then(senderOk).then(function () {
        return tx.run("UPDATE campaign_leads SET status = 'bounced', next_send_at = NULL, status_note = 'Address rejected by the receiving server' WHERE id = ? AND status = 'active'", [c.cl_id]);
      }).then(function () { return tx.run("INSERT OR IGNORE INTO suppression (user_id, email, reason, created_at) VALUES (?,?,'bounced',?)", [c.user_id, c.email, t2]); })
        .then(function () { return stateLib.stopQueued(tx, c.user_id, c.email, 'bounced', 'Address bounced in another campaign', t2); })
        .then(function () { return tx.run("UPDATE leads SET verify_status = 'invalid', verify_error = 'rejected_when_sending', verified_at = ? WHERE id = ?", [t2, c.lead_id]); })
        .then(function () { return state.completeIfDone(tx, c.campaign_id, t2); });
    }
    if (cls.kind === 'policy') {
      return p.then(senderOk).then(function () {
        return tx.run("UPDATE campaign_leads SET status = 'error', next_send_at = NULL, status_note = 'Blocked by the receiving server (policy)' WHERE id = ? AND status = 'active'", [c.cl_id]);
      }).then(function () { return state.completeIfDone(tx, c.campaign_id, t2); });
    }
    // transient: retry this lead later with backoff; slow the sender down if failures keep happening
    var streak = (sender.error_streak || 0) + 1;
    var pauseSender = streak >= health.streakLimitFor(sender) && !health.isForced(sender, t2);     // "force continue" skips this automatic pause
    return p.then(function () {
      if (claim.attempts >= MAX_ATTEMPTS) {
        return tx.run("UPDATE campaign_leads SET status = 'error', next_send_at = NULL, status_note = ? WHERE id = ? AND status = 'active'", ['Gave up after ' + MAX_ATTEMPTS + ' failed attempts', c.cl_id])
          .then(function () { return state.completeIfDone(tx, c.campaign_id, t2); });
      }
      return tx.run("UPDATE campaign_leads SET next_send_at = ? WHERE id = ? AND status = 'active'", [t2 + BACKOFF_MIN[claim.attempts - 1] * 60000, c.cl_id]);
    }).then(function () {
      return tx.run('UPDATE senders SET error_streak = ?, next_send_at = ?, last_error = ? WHERE id = ?',
        [streak, t2 + (pauseSender ? STREAK_PAUSE_MS : 60000), cls.message + (pauseSender ? ' Paused for 30 minutes after repeated failures.' : ''), sender.id]);
    });
  }).then(function () {
    if (cls.kind === 'recipient' || cls.kind === 'policy') return senderHealth.recompute(self.db, sender.id, t2);
    return null;
  });
};

// ---------- campaigns are never blocked ----------
// Protection works on SENDER accounts only: a sender that falls below its health line is paused (see senderHealth), and its people simply
// wait. The campaign itself keeps its own status. Older versions marked such campaigns 'error'; this puts any of those back to 'active'.
// Single source of truth for "sent today": the messages table. A sender's stored counter (the one the daily limit uses) is only
// ever raised to match it, never lowered, because a provider quota error deliberately marks the counter as full.
// This heals a counter that fell behind (crash between send and update, restored data) so cards, limits and Home agree.
E._healSentToday = function (t) {
  var self = this, today = utcDate(t), start = Date.parse(today + 'T00:00:00Z');
  return this.db.all("SELECT m.sender_id AS id, COUNT(*) AS n FROM messages m WHERE m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ? AND m.sent_at < ? AND m.sender_id IS NOT NULL GROUP BY m.sender_id", [start, start + DAY]).then(function (rows) {
    return rows.reduce(function (p, r) {
      return p.then(function () {
        return self.db.run('UPDATE senders SET sent_today = ?, sent_today_date = ? WHERE id = ? AND ((sent_today_date = ? AND sent_today < ?) OR sent_today_date IS NULL OR sent_today_date != ?)', [r.n, today, r.id, today, r.n, today]);
      });
    }, Promise.resolve());
  });
};

E._reconcile = function (t) {
  var self = this;
  if (t - this._reconciledAt < RECONCILE_EVERY_MS) return Promise.resolve();
  this._reconciledAt = t;
  return this._healSentToday(t).then(function () { return self.db.all("SELECT id, parent_id FROM campaigns WHERE status = 'error'"); }).then(function (camps) {
    return camps.reduce(function (p, c) {
      return p.then(function () {
        return self.db.run("UPDATE campaigns SET status = 'active', last_error = NULL, updated_at = ? WHERE id = ?", [t, c.id])
          .then(function () { return state.completeIfDone(self.db, c.id, t); })
          .then(function () { return c.parent_id ? state.syncMain(self.db, c.parent_id, t) : null; });
      });
    }, Promise.resolve());
  });
};

module.exports = { SendEngine: SendEngine, inWindow: inWindow, utcDate: utcDate, trackingOk: trackingOk, MAX_ATTEMPTS: MAX_ATTEMPTS, BACKOFF_MIN: BACKOFF_MIN, STREAK_LIMIT: STREAK_LIMIT };
