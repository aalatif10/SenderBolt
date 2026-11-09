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
var split = require('../lib/split');
var throttle = require('../lib/throttle');
var email = require('../lib/email');
var html = require('../lib/html');
var unsub = require('../lib/unsub');
var health = require('../lib/health');
var classify = require('../lib/sendErrors').classify;
var capacityToday = require('../services/senders').capacityToday;
var senderHealth = require('../services/senderHealth');
var state = require('../services/campaignState');

var DAY = 86400000;
var MAX_ATTEMPTS = 5;
var BACKOFF_MIN = [5, 15, 60, 240, 720];
var STREAK_LIMIT = 5;
var STREAK_PAUSE_MS = 30 * 60000;
var SEND_TIMEOUT_MS = 45000;
var CANDIDATES_PER_TICK = 25;
var SYNC_FRESH_MS = 15 * 60000;
var RECONCILE_EVERY_MS = 30000;

function utcDate(t) { return new Date(t).toISOString().slice(0, 10); }
function nextUtcMidnight(t) { var d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
function hash32(n) { return (Math.imul(n | 0, 2654435761) >>> 0); }

// Is campaign c (window settings) allowed to send at time t? Hours are local = UTC + offset.
function inWindow(c, t) {
  var local = new Date(t + c.utc_offset_min * 60000), hour = local.getUTCHours();
  if (hour < c.window_start_hour || hour >= c.window_end_hour) return false;
  if (c.weekdays_only) { var d = local.getUTCDay(); if (d === 0 || d === 6) return false; }
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

function trackingOk(s, t, required) {
  if (!required || !s.imap_host) return true;
  return s.imap_last_uid !== null && s.imap_last_uid !== undefined && !s.sync_error && s.last_sync_at !== null && s.last_sync_at !== undefined && t - s.last_sync_at <= SYNC_FRESH_MS;
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
    return self.db.all("SELECT id, window_start_hour, window_end_hour, utc_offset_min, weekdays_only FROM campaigns WHERE status = 'active'");
  }).then(function (camps) {
    var open = camps.filter(function (c) { return inWindow(c, t); }).map(function (c) { return c.id; }).slice(0, 800);
    if (!open.length) return stats;
    return self.db.all("SELECT * FROM senders WHERE status = 'active' AND health_score >= ? AND (next_send_at IS NULL OR next_send_at <= ?)", [health.AUTO_PAUSE_BELOW, t]).then(function (senders) {
      senders = senders.filter(function (s) { return trackingOk(s, t, self.requireReplyTracking); });
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

E._nextCandidate = function (senderId, t, openIds) {
  return this.db.get(
    'SELECT cl.id AS cl_id, cl.campaign_id, cl.lead_id, cl.current_step, c.user_id, l.email, l.domain, l.first_name, l.last_name, l.company, l.custom ' +
    "FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id JOIN campaigns c ON c.id = cl.campaign_id " +
    "WHERE cl.sender_id = ? AND cl.status = 'active' AND cl.next_send_at <= ? AND c.status = 'active' AND c.id IN (" + openIds.map(function () { return '?'; }).join(',') + ') ' +
    'ORDER BY cl.next_send_at, cl.position, cl.id LIMIT 1', [senderId, t].concat(openIds));
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
  var b = tpl.render(step.body_html, vars, { html: true, rnd: rnd });
  b.missing.forEach(function (m) { if (missing.indexOf(m) === -1) missing.push(m); });

  var link = this.publicOrigin && this.secret ? unsub.url(this.publicOrigin, unsub.make(this.secret, c.cl_id)) : null;
  var footer = link
    ? '<p style="font-size:12px;color:#777">If you would rather not receive these emails, <a href="' + link + '">unsubscribe</a>.</p>'
    : '<p style="font-size:12px;color:#777">Not interested? Reply with "unsubscribe" and I will not contact you again.</p>';
  var bodyHtml = b.text + (sender.signature_html ? '<br>' + sender.signature_html : '') + footer;
  var mailto = '<mailto:' + sender.email + '?subject=unsubscribe>';
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
        composed = self._compose(sender, c, step, history);
        if (composed.missing.length) {
          return self._finishLead(c, 'error', 'Missing merge field: ' + composed.missing.join(', '), t).then(function () { return 'skipped'; });
        }
        return self._claim(sender, c, composed.mail, steps, t).then(function (cl) {
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
    });
  });
};

// Write the 'sending' row (or revive a retryable failed one) and re-validate everything, atomically.
E._claim = function (sender, c, mail, steps, t) {
  var key = 'cl:' + c.cl_id + ':s:' + c.current_step, self = this;
  return this.db.transaction(function (tx) {
    return tx.get('SELECT cl.status AS st, cl.current_step AS step, c.status AS cst FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.id = ?', [c.cl_id]).then(function (row) {
      if (!row || row.st !== 'active' || row.cst !== 'active' || row.step !== c.current_step) return { ok: false };
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
      .then(function () {
        return tx.run('UPDATE senders SET sent_today = CASE WHEN sent_today_date = ? THEN sent_today + 1 ELSE 1 END, sent_today_date = ?, next_send_at = ?, error_streak = 0, last_error = NULL, warmup_started_at = COALESCE(warmup_started_at, ?) WHERE id = ?',
          [today, today, t2 + delay, t2, sender.id]);
      });
  });
};

E._onFailure = function (sender, c, steps, claim, err) {
  var self = this, t2 = this.now(), cls = classify(err), today = utcDate(t2);
  var detail = String((err && (err.response || err.message)) || '').replace(/\s+/g, ' ').slice(0, 300);
  var delay = throttle.nextDelayMs({ mode: sender.delay_mode, fixedSec: sender.delay_fixed_sec, minSec: sender.delay_min_sec, maxSec: sender.delay_max_sec });
  var senderSide = cls.kind === 'auth' || cls.kind === 'quota';
  var attempts = senderSide ? Math.max(0, claim.attempts - 1) : claim.attempts;     // sender-side failures do not use up the lead's retries
  return this.db.transaction(function (tx) {
    var p = tx.run("UPDATE messages SET status = 'failed', error = ?, error_class = ?, attempts = ? WHERE id = ?", [cls.message + (detail ? ' [' + detail + ']' : ''), cls.kind, attempts, claim.id]);
    if (cls.kind === 'auth') {
      return p.then(function () { return tx.run("UPDATE senders SET status = 'paused', last_error = ?, next_send_at = NULL, updated_at = ? WHERE id = ?", [cls.message, t2, sender.id]); });
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
    var pauseSender = streak >= STREAK_LIMIT;
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

// ---------- campaign-level error status ----------
// A campaign whose waiting leads all belong to unusable senders shows as 'error' (dashboard "With Error");
// it returns to 'active' automatically once a sender is usable again.
E._reconcile = function (t) {
  var self = this;
  if (t - this._reconciledAt < RECONCILE_EVERY_MS) return Promise.resolve();
  this._reconciledAt = t;
  return this.db.all("SELECT id, parent_id, status FROM campaigns WHERE status IN ('active','error') AND EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = campaigns.id)").then(function (camps) {
    return camps.reduce(function (p, c) {
      return p.then(function () {
        return self.db.get("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.status = 'active' AND s.health_score >= ? THEN 1 ELSE 0 END), 0) AS usable FROM campaign_leads cl LEFT JOIN senders s ON s.id = cl.sender_id WHERE cl.campaign_id = ? AND cl.status = 'active'", [health.AUTO_PAUSE_BELOW, c.id]).then(function (r) {
          if (r.n > 0 && Number(r.usable) === 0 && c.status === 'active') {
            return self.db.get("SELECT s.last_error AS e, s.status AS st FROM campaign_leads cl JOIN senders s ON s.id = cl.sender_id WHERE cl.campaign_id = ? AND cl.status = 'active' LIMIT 1", [c.id]).then(function (why) {
              var reason = (why && why.e) || 'All sending accounts for this campaign are paused or disabled';
              return self.db.run("UPDATE campaigns SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?", [reason, t, c.id]);
            }).then(function () { return c.parent_id ? state.syncMain(self.db, c.parent_id, t) : null; });
          }
          if (c.status === 'error' && (r.n === 0 || Number(r.usable) > 0)) {
            return self.db.run("UPDATE campaigns SET status = 'active', last_error = NULL, updated_at = ? WHERE id = ?", [t, c.id])
              .then(function () { return state.completeIfDone(self.db, c.id, t); })
              .then(function () { return c.parent_id ? state.syncMain(self.db, c.parent_id, t) : null; });
          }
          return null;
        });
      });
    }, Promise.resolve());
  });
};

module.exports = { SendEngine: SendEngine, inWindow: inWindow, utcDate: utcDate, trackingOk: trackingOk, MAX_ATTEMPTS: MAX_ATTEMPTS, BACKOFF_MIN: BACKOFF_MIN, STREAK_LIMIT: STREAK_LIMIT };
