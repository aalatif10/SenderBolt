'use strict';
// v1.9.0 backend: health healing, connection errors never pause/hurt a sender, IMAP time-out back-off, real next-send timing.
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var health = require('../src/lib/health');
var nextSend = require('../src/lib/nextSend');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var InboxSync = require('../src/engine/inboxSync').InboxSync;
var inboxSync = require('../src/engine/inboxSync');
var sendEngine = require('../src/engine/sendEngine');
var senderHealth = require('../src/services/senderHealth');

var DAY = 86400000, HOUR = 3600000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);

function setup() {
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var c = { db: db, clock: clock, key: key, leads: new Leads(db, { now: now }), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }) };
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a;
      return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}

h.group('health healing (pure)');
h.test('a day with no emails sent earns 5, a calm sending day earns 1, clean sends and replies earn more, a severe day earns nothing, daily cap 10', function () {
  assert.strictEqual(health.healPoints({ severe: 0, sent: 0, replies: 0 }), 5, 'idle day: +5');
  assert.strictEqual(health.healPoints({ severe: 1, sent: 0, replies: 0 }), 0, 'a severe event still earns nothing');
  assert.strictEqual(health.healPoints({ severe: 0, sent: 9, replies: 0 }), 1, 'fewer than 10 clean emails earn nothing extra');
  assert.strictEqual(health.healPoints({ severe: 0, sent: 10, replies: 0 }), 2, '+1 for every 10 clean emails');
  assert.strictEqual(health.healPoints({ severe: 0, sent: 50, replies: 1 }), 7);
  assert.strictEqual(health.healPoints({ severe: 0, sent: 400, replies: 5 }), 10, 'never more than 10 a day');
  assert.strictEqual(health.HEAL.dayMax, 10); assert.strictEqual(health.HEAL.cleanPer, 10);
  assert.strictEqual(health.healPoints({ severe: 1, sent: 400, replies: 5 }), 0);
  assert.strictEqual(health.clampHeal(50, 90), 10, 'never above the cap of 100');
  assert.strictEqual(health.effective(60, 15), 75); assert.strictEqual(health.effective(99, 15), 100);
});

