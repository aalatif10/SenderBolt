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

h.group('studio backend');
h.test('step progress: sent vs capacity per step; people who left drop out of later steps', function () {
  return setup().then(function (c) {
    return cls(c).then(function (rows) {
      var t = T0;
      // 5 got email 1. #0 replied (done), #1 completed? no: 2 got email 2 too (#1,#2), #3 unsubscribed after email 1, #4 still waiting.
      return Promise.all(rows.map(function (r) { return sendMsg(c, r.id, 0, t); })).then(function () {
        return Promise.all([sendMsg(c, rows[1].id, 1, t + 3 * DAY), sendMsg(c, rows[2].id, 1, t + 3 * DAY)]);
      }).then(function () {
        return c.db.run("UPDATE campaign_leads SET status = 'replied', current_step = 1 WHERE id = ?", [rows[0].id])
          .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'active', current_step = 2 WHERE id IN (?,?)", [rows[1].id, rows[2].id]); })
          .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed', current_step = 1 WHERE id = ?", [rows[3].id]); })
          .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'active', current_step = 1 WHERE id = ?", [rows[4].id]); })
          .then(function () { return c.db.run("UPDATE campaigns SET status = 'active' WHERE id = ?", [c.camp.id]); });
      });
    }).then(function () { return c.camps.get(c.a, c.camp.id); }).then(function (g) {
      assert.deepStrictEqual(g.steps.map(function (s) { return [s.sent, s.capacity, s.locked]; }), [[5, 5, true], [2, 3, true], [0, 3, false]]);
      return c.camps.list(c.a, {});
    }).then(function (l) {
      var sp = l.items[0].step_progress;
      assert.deepStrictEqual(sp.map(function (s) { return [s.sent, s.capacity]; }), [[5, 5], [2, 3], [0, 3]]);
      assert.strictEqual(sp[1].pct, 66.7);
    });
  });
});

h.test('live edit: unsent steps editable, sent steps locked, delay shifts waiting people', function () {
  return setup().then(function (c) {
    c.now = T0 + DAY;
    return cls(c).then(function (rows) {
      return sendMsg(c, rows[0].id, 0, T0).then(function () {
        return c.db.run("UPDATE campaign_leads SET status = 'active', current_step = 1, next_send_at = ? WHERE id = ?", [T0 + 3 * DAY, rows[0].id]);
      }).then(function () { return c.db.run("UPDATE campaigns SET status = 'active' WHERE id = ?", [c.camp.id]); })
        .then(function () { return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 0, subject: 'New' }] }), 'conflict'); })
        .then(function () { return c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 1, subject: 'Re: hello', body_html: '<p>New follow-up <b>x</b></p>', delay_days: 5 }] }); })
        .then(function (g) {
          assert.strictEqual(g.steps[1].subject, 'Re: hello'); assert.strictEqual(g.steps[1].delay_days, 5); assert.ok(/New follow-up/.test(g.steps[1].body_html));
          assert.strictEqual(g.steps[0].subject, 'Hello {{first_name|there}}');
          return c.db.get('SELECT next_send_at FROM campaign_leads WHERE id = ?', [rows[0].id]);
        }).then(function (r) {
          assert.strictEqual(r.next_send_at, T0 + 5 * DAY);                            // moved by +2 days
          return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 2, body_html: '   ' }] }), 'validation');
        }).then(function () { return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 9 }] }), 'validation'); })
        .then(function () { return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 2, delay_days: 99 }] }), 'validation'); })
        .then(function () { return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 2 }, { step_no: 2 }] }), 'validation'); })
        .then(function () { return c.db.run("UPDATE campaigns SET status = 'completed' WHERE id = ?", [c.camp.id]); })
        .then(function () { return h.expectReject(c.camps.updateSteps(c.a, c.camp.id, { steps: [{ step_no: 2, subject: 'x' }] }), 'conflict'); });
    });
  });
});

