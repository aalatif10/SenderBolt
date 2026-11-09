'use strict';
// Reply / bounce handling, inbox service and unsubscribe, with a fake mailbox (no network).
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var InboxSync = require('../src/engine/inboxSync').InboxSync;
var InboxService = require('../src/services/inbox').InboxService;
var UnsubscribeService = require('../src/services/unsubscribe').UnsubscribeService;
var sentiment = require('../src/lib/sentiment');
var bounce = require('../src/lib/bounce');
var unsub = require('../src/lib/unsub');

var HOUR = 3600000, DAY = 86400000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);
var SECRET = 'unsub-secret-for-tests-0123456789abcdef';
var STEPS = [
  { subject: 'About {{company|your domain}}', body_html: '<p>Interested in selling?</p>' },
  { subject: '', body_html: '<p>Following up.</p>', delay_days: 3 }
];

function setup() {
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var sent = [];
    var mailer = { send: function (creds, mail) { sent.push(mail); return Promise.resolve({ messageId: mail.messageId }); }, verify: function () { return Promise.resolve(true); } };
    var box = { uidValidity: 7, lastUid: 40, queue: [], mode: 'fake' };
    var mailbox = {
      baseline: function () { return Promise.resolve({ uidValidity: box.uidValidity, lastUid: box.lastUid }); },
      fetchSince: function (creds, st) {
        if (st.uidValidity !== box.uidValidity) return Promise.resolve({ uidValidity: box.uidValidity, lastUid: box.lastUid, reset: true, messages: [] });
        var msgs = box.queue.filter(function (m) { return m.uid > st.lastUid; });
        return Promise.resolve({ uidValidity: box.uidValidity, lastUid: msgs.length ? msgs[msgs.length - 1].uid : st.lastUid, messages: msgs });
      }
    };
    var c = { db: db, clock: clock, sent: sent, box: box, key: key, leads: new Leads(db), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }) };
    c.engine = new SendEngine(db, { key: key, mailer: mailer, now: now, unsubSecret: SECRET });
    c.sync = new InboxSync(db, { key: key, mailbox: mailbox, now: now });
    c.inbox = new InboxService(db, { engine: c.engine, now: now });
    c.unsub = new UnsubscribeService(db, { unsubSecret: SECRET, now: now });
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a; return h.mkUser(db, 'b@x.com');
    }).then(function (b) {
      c.b = b; return c.senders.create(c.a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}
function launch(c, n, extra) {
  var emails = [];
  for (var i = 0; i < n; i++) emails.push('p' + i + '@co' + i + '.com');
  return c.leads.createFolder(c.a, 'F' + Math.random()).then(function (f) {
    return c.leads.importLeads(c.a, f.id, 'paste', emails.join('\n')).then(function () {
      return c.camps.create(c.a, Object.assign({ name: 'C', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [c.sid], folder_id: f.id }, extra || {}));
    });
  }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); });
}
function senderRow(c) { return c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid]); }
function armed(c) { return senderRow(c).then(function (s) { return c.sync.syncSender(s); }); }
function sync(c) { return senderRow(c).then(function (s) { return c.sync.syncSender(s); }); }
function sendAll(c, rounds) {
  var p = Promise.resolve(), i;
  for (i = 0; i < (rounds || 1); i++) p = p.then(function () { c.clock.t += HOUR; return c.engine.tick(); });
  return p;
}
function incoming(c, o) {
  c.box.lastUid; var uid = (c.box.queue.length ? c.box.queue[c.box.queue.length - 1].uid : c.box.lastUid) + 1;
  c.box.queue.push(Object.assign({ uid: uid, messageId: '<in' + uid + '@mail.example>', references: [], from: 'x@y.com', fromName: '', to: 's1@gmail.com', subject: 'Re: About', date: c.clock.t, text: '', html: null }, o));
}
function clOf(c, email) {
  return c.db.get('SELECT cl.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = ?', [email]);
}
function firstSent(c) { return c.sent[0]; }

