'use strict';
// Sending engine tests: fake clock + scripted fake mailer (no network).
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var unsub = require('../src/lib/unsub');
var sendErrors = require('../src/lib/sendErrors');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var mailerLib = require('../src/engine/mailer');

var HOUR = 3600000, DAY = 86400000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);          // Tuesday 10:00 UTC (inside the default 9-17 window)
var SECRET = 'unsub-secret-for-tests-0123456789abcdef';
var STEPS = [
  { subject: 'Question about {{company|your domain}}', body_html: '<p>Hi {{first_name|there}}, interested?</p>' },
  { subject: '', body_html: '<p>Following up.</p>', delay_days: 3 },
  { subject: 'Last note', body_html: '<p>Final.</p>', delay_days: 5 }
];

function setup(opts) {
  opts = opts || {};
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var script = [], sent = [];
    var mailer = { send: function (creds, mail) {
      sent.push({ creds: creds, mail: mail });
      var f = script.length ? script.shift() : null;
      return f ? Promise.reject(f) : Promise.resolve({ messageId: mail.messageId });
    }, verify: function () { return Promise.resolve(true); } };
    var c = { db: db, clock: clock, key: key, script: script, sent: sent,
      leads: new Leads(db), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }) };
    c.engine = new SendEngine(db, { key: key, mailer: mailer, now: now, unsubSecret: SECRET, publicOrigin: opts.origin || '', requireReplyTracking: !!opts.track });
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a;
      return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}
function launch(c, n, extra) {
  var emails = [];
  for (var i = 0; i < n; i++) emails.push('p' + i + '@co' + i + '.com');
  return c.leads.createFolder(c.a, 'F').then(function (f) {
    return c.leads.importLeads(c.a, f.id, 'paste', emails.join('\n')).then(function () {
      return c.camps.create(c.a, Object.assign({ name: 'C', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [c.sid], folder_id: f.id }, extra || {}));
    });
  }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); });
}
function adv(c, ms) { c.clock.t += ms; return c.engine.tick(); }
function lead(c, i) { return c.db.get('SELECT cl.* FROM campaign_leads cl ORDER BY cl.position, cl.id LIMIT 1 OFFSET ?', [i || 0]); }
function allLeads(c) { return c.db.all('SELECT * FROM campaign_leads ORDER BY position, id'); }
function msgs(c) { return c.db.all("SELECT * FROM messages WHERE direction = 'out' ORDER BY id"); }
function smtpErr(code, rc, text) { var e = new Error(text); e.code = code; e.responseCode = rc; e.response = text; return e; }