h.test('live edit: isolation between users', function () {
  return setup().then(function (c) {
    return h.mkUser(c.db, 'b@x.com').then(function (b) { return h.expectReject(c.camps.updateSteps(b, c.camp.id, { steps: [{ step_no: 2, subject: 'x' }] }), 'not_found'); });
  });
});

h.test('opt-out visibility: stop campaign vs unsubscribe link vs bounce', function () {
  return setup().then(function (c) {
    var E;
    return cls(c).then(function (rows) {
      E = rows.map(function (r) { return r.email; });
      return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed', status_note = 'Replied \"stop campaign\"' WHERE id = ?", [rows[0].id])
        .then(function () { return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?,?,?,?)", [c.a, E[0], 'replied_stop', 1]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed', status_note = 'Unsubscribed' WHERE id = ?", [rows[1].id]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'bounced' WHERE id = ?", [rows[2].id]); })
        .then(function () { return replyMsg(c, rows[0].id, T0, null); })
        .then(function () { return c.camps.listLeads(c.a, c.camp.id, {}); });
    }).then(function (r) {
      var k = {}; r.items.forEach(function (i) { k[i.email] = i; });
      assert.strictEqual(k[E[0]].opt_out, 'stop_campaign'); assert.strictEqual(k[E[0]].replied_at, T0);
      assert.strictEqual(k[E[1]].opt_out, 'unsubscribe_link');
      assert.strictEqual(k[E[2]].opt_out, 'bounce');
      assert.strictEqual(k[E[3]].opt_out, null);
    });
  });
});

h.test('opens drill-down: per person, count, first and last time; works for the main campaign', function () {
  return setup().then(function (c) {
    return cls(c).then(function (rows) {
      return sendMsg(c, rows[0].id, 0, T0, 3).then(function () { return sendMsg(c, rows[1].id, 0, T0, 1); }).then(function () { return sendMsg(c, rows[2].id, 0, T0, 0); });
    }).then(function () { return c.rep.opens(c.a, c.camp.id, {}); }).then(function (o) {
      assert.strictEqual(o.tracking_enabled, true); assert.strictEqual(o.emails_sent, 3); assert.strictEqual(o.opened_emails, 2); assert.strictEqual(o.total_opens, 4);
      assert.strictEqual(o.open_rate, 66.7); assert.strictEqual(o.rows.length, 2);
      var top = o.rows.slice().sort(function (a, b) { return b.opens - a.opens; })[0];
      assert.strictEqual(top.opens, 3); assert.strictEqual(top.last_opened_at, T0 + 5000); assert.strictEqual(top.first_opened_at, T0 + 1000);
      return h.mkUser(c.db, 'z@x.com');
    }).then(function (z) { return h.expectReject(c.rep.opens(z, c.camp.id, {}), 'not_found'); });
  });
});

