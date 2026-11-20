'use strict';
// Unified inbox: replies from every sender and campaign in one place.
//   list     one row per conversation (campaign lead) = its newest reply, with unread count + filters
//   thread   the whole conversation: our emails, their replies, auto-replies, bounces
//   markRead / setSentiment / reply
// Security: every query is scoped by user_id (foreign ids -> 404). Only PLAIN TEXT is ever returned;
// the raw HTML of incoming mail is stored but never exposed by this service (no sanitizer is shipped
// yet - when DOMPurify is added, sanitized HTML can be offered inside a sandboxed iframe).
var crypto = require('crypto');
var AppError = require('../lib/errors').AppError;
var v = require('../lib/validate');
var htmlLib = require('../lib/html');
var sanitize = require('../lib/sanitize');
var emailLib = require('../lib/email');
var audit = require('./audit');
var withSignature = require('./settings').withSignature;
var images = require('./images');
var replyParse = require('../lib/replyParse');

// 'stop_campaign' | 'unsubscribe_link' | 'bounce' | null  (same rule the Studio uses for its badges)
function optOutKind(status, note, reason) {
  if (status === 'bounced') return 'bounce';
  if (status !== 'unsubscribed') return null;
  return reason === 'replied_stop' || /stop campaign/i.test(note || '') ? 'stop_campaign' : 'unsubscribe_link';
}

var SENTIMENTS = ['interested', 'more_info', 'not_interested', 'neutral'];
var MAX_REPLY = 20000;

function hasControl(s) {
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true;
  }
  return false;
}
function likeEscape(s) { return s.replace(/[\\%_]/g, '\\$&'); }
function utcDate(t) { return new Date(t).toISOString().slice(0, 10); }

function InboxService(db, deps) {
  this.db = db;
  this.engine = deps && deps.engine;       // used only to deliver manual replies
  this.now = (deps && deps.now) || Date.now;
}
var I = InboxService.prototype;