h.group('engine: pacing, sequencing, windows');
h.test('one email per sender per tick (throttle), message + lead + sender state updated', function () {
  return setup().then(function (c) {
    return launch(c, 3).then(function () { return c.engine.tick(); }).then(function (r) {
      assert.strictEqual(r.sent, 1); assert.strictEqual(c.sent.length, 1);
      return c.engine.tick();
    }).then(function (r) {
      assert.strictEqual(r.sent, 0, 'throttled: next_send_at of the sender is in the future');
      return adv(c, HOUR);
    }).then(function (r) {
      assert.strictEqual(r.sent, 1);
      return Promise.all([msgs(c), c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid])]);
    }).then(function (r) {
      assert.strictEqual(r[0].length, 2); assert.ok(r[0].every(function (m) { return m.status === 'sent' && m.sent_at && m.step_no === 0 && m.attempts === 1; }));
      assert.strictEqual(r[1].sent_today, 2); assert.ok(r[1].warmup_started_at, 'warm-up clock starts at the first real send');
      var m = c.sent[0].mail;
      assert.ok(/^p\d@co\d\.com$/.test(m.to)); assert.notStrictEqual(c.sent[1].mail.to, m.to); assert.strictEqual(m.subject, 'Question about your domain');
      assert.ok(/<s1\.|\.\d+@gmail\.com>$/.test(m.messageId) || /@gmail\.com>$/.test(m.messageId));
      assert.ok(m.headers['List-Unsubscribe'].indexOf('mailto:') !== -1);
      assert.ok(m.html.indexOf('stop campaign') !== -1 && m.text.indexOf('Hi there') === 0);
      assert.strictEqual(c.sent[0].creds.pass, 'abcdefghijklmnop', 'password decrypted only for sending');
    });
  });
});
h.test('follow-ups are threaded (Re:, In-Reply-To, References) and the lead completes', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return c.engine.tick(); }).then(function () {
      return lead(c);
    }).then(function (cl) {
      assert.strictEqual(cl.current_step, 1); assert.ok(cl.next_send_at >= TUE_10 + 3 * DAY);
      return adv(c, 2 * DAY).then(function (r) { assert.strictEqual(r.sent, 0, 'not due yet'); return adv(c, 1 * DAY + HOUR); });
    }).then(function (r) {
      assert.strictEqual(r.sent, 1);
      var m2 = c.sent[1].mail, m1 = c.sent[0].mail;
      assert.strictEqual(m2.subject, 'Re: Question about your domain'); assert.strictEqual(m2.inReplyTo, m1.messageId); assert.deepStrictEqual(m2.references, [m1.messageId]);
      return adv(c, 5 * DAY + HOUR);
    }).then(function () {
      var m3 = c.sent[2].mail;
      assert.strictEqual(m3.subject, 'Last note'); assert.strictEqual(m3.references.length, 2);
      return Promise.all([lead(c), c.camps.get(c.a, c.camp.id)]);
    }).then(function (r) { assert.strictEqual(r[0].status, 'completed'); assert.strictEqual(r[1].status, 'completed'); });
  });
});
h.test('nothing is sent outside the window, at weekends, or while campaign/sender is paused', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      c.clock.t = Date.UTC(2026, 10, 10, 20, 0, 0); return c.engine.tick();
    }).then(function (r) { assert.strictEqual(r.sent, 0, 'after hours');
      c.clock.t = Date.UTC(2026, 10, 14, 10, 0, 0); return c.engine.tick();
    }).then(function (r) { assert.strictEqual(r.sent, 0, 'Saturday');
      c.clock.t = Date.UTC(2026, 10, 16, 10, 0, 0); return c.camps.pause(c.a, c.camp.id).then(function () { return c.engine.tick(); });
    }).then(function (r) { assert.strictEqual(r.sent, 0, 'campaign paused');
      return c.camps.resume(c.a, c.camp.id).then(function () { return c.senders.setStatus(c.a, c.sid, 'paused'); }).then(function () { return c.engine.tick(); });
    }).then(function (r) { assert.strictEqual(r.sent, 0, 'sender paused');
      return c.senders.setStatus(c.a, c.sid, 'active').then(function () { return c.engine.tick(); });
    }).then(function (r) { assert.strictEqual(r.sent, 1); assert.strictEqual(c.sent.length, 1); });
  });
});
h.test('daily limit stops a sender until the next UTC day', function () {
  return setup().then(function (c) {
    return launch(c, 3).then(function () {
      return c.db.run("UPDATE senders SET sent_today = daily_limit, sent_today_date = ? WHERE id = ?", [new Date(TUE_10).toISOString().slice(0, 10), c.sid]);
    }).then(function () { return c.engine.tick(); }).then(function (r) {
      assert.strictEqual(r.sent, 0); return adv(c, DAY);
    }).then(function (r) { assert.strictEqual(r.sent, 1, 'new day, counter resets'); });
  });
});
h.test('suppressed address is skipped at send time; missing merge field marks the lead, never sends', function () {
  return setup().then(function (c) {
    var steps = JSON.parse(JSON.stringify(STEPS)); steps[0].body_html = '<p>Hi {{nickname}}</p>';
    return launch(c, 2, { steps: steps }).then(function () {
      return c.leads.addSuppression(c.a, ['p0@co0.com']);
    }).then(function () { return c.engine.tick(); }).then(function () { return adv(c, HOUR); }).then(function () {
      return c.db.all('SELECT l.email, cl.status, cl.status_note FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY l.email');
    }).then(function (ls) {
      assert.strictEqual(ls[0].status, 'unsubscribed');
      assert.strictEqual(ls[1].status, 'error'); assert.ok(/nickname/.test(ls[1].status_note));
      assert.strictEqual(c.sent.length, 0);
      return c.camps.get(c.a, c.camp.id);
    }).then(function (camp) { assert.strictEqual(camp.status, 'completed'); });
  });
});
h.test('unsubscribe link + one-click header when a public origin is configured; token authorises exactly that lead', function () {
  return setup({ origin: 'https://app.example.com' }).then(function (c) {
    return launch(c, 1).then(function () { return c.engine.tick(); }).then(function () { return lead(c); }).then(function (cl) {
      var m = c.sent[0].mail, tok = /\/u\/([^"<>\s]+)"/.exec(m.html)[1];
      assert.strictEqual(unsub.verify(SECRET, tok), cl.id);
      assert.strictEqual(unsub.verify(SECRET, tok.slice(0, -1) + 'x'), null);
      assert.strictEqual(unsub.verify('other-secret-other-secret-other-secret', tok), null);
      assert.ok(m.headers['List-Unsubscribe'].indexOf('https://app.example.com/u/' + tok) !== -1);
      assert.strictEqual(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    });
  });
});

h.group('engine: failures');
h.test('recipient rejected -> bounced + suppressed + address invalid; sender unharmed otherwise', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () {
      c.script.push(smtpErr('EENVELOPE', 550, '550 5.1.1 The email account that you tried to reach does not exist'));
      return c.engine.tick();
    }).then(function () { return Promise.all([lead(c), c.db.get("SELECT * FROM suppression WHERE email = 'p0@co0.com'"), c.db.get("SELECT verify_status FROM leads LIMIT 1"), c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid]), c.camps.get(c.a, c.camp.id)]); })
      .then(function (r) {
        assert.strictEqual(r[0].status, 'bounced'); assert.strictEqual(r[1].reason, 'bounced'); assert.strictEqual(r[2].verify_status, 'invalid');
        assert.strictEqual(r[3].status, 'active'); assert.strictEqual(r[4].status, 'completed');
      });
  });
});
h.test('auth failure pauses the SENDER and does not blame the lead (retry budget untouched)', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      c.script.push(smtpErr('EAUTH', 535, '535-5.7.8 Username and Password not accepted'));
      return c.engine.tick();
    }).then(function () { return Promise.all([lead(c), c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid]), msgs(c)]); }).then(function (r) {
      assert.strictEqual(r[0].status, 'active'); assert.strictEqual(r[1].status, 'paused'); assert.ok(/App Password/.test(r[1].last_error));
      assert.strictEqual(r[2][0].attempts, 0); assert.strictEqual(r[2][0].error_class, 'auth');
      return adv(c, HOUR);
    }).then(function (t) { assert.strictEqual(t.sent, 0, 'paused sender stays silent'); });
  });
});
h.test('provider daily quota exhausts the sender for the day without blaming the lead', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      c.script.push(smtpErr('EENVELOPE', 550, '550 5.4.5 Daily user sending quota exceeded'));
      return c.engine.tick();
    }).then(function () { return Promise.all([lead(c), c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid])]); }).then(function (r) {
      assert.strictEqual(r[0].status, 'active'); assert.strictEqual(r[1].sent_today, r[1].daily_limit); assert.ok(r[1].next_send_at >= Date.UTC(2026, 10, 11));
    });
  });
});
h.test('transient failure retries the SAME message row with backoff and gives up after 5 attempts', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () {
      var chain = Promise.resolve(), i;
      function fail() { c.script.push(smtpErr('ETIMEDOUT', 0, 'timeout')); }
      fail();
      for (i = 0; i < 5; i++) (function (k) {
        chain = chain.then(function () { if (k > 0) fail(); return c.engine.tick(); }).then(function () { return Promise.all([msgs(c), lead(c)]); }).then(function (r) {
          assert.strictEqual(r[0].length, 1, 'one message row, reused'); assert.strictEqual(r[0][0].attempts, k + 1);
          if (k < 4) { assert.strictEqual(r[1].status, 'active'); assert.ok(r[1].next_send_at > c.clock.t); c.clock.t = r[1].next_send_at + 1; c.clock.t = Math.max(c.clock.t, 0); return c.db.run('UPDATE senders SET next_send_at = NULL'); }
          assert.strictEqual(r[1].status, 'error'); assert.ok(/5 failed attempts/.test(r[1].status_note));
          return null;
        });
      })(i);
      return chain;
    });
  });
});
h.test('crash recovery: a message left "sending" is NOT retried (no duplicate cold email)', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return lead(c); }).then(function (cl) {
      return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, kind, step_no, attempts, created_at) VALUES (?,?,?,?,'out','sending',?,'email',0,1,?)",
        [c.a, cl.id, c.sid, cl.lead_id, 'cl:' + cl.id + ':s:0', 1]);
    }).then(function () { return c.engine.recoverInterrupted(); }).then(function (n) {
      assert.strictEqual(n, 1); return c.engine.tick();
    }).then(function () { return Promise.all([lead(c), msgs(c)]); }).then(function (r) {
      assert.strictEqual(r[0].status, 'error'); assert.strictEqual(c.sent.length, 0); assert.strictEqual(r[1][0].error_class, 'interrupted');
    });
  });
});
h.test('already-sent step is repaired, never resent (duplicate guard)', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return lead(c); }).then(function (cl) {
      return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, kind, step_no, attempts, sent_at, message_id_hdr, subject, created_at) VALUES (?,?,?,?,'out','sent',?,'email',0,1,1,'<x@y>','S',1)",
        [c.a, cl.id, c.sid, cl.lead_id, 'cl:' + cl.id + ':s:0']);
    }).then(function () { return c.engine.tick(); }).then(function () { return lead(c); }).then(function (cl) {
      assert.strictEqual(c.sent.length, 0); assert.strictEqual(cl.current_step, 1);
    });
  });
});
h.test('tick is single-flight', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return Promise.all([c.engine.tick(), c.engine.tick()]); }).then(function (r) {
      assert.ok(r.some(function (x) { return x.skipped; })); assert.strictEqual(c.sent.length, 1);
    });
  });
});
h.test('reply tracking gate (live mode): no sending until the mailbox is armed and fresh', function () {
  return setup({ track: true }).then(function (c) {
    return launch(c, 1).then(function () { return c.engine.tick(); }).then(function (r) {
      assert.strictEqual(r.sent, 0, 'IMAP not armed');
      return c.db.run('UPDATE senders SET imap_uidvalidity = 1, imap_last_uid = 0, last_sync_at = ?', [c.clock.t]);
    }).then(function () { return c.engine.tick(); }).then(function (r) {
      assert.strictEqual(r.sent, 1); return adv(c, HOUR);
    }).then(function (r) { assert.strictEqual(r.sent, 0, 'sync is stale (>15 min) -> paused again'); });
  });
});
h.test('campaign shows error when no waiting lead has a usable sender, and recovers', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return c.senders.setStatus(c.a, c.sid, 'paused'); }).then(function () { return c.engine.tick(); })
      .then(function () { return c.camps.get(c.a, c.camp.id); }).then(function (camp) {
        assert.strictEqual(camp.status, 'error');
        return c.senders.setStatus(c.a, c.sid, 'active').then(function () { return adv(c, 31000); });
      }).then(function () { return c.camps.get(c.a, c.camp.id); }).then(function (camp) { assert.notStrictEqual(camp.status, 'error'); });
  });
});