h.group('health healing (database)');
function seedBounces(c, n, at) {
  var p = Promise.resolve(), i;
  for (i = 0; i < n; i++) (function (k) { p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, idempotency_key, kind, error_class, created_at) VALUES (?,?,'in','received',?,'bounce','hard',?)", [c.a, c.sid, 'b' + k + ':' + at, at]); }); })(i);
  return p;
}
function seedSent(c, n, at) {
  var p = Promise.resolve(), i;
  for (i = 0; i < n; i++) (function (k) { p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, idempotency_key, kind, step_no, sent_at, created_at) VALUES (?,?,'out','sent',?,'email',0,?,?)", [c.a, c.sid, 's' + k + ':' + at, at, at]); }); })(i);
  return p;
}
h.test('score recovers gradually day by day, never above 100, and a new bounce cancels the healing', function () {
  return setup().then(function (c) {
    var sid = c.sid, t0 = TUE_10;
    return seedSent(c, 100, t0 - 2 * HOUR).then(function () { return seedBounces(c, 8, t0 - HOUR); }).then(function () { return senderHealth.recompute(c.db, sid, t0); })
      .then(function (score) {
        assert.strictEqual(score, 52, '100 sent, 8 hard bounces');
        return senderHealth.healDaily(c.db, sid, t0);          // first call only starts the clock
      }).then(function () { return c.db.get('SELECT health_score, health_heal, health_heal_day FROM senders WHERE id = ?', [sid]); })
      .then(function (s) { assert.strictEqual(s.health_score, 52); assert.strictEqual(s.health_heal, 0); assert.strictEqual(s.health_heal_day, '2026-11-09'); return senderHealth.healDaily(c.db, sid, t0 + 3 * DAY); })
      .then(function () { return c.db.get('SELECT health_score, health_heal FROM senders WHERE id = ?', [sid]); })
      .then(function (s) {
        // 3 completed days (Nov 10, 11, 12). Nov 10 had the 8 bounces + 100 sends -> severe (0 points); Nov 11 and 12 sent nothing: +5 each.
        assert.strictEqual(s.health_heal, 10); assert.strictEqual(s.health_score, 62);
        return seedBounces(c, 1, t0 + 3 * DAY + HOUR);
      }).then(function () { return senderHealth.recompute(c.db, sid, t0 + 3 * DAY + 2 * HOUR); })
      .then(function () { return c.db.get('SELECT health_heal FROM senders WHERE id = ?', [sid]); })
      .then(function (s) { assert.strictEqual(s.health_heal, 0, 'a new severe event resets the earned healing'); });
  });
});
h.test('a long calm stretch heals a damaged sender up to exactly 100 and no further', function () {
  return setup().then(function (c) {
    var sid = c.sid;
    return seedSent(c, 40, TUE_10 - HOUR).then(function () { return seedBounces(c, 4, TUE_10 - HOUR); }).then(function () { return senderHealth.recompute(c.db, sid, TUE_10); })
      .then(function () { return senderHealth.healDaily(c.db, sid, TUE_10); })
      .then(function () { return senderHealth.healDaily(c.db, sid, TUE_10 + 29 * DAY); })    // 29 days later: the bounces are still inside the 30-day window
      .then(function () { return c.db.get('SELECT health_score, health_base, health_heal FROM senders WHERE id = ?', [sid]); })
      .then(function (s) { assert.ok(s.health_score > s.health_base, 'healed above the raw score'); assert.ok(s.health_score <= 100); return senderHealth.healDaily(c.db, sid, TUE_10 + 80 * DAY); })
      .then(function () { return senderHealth.recompute(c.db, sid, TUE_10 + 80 * DAY); })
      .then(function () { return c.db.get('SELECT health_score, health_heal FROM senders WHERE id = ?', [sid]); })
      .then(function (s) { assert.strictEqual(s.health_score, 100); assert.strictEqual(s.health_heal, 0, 'heal never banks more than needed'); });
  });
});
h.test('the sender view explains healing', function () {
  return setup().then(function (c) { return c.senders.get(c.a, c.sid); }).then(function (s) {
    assert.strictEqual(s.health_base, 100); assert.strictEqual(s.health_heal, 0); assert.strictEqual(s.heal_rules.day_max, 10); assert.strictEqual(s.connection_error, null);
  });
});

h.group('IMAP time-outs');
h.test('"Timed out while authenticating" is a transient time-out, not a wrong password', function () {
  var e = new Error('Timed out while authenticating with server'); e.source = 'timeout-auth';
  assert.ok(inboxSync.isTransient(e)); assert.ok(!/login failed/i.test(inboxSync.friendlyError(e)));
  assert.ok(/retry automatically/.test(inboxSync.friendlyError(e)));
  var bad = new Error('Invalid credentials (Failure)'); bad.textCode = 'AUTHENTICATIONFAILED';
  assert.ok(!inboxSync.isTransient(bad)); assert.ok(/IMAP login failed/.test(inboxSync.friendlyError(bad)));
  assert.deepStrictEqual([1, 2, 3, 4, 9].map(function (n) { return inboxSync.retryDelay(n, true) / 60000; }), [1, 2, 4, 5, 5]);
  assert.strictEqual(inboxSync.retryDelay(1, false), 15 * 60000);
});
h.test('a failing mailbox is retried with back-off, logged once, and does not block sending; success resets it', function () {
  return setup().then(function (c) {
    var logs = [], calls = 0, fail = true;
    var mailbox = { baseline: function () { calls++; if (fail) { var e = new Error('Timed out while authenticating with server'); e.source = 'timeout-auth'; return Promise.reject(e); } return Promise.resolve({ uidValidity: 1, lastUid: 0 }); },
      fetchSince: function () { return Promise.resolve({ uidValidity: 1, lastUid: 0, messages: [] }); } };
    var sync = new InboxSync(c.db, { key: c.key, mailbox: mailbox, now: function () { return c.clock.t; }, log: function (m) { logs.push(m); } });
    return c.db.run("UPDATE senders SET imap_host = 'imap.gmail.com', imap_port = 993").then(function () { return sync.syncAll(); }).then(function (sum) {
      assert.strictEqual(sum.errors, 1); assert.strictEqual(calls, 1);
      return c.db.get('SELECT sync_error, sync_transient, sync_failures, sync_retry_at FROM senders WHERE id = ?', [c.sid]);
    }).then(function (s) {
      assert.strictEqual(s.sync_transient, 1); assert.strictEqual(s.sync_failures, 1); assert.strictEqual(s.sync_retry_at, c.clock.t + 60000);
      assert.strictEqual(sendEngine.trackingOk({ imap_host: 'x', imap_last_uid: 5, sync_error: s.sync_error, sync_transient: 1, last_sync_at: c.clock.t - 60000 }, c.clock.t, true), true, 'transient failure does not block sending while the last good sync is fresh');
      assert.strictEqual(sendEngine.trackingOk({ imap_host: 'x', imap_last_uid: 5, sync_error: 'IMAP login failed', sync_transient: 0, last_sync_at: c.clock.t - 60000 }, c.clock.t, true), false, 'a real login failure does');
      return sync.syncAll();
    }).then(function () { assert.strictEqual(calls, 1, 'skipped during the back-off'); c.clock.t += 61000; return sync.syncAll(); })
      .then(function () { assert.strictEqual(calls, 2); assert.strictEqual(logs.length, 1, 'only the first failure is logged'); fail = false; c.clock.t += 3 * 60000; return sync.syncAll(); })
      .then(function () { return c.db.get('SELECT sync_error, sync_failures, sync_retry_at FROM senders WHERE id = ?', [c.sid]); })
      .then(function (s) { assert.strictEqual(s.sync_error, null); assert.strictEqual(s.sync_failures, 0); assert.strictEqual(s.sync_retry_at, null); });
  });
});

h.group('real next-send timing');
h.test('window maths: waits for opening hours, selected days and the start date', function () {
  var c = { window_start_hour: 9, window_end_hour: 17, utc_offset_min: -360, active_days: 62 };      // Mon-Fri 9-5 at UTC-6
  assert.strictEqual(new Date(nextSend.nextWindowOpen(c, Date.UTC(2026, 10, 20, 23, 0))).toISOString(), '2026-11-23T15:00:00.000Z', 'Friday evening -> Monday 9 AM');
  assert.strictEqual(nextSend.nextWindowOpen(c, Date.UTC(2026, 10, 20, 16, 0)), Date.UTC(2026, 10, 20, 16, 0), 'inside the window: now');
  assert.strictEqual(new Date(nextSend.nextWindowOpen(Object.assign({}, c, { start_at: Date.UTC(2026, 11, 1, 0, 0) }), Date.UTC(2026, 10, 10, 16, 0))).toISOString(), '2026-12-01T15:00:00.000Z', 'start date respected');
  assert.strictEqual(nextSend.nextWindowOpen({ window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, active_days: 0, weekdays_only: 0 }, 0) !== null, true, 'no mask falls back to every day');
});
h.test('sender and campaign next-email times are window-aware', function () {
  return setup().then(function (c) {
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'paste', 'p1@co1.com\np2@co2.com').then(function () {
        return c.camps.create(c.a, { name: 'C', steps: [{ subject: 'Hi', body_html: '<p>x</p>' }], sender_ids: [c.sid], folder_id: f.id });
      });
    }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); }).then(function () {
      // Tue 10:00 UTC; close the window for today: only 20:00-22:00 UTC allowed.
      return c.db.run('UPDATE campaigns SET window_start_hour = 20, window_end_hour = 22, utc_offset_min = 0, active_days = 127');
    }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.next_email_at, Date.UTC(2026, 10, 10, 20, 0), 'sender: next email when the window opens');
      return c.camps.list ? c.camps.list(c.a) : null;
    }).then(function (list) {
      var items = list && (list.items || list); var main = items && items.filter(function (x) { return x.id === c.camp.id; })[0];
      if (main && main.stats) assert.strictEqual(main.stats.next_send_at, Date.UTC(2026, 10, 10, 20, 0), 'campaign: same');
      return c.db.run('UPDATE senders SET sent_today = daily_limit, sent_today_date = ?', ['2026-11-10']);
    }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.next_email_at, Date.UTC(2026, 10, 11, 20, 0), 'allowance used up: tomorrow, then the window');
    });
  });
});