h.test('reports: totals, funnel, per-step reply attribution, sentiment, previous period, filters, isolation', function () {
  return setup().then(function (c) {
    var t = c.now - 2 * DAY;      // inside the 30-day window
    return cls(c).then(function (rows) {
      return Promise.all(rows.map(function (r) { return sendMsg(c, r.id, 0, t, r.id % 2 ? 1 : 0); })).then(function () {
        return sendMsg(c, rows[1].id, 1, t + 3600000, 0);
      }).then(function () {
        return replyMsg(c, rows[0].id, t + 7200000, 'interested');             // replied to step 0
      }).then(function () { return replyMsg(c, rows[1].id, t + 9000000, 'not_interested'); })   // after step 1 was sent
        .then(function () { return replyMsg(c, rows[2].id, t + 9000000, null, 'bounce'); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'replied', current_step = 1 WHERE id = ?", [rows[0].id]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'replied', current_step = 2 WHERE id = ?", [rows[1].id]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'bounced', current_step = 1 WHERE id = ?", [rows[2].id]); })
        .then(function () { return sendMsg(c, rows[3].id, 0, c.now - 40 * DAY); });              // previous period
    }).then(function () { return c.rep.overview(c.a, { days: 30 }); }).then(function (r) {
      assert.strictEqual(r.totals.sent, 6); assert.strictEqual(r.totals.replied, 2); assert.strictEqual(r.totals.bounced, 1); assert.strictEqual(r.totals.contacted, 5);
      assert.strictEqual(r.previous.sent, 1);
      assert.strictEqual(r.funnel.contacted, 5); assert.strictEqual(r.funnel.followed_up, 1); assert.strictEqual(r.funnel.replied, 2); assert.strictEqual(r.funnel.bounced, 1); assert.strictEqual(r.funnel.interested, 1);
      assert.strictEqual(r.steps[0].replied, 1); assert.strictEqual(r.steps[1].replied, 1);
      assert.strictEqual(r.sentiment.interested, 1); assert.strictEqual(r.sentiment.not_interested, 1);
      assert.strictEqual(r.series.length, 30); assert.strictEqual(r.series.reduce(function (a, s) { return a + s.sent; }, 0), 6);
      assert.strictEqual(r.campaigns.length, 1); assert.strictEqual(r.campaigns[0].name, 'Main'); assert.strictEqual(r.senders[0].sent, 6);
      return c.rep.overview(c.a, { days: 7, campaign_id: c.camp.id, sender_id: c.sid });
    }).then(function (r2) {
      assert.strictEqual(r2.totals.sent, 6);
      return h.expectReject(c.rep.overview(c.a, { campaign_id: 'x' }), 'validation');
    }).then(function () { return h.mkUser(c.db, 'q@x.com'); }).then(function (q) {
      return c.rep.overview(q, {}).then(function (r) { assert.strictEqual(r.totals.sent, 0); return h.expectReject(c.rep.overview(q, { campaign_id: c.camp.id }), 'not_found'); });
    });
  });
});

h.group('reply parsing');
h.test('signature and quote are separated, never mashed', function () {
  var p = replyParse.parse('Yes, send details!Sent from my Galaxy');
  assert.strictEqual(p.body, 'Yes, send details!'); assert.ok(/Galaxy/.test(p.signature));
  var q = replyParse.parse('Sounds good\n\nOn Tue, 3 Jun 2026 at 10:00, Ann <a@x.com> wrote:\n> Hi there\n> offer');
  assert.strictEqual(q.body, 'Sounds good'); assert.ok(/Hi there/.test(q.quoted)); assert.ok(/wrote/.test(q.quotedHeader));
});

h.group('inbox, settings, images');
h.test('inbox: thread parts, clean snippet and opt-out flag', function () {
  var InboxService = require('../src/services/inbox').InboxService;
  return setup().then(function (c) {
    var inbox = new InboxService(c.db, { now: function () { return c.now; } });
    return cls(c).then(function (rows) {
      var id = rows[0].id;
      return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, subject, kind, sentiment, received_at, created_at, body_text) SELECT ?, cl.id, ?, cl.lead_id, 'in', 'received', 'Re: x', 'email', 'interested', ?, ?, ? FROM campaign_leads cl WHERE cl.id = ?",
        [c.a, c.sid, T0, T0, 'Yes, send details!Sent from my Galaxy', id]).then(function () {
        return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed', status_note = 'Replied \"stop campaign\"' WHERE id = ?", [id]);
      }).then(function () { return inbox.list(c.a, {}); }).then(function (l) {
        assert.strictEqual(l.items[0].snippet, 'Yes, send details!'); assert.strictEqual(l.items[0].opt_out, 'stop_campaign');
        assert.strictEqual(l.items[0].status_note, undefined);
        return inbox.thread(c.a, id);
      }).then(function (t) {
        var m = t.messages.filter(function (x) { return x.direction === 'in'; })[0];
        assert.strictEqual(m.view.body, 'Yes, send details!'); assert.ok(/Galaxy/.test(m.view.signature)); assert.strictEqual(t.conversation.opt_out, 'stop_campaign');
        assert.strictEqual(t.messages.some(function (x) { return x.body_html !== undefined; }), false);      // incoming HTML never leaves the server
      });
    });
  });
});