h.group('engine: adapters and error classification');
h.test('SMTP error classification table', function () {
  var cases = [
    [smtpErr('EAUTH', 535, 'Invalid login'), 'auth'], [smtpErr('', 534, '5.7.9 Application-specific password required'), 'auth'],
    [smtpErr('ETIMEDOUT', 0, 'x'), 'transient'], [smtpErr('ECONNECTION', 0, 'x'), 'transient'], [new Error('weird'), 'transient'],
    [smtpErr('', 421, '421 4.7.0 Try again later'), 'quota'], [smtpErr('', 450, '4.2.1 mailbox busy'), 'transient'],
    [smtpErr('', 550, '550 5.1.1 user unknown'), 'recipient'], [smtpErr('', 553, '5.1.3 invalid address'), 'recipient'],
    [smtpErr('', 550, '5.7.1 blocked by spam policy'), 'policy'], [smtpErr('', 554, '5.7.1 Message rejected due to reputation'), 'policy'],
    [smtpErr('', 550, '5.4.5 Daily user sending quota exceeded'), 'quota'], [smtpErr('', 452, '4.5.3 too many recipients, rate limit'), 'quota'],
    [Object.assign(new Error('x'), { code: 'EDECRYPT' }), 'auth']
  ];
  cases.forEach(function (c) { assert.strictEqual(sendErrors.classify(c[0]).kind, c[1], String(c[0].response || c[0].message) + ' -> ' + c[1]); });
});