h.group('reply tracking: arming');
h.test('first sync only records the mailbox end; old mail is never imported', function () {
  return setup().then(function (c) {
    incoming(c, { uid: 10, from: 'p0@co0.com', text: 'old mail' });
    return armed(c).then(function (r) { assert.ok(r.armed); return senderRow(c); }).then(function (s) {
      assert.strictEqual(s.imap_last_uid, 40); assert.strictEqual(s.imap_uidvalidity, 7); assert.ok(s.last_sync_at);
      return c.db.get("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'");
    }).then(function (r) { assert.strictEqual(r.n, 0); });
  });
});
h.test('UIDVALIDITY change resets the cursor without importing anything', function () {
  return setup().then(function (c) {
    return armed(c).then(function () { c.box.uidValidity = 8; c.box.lastUid = 5; incoming(c, { uid: 6, from: 'p0@co0.com', text: 'x' }); return sync(c); })
      .then(function (r) { assert.ok(r.reset); return senderRow(c); }).then(function (s) { assert.strictEqual(s.imap_uidvalidity, 8); assert.strictEqual(s.imap_last_uid, 5); });
  });
});
h.test('a mailbox failure is recorded on the sender (friendly text) and never throws', function () {
  return setup().then(function (c) {
    c.sync.mailbox = { baseline: function () { return Promise.reject(new Error('LOGIN failed: invalid credentials')); } };
    return sync(c).then(function (r) { assert.ok(r.error); return senderRow(c); }).then(function (s) {
      assert.ok(/IMAP login failed/.test(s.sync_error)); assert.ok(s.sync_error.indexOf('invalid credentials') === -1);
    });
  });
});

h.group('replies');
h.test('reply matched by In-Reply-To: stored, classified, sequence stopped, campaign completes', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      incoming(c, { from: 'p0@co0.com', inReplyTo: firstSent(c).messageId, text: 'Yes I am interested. What is your best offer?\n\nOn Tue, s1 wrote:\n> Interested in selling?' });
      return sync(c);
    }).then(function (r) {
      assert.strictEqual(r.reply, 1); return Promise.all([clOf(c, 'p0@co0.com'), c.camps.get(c.a, c.camp.id), c.db.get("SELECT * FROM messages WHERE direction = 'in'")]);
    }).then(function (r) {
      assert.strictEqual(r[0].status, 'replied'); assert.strictEqual(r[0].next_send_at, null); assert.strictEqual(r[1].status, 'completed');
      assert.strictEqual(r[2].sentiment, 'interested'); assert.strictEqual(r[2].kind, 'email'); assert.strictEqual(r[2].campaign_lead_id, r[0].id);
      return sendAll(c, 80).then(function () { assert.strictEqual(c.sent.length, 1, 'no follow-up after a reply'); });
    });
  });
});
h.test('quoted text does not decide the sentiment; "?" means more_info', function () {
  assert.strictEqual(sentiment.classify('Can you tell me more about pricing?\n\nOn Tue, Bob wrote:\n> Are you interested in selling?').sentiment, 'more_info');
  assert.strictEqual(sentiment.classify('> I am not interested\nSounds great, call me').sentiment, 'interested');
  assert.strictEqual(sentiment.classify('Not interested, thanks.').sentiment, 'not_interested');
  assert.strictEqual(sentiment.classify('Ok').sentiment, 'neutral');
  assert.deepStrictEqual(sentiment.classify('Please remove me from your list'), { sentiment: 'not_interested', stop: true });
});
h.test('stop_on_reply = off keeps the sequence running', function () {
  return setup().then(function (c) {
    return launch(c, 1, { stop_on_reply: 0 }).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      incoming(c, { from: 'p0@co0.com', inReplyTo: firstSent(c).messageId, text: 'Tell me more?' }); return sync(c);
    }).then(function () { return clOf(c, 'p0@co0.com'); }).then(function (cl) { assert.strictEqual(cl.status, 'active'); });
  });
});
h.test('"stop emailing me" suppresses the address and ends every other sequence aimed at it', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      var first = c.camp;
      return c.leads.createFolder(c.a, 'G').then(function (f) { return c.leads.importLeads(c.a, f.id, 'paste', 'p0@co0.com'); })
        .then(function () { return c.db.get('SELECT id FROM folders WHERE name = ?', ['G']); }).then(function (f) {
          return c.camps.create(c.a, { name: 'C2', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [c.sid], folder_id: f.id, allow_active_overlap: true });
        }).then(function () { return first; });
    }).catch(function () { return null; }).then(function () {
      incoming(c, { from: 'p0@co0.com', inReplyTo: firstSent(c).messageId, text: 'Stop emailing me.' }); return sync(c);
    }).then(function () { return Promise.all([c.db.get("SELECT reason FROM suppression WHERE email = 'p0@co0.com'"), clOf(c, 'p0@co0.com')]); }).then(function (r) {
      assert.strictEqual(r[0].reason, 'replied_stop'); assert.strictEqual(r[1].status, 'replied');
    });
  });
});
h.test('out-of-office auto-reply does NOT stop the sequence; next email is pushed back 3 days', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      return clOf(c, 'p0@co0.com');
    }).then(function (before) {
      incoming(c, { from: 'p0@co0.com', inReplyTo: firstSent(c).messageId, subject: 'Automatic reply: About', autoSubmitted: 'auto-replied', text: 'I am out of the office.' });
      return sync(c).then(function (r) { assert.strictEqual(r.auto_reply, 1); return clOf(c, 'p0@co0.com'); }).then(function (after) {
        assert.strictEqual(after.status, 'active'); assert.ok(after.next_send_at >= c.clock.t + 3 * DAY - 1000); assert.ok(after.next_send_at >= before.next_send_at);
        return c.inbox.list(c.a);
      });
    }).then(function (l) { assert.strictEqual(l.total, 0, 'auto-replies are not inbox conversations'); });
  });
});
h.test('reply without threading headers falls back to the sender address; unrelated mail is ignored; duplicates dropped', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      incoming(c, { from: 'newsletter@shop.com', text: 'Buy now' });
      incoming(c, { from: 'P0@CO0.COM', messageId: '<dup@m>', text: 'Sure, call me' });
      incoming(c, { from: 'p0@co0.com', messageId: '<dup@m>', text: 'Sure, call me' });
      return sync(c);
    }).then(function (r) {
      assert.strictEqual(r.reply, 1); assert.strictEqual(r.ignored, 1); assert.strictEqual(r.duplicate, 1);
      return clOf(c, 'p0@co0.com');
    }).then(function (cl) { assert.strictEqual(cl.status, 'replied'); });
  });
});
h.test('other users\' mail is never matched (replies resolve inside the sender\'s own user)', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      return c.inbox.list(c.b);
    }).then(function (l) { assert.strictEqual(l.total, 0); });
  });
});