I.list = function (userId, q) {
  var self = this;
  return Promise.resolve().then(function () { return self._list(userId, q); });     // validation errors become rejections
};
I._list = function (userId, q) {
  q = q || {};
  var limit = v.intIn(q.limit, 1, 100) || 30, offset = v.intIn(q.offset, 0, 1000000) || 0;
  var conv = 'SELECT campaign_lead_id, MAX(id) AS last_id, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, COUNT(*) AS replies ' +
    "FROM messages WHERE user_id = ? AND direction = 'in' AND kind = 'email' AND campaign_lead_id IS NOT NULL GROUP BY campaign_lead_id";
  var sql = 'FROM (' + conv + ') x JOIN messages m ON m.id = x.last_id JOIN campaign_leads cl ON cl.id = x.campaign_lead_id ' +
    'JOIN campaigns c ON c.id = cl.campaign_id JOIN leads l ON l.id = cl.lead_id LEFT JOIN senders s ON s.id = cl.sender_id LEFT JOIN suppression sp ON sp.user_id = m.user_id AND sp.email = l.email WHERE m.user_id = ?';
  var p = [userId, userId], extra = '';
  if (q.sentiment !== undefined && q.sentiment !== '') {
    if (SENTIMENTS.indexOf(q.sentiment) === -1) throw new AppError('validation', 'Unknown sentiment filter', 400);
    extra += ' AND m.sentiment = ?'; p.push(q.sentiment);
  }
  if (q.unread === '1' || q.unread === 1 || q.unread === true) extra += ' AND x.unread > 0';
  if (q.campaign_id !== undefined && q.campaign_id !== '') {
    var cid = v.intIn(q.campaign_id, 1, 9007199254740991);
    if (cid === null) throw new AppError('validation', 'Bad campaign filter', 400);
    extra += ' AND (c.id = ? OR c.parent_id = ?)'; p.push(cid, cid);
  }
  if (q.sender_id !== undefined && q.sender_id !== '') {
    var sid = v.intIn(q.sender_id, 1, 9007199254740991);
    if (sid === null) throw new AppError('validation', 'Bad sender filter', 400);
    extra += ' AND cl.sender_id = ?'; p.push(sid);
  }
  // Multi-select filters (comma separated ids): several campaigns and/or several sending accounts at once.
  function ids(x, what) {
    if (x === undefined || x === '' || x === null) return [];
    var out = String(x).split(',').map(function (a) { return v.intIn(a.trim(), 1, 9007199254740991); });
    if (out.some(function (n) { return n === null; }) || out.length > 100) throw new AppError('validation', 'Bad ' + what + ' filter', 400);
    return out;
  }
  var cids = ids(q.campaign_ids, 'campaign'), sids = ids(q.sender_ids, 'sender');
  if (cids.length) { extra += ' AND (c.id IN (' + v.placeholders(cids.length) + ') OR c.parent_id IN (' + v.placeholders(cids.length) + '))'; p = p.concat(cids, cids); }
  if (sids.length) { extra += ' AND cl.sender_id IN (' + v.placeholders(sids.length) + ')'; p = p.concat(sids); }
  if (q.read === '1' || q.read === 1 || q.read === true) extra += ' AND x.unread = 0';
  // Status uses the SAME tags the conversations show (the tag of the latest detected reply, automatic or set by hand):
  //   interested | more_info | not_interested | neutral (an untagged reply counts as neutral)
  //   successful     = tagged Interested (the "Successful" column of the campaigns table)
  //   not_successful = tagged Not interested, or the person opted out / the address bounced
  // Several values combine with OR. Campaign-state values (in sequence, paused, stopped) are not tags and are rejected.
  if (q.status !== undefined && q.status !== '') {
    var STATUS_SQL = { interested: "m.sentiment = 'interested'", more_info: "m.sentiment = 'more_info'", not_interested: "m.sentiment = 'not_interested'", neutral: "(m.sentiment = 'neutral' OR m.sentiment IS NULL)",
      successful: "m.sentiment = 'interested'", not_successful: "(m.sentiment = 'not_interested' OR cl.status IN ('unsubscribed','bounced'))" };
    var conds = String(q.status).split(',').map(function (k) {
      var c1 = Object.prototype.hasOwnProperty.call(STATUS_SQL, k.trim()) ? STATUS_SQL[k.trim()] : null;
      if (!c1) throw new AppError('validation', 'Unknown status filter', 400);
      return c1;
    });
    extra += ' AND (' + conds.join(' OR ') + ')';
  }
  if (q.q) {
    var term = '%' + likeEscape(String(q.q).slice(0, 100).toLowerCase()) + '%';
    extra += " AND (lower(l.email) LIKE ? ESCAPE '\\' OR lower(COALESCE(l.company,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(m.subject,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) LIKE ? ESCAPE '\\')";
    p.push(term, term, term, term);
  }
  return Promise.all([
    this.db.all('SELECT m.id, m.campaign_lead_id, m.subject, m.sentiment, m.sentiment_manual, m.received_at, substr(m.body_text, 1, 1200) AS snippet, cl.status_note AS status_note, sp.reason AS suppression_reason, x.unread, x.replies, ' +
      'l.email AS lead_email, l.first_name, l.last_name, l.company, c.id AS campaign_id, c.name AS campaign_name, cl.status AS lead_status, s.id AS sender_id, s.email AS sender_email ' +
      sql + extra + ' ORDER BY m.received_at DESC, m.id DESC LIMIT ? OFFSET ?', p.concat([limit, offset])),
    this.db.get('SELECT COUNT(*) AS n ' + sql + extra, p),
    this.db.all('SELECT m.sentiment AS k, COUNT(*) AS n FROM (' + conv + ') x JOIN messages m ON m.id = x.last_id GROUP BY m.sentiment', [userId]),
    this.db.get("SELECT COUNT(DISTINCT campaign_lead_id) AS n FROM messages WHERE user_id = ? AND direction = 'in' AND kind = 'email' AND read_at IS NULL AND campaign_lead_id IS NOT NULL", [userId])
  ]).then(function (r) {
    var counts = { interested: 0, more_info: 0, not_interested: 0, neutral: 0 };
    r[2].forEach(function (row) { if (counts[row.k] !== undefined) counts[row.k] = row.n; });
    r[0].forEach(function (it) {
      it.snippet = replyParse.snippet(it.snippet || '', 200);          // the reply itself, never the signature or the quoted history
      it.opt_out = optOutKind(it.lead_status, it.status_note, it.suppression_reason);
      delete it.status_note; delete it.suppression_reason;
    });
    return { items: r[0], total: r[1].n, counts: counts, unread: r[3].n, limit: limit, offset: offset };
  });
};

// Loads a conversation the user owns, or 404.
I._conversation = function (userId, clId) {
  return this.db.get('SELECT cl.id, cl.status, cl.status_note, cl.sender_id, cl.lead_id, cl.campaign_id, c.name AS campaign_name, c.user_id, ' +
    'l.email AS lead_email, l.first_name, l.last_name, l.company ' +
    'FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ? AND c.user_id = ?', [clId, userId]).then(function (r) {
    if (!r) throw new AppError('not_found', 'Conversation not found', 404);
    return r;
  });
};