h.group('campaigns table: archive, duplicate, filters');
h.test('duplicate makes a draft copy, archive hides/restores and is refused while active, table filters work', function () {
  var ProjectsService = require('../src/services/projects').ProjectsService;
  return setup().then(function (c) {
    var proj = new ProjectsService(c.db, { campaigns: c.camps, now: function () { return c.clock.t; } });
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'paste', 'p1@co1.com\np2@co2.com').then(function () {
        return c.camps.create(c.a, { name: 'Alpha', steps: [{ subject: 'Hi', body_html: '<p>x</p>' }], sender_ids: [c.sid], folder_id: f.id });
      });
    }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); })
      .then(function () { return h.expectReject(c.camps.setArchived(c.a, c.camp.id, true)); })
      .then(function () { return c.camps.pause(c.a, c.camp.id); })
      .then(function () { return c.camps.duplicate(c.a, c.camp.id); }).then(function (copy) {
        assert.strictEqual(copy.name, 'Alpha (copy)'); assert.strictEqual(copy.status, 'draft'); c.copy = copy;
        return proj.campaignTable(c.a, {});
      }).then(function (t) {
        assert.strictEqual(t.items.length, 2);
        return proj.campaignTable(c.a, { q: 'copy' });
      }).then(function (t) {
        assert.strictEqual(t.items.length, 1); assert.strictEqual(t.items[0].name, 'Alpha (copy)');
        return proj.campaignTable(c.a, { status: 'paused' });
      }).then(function (t) {
        assert.strictEqual(t.items.length, 1); assert.strictEqual(t.items[0].name, 'Alpha');
        return proj.campaignTable(c.a, { sender_ids: String(c.sid) });
      }).then(function (t) {
        assert.strictEqual(t.items.length, 2);
        return h.expectReject(proj.campaignTable(c.a, { status: 'bogus' }));
      }).then(function () { return c.camps.setArchived(c.a, c.camp.id, true); })
      .then(function () { return proj.campaignTable(c.a, {}); }).then(function (t) {
        assert.strictEqual(t.items.length, 1, 'archived hidden by default');
        return proj.campaignTable(c.a, { status: 'archived' });
      }).then(function (t) {
        assert.strictEqual(t.items.length, 1); assert.strictEqual(t.items[0].name, 'Alpha');
        return h.mkUser(c.db, 'b@x.com');
      }).then(function (b) { return h.expectReject(c.camps.duplicate(b, c.camp.id)); });
  });
});