h.group('bounces');
h.test('bounce analysis table', function () {
  var dsn = function (extra) { return Object.assign({ from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', text: '' }, extra); };
  assert.strictEqual(bounce.analyze(dsn({ dsn: 'Final-Recipient: rfc822; gone@x.com\nAction: failed\nStatus: 5.1.1' })).kind, 'hard');
  assert.strictEqual(bounce.analyze(dsn({ dsn: 'Final-Recipient: rfc822; a@x.com\nStatus: 5.7.1' })).kind, 'policy');
  assert.strictEqual(bounce.analyze(dsn({ dsn: 'Action: delayed\nStatus: 4.4.1' })).kind, 'soft');
  assert.strictEqual(bounce.analyze(dsn({ text: 'Something strange happened' })).kind, 'soft', 'unknown wording never suppresses');
  assert.strictEqual(bounce.analyze(dsn({ text: 'The address gone@x.com does not exist' })).kind, 'hard');
  assert.strictEqual(bounce.analyze({ from: 'person@x.com', text: 'hello' }), null);
});
h.test('hard bounce: lead bounced, address suppressed + invalid; soft bounce changes nothing', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return armed(c); }).then(function () { return sendAll(c, 2); }).then(function () {
      var m0 = c.sent[0], m1 = c.sent[1];
      incoming(c, { from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)', inReplyTo: m0.messageId,
        text: 'Your message wasn\'t delivered. 550 5.1.1 user unknown', dsn: 'Final-Recipient: rfc822; ' + m0.to + '\nAction: failed\nStatus: 5.1.1' });
      incoming(c, { from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', subject: 'Delayed', inReplyTo: m1.messageId, text: 'will keep trying', dsn: 'Final-Recipient: rfc822; ' + m1.to + '\nAction: delayed\nStatus: 4.4.1' });
      return sync(c).then(function (r) { assert.strictEqual(r.bounce, 2); return Promise.all([clOf(c, m0.to), clOf(c, m1.to), c.db.get('SELECT * FROM suppression WHERE email = ?', [m0.to]), c.db.get('SELECT verify_status FROM leads WHERE email = ?', [m0.to]), senderRow(c), c.db.all("SELECT error_class FROM messages WHERE kind = 'bounce' ORDER BY id")]); });
    }).then(function (r) {
      assert.strictEqual(r[0].status, 'bounced'); assert.strictEqual(r[1].status, 'active'); assert.strictEqual(r[2].reason, 'bounced'); assert.strictEqual(r[3].verify_status, 'invalid'); assert.deepStrictEqual(r[5].map(function (x) { return x.error_class; }), ['hard', 'soft']);
      assert.strictEqual(r[4].health_score, 100, 'too few sends to judge health yet');
    });
  });
});