I.thread = function (userId, clId) {
  var db = this.db;
  return this._conversation(userId, clId).then(function (conv) {
    return Promise.all([
      db.all("SELECT id, direction, kind, status, step_no, subject, body_text, (body_html IS NOT NULL AND direction = 'in' AND kind = 'email' AND length(body_html) > 0) AS has_html, from_addr, to_addr, sentiment, sentiment_manual, error_class, error, sent_at, received_at, read_at, created_at " +
        "FROM messages WHERE campaign_lead_id = ? AND user_id = ? AND NOT (direction = 'out' AND status IN ('queued','sending')) " +
        'ORDER BY COALESCE(sent_at, received_at, created_at), id', [clId, userId]),
      conv.sender_id ? db.get('SELECT id, email, label FROM senders WHERE id = ? AND user_id = ?', [conv.sender_id, userId]) : Promise.resolve(null),
      db.get('SELECT reason FROM suppression WHERE user_id = ? AND email = ?', [userId, conv.lead_email])
    ]).then(function (r) {
      return {
        conversation: { id: conv.id, status: conv.status, campaign_id: conv.campaign_id, campaign_name: conv.campaign_name,
          lead: { id: conv.lead_id, email: conv.lead_email, first_name: conv.first_name, last_name: conv.last_name, company: conv.company },
          sender: r[1] || null, suppressed: r[2] ? r[2].reason : null, opt_out: optOutKind(conv.status, conv.status_note, r[2] && r[2].reason) },
        messages: r[0].map(function (m) {
          // Incoming text is split into what they wrote / their device signature / the quoted history, so the screen can lay it out cleanly.
          if (m.direction === 'in') m.view = replyParse.parse(m.body_text || '');
          return m;
        })
      };
    });
  });
};

// The formatted version of one incoming reply, as a complete, self-contained page for a sandboxed iframe.
// The raw HTML is never returned by the JSON API: it goes through the allowlist sanitizer (no scripts, images, forms,
// external links other than http/https/mailto) and the route serves it with a CSP that forbids everything but inline styles.
I.replyHtml = function (userId, messageId) {
  return this.db.get("SELECT body_html FROM messages WHERE id = ? AND user_id = ? AND direction = 'in' AND kind = 'email' AND body_html IS NOT NULL", [messageId, userId]).then(function (m) {
    if (!m) throw new AppError('not_found', 'Message not found', 404);
    var safe = sanitize.clean(String(m.body_html).slice(0, 200000));
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">' +
      '<style>body{font:14px/1.5 Arial,Helvetica,sans-serif;color:#1f2937;margin:0;padding:12px;word-wrap:break-word}a{color:#2563eb}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d1d5db;color:#6b7280}p{margin:0 0 10px}</style>' +
      '</head><body>' + safe + '</body></html>';
  });
};

I.markRead = function (userId, clId, read) {
  var self = this, t = this.now();
  return this._conversation(userId, clId).then(function () {
    var sql = read
      ? "UPDATE messages SET read_at = ? WHERE campaign_lead_id = ? AND user_id = ? AND direction = 'in' AND read_at IS NULL"
      : "UPDATE messages SET read_at = NULL WHERE campaign_lead_id = ? AND user_id = ? AND direction = 'in' AND id = (SELECT MAX(id) FROM messages WHERE campaign_lead_id = ? AND user_id = ? AND direction = 'in' AND kind = 'email')";
    return self.db.run(sql, read ? [t, clId, userId] : [clId, userId, clId, userId]);
  }).then(function () { return { ok: true }; });
};

I.setSentiment = function (userId, messageId, sentiment, ip) {
  var self = this;
  if (SENTIMENTS.indexOf(sentiment) === -1) return Promise.reject(new AppError('validation', 'Unknown sentiment', 400));
  return this.db.get("SELECT id FROM messages WHERE id = ? AND user_id = ? AND direction = 'in' AND kind = 'email'", [messageId, userId]).then(function (m) {
    if (!m) throw new AppError('not_found', 'Message not found', 404);
    return self.db.run('UPDATE messages SET sentiment = ?, sentiment_manual = 1 WHERE id = ?', [sentiment, messageId]);
  }).then(function () { return audit.log(self.db, { userId: userId, action: 'inbox.sentiment', entity: 'message', entityId: messageId, ip: ip, meta: { sentiment: sentiment } }, self.now); })
    .then(function () { return { ok: true, sentiment: sentiment }; });
};

