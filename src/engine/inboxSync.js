'use strict';
// Reads each sender's mailbox (read-only) and turns what it finds into campaign events:
//   reply            -> store it, classify sentiment, STOP the lead's sequence (if the campaign says so)
//   reply containing "stop campaign" / classified not interested -> that person stopped in THAT campaign only (no global block)
//   auto-reply (out of office) -> store it, do NOT stop; push the next email back 3 days
//   hard bounce      -> lead 'bounced', address suppressed + marked invalid, sender health recomputed
//   policy bounce    -> lead 'error' (address may be fine), hurts sender health
//   soft bounce      -> recorded only
// Mail that cannot be tied to one of OUR sent emails is ignored (newsletters, unrelated mail).
//
// Reply tracking is "armed" by recording the mailbox's current end (baseline) BEFORE the sender is
// allowed to send; only mail arriving after that point is processed, never the user's old mail.
var vault = require('../lib/vault');
var email = require('../lib/email');
var bounceLib = require('../lib/bounce');
var sentiment = require('../lib/sentiment');
var state = require('../services/campaignState');
var senderHealth = require('../services/senderHealth');

var DAY = 86400000;
var OOO_DELAY_MS = 3 * DAY;
// Part of the UPDATE after a SUCCESSFUL inbox check: logging in to the mailbox works, so an old connection problem (wrong password, network
// down) on the account is outdated. It clears the stale warning and lets the engine retry at once; if sending is still broken the next
// failed send raises it again. (last_error is cleared only when it is that same connection message.)
var CONN_CLEAR = "last_error = CASE WHEN last_error = connection_error THEN NULL ELSE last_error END, " +
  "next_send_at = CASE WHEN connection_error IS NOT NULL THEN NULL ELSE next_send_at END, connection_error = NULL, connection_error_at = NULL";
var STOPPABLE = ['active', 'pending', 'paused', 'completed'];

var NET = { ETIMEDOUT: 1, ECONNRESET: 1, ECONNREFUSED: 1, ENOTFOUND: 1, EAI_AGAIN: 1, EPIPE: 1, EHOSTUNREACH: 1, ENETUNREACH: 1, ESOCKET: 1, ECONNECTION: 1 };
var RETRY_MAX_MS = 5 * 60000;       // transient failures: 1, 2, 4, then every 5 minutes (stays inside the 15 minute "fresh" window)
var RETRY_LOGIN_MS = 15 * 60000;    // a rejected login will not fix itself quickly: ask Gmail at most every 15 minutes

// A time-out or network blip says nothing about the account itself: it is retried quietly and never blocks sending.
function isTransient(e) {
  var code = e && e.code ? String(e.code) : '', src = e && e.source ? String(e.source) : '', msg = String((e && e.message) || '');
  return !!NET[code] || code === 'IMAP_PROTOCOL' || src === 'protocol' || /^timeout/.test(src) || /timed? ?out|socket hang up|ECONN|getaddrinfo/i.test(msg);
}

// Which step of the IMAP conversation went wrong: connect (TCP/TLS) | login | read (after login) | protocol | network | other
function phaseOf(e) {
  var src = e && e.source ? String(e.source) : '', code = e && e.code ? String(e.code) : '';
  if (src === 'protocol' || code === 'IMAP_PROTOCOL') return 'protocol';
  if (src === 'timeout') return 'connect';
  if (src === 'timeout-auth') return 'login';
  if (src === 'timeout-op') return 'read';
  if (NET[code]) return 'network';
  return 'other';
}
function where(e) { return e && e.imapHost ? ' (' + e.imapHost + (e.imapPort ? ':' + e.imapPort : '') + ')' : ''; }