h.group('inbox service');
h.test('list / counts / filters / thread (text only) / read state / manual sentiment / isolation', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return armed(c); }).then(function () { return sendAll(c, 2); }).then(function () {
      incoming(c, { from: c.sent[0].to, inReplyTo: c.sent[0].messageId, text: 'Yes, interested!', html: '<script>alert(1)</script><b>Yes</b>' });
      incoming(c, { from: c.sent[1].to, inReplyTo: c.sent[1].messageId, text: 'Who are you?' });
      return sync(c);
    }).then(function () { return c.inbox.list(c.a); }).then(function (l) {
      assert.strictEqual(l.total, 2); assert.strictEqual(l.unread, 2); assert.strictEqual(l.counts.interested, 1); assert.strictEqual(l.counts.more_info, 1);
      assert.ok(l.items[0].sender_email === 's1@gmail.com' && l.items[0].campaign_name === 'C');
      return c.inbox.list(c.a, { sentiment: 'interested' }).then(function (f) {
        assert.strictEqual(f.total, 1); var id = f.items[0].campaign_lead_id;
        return h.expectReject(c.inbox.thread(c.b, id), 'not_found').then(function () { return c.inbox.thread(c.a, id); }).then(function (t) {
          assert.strictEqual(t.messages.length, 2); assert.strictEqual(t.messages[0].direction, 'out'); assert.strictEqual(t.messages[1].direction, 'in');
          assert.ok(t.messages.every(function (m) { return m.body_html === undefined; }), 'raw HTML is never returned'); assert.strictEqual(t.conversation.sender.email, 's1@gmail.com');
          return c.inbox.markRead(c.a, id, true);
        }).then(function () { return h.expectReject(c.inbox.markRead(c.b, id, true), 'not_found'); }).then(function () { return c.inbox.list(c.a, { unread: '1' }); })
          .then(function (u) {
            assert.strictEqual(u.total, 1);
            return c.db.get("SELECT id FROM messages WHERE direction = 'in' AND campaign_lead_id = ?", [id]);
          }).then(function (m) {
            return h.expectReject(c.inbox.setSentiment(c.b, m.id, 'neutral'), 'not_found').then(function () { return h.expectReject(c.inbox.setSentiment(c.a, m.id, 'bogus'), 'validation'); })
              .then(function () { return c.inbox.setSentiment(c.a, m.id, 'not_interested'); }).then(function () { return c.inbox.list(c.a, { sentiment: 'not_interested' }); });
          }).then(function (n) { assert.strictEqual(n.total, 1); assert.strictEqual(n.items[0].sentiment_manual, 1); });
      });
    }).then(function () { return h.expectReject(c.inbox.list(c.a, { sentiment: "x' OR 1=1" }), 'validation'); })
      .then(function () { return c.inbox.list(c.a, { q: "%' OR '1'='1" }); }).then(function (r) { assert.strictEqual(r.total, 0); });
  });
});
h.test('manual reply: threaded from the same sender, counted, marks read; blocked for suppressed contacts and foreign users', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      incoming(c, { from: c.sent[0].to, inReplyTo: c.sent[0].messageId, text: 'Interested, send details' }); return sync(c);
    }).then(function () { return clOf(c, c.sent[0].to); }).then(function (cl) {
      return h.expectReject(c.inbox.reply(c.b, cl.id, { body: 'hi' }), 'not_found')
        .then(function () { return h.expectReject(c.inbox.reply(c.a, cl.id, { body: '   ' }), 'validation'); })
        .then(function () { return h.expectReject(c.inbox.reply(c.a, cl.id, { body: 'a\u0000b' }), 'validation'); })
        .then(function () { return c.inbox.reply(c.a, cl.id, { body: 'Great - here are the details.\nBest' }); })
        .then(function () {
          var m = c.sent[c.sent.length - 1];
          assert.strictEqual(m.from.address, 's1@gmail.com'); assert.strictEqual(m.to, c.sent[0].to); assert.ok(/^Re: About/.test(m.subject) && m.subject.indexOf('\n') === -1);
          assert.ok(m.inReplyTo && m.references.length >= 2); assert.ok(m.html.indexOf('<br') !== -1);
          return Promise.all([c.inbox.list(c.a, { unread: '1' }), senderRow(c), c.db.get("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' AND step_no IS NULL")]);
        }).then(function (r) { assert.strictEqual(r[0].total, 0); assert.strictEqual(r[1].sent_today, 2); assert.strictEqual(r[2].n, 1);
          return c.leads.addSuppression(c.a, [c.sent[0].to]);
        }).then(function () { return h.expectReject(c.inbox.reply(c.a, cl.id, { body: 'again' }), 'conflict'); });
    });
  });
});
h.test('a failed manual reply is recorded as failed and reported without leaking server text', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () {
      incoming(c, { from: c.sent[0].to, inReplyTo: c.sent[0].messageId, text: 'Sure' }); return sync(c);
    }).then(function () { return clOf(c, c.sent[0].to); }).then(function (cl) {
      c.engine.mailer = { send: function () { return Promise.reject(new Error('535 secret-ish server detail')); } };
      return c.inbox.reply(c.a, cl.id, { body: 'hello' }).then(function () { throw new Error('should fail'); }, function (e) {
        assert.strictEqual(e.code, 'send_failed'); assert.ok(e.message.indexOf('535') === -1);
        return c.db.get("SELECT status FROM messages WHERE direction = 'out' AND step_no IS NULL");
      });
    }).then(function (m) { assert.strictEqual(m.status, 'failed'); });
  });
});