h.group('sender risk and healing outlook');
h.test('sender view exposes risk factors and a healing outlook', function () {
  return setup().then(function (c) {
    return c.db.run('UPDATE senders SET health_score = 60, health_base = 55, health_heal = 5').then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.risk.level, 'high'); assert.ok(s.risk.factors.length >= 1);
      assert.strictEqual(s.heal_full_in_days, 4); assert.ok(s.heal_next_at > c.clock.t);
      return c.db.run("UPDATE senders SET health_score = 20, health_base = 20, health_heal = 0, connection_error = 'Login failed'");
    }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.risk.level, 'critical'); assert.ok(/Connection problem/.test(s.risk.factors.join(' ')));
    });
  });
});

h.group('inbox status filter = reply tags');
h.test('Status filter matches the reply tags; successful/not_successful keep their meaning; old state values are rejected', function () {
  var InboxService = require('../src/services/inbox').InboxService;
  return setup().then(function (c) {
    var inbox = new InboxService(c.db, { now: function () { return c.clock.t; } });
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'paste', 'a@co1.com\nb@co2.com\nc@co3.com\nd@co4.com\ne@co5.com').then(function () {
        return c.camps.create(c.a, { name: 'C', steps: [{ subject: 'Hi', body_html: '<p>x</p>' }], sender_ids: [c.sid], folder_id: f.id });
      });
    }).then(function () { return c.db.all('SELECT id, lead_id FROM campaign_leads ORDER BY id'); }).then(function (cls) {
      var tags = ['interested', 'more_info', 'not_interested', 'neutral', null], i = 0; c.cls = cls;
      return cls.reduce(function (p, cl) {
        var tag = tags[i++];
        return p.then(function () {
          return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, idempotency_key, subject, body_text, from_addr, to_addr, kind, sentiment, received_at, created_at) VALUES (?,?,?,?, 'in','received',?,?,?,?,?, 'email',?,?,?)",
            [c.a, cl.id, c.sid, cl.lead_id, 'k' + cl.id, 'Re', 'text', 'x@y.com', 's1@gmail.com', tag, c.clock.t, c.clock.t]);
        });
      }, Promise.resolve()).then(function () {
        // the fifth person also opted out
        return c.db.run("UPDATE campaign_leads SET status = 'unsubscribed' WHERE id = ?", [c.cls[4].id]);
      });
    }).then(function () {
      function n(status) { return inbox.list(c.a, { status: status }).then(function (r) { return r.total; }); }
      return Promise.all([n('interested'), n('more_info'), n('not_interested'), n('neutral'), n('successful'), n('not_successful'), n('interested,more_info'), n('')]).then(function (r) {
        assert.deepStrictEqual(r, [1, 1, 1, 2, 0, 1, 2, 5], 'nothing is Successful until you mark it; Not successful = opted out / bounced only');
        return Promise.all(['active', 'paused', 'completed', 'x;drop'].map(function (bad) { return h.expectReject(inbox.list(c.a, { status: bad })); }));
      }).then(function () { return inbox.setOutcome(c.a, c.cls[0].id, 'successful'); }).then(function () {
        return Promise.all([n('successful'), n('interested'), inbox.list(c.a, { sentiment: 'successful' }), inbox.list(c.a, {})]);
      }).then(function (r) {
        assert.strictEqual(r[0], 1); assert.strictEqual(r[1], 1, 'the reply tag is untouched');
        assert.strictEqual(r[2].total, 1); assert.strictEqual(r[2].items[0].outcome, 'successful'); assert.strictEqual(r[3].counts.successful, 1);
        return inbox.thread(c.a, c.cls[0].id);
      }).then(function (t) {
        assert.strictEqual(t.conversation.outcome, 'successful');
        return inbox.setOutcome(c.a, c.cls[4].id, 'successful');
      }).then(function () { return n('not_successful'); }).then(function (x) {
        assert.strictEqual(x, 0, 'marked Successful wins over opted out');
        return inbox.setOutcome(c.a, c.cls[0].id, null);
      }).then(function () { return n('successful'); }).then(function (x) {
        assert.strictEqual(x, 1);
        return Promise.all([h.expectReject(inbox.setOutcome(c.a, c.cls[0].id, 'won')), h.mkUser(c.db, 'b@x.com').then(function (b) { return h.expectReject(inbox.setOutcome(b, c.cls[0].id, 'successful')); })]);
      });
    });
  });
});