function friendlyError(e) {
  var msg = String((e && e.message) || ''), code = e && e.code ? String(e.code) : '';
  if (/need the .*packages/i.test(msg)) return msg.slice(0, 200);
  var ph = phaseOf(e);
  if (ph === 'protocol') return 'The mail server sent an unexpected response' + where(e) + '. SenderBolt will retry automatically.';
  // Time-outs first: "Timed out while authenticating with server" contains the word "authenticating" but is NOT a rejected login.
  if (ph === 'connect') return 'Could not open a connection to the mail server' + where(e) + ' in time. Check the IMAP server and port, and that nothing blocks this computer from reaching it. SenderBolt will retry automatically.';
  if (ph === 'login') return 'The mail server' + where(e) + ' did not finish the sign-in in time (it is busy or slowing this account down). This is not a wrong password. SenderBolt will retry automatically.';
  if (ph === 'read') return 'The mail server' + where(e) + ' stopped answering while the inbox was being read. SenderBolt will retry automatically.';
  if (ph === 'network') return 'Could not reach the mail server' + where(e) + ' (' + code + '). SenderBolt will retry automatically.';
  if (isTransient(e)) return 'The mail server did not answer in time. SenderBolt will retry automatically.';
  if (/auth|login|credential|invalid|password/i.test(msg + ' ' + (e && e.textCode || ''))) return 'IMAP login failed. Check the App Password and that IMAP is enabled for this account.';
  return 'Could not read the mailbox' + (code ? ' (' + code + ')' : '') + '. Will retry.';
}

// What a connectivity probe found, in plain words (appended once failures repeat, so the owner sees WHY).
function probeHint(r, host, port) {
  if (!r) return '';
  var at = host + ':' + (port || 993);
  if (r.ok) return ' Connection test: ' + at + ' is reachable (' + r.ms + ' ms), so the server is slow to answer for this account.';
  if (r.step === 'dns') return ' Connection test: the address ' + host + ' cannot be found. Check the IMAP server name.';
  if (r.step === 'tcp') return ' Connection test: ' + at + ' does not accept connections (' + r.detail + '). Check the IMAP server and port, and any firewall or antivirus on this computer.';
  return ' Connection test: ' + at + ' accepts connections but the secure handshake fails (' + r.detail + '). This port may not use SSL/TLS: check the IMAP port (usually 993).';
}

function retryDelay(failures, transient) {
  return transient ? Math.min(RETRY_MAX_MS, 60000 * Math.pow(2, Math.max(0, failures - 1))) : RETRY_LOGIN_MS;
}

function InboxSync(db, deps) {
  this.db = db;
  this.key = deps.key;
  this.mailbox = deps.mailbox;
  this.now = deps.now || Date.now;
  this.log = deps.log || function () {};
  this.running = false;
  this.lastRunAt = null;
}
var S = InboxSync.prototype;

S._creds = function (s) {
  return { host: s.imap_host, port: s.imap_port || 993, user: s.username, pass: vault.decrypt(s.password_enc, this.key, 'sender:' + s.id) };
};