// Manual reply from the same sender account, threaded under the conversation.
I.reply = function (userId, clId, input, ip) {
  var self = this, t = this.now();
  var text = input && typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return Promise.reject(new AppError('validation', 'Write a message first', 400, { body: 'Required' }));
  if (text.length > MAX_REPLY || hasControl(text)) return Promise.reject(new AppError('validation', 'Message is too long or contains invalid characters', 400, { body: 'Invalid' }));
  if (!this.engine) return Promise.reject(new AppError('unavailable', 'Sending is not available', 503));
  var conv, sender, key = 'reply:' + clId + ':' + crypto.randomBytes(8).toString('hex');
  return this._conversation(userId, clId).then(function (c) {
    conv = c;
    if (!c.sender_id) throw new AppError('conflict', 'The sender account for this conversation no longer exists', 409);
    return self.db.get('SELECT 1 AS x FROM suppression WHERE user_id = ? AND email = ?', [userId, c.lead_email]);
  }).then(function (sup) {
    if (sup) throw new AppError('conflict', 'This contact asked not to be emailed or the address bounced. Replying is blocked.', 409);
    return self.db.get('SELECT * FROM senders WHERE id = ? AND user_id = ?', [conv.sender_id, userId]);
  }).then(function (s) {
    if (!s || s.status === 'disabled') throw new AppError('conflict', 'The sender account is disabled', 409);
    return withSignature(self.db, userId, s);
  }).then(function (s) {
    sender = s;
    return self.db.all("SELECT subject, message_id_hdr, direction FROM messages WHERE campaign_lead_id = ? AND user_id = ? AND message_id_hdr IS NOT NULL AND ((direction = 'out' AND status = 'sent') OR (direction = 'in' AND kind IN ('email','auto_reply'))) ORDER BY COALESCE(sent_at, received_at, created_at), id", [clId, userId]);
  }).then(function (hist) {
    var ids = hist.map(function (h) { return h.message_id_hdr; });
    var last = hist.length ? hist[hist.length - 1] : null;
    var subject = last && last.subject ? 'Re: ' + String(last.subject).replace(/^(re:\s*)+/i, '') : 'Re: your message';
    subject = subject.replace(/[\r\n]+/g, ' ').slice(0, 300);                       // no header injection through a stored subject
    var domain = emailLib.domainOf(sender.email);
    var mail = {
      from: { name: sender.from_name || '', address: sender.email }, to: conv.lead_email, subject: subject,
      html: htmlLib.textToHtml(text) + (sender.signature_html ? '<br>' + sanitize.clean(sender.signature_html) : ''), text: text,
      headers: {}, messageId: '<' + crypto.randomBytes(12).toString('hex') + '.r' + clId + '@' + domain + '>',
      inReplyTo: ids.length ? ids[ids.length - 1] : null, references: ids.slice(-20)
    };
    mail.text = htmlLib.htmlToText(mail.html);
    return images.embed(self.db, userId, mail.html).then(function (emb) {
      mail.html = emb.html; if (emb.attachments.length) mail.attachments = emb.attachments;
      return mail;
    });
  }).then(function (mail) {
    return self.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, message_id_hdr, in_reply_to, subject, body_html, body_text, from_addr, to_addr, kind, attempts, created_at) " +
      "VALUES (?,?,?,?,'out','sending',?,?,?,?,?,?,?,?,'email',1,?)",
      [userId, clId, sender.id, conv.lead_id, key, mail.messageId, mail.inReplyTo, mail.subject, mail.html, mail.text, sender.email, conv.lead_email, t]).then(function (ins) {
      return self.engine.deliver(sender, mail).then(function (res) {
        var t2 = self.now();
        return self.db.transaction(function (tx) {
          return tx.run("UPDATE messages SET status = 'sent', sent_at = ?, message_id_hdr = ? WHERE id = ?", [t2, (res && res.messageId) || mail.messageId, ins.lastID])
            .then(function () {
              return tx.run('UPDATE senders SET sent_today = CASE WHEN sent_today_date = ? THEN sent_today + 1 ELSE 1 END, sent_today_date = ? WHERE id = ?', [utcDate(t2), utcDate(t2), sender.id]);
            })
            .then(function () { return tx.run("UPDATE messages SET read_at = ? WHERE campaign_lead_id = ? AND user_id = ? AND direction = 'in' AND read_at IS NULL", [t2, clId, userId]); });
        }).then(function () { return audit.log(self.db, { userId: userId, action: 'inbox.reply', entity: 'campaign_lead', entityId: clId, ip: ip }, self.now); })
          .then(function () { return { ok: true, message_id: ins.lastID }; });
      }, function (err) {
        // Not delivered (or unknown): keep the record as failed so the thread is honest; never auto-retry a manual reply.
        return self.db.run("UPDATE messages SET status = 'failed', error_class = 'send', error = ? WHERE id = ?", [String((err && err.message) || 'Send failed').slice(0, 200), ins.lastID]).then(function () {
          throw new AppError('send_failed', 'The reply could not be sent. Check the sender account and try again.', 502);
        });
      });
    });
  });
};

module.exports = { InboxService: InboxService, SENTIMENTS: SENTIMENTS };
