'use strict';
// Studio / reports / opt-out visibility / step progress / live editing (backend).
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var ReportsService = require('../src/services/reports').ReportsService;
var replyParse = require('../src/lib/replyParse');

var DAY = 86400000, T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
var STEPS = [
  { subject: 'Hello {{first_name|there}}', body_html: '<p>First</p>' },
  { subject: '', body_html: '<p>Follow-up one</p>', delay_days: 3 },
  { subject: 'Last', body_html: '<p>Final</p>', delay_days: 5 }
];

// 5 leads in a campaign; marks the campaign running and simulates what the engine writes.
function setup() {
  return h.freshDb().then(function (db) {
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var c = { db: db, now: T0 + 20 * DAY };
    c.leads = new Leads(db); c.senders = new Senders(db, key);
    c.camps = new CampaignsService(db, { now: function () { return c.now; } });
    c.rep = new ReportsService(db, { now: function () { return c.now; } });
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a;
      return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) {
      c.sid = s.id;
      return c.leads.createFolder(c.a, 'F');
    }).then(function (f) {
      var sid = c.sid;
      return c.leads.importLeads(c.a, f.id, 'paste', ['a@co1.com', 'b@co2.com', 'c@co3.com', 'd@co4.com', 'e@co5.com'].join('\n')).then(function () {
        return c.camps.create(c.a, { name: 'Main', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [sid], folder_id: f.id, track_opens: 1 });
      });
    }).then(function (camp) { c.camp = camp; return c; });
  });
}
function cls(c) { return c.db.all('SELECT cl.id, cl.status, l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? ORDER BY cl.id', [c.camp.id]); }
function sendMsg(c, cl, step, at, opens) {
  return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, subject, kind, step_no, sent_at, open_count, opened_at, last_opened_at, created_at) " +
    "SELECT ?, cl.id, ?, cl.lead_id, 'out', 'sent', 's', 'email', ?, ?, ?, ?, ?, ? FROM campaign_leads cl WHERE cl.id = ?",
    [c.a, c.sid, step, at, opens || 0, opens ? at + 1000 : null, opens ? at + 5000 : null, at, cl]);
}
function replyMsg(c, cl, at, sentiment, kind) {
  return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, subject, kind, sentiment, received_at, created_at, body_text) " +
    "SELECT ?, cl.id, ?, cl.lead_id, 'in', 'received', 're', ?, ?, ?, ?, 'ok' FROM campaign_leads cl WHERE cl.id = ?", [c.a, c.sid, kind || 'email', sentiment || null, at, at, cl]);
}


function start(c) {
  return c.db.run("UPDATE campaigns SET status = 'active' WHERE id = ?", [c.camp.id])
    .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'active', current_step = 0, next_send_at = ?, sender_id = ? WHERE campaign_id = ?", [c.now, c.sid, c.camp.id]); });
}