// One sender: arm (first time) or fetch + process new mail. Never throws; failures are recorded on the sender.
S.syncSender = function (s) {
  var self = this;
  return Promise.resolve().then(function () {
    var creds = self._creds(s);
    if (s.imap_last_uid === null || s.imap_last_uid === undefined) {
      return self.mailbox.baseline(creds).then(function (b) {
        return self.db.run('UPDATE senders SET imap_uidvalidity = ?, imap_last_uid = ?, last_sync_at = ?, sync_error = NULL, sync_transient = 0, sync_failures = 0, sync_retry_at = NULL, ' + CONN_CLEAR + ' WHERE id = ?', [b.uidValidity, b.lastUid, self.now(), s.id])
          .then(function () { return { armed: true }; });
      });
    }
    return self.mailbox.fetchSince(creds, { uidValidity: s.imap_uidvalidity, lastUid: s.imap_last_uid }).then(function (res) {
      if (res.reset) {            // mailbox was rebuilt on the server: start again from its current end
        self.log('mailbox of sender ' + s.id + ' was reset (UIDVALIDITY changed)');
        return self.db.run('UPDATE senders SET imap_uidvalidity = ?, imap_last_uid = ?, last_sync_at = ?, sync_error = NULL, sync_transient = 0, sync_failures = 0, sync_retry_at = NULL, ' + CONN_CLEAR + ' WHERE id = ?', [res.uidValidity, res.lastUid, self.now(), s.id])
          .then(function () { return { reset: true }; });
      }
      var counts = { reply: 0, bounce: 0, auto_reply: 0, ignored: 0, duplicate: 0 };
      return res.messages.reduce(function (p, m) {
        return p.then(function () {
          return self.processMessage(s, m).then(function (outcome) { counts[outcome] = (counts[outcome] || 0) + 1; });
        }).then(function () { return self.db.run('UPDATE senders SET imap_last_uid = ? WHERE id = ? AND imap_last_uid < ?', [m.uid, s.id, m.uid]); });
      }, Promise.resolve()).then(function () {
        return self.db.run('UPDATE senders SET imap_last_uid = CASE WHEN imap_last_uid < ? THEN ? ELSE imap_last_uid END, last_sync_at = ?, sync_error = NULL, sync_transient = 0, sync_failures = 0, sync_retry_at = NULL, ' + CONN_CLEAR + ' WHERE id = ?', [res.lastUid, res.lastUid, self.now(), s.id]);
      }).then(function () { return counts; });
    });
  }).catch(function (e) {
    var transient = isTransient(e), failures = (s.sync_failures || 0) + 1, t = self.now(), base = friendlyError(e);
    var label = (s.email || ('sender ' + s.id)) + (s.imap_host ? ', ' + s.imap_host + ':' + (s.imap_port || 993) : '');
    // From the 3rd failure in a row (and every 10th) run a quick DNS/TCP/TLS check so the message says WHY; in between keep the last finding.
    var probeNow = transient && (failures === 3 || failures % 10 === 0) && typeof self.mailbox.probe === 'function';
    var hintP = probeNow ? Promise.resolve().then(function () { return self.mailbox.probe(self._creds(s)); }).then(function (r) { return probeHint(r, s.imap_host, s.imap_port); }, function () { return ''; })
      : Promise.resolve(failures > 3 && transient && /Connection test:/.test(s.sync_error || '') ? (' Connection test:' + String(s.sync_error).split(' Connection test:')[1]) : '');
    return hintP.then(function (hint) {
      var msg = base + hint;
      // Log the first failure and then only every 10th: a mailbox that is down must not flood the terminal every minute.
      if (failures === 1 || failures === 3 || failures % 10 === 0) self.log('sync sender ' + s.id + ' (' + label + '): ' + msg + (failures > 1 ? ' [' + failures + ' failures in a row, next try in ' + Math.round(retryDelay(failures, transient) / 60000) + ' min]' : ''));
      return self.db.run('UPDATE senders SET sync_error = ?, sync_transient = ?, sync_failures = ?, sync_retry_at = ? WHERE id = ?',
        [msg.slice(0, 500), transient ? 1 : 0, failures, t + retryDelay(failures, transient), s.id]).then(function () { return { error: true, transient: transient }; });
    });
  });
};

// All senders that have a mailbox (optionally only one user's). Single-flight.
S.syncAll = function (userId) {
  var self = this;
  if (this.running) return Promise.resolve({ skipped: true });
  this.running = true;
  var sql = "SELECT * FROM senders WHERE imap_host IS NOT NULL AND status <> 'disabled'", params = [];
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  var summary = { senders: 0, reply: 0, bounce: 0, auto_reply: 0, ignored: 0, duplicate: 0, errors: 0 };
  return this.db.all(sql, params).then(function (senders) {
    // Back-off: a sender whose last read failed is not asked again before its retry time (a manual "check now" for one user skips this).
    var t = self.now();
    if (!userId) senders = senders.filter(function (s) { return !s.sync_retry_at || s.sync_retry_at <= t; });
    return senders.reduce(function (p, s) {
      return p.then(function () {
        return self.syncSender(s).then(function (r) {
          summary.senders++;
          if (r.error) summary.errors++;
          ['reply', 'bounce', 'auto_reply', 'ignored', 'duplicate'].forEach(function (k) { summary[k] += r[k] || 0; });
        });
      });
    }, Promise.resolve());
  }).then(function () { self.running = false; self.lastRunAt = self.now(); return summary; }, function (e) { self.running = false; throw e; });
};