h.group('project row = aggregate, campaign rows = own numbers');
h.test('a project row equals its only campaign; with several campaigns it is their sum while each campaign keeps its own numbers', function () {
  var ProjectsService = require('../src/services/projects').ProjectsService;
  return setup().then(function (c) {
    var proj = new ProjectsService(c.db, { campaigns: c.camps, now: function () { return c.clock.t; } });
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'paste', 'p1@co1.com\np2@co2.com\np3@co3.com').then(function () {
        return c.camps.create(c.a, { name: 'Alpha', steps: [{ subject: 'Hi', body_html: '<p>x</p>' }, { subject: 'Again', body_html: '<p>y</p>', delay_days: 3 }], sender_ids: [c.sid], folder_id: f.id });
      });
    }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); })
      .then(function () { return Promise.all([proj.list(c.a, {}), proj.campaignTable(c.a, {})]); }).then(function (r) {
        var p = r[0].items[0], rows = r[1].items;
        assert.strictEqual(rows.length, 1); assert.ok(p.row, 'project has an aggregated row');
        ['scheduled', 'sent', 'leads', 'progress_pct', 'display_status', 'next_send_at', 'next_kind'].forEach(function (k) { assert.strictEqual(p.row[k], rows[0][k], k); });
        assert.deepStrictEqual(p.row.step_progress.map(function (x) { return [x.sent, x.capacity]; }), rows[0].step_progress.map(function (x) { return [x.sent, x.capacity]; }));
        assert.strictEqual(p.row.scheduled, 6, '3 people x 2 emails');
        return c.camps.duplicate(c.a, c.camp.id);
      }).then(function () { return Promise.all([proj.list(c.a, {}), proj.campaignTable(c.a, {})]); }).then(function (r) {
        var p = r[0].items[0], rows = r[1].items;
        assert.strictEqual(rows.length, 2); assert.strictEqual(p.row.campaign_count, 2);
        assert.strictEqual(p.row.scheduled, rows[0].scheduled + rows[1].scheduled); assert.strictEqual(p.row.leads, rows[0].leads + rows[1].leads);
        assert.strictEqual(p.row.step_progress[0].capacity, rows[0].step_progress[0].capacity + rows[1].step_progress[0].capacity);
        assert.ok(rows.some(function (x) { return x.scheduled !== p.row.scheduled; }), 'a campaign row keeps its own number, not the project total');
        return c.camps.setArchived(c.a, c.copyId || rows.filter(function (x) { return x.status === 'draft'; })[0].id, true);
      }).then(function () { return proj.list(c.a, {}); }).then(function (r) {
        assert.strictEqual(r.items[0].row.campaign_count, 1, 'archived campaigns are left out of the aggregate, like in the expanded list');
      });
  });
});