h.group('start warnings');
h.test('start reports missing merge values and senders without reply tracking (non-blocking)', function () {
  return setup().then(function (c) {
    var steps = JSON.parse(JSON.stringify(STEPS)); steps[0].body_html = '<p>Hi {{first_name}}</p>';
    return c.senders.create(c.a, { label: 'Plain', email: 'plain@mydomain.com', provider: 'smtp', username: 'plain@mydomain.com', password: 'secret-password-1', smtp_host: 'smtp.mydomain.com', smtp_port: 465, smtp_secure: 1 }).then(function (s2) {
      return c.leads.createFolder(c.a, 'W').then(function (f) {
        return c.leads.importLeads(c.a, f.id, 'paste', 'a@one.com\nb@two.com').then(function () {
          return c.camps.create(c.a, { name: 'W', steps: steps, sender_ids: [c.sid, s2.id], folder_id: f.id });
        });
      });
    }).then(function (camp) { return c.camps.start(c.a, camp.id); }).then(function (started) {
      var codes = started.warnings.map(function (w) { return w.code; }).sort();
      assert.deepStrictEqual(codes, ['missing_variables', 'no_reply_tracking']); assert.strictEqual(started.status, 'active');
    });
  });
});

h.group('engine: warm-up ramp (optional, idle-safe, health-aware)');
function sendN(c, n) {   // n real sends on the current clock day (one per tick, an hour apart, inside the 9-17 window)
  var p = Promise.resolve();
  for (var i = 0; i < n; i++) p = p.then(function () { return adv(c, 10 * 60000); });
  return p;
}
h.test('warm-up ON caps a new sender at 5/day; OFF lets the same sender use its full limit on day one', function () {
  return setup().then(function (c) {
    return c.db.run('UPDATE senders SET daily_limit = 50 WHERE id = ?', [c.sid]).then(function () { return launch(c, 14); }).then(function () { return c.engine.tick(); })
      .then(function () { return sendN(c, 9); }).then(function () { return c.db.get('SELECT sent_today FROM senders WHERE id = ?', [c.sid]); })
      .then(function (r) { assert.strictEqual(r.sent_today, 5, 'ramp day 1 = 5 emails'); return c.db.run('UPDATE senders SET warmup_enabled = 0 WHERE id = ?', [c.sid]); })
      .then(function () { return sendN(c, 9); }).then(function () { return c.db.get('SELECT sent_today FROM senders WHERE id = ?', [c.sid]); })
      .then(function (r) { assert.strictEqual(r.sent_today, 14, 'warm-up off: all 14 leads went out the same day, limit 50'); });
  });
});
h.test('the ramp advances only after a day that was really used; idle weeks and token days change nothing', function () {
  return setup().then(function (c) {
    var q = function () { return c.db.get('SELECT warmup_days, sent_today FROM senders WHERE id = ?', [c.sid]); };
    return launch(c, 60).then(function () { return c.engine.tick(); }).then(function () { return sendN(c, 3); }).then(q)
      .then(function (r) { assert.strictEqual(r.sent_today, 4); assert.strictEqual(r.warmup_days, 0, 'day in progress is not counted');
        c.clock.t += DAY; return c.engine.tick(); })                                                 // Wed: yesterday used 4 of 5 -> earned a step
      .then(q).then(function (r) { assert.strictEqual(r.warmup_days, 1); return c.senders.get(c.a, c.sid); })
      .then(function (s) { assert.strictEqual(s.limit_today, 6); assert.strictEqual(s.warmup_day, 2);
        c.clock.t += DAY; return c.engine.tick(); })                                                 // Thu: Wed was a token day (1 of 6) -> no step
      .then(q).then(function (r) { assert.strictEqual(r.warmup_days, 1, 'one email on a 6-email day does not count');
        c.clock.t += 7 * DAY; return c.engine.tick(); })                                             // a week of nothing, then next Thu
      .then(q).then(function (r) { assert.strictEqual(r.warmup_days, 1, 'idle days never advance the ramp'); return c.senders.get(c.a, c.sid); })
      .then(function (s) { assert.strictEqual(s.limit_today, 6, 'still on the ramp it earned, not a calendar-based jump'); });
  });
});
h.test('recent bounces slow the ramp (7-day rate) and it recovers; tiny samples never slow it', function () {
  return setup().then(function (c) {
    var senderHealth = require('../src/services/senderHealth');
    function rows(sentN, bounceN) {
      var ps = [];
      for (var i = 0; i < sentN; i++) ps.push(c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, step_no, sent_at, created_at) VALUES (?,?,'out','sent',0,?,?)", [c.a, c.sid, c.clock.t, c.clock.t]));
      for (var j = 0; j < bounceN; j++) ps.push(c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, kind, error_class, created_at) VALUES (?,?,'in','received','bounce','hard',?)", [c.a, c.sid, c.clock.t]));
      return Promise.all(ps);
    }
    return c.db.run('UPDATE senders SET warmup_days = 10, daily_limit = 100 WHERE id = ?', [c.sid])
      .then(function () { return rows(10, 5); }).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); })
      .then(function () { return c.senders.get(c.a, c.sid); })
      .then(function (s) { assert.strictEqual(s.limit_today, 47, '15 sends is too little data: no slow-down'); assert.strictEqual(s.warmup_slowed, false); return rows(15, 0); })
      .then(function () { return rows(0, 0); }).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); })   // 25 sends, 5 bounces = 20%
      .then(function () { return c.senders.get(c.a, c.sid); })
      .then(function (s) { assert.strictEqual(s.warmup_slowed, true); assert.strictEqual(s.limit_today, 12, 'six steps back from ramp day 10'); return c.db.get('SELECT health_score, status FROM senders WHERE id = ?', [c.sid]); })
      .then(function (r) { assert.ok(r.health_score < 50 ? r.status === 'paused' : r.status === 'active'); return c.senders.get(c.a, c.sid); })
      .then(function () { c.clock.t += 8 * DAY; return senderHealth.recompute(c.db, c.sid, c.clock.t); })                      // old bounces fall out of the 7-day window
      .then(function () { return c.db.get('SELECT warmup_penalty FROM senders WHERE id = ?', [c.sid]); })
      .then(function (r) { assert.strictEqual(r.warmup_penalty, 0, 'recovered once the bounces are older than 7 days'); });
  });
});