S._findLead = function (sender, ids, addr) {
  var self = this;
  var byId = ids.length
    ? this.db.get("SELECT campaign_lead_id AS id FROM messages WHERE sender_id = ? AND direction = 'out' AND campaign_lead_id IS NOT NULL AND message_id_hdr IN (" + ids.map(function () { return '?'; }).join(',') + ') LIMIT 1', [sender.id].concat(ids))
    : Promise.resolve(null);
  return byId.then(function (row) {
    if (row) return row.id;
    if (!addr) return null;
    return self.db.get('SELECT cl.id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.sender_id = ? AND l.user_id = ? AND l.email = ? ORDER BY COALESCE(cl.last_sent_at, 0) DESC, cl.id DESC LIMIT 1', [sender.id, sender.user_id, addr])
      .then(function (r) { return r ? r.id : null; });
  });
};

// Returns 'reply' | 'bounce' | 'auto_reply' | 'ignored' | 'duplicate'
S.processMessage = function (sender, m) {
  var self = this, t = this.now();
  var mid = m.messageId || '<uid-' + sender.id + '-' + m.uid + '@sync.local>';
  var key = ('in:' + sender.id + ':' + mid).slice(0, 250);
  var from = email.normalize(m.from);
  if (!from || from === email.normalize(sender.email)) return Promise.resolve('ignored');
  var bounce = bounceLib.analyze(m);
  var auto = !bounce && sentiment.isAutoReply(m);
  return this.db.get('SELECT id FROM messages WHERE idempotency_key = ?', [key]).then(function (dup) {
    if (dup) return 'duplicate';
    return self._findLead(sender, bounceLib.referencedIds(m), bounce ? bounce.recipient : from).then(function (clId) {
      if (!clId) return 'ignored';
      return self.db.get('SELECT cl.id, cl.campaign_id, cl.status, cl.next_send_at, cl.lead_id, c.user_id, c.stop_on_reply, l.email AS lead_email FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ?', [clId]).then(function (cl) {
        if (!cl) return 'ignored';
        var received = m.date && m.date <= t ? m.date : t;
        var text = String(m.text || '');
        var kind = bounce ? 'bounce' : (auto ? 'auto_reply' : 'email');
        var cls = kind === 'email' ? sentiment.classify(text) : null;
        var stop = kind === 'email' && sentiment.isStopRequest(m.subject, text);
        if (stop) cls = { sentiment: 'not_interested' };
        var sent = kind === 'email' ? cls.sentiment : (kind === 'auto_reply' ? 'out_of_office' : null);
        var cat = bounce ? bounce.kind : null;
        return self.db.transaction(function (tx) {
          return tx.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, message_id_hdr, in_reply_to, subject, body_html, body_text, from_addr, to_addr, kind, error_class, sentiment, received_at, created_at) " +
            "VALUES (?,?,?,?,'in','received',?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [cl.user_id, cl.id, sender.id, cl.lead_id, key, mid, m.inReplyTo || null, String(m.subject || '').slice(0, 300), m.html || null, text.slice(0, 100000), from, email.normalize(m.to || sender.email), kind, cat, sent, received, t]).then(function () {
            if (bounce) return self._applyBounce(tx, cl, bounce, t);
            if (auto) {
              if (cl.status !== 'active') return null;
              return tx.run("UPDATE campaign_leads SET next_send_at = ? WHERE id = ? AND status = 'active' AND next_send_at < ?", [t + OOO_DELAY_MS, cl.id, t + OOO_DELAY_MS]);
            }
            return self._applyReply(tx, cl, stop, t, sender.reply_detection !== 0, kind === 'email' && cls && cls.sentiment === 'not_interested');
          });
        }).then(function () {
          if (bounce && (bounce.kind === 'hard' || bounce.kind === 'policy')) return senderHealth.recompute(self.db, sender.id, t);
          if (kind === 'email') return senderHealth.recompute(self.db, sender.id, t);
          return null;
        }).then(function () { return bounce ? 'bounce' : (auto ? 'auto_reply' : 'reply'); });
      });
    });
  });
};