h.group('live campaign operations');
h.test('running campaign: schedule + senders change, active_days mask, sender rebalance; draft-only sequence rule', function () {
  return setup().then(function (c) {
    return start(c).then(function () {
      return c.senders.create(c.a, { label: 'S2', email: 's2@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s2) {
      return c.camps.update(c.a, c.camp.id, { window_start_hour: 8, window_end_hour: 20, active_days: 127, sender_ids: [c.sid, s2.id] }).then(function (u) {
        assert.strictEqual(u.settings.window_start_hour, 8); assert.strictEqual(u.settings.active_days, 127); assert.strictEqual(u.settings.weekdays_only, 0);
        assert.strictEqual(u.senders.length, 2);
        return c.db.all('SELECT DISTINCT sender_id FROM campaign_leads WHERE campaign_id = ?', [c.camp.id]);
      }).then(function (rows) {
        assert.strictEqual(rows.length, 2, 'people not yet emailed are spread over both senders');
        return c.camps.update(c.a, c.camp.id, { sender_ids: [s2.id] });
      }).then(function () { return c.db.all('SELECT DISTINCT sender_id FROM campaign_leads WHERE campaign_id = ?', [c.camp.id]); })
        .then(function (rows) { assert.deepStrictEqual(rows.map(function (r) { return r.sender_id; }), [s2.id], 'removed sender no longer holds anybody'); })
        .then(function () { return h.expectReject(c.camps.update(c.a, c.camp.id, { steps: STEPS }), 'conflict'); })
        .then(function () { return h.expectReject(c.camps.update(c.a, c.camp.id, { active_days: 0 }), 'validation'); });
    });
  });
});

h.test('engine inWindow honours the day mask', function () {
  var inWindow = require('../src/engine/sendEngine').inWindow;
  var sat = Date.UTC(2026, 5, 13, 12, 0, 0), mon = Date.UTC(2026, 5, 15, 12, 0, 0);
  var c = { window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, weekdays_only: 1, active_days: null };
  assert.strictEqual(inWindow(c, sat), false); assert.strictEqual(inWindow(c, mon), true);
  c.active_days = 64 | 2;      // Sat + Mon only
  assert.strictEqual(inWindow(c, sat), true); assert.strictEqual(inWindow(c, mon), true);
  c.active_days = 4; assert.strictEqual(inWindow(c, mon), false);
});

h.test('add follow-up to a running campaign; cap at 6 emails; finished campaign refuses', function () {
  return setup().then(function (c) {
    return start(c).then(function () {
      return c.camps.addSteps(c.a, c.camp.id, { steps: [{ subject: '', body_html: '<p>Third nudge</p>', delay_days: 4 }] });
    }).then(function (g) {
      assert.strictEqual(g.steps.length, 4); assert.strictEqual(g.steps[3].step_no, 3); assert.strictEqual(g.steps[3].delay_days, 4); assert.strictEqual(g.steps[3].locked, false);
      return h.expectReject(c.camps.addSteps(c.a, c.camp.id, { steps: [1, 2, 3].map(function () { return { body_html: '<p>x</p>' }; }) }), 'validation');
    }).then(function () { return c.camps.addSteps(c.a, c.camp.id, { steps: [{ body_html: '<p>four</p>' }, { body_html: '<p>five</p>' }] }); })
      .then(function (g) { assert.strictEqual(g.steps.length, 6); })
      .then(function () { return c.db.run("UPDATE campaigns SET status = 'completed' WHERE id = ?", [c.camp.id]); })
      .then(function () { return h.expectReject(c.camps.addSteps(c.a, c.camp.id, { steps: [{ body_html: '<p>x</p>' }] }), 'conflict'); });
  });
});

h.test('lead history, inline edit of merge fields, per-user isolation', function () {
  return setup().then(function (c) {
    return start(c).then(function () { return cls(c); }).then(function (rows) {
      var cl = rows[0].id;
      return sendMsg(c, cl, 0, T0, 1).then(function () { return replyMsg(c, cl, T0 + 1000, 'interested'); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET current_step = 1, next_send_at = ? WHERE id = ?", [T0 + 3 * DAY, cl]); })
        .then(function () { return c.camps.leadHistory(c.a, c.camp.id, cl); }).then(function (hi) {
          assert.strictEqual(hi.messages.length, 2); assert.strictEqual(hi.messages[0].direction, 'out'); assert.strictEqual(hi.messages[1].body_text, 'ok');
          assert.deepStrictEqual(hi.steps.map(function (s) { return s.state; }), ['sent', 'scheduled', 'not_sent']);
          return c.camps.updateLead(c.a, c.camp.id, cl, { first_name: 'Nina', company: 'Acme', custom: { Budget: '5k' } });
        }).then(function (hi) {
          assert.strictEqual(hi.lead.first_name, 'Nina'); assert.deepStrictEqual(hi.lead.custom, { budget: '5k' });
          return h.expectReject(c.camps.updateLead(c.a, c.camp.id, cl, { custom: { 'bad key!': 'x' } }), 'validation');
        }).then(function () { return h.mkUser(c.db, 'b@x.com'); })
        .then(function (b) { return h.expectReject(c.camps.leadHistory(b, c.camp.id, cl), 'not_found'); });
    });
  });
});

h.test('bulk: pause / resume / remove / re-queue rules (stop-campaign yes, unsubscribe link and bounce no)', function () {
  return setup().then(function (c) {
    return start(c).then(function () { return cls(c); }).then(function (rows) {
      var id = function (i) { return rows[i].id; };
      return sendMsg(c, id(0), 0, T0).then(function () {
        return c.db.run("UPDATE campaign_leads SET current_step = 1 WHERE id = ?", [id(0)]);
      }).then(function () {
        return c.camps.bulkLeads(c.a, c.camp.id, { action: 'pause', ids: [id(1), id(2)] });
      }).then(function (r) {
        assert.strictEqual(r.done.length, 2);
        return c.camps.bulkLeads(c.a, c.camp.id, { action: 'resume', ids: [id(1), id(3)] });
      }).then(function (r) {
        assert.strictEqual(r.done.length, 1); assert.strictEqual(r.skipped.length, 1);
        // stop-campaign reply, unsubscribe-link, bounce
        return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed', status_note = 'replied stop campaign' WHERE id = ?", [id(0)])
          .then(function () { return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?, ?, 'replied_stop', ?)", [c.a, rows[0].email, T0]); })
          .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed' WHERE id = ?", [id(3)]); })
          .then(function () { return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?, ?, 'unsubscribed', ?)", [c.a, rows[3].email, T0]); })
          .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'bounced' WHERE id = ?", [id(4)]); });
      }).then(function () {
        return c.camps.bulkLeads(c.a, c.camp.id, { action: 'requeue', ids: [id(0), id(3), id(4)] });
      }).then(function (r) {
        assert.deepStrictEqual(r.done, [id(0)]); assert.strictEqual(r.skipped.length, 2);
        return c.db.get("SELECT status FROM campaign_leads WHERE id = ?", [id(0)]).then(function (x) {
          assert.strictEqual(x.status, 'active');
          return c.db.get("SELECT COUNT(*) AS n FROM suppression WHERE email = ?", [rows[0].email]);
        }).then(function (x) { assert.strictEqual(x.n, 0, 'replied_stop override lifted'); return c.db.get("SELECT COUNT(*) AS n FROM suppression WHERE email = ?", [rows[3].email]); })
          .then(function (x) { assert.strictEqual(x.n, 1, 'unsubscribe-link suppression kept'); });
      }).then(function () {
        // remove: emailed person is closed with a note, never-emailed person is deleted
        return c.camps.bulkLeads(c.a, c.camp.id, { action: 'remove', ids: [id(0), id(2)] });
      }).then(function (r) {
        assert.strictEqual(r.done.length, 2);
        return c.db.get("SELECT status, status_note FROM campaign_leads WHERE id = ?", [id(0)]).then(function (x) {
          assert.strictEqual(x.status, 'completed'); assert.strictEqual(x.status_note, 'Removed from the campaign');
          return c.db.get("SELECT COUNT(*) AS n FROM campaign_leads WHERE id = ?", [id(2)]);
        }).then(function (x) { assert.strictEqual(x.n, 0); });
      }).then(function () { return h.expectReject(c.camps.bulkLeads(c.a, c.camp.id, { action: 'nuke', ids: [1] }), 'validation'); })
        .then(function () { return h.expectReject(c.camps.bulkLeads(c.a, c.camp.id, { action: 'pause', ids: [] }), 'validation'); });
    });
  });
});

h.test('metrics breakdown: per step rows + people-once sequence row; home overview numbers', function () {
  return setup().then(function (c) {
    return start(c).then(function () { return cls(c); }).then(function (rows) {
      var id = function (i) { return rows[i].id; };
      return Promise.all(rows.map(function (r) { return sendMsg(c, r.id, 0, T0, r === rows[0] ? 1 : 0); })).then(function () {
        return sendMsg(c, id(1), 1, T0 + 3 * DAY, 1);
      }).then(function () { return replyMsg(c, id(0), T0 + 2000, 'interested'); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET current_step = 1 WHERE campaign_id = ?", [c.camp.id]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET current_step = 2 WHERE id = ?", [id(1)]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'bounced' WHERE id = ?", [id(4)]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'replied' WHERE id = ?", [id(0)]); })
        .then(function () { return c.camps.metrics(c.a, c.camp.id); }).then(function (m) {
          var s = m.rows[0], f = m.rows[1], u1 = m.rows[2], u2 = m.rows[3];
          assert.strictEqual(s.label, 'Sequence'); assert.strictEqual(f.sent, 5); assert.strictEqual(f.bounced, 1); assert.strictEqual(f.delivered, 4);
          assert.strictEqual(f.opened, 1); assert.strictEqual(f.replied, 1); assert.strictEqual(f.successful, 1);
          assert.strictEqual(u1.sent, 1); assert.strictEqual(u1.opened, 1);
          assert.strictEqual(s.sent, 6); assert.strictEqual(s.opened, 2, 'two different people opened'); assert.strictEqual(s.bounced, 1);
          // waiting: #2,#3 at step 1 -> scheduled for steps 1 and 2; #1 at step 2 -> step 2 only
          assert.strictEqual(u1.scheduled, 2); assert.strictEqual(u2.scheduled, 3); assert.strictEqual(f.scheduled, 0);
          return c.camps.homeOverview(c.a, { tz: 0 });
        }).then(function (o) {
          assert.strictEqual(o.active_campaigns, 1); assert.strictEqual(o.replies_7d, 0, 'the only reply is 20 days old');
          assert.strictEqual(o.sent_today, 0, 'sent weeks ago, not today');
          assert.strictEqual(o.scheduled, 1 + 2 + 2);       // #1 has 1 email left, #2 and #3 have 2; #0 replied, #4 bounced
        });
    });
  });
});

h.run();