h.group('open tracking');
h.test('pixel only when the campaign opted in AND a public origin exists; pixel hit is recorded once per email, forged tokens never', function () {
  var TrackingService = require('../src/services/tracking').TrackingService, track = require('../src/lib/track');
  return setup({ origin: 'https://app.example' }).then(function (c) {
    return launch(c, 1, { track_opens: true }).then(function () { return c.engine.tick(); }).then(function () {
      var m = c.sent[0].mail; assert.ok(/<img src="https:\/\/app\.example\/t\/o\/\d+\.0\.[\w-]+\.gif" width="1" height="1"/.test(m.html), m.html);
      assert.ok(m.text.indexOf('/t/o/') === -1, 'plain-text part has no tracking link');
      var tok = /\/t\/o\/([^"]+)\.gif/.exec(m.html)[1], svc = new TrackingService(c.db, { secret: SECRET, now: function () { return c.clock.t; } });
      return svc.recordOpen(tok).then(function (ok) { assert.strictEqual(ok, true); return svc.recordOpen(tok); }).then(function () {
        return svc.recordOpen(tok.replace(/.$/, function (ch) { return ch === 'A' ? 'B' : 'A'; }));
      }).then(function (forged) {
        assert.strictEqual(forged, false); return svc.recordOpen(track.make('wrong-secret-wrong-secret-wrong', 1, 0));
      }).then(function (f2) { assert.strictEqual(f2, false); return c.db.get("SELECT open_count, opened_at FROM messages WHERE direction = 'out'"); })
        .then(function (row) { assert.strictEqual(row.open_count, 2); assert.strictEqual(row.opened_at, c.clock.t); });
    });
  }).then(function () { return setup({ origin: 'https://app.example' }); }).then(function (c) {
    return launch(c, 1).then(function () { return c.engine.tick(); }).then(function () { assert.ok(c.sent[0].mail.html.indexOf('/t/o/') === -1, 'not opted in: no pixel'); return setup({}); });
  }).then(function (c) {
    return launch(c, 1, { track_opens: true }).then(function () { return c.engine.tick(); }).then(function () { assert.ok(c.sent[0].mail.html.indexOf('<img') === -1, 'no public origin: no pixel'); });
  });
});

h.run();