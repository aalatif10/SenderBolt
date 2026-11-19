'use strict';
// v1.8.1 backend: block-list enforcement and queue consistency.
// (setup helpers copied from v180.js)
// v1.8.0 backend: sender protection + force continue, reply detection switch, per-person reply handling, send priority,
// scheduled start, do-not-email bulk Unblock / Delete + sorting, campaign People sort / risky filter / history-preserving removal.
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var health = require('../src/lib/health');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var CampaignLive = require('../src/services/campaignLive');
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var sendEngine = require('../src/engine/sendEngine');
var InboxSync = require('../src/engine/inboxSync').InboxSync;
var senderHealth = require('../src/services/senderHealth');

var HOUR = 3600000, DAY = 86400000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);
var STEPS = [
  { subject: 'Hello {{first_name|there}}', body_html: '<p>First</p>' },
  { subject: 'Following up', body_html: '<p>Follow-up</p>', delay_days: 3 }
];

function setup(opts) {
  opts = opts || {};
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var sent = [];
    var mailer = { send: function (creds, mail) { sent.push(mail); return Promise.resolve({ messageId: mail.messageId }); }, verify: function () { return Promise.resolve(true); } };
    var c = { db: db, clock: clock, sent: sent, leads: new Leads(db, { now: now }), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }) };
    c.engine = new SendEngine(db, { key: key, mailer: mailer, now: now, requireReplyTracking: !!opts.track });
    c.sync = new InboxSync(db, { key: key, mailbox: {}, now: now });
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a;
      return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}