S._applyBounce = function (tx, cl, bounce, t) {
  if (bounce.kind === 'hard') {
    return tx.run("UPDATE campaign_leads SET status = 'bounced', next_send_at = NULL, status_note = 'Address bounced' WHERE id = ? AND status IN ('active','pending','paused','completed')", [cl.id])
      .then(function () { return tx.run("INSERT OR IGNORE INTO suppression (user_id, email, reason, created_at) VALUES (?,?,'bounced',?)", [cl.user_id, cl.lead_email, t]); })
      .then(function () { return state.stopQueued(tx, cl.user_id, cl.lead_email, 'bounced', 'Address bounced in another campaign', t); })
      .then(function () { return tx.run("UPDATE leads SET verify_status = 'invalid', verify_error = 'hard_bounce', verified_at = ? WHERE id = ?", [t, cl.lead_id]); })
      .then(function () { return state.completeIfDone(tx, cl.campaign_id, t); });
  }
  if (bounce.kind === 'policy') {
    return tx.run("UPDATE campaign_leads SET status = 'error', next_send_at = NULL, status_note = 'Blocked by the receiving server (policy)' WHERE id = ? AND status IN ('active','pending','paused')", [cl.id])
      .then(function () { return state.completeIfDone(tx, cl.campaign_id, t); });
  }
  return null;     // soft bounce: the original server keeps retrying; nothing to do
};

// stop = the reply contains the exact phrase "stop campaign" (see lib/sentiment.js isStopRequest); notInterested = the reply was
// classified "not interested".
// Everything here is scoped to THIS campaign_leads row (this person in this campaign): other campaigns, other people and the
// do-not-email list are never touched (the unsubscribe link and bounces are the global opt-outs).
//  - "stop campaign" phrase: honoured whatever the sender's "Replies detected" switch says; the person is 'stopped' here.
//  - "not interested" reply: 'stopped' here too (the same stopLead() the Inbox button uses), unless the sender's reply detection is off.
//  - any other reply: the sequence ends as 'replied' when the campaign has stop_on_reply (and detection is on).
S._applyReply = function (tx, cl, stop, t, detect, notInterested) {
  if (stop) return state.stopLead(tx, cl.id, cl.campaign_id, 'stop_phrase', t);
  if (detect !== false && notInterested) return state.stopLead(tx, cl.id, cl.campaign_id, 'not_interested', t);
  if (detect !== false && cl.stop_on_reply === 1 && STOPPABLE.indexOf(cl.status) !== -1) {
    return tx.run("UPDATE campaign_leads SET status = 'replied', next_send_at = NULL, status_note = NULL WHERE id = ? AND status IN ('active','pending','paused','completed')", [cl.id])
      .then(function () { return state.completeIfDone(tx, cl.campaign_id, t); });
  }
  return Promise.resolve();
};

module.exports = { phaseOf: phaseOf, probeHint: probeHint, InboxSync: InboxSync, friendlyError: friendlyError, isTransient: isTransient, retryDelay: retryDelay, OOO_DELAY_MS: OOO_DELAY_MS };