h.group('sync time-out diagnostics');
h.test('time-out messages name the step and the mailbox; a repeating time-out runs a connectivity probe and the finding is kept', function () {
  function err(source, host) { var e = new Error('Timed out'); e.source = source; e.imapHost = host; e.imapPort = 993; return e; }
  assert.strictEqual(inboxSync.phaseOf(err('timeout')), 'connect'); assert.strictEqual(inboxSync.phaseOf(err('timeout-auth')), 'login'); assert.strictEqual(inboxSync.phaseOf(err('timeout-op')), 'read');
  assert.ok(/open a connection.*imap\.x\.com:993/.test(inboxSync.friendlyError(err('timeout', 'imap.x.com'))));
  assert.ok(/did not finish the sign-in.*not a wrong password/.test(inboxSync.friendlyError(err('timeout-auth', 'imap.x.com'))));
  assert.ok(/handshake fails/.test(inboxSync.probeHint({ ok: false, step: 'tls', detail: 'ETIMEDOUT' }, 'imap.x.com', 993)));
  assert.ok(/cannot be found/.test(inboxSync.probeHint({ ok: false, step: 'dns', detail: 'ENOTFOUND' }, 'imap.x.com', 993)));
  return setup().then(function (c) {
    var logs = [], probes = 0;
    var mailbox = { baseline: function () { return Promise.reject(err('timeout', 'imap.gmail.com')); }, fetchSince: function () { return Promise.reject(err('timeout', 'imap.gmail.com')); },
      probe: function () { probes++; return Promise.resolve({ ok: false, step: 'tcp', ms: 8000, detail: 'no answer within 8s' }); } };
    var sync = new InboxSync(c.db, { key: c.key, mailbox: mailbox, now: function () { return c.clock.t; }, log: function (m) { logs.push(m); } });
    function again() { c.clock.t += 6 * 60000; return sync.syncAll(); }
    return c.db.run("UPDATE senders SET imap_host = 'imap.gmail.com', imap_port = 993").then(function () { return sync.syncAll(); }).then(again).then(function () { assert.strictEqual(probes, 0, 'no probe before the 3rd failure'); return again(); }).then(function () {
      assert.strictEqual(probes, 1);
      return c.db.get('SELECT sync_error, sync_failures FROM senders WHERE id = ?', [c.sid]);
    }).then(function (r) {
      assert.strictEqual(r.sync_failures, 3); assert.ok(/Connection test: imap\.gmail\.com:993 does not accept connections/.test(r.sync_error), r.sync_error);
      assert.ok(logs.some(function (l) { return /s1@gmail\.com, imap\.gmail\.com:993/.test(l) && /Connection test/.test(l); }), 'the log names the account and the finding');
      return again();
    }).then(function () { return c.db.get('SELECT sync_error FROM senders WHERE id = ?', [c.sid]); }).then(function (r) {
      assert.strictEqual(probes, 1, 'not probed again on the 4th'); assert.ok(/Connection test:/.test(r.sync_error), 'the finding stays visible');
    });
  });
});

h.run();