h.group('unsubscribe');
h.test('lookup never changes anything; apply suppresses the address and ends the sequence; forged tokens look like 404', function () {
  return setup().then(function (c) {
    return launch(c, 1).then(function () { return armed(c); }).then(function () { return sendAll(c); }).then(function () { return clOf(c, c.sent[0].to); }).then(function (cl) {
      var tok = unsub.make(SECRET, cl.id);
      return c.unsub.lookup(tok).then(function (l) {
        assert.ok(l.valid); assert.ok(/^p\*\*\*@co0\.com$/.test(l.email) || /\*\*\*@/.test(l.email));
        return clOf(c, c.sent[0].to);
      }).then(function (still) {
        assert.strictEqual(still.status, 'active', 'GET (mail scanners) must not unsubscribe');
        return c.unsub.apply(tok);
      }).then(function (r) { assert.ok(r.valid); return Promise.all([clOf(c, c.sent[0].to), c.db.get('SELECT reason FROM suppression WHERE email = ?', [c.sent[0].to]), c.camps.get(c.a, c.camp.id)]); })
        .then(function (r) { assert.strictEqual(r[0].status, 'unsubscribed'); assert.strictEqual(r[1].reason, 'unsubscribed'); assert.strictEqual(r[2].status, 'completed');
          return c.unsub.apply(unsub.make(SECRET, cl.id).slice(0, -2) + 'zz');
        }).then(function (bad) { assert.strictEqual(bad.valid, false); return c.unsub.apply(unsub.make(SECRET, 99999)); })
        .then(function (none) { assert.strictEqual(none.valid, false); return c.unsub.apply('garbage'); }).then(function (g) { assert.strictEqual(g.valid, false); });
    });
  });
});

h.run();