h.test('settings: preferences are whitelisted, range-checked and saved without touching the signature', function () {
  var SettingsService = require('../src/services/settings').SettingsService;
  return h.freshDb().then(function (db) {
    var s = new SettingsService(db);
    return h.mkUser(db, 'p@x.com').then(function (u) {
      return s.update(u, { default_signature_html: '<p>Sig</p>' }).then(function () {
        return s.update(u, { prefs: { window_start_hour: 8, window_end_hour: 18, track_opens: true, evil: 'x' } });
      }).then(function (r) {
        assert.strictEqual(r.settings.prefs.window_start_hour, 8); assert.strictEqual(r.settings.prefs.track_opens, 1); assert.strictEqual(r.settings.prefs.evil, undefined);
        assert.strictEqual(r.settings.prefs.default_delay_days, 3); assert.ok(/Sig/.test(r.settings.default_signature_html));
        return h.expectReject(s.update(u, { prefs: { window_start_hour: 30 } }), 'validation');
      }).then(function () { return h.expectReject(s.update(u, { prefs: { window_start_hour: 17, window_end_hour: 9 } }), 'validation'); })
        .then(function () { return h.expectReject(s.update(u, {}), 'validation'); });
    });
  });
});

h.test('images: validated by content, scoped to the user, embedded as CID, protected while in use', function () {
  var ImagesService = require('../src/services/images').ImagesService, embed = require('../src/services/images').embed;
  // 1x1 transparent PNG
  var png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  return h.freshDb().then(function (db) {
    var im = new ImagesService(db, { now: function () { return T0; } });
    return Promise.all([h.mkUser(db, 'i@x.com'), h.mkUser(db, 'j@x.com')]).then(function (u) {
      return h.expectReject(im.upload(u[0], { name: 'a.png', data: Buffer.from('not an image at all').toString('base64') }), 'validation')
        .then(function () { return im.upload(u[0], { name: 'logo.png', data: png.toString('base64') }); })
        .then(function (r) {
          assert.strictEqual(r.image.mime, 'image/png'); var id = r.image.id;
          return im.upload(u[0], { name: 'logo again.png', data: png.toString('base64') }).then(function (again) {
            assert.strictEqual(again.existing, true); assert.strictEqual(again.image.id, id);
            return h.expectReject(im.read(u[1], id), 'not_found');
          }).then(function () { return embed(db, u[0], '<p>Hi</p><img src="sbimg:' + id + '" alt="Logo" width="40" height="40">'); })
            .then(function (e) {
              assert.ok(/src="cid:sbimg-\d+@senderbolt"/.test(e.html)); assert.strictEqual(e.attachments.length, 1); assert.ok(/^sbimg-\d+@senderbolt$/.test(e.attachments[0].cid));
              return embed(db, u[1], '<img src="sbimg:' + id + '" alt="x">');                      // someone else's picture is dropped
            }).then(function (e2) { assert.strictEqual(e2.attachments.length, 0); assert.ok(!/sbimg/.test(e2.html)); });
        });
    });
  });
});

h.test('sanitizer: only our own picture reference survives', function () {
  var sanitize = require('../src/lib/sanitize');
  var out = sanitize.clean('<p>x</p><img src="https://evil.test/t.gif"><img src="data:image/png;base64,AAAA"><img src="sbimg:7" alt="Logo" onerror="x()" width="50" height="20">');
  assert.ok(!/evil|data:|onerror/.test(out)); assert.ok(/<img src="sbimg:7" alt="Logo" width="50" height="20">/.test(out));
});

h.run();