var folderSeq = 0;
function launch(c, n, extra, start) {
  var emails = [];
  for (var i = 0; i < n; i++) emails.push('p' + i + '@co' + i + '.com');
  return c.leads.createFolder(c.a, 'F' + (++folderSeq)).then(function (f) {
    c.folder = f;
    return c.leads.importLeads(c.a, f.id, 'paste', emails.join('\n')).then(function () {
      return c.camps.create(c.a, Object.assign({ name: 'C', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [c.sid], folder_id: f.id }, extra || {}));
    });
  }).then(function (camp) { c.camp = camp; return start === false ? camp : c.camps.start(c.a, camp.id); });
}
function setSender(c, cols) {
  var keys = Object.keys(cols);
  return c.db.run('UPDATE senders SET ' + keys.map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ?', keys.map(function (k) { return cols[k]; }).concat([c.sid]));
}
function tick(c, ms) { c.clock.t += ms || 0; return c.engine.tick(); }


h.group('v1.8.1 suppression guardrails and queue consistency');
h.test('adding an address to the do-not-email list stops its waiting entries in EVERY campaign at once', function () {
  return setup().then(function (c) {
    return launch(c, 3).then(function () { c.camp1 = c.camp; return launch(c, 3); }).then(function () {
      return c.leads.addSuppression(c.a, ['p1@co1.com', 'nobody@nowhere.com', 'not-an-email'], 'manual');
    }).then(function (r) {
      assert.strictEqual(r.added, 2); assert.strictEqual(r.invalid, 1); assert.strictEqual(r.stopped_in_campaigns, 2, 'p1 waited in two campaigns');
      return c.db.all("SELECT cl.status, cl.next_send_at, cl.status_note FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = 'p1@co1.com'");
    }).then(function (rows) {
      assert.strictEqual(rows.length, 2);
      rows.forEach(function (x) { assert.strictEqual(x.status, 'unsubscribed'); assert.strictEqual(x.next_send_at, null); assert.ok(x.status_note); });
      return c.db.get("SELECT COUNT(*) AS n FROM campaign_leads WHERE status = 'active'");
    }).then(function (r) { assert.strictEqual(r.n, 4, 'everybody else keeps going'); });
  });
});
h.test('a manual "bounced" block marks waiting people bounced; other users are never touched; the campaign completes when nobody is left', function () {
  return setup().then(function (c) {
    return h.mkUser(c.db, 'b@x.com').then(function (b) { c.b = b; return launch(c, 1); }).then(function () {
      return c.db.run("INSERT INTO folders (user_id, name, created_at) VALUES (?, 'Other', ?)", [c.b, c.clock.t]);
    }).then(function (r) {
      return c.db.run("INSERT INTO leads (user_id, folder_id, email, domain, created_at) VALUES (?,?,?,?,?)", [c.b, r.lastID, 'p0@co0.com', 'co0.com', c.clock.t]);
    }).then(function () { return c.leads.addSuppression(c.a, ['p0@co0.com'], 'bounced'); })
      .then(function () { return Promise.all([c.db.get("SELECT status FROM campaign_leads WHERE campaign_id = ?", [c.camp.id]), c.camps.get(c.a, c.camp.id), c.db.get("SELECT COUNT(*) AS n FROM suppression WHERE user_id = ?", [c.b])]); })
      .then(function (r) {
        assert.strictEqual(r[0].status, 'bounced'); assert.strictEqual(r[1].status, 'completed', 'nobody left to email'); assert.strictEqual(r[2].n, 0, 'the other user has no block');
      });
  });
});
h.test('the send claim re-reads the block list in its own transaction: an address blocked mid-preparation is never sent to', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return c.db.get("SELECT cl.id AS cl_id, cl.current_step, cl.campaign_id, l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY cl.id LIMIT 1"); })
      .then(function (row) {
        c.row = Object.assign({ user_id: c.a, lead_id: 0 }, row);
        return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?,?,'unsubscribed',?)", [c.a, row.email, c.clock.t]);
      }).then(function () {
        return c.engine._stepsFor(c.row.campaign_id).then(function (steps) {
          return c.engine._claim({ id: c.sid }, c.row, { messageId: '<x@y>', inReplyTo: null, subject: 's', html: 'h', text: 't', from: { address: 's1@gmail.com' }, to: c.row.email }, steps, c.clock.t);
        });
      }).then(function (claim) {
        assert.strictEqual(claim.ok, false);
        return Promise.all([c.db.get("SELECT status FROM campaign_leads WHERE id = ?", [c.row.cl_id]), c.db.get("SELECT COUNT(*) AS n FROM messages WHERE campaign_lead_id = ?", [c.row.cl_id])]);
      }).then(function (r) { assert.strictEqual(r[0].status, 'unsubscribed'); assert.strictEqual(r[1].n, 0, 'no message row, nothing sent'); });
  });
});
h.test('a hard bounce stops the same address in other campaigns too (status bounced), with history kept', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return launch(c, 2); }).then(function () {
      return c.db.get("SELECT cl.id, cl.campaign_id, cl.lead_id, l.email AS lead_email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = 'p0@co0.com' ORDER BY cl.id LIMIT 1");
    }).then(function (cl) {
      cl.user_id = c.a;
      return c.db.transaction(function (tx) { return c.sync._applyBounce(tx, cl, { kind: 'hard' }, c.clock.t); }).then(function () {
        return c.db.all("SELECT cl.status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = 'p0@co0.com'");
      });
    }).then(function (rows) { assert.strictEqual(rows.length, 2); rows.forEach(function (x) { assert.strictEqual(x.status, 'bounced'); }); });
  });
});
h.test('starting a campaign whose people were all blocked behind the scenes completes it instead of leaving it "active" with nobody to email', function () {
  return setup().then(function (c) {
    return launch(c, 2, null, false).then(function () {
      return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) SELECT ?, email, 'manual', ? FROM leads WHERE user_id = ?", [c.a, c.clock.t, c.a]);
    }).then(function () { return c.camps.start(c.a, c.camp.id); }).then(function (camp) {
      assert.strictEqual(camp.status, 'completed');
      return c.db.all("SELECT status, status_note FROM campaign_leads WHERE campaign_id = ?", [c.camp.id]);
    }).then(function (rows) { rows.forEach(function (x) { assert.strictEqual(x.status, 'unsubscribed'); assert.ok(x.status_note); }); });
  });
});
h.test('the engine never sends to a blocked address even when the lead is still queued (end to end)', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?,?,'complaint',?)", [c.a, 'p0@co0.com', c.clock.t]);
    }).then(function () { return tick(c); }).then(function () { return tick(c, HOUR); }).then(function () { return tick(c, HOUR); }).then(function () { return tick(c, HOUR); }).then(function () {
      assert.ok(c.sent.every(function (m) { return m.to !== 'p0@co0.com'; }), 'nothing went to the blocked address');
      return c.db.get("SELECT status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = 'p0@co0.com'");
    }).then(function (r) { assert.strictEqual(r.status, 'unsubscribed'); });
  });
});

h.run();
