'use strict';
// v1.9.1x: system guardrail window, dedicated sender ownership, counter healing, sending-accounts backup / restore (smart merge).
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var password = require('../src/lib/password');
var nextSend = require('../src/lib/nextSend');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var SettingsService = require('../src/services/settings').SettingsService;
var SenderBackup = require('../src/services/senderBackup').SenderBackup;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var senderHealth = require('../src/services/senderHealth');
var AlertsService = require('../src/services/alerts').AlertsService;
var ProjectsService = require('../src/services/projects').ProjectsService;

var HOUR = 3600000, DAY = 86400000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);
var STEPS = [{ subject: 'Hello', body_html: '<p>First</p>' }, { subject: 'Follow', body_html: '<p>Again</p>', delay_days: 3 }];

function setup() {
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var sent = [];
    var mailer = { send: function (creds, mail) { sent.push(mail); return Promise.resolve({ messageId: mail.messageId }); }, verify: function () { return Promise.resolve(true); } };
    var c = { db: db, clock: clock, sent: sent, key: key, leads: new Leads(db, { now: now }), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }), settings: new SettingsService(db, { now: now }) };
    c.engine = new SendEngine(db, { key: key, mailer: mailer, now: now });
    c.backup = new SenderBackup(db, { senders: c.senders, key: key, now: now });
    return h.mkUser(db, 'a@x.com').then(function (a) {
      c.a = a; return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}
var seqNo = 0;
function launch(c, n, sids) {
  var emails = [];
  for (var i = 0; i < n; i++) emails.push('p' + i + '@co' + i + '.com');
  return c.leads.createFolder(c.a, 'F' + (++seqNo)).then(function (f) {
    return c.leads.importLeads(c.a, f.id, 'paste', emails.join('\n')).then(function () {
      return c.camps.create(c.a, { name: 'C', steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: sids || [c.sid], folder_id: f.id });
    });
  }).then(function (camp) { c.camp = camp; return c.camps.start(c.a, camp.id); });
}
function setGuard(c, g) { return c.settings.update(c.a, { prefs: Object.assign({}, g) }); }

h.group('system guardrail window');
h.test('nextAllowed intersects the campaign window with the guardrail and never moves a time earlier', function () {
  var camp = { window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, weekdays_only: 1, active_days: 0 };
  var guard = { window_start_hour: 14, window_end_hour: 20, utc_offset_min: 0, weekdays_only: 0, active_days: 0 };
  assert.strictEqual(nextSend.nextAllowed(camp, TUE_10, null), TUE_10);
  assert.strictEqual(nextSend.nextAllowed(camp, TUE_10, guard), TUE_10 + 4 * HOUR, 'waits for the guardrail to open');
  assert.strictEqual(nextSend.nextAllowed(camp, TUE_10 + 15 * HOUR, guard), TUE_10 + DAY + 4 * HOUR, 'after 17:00 both are closed: next day 14:00');
  assert.strictEqual(nextSend.nextAllowed(camp, TUE_10, { window_start_hour: 18, window_end_hour: 22, utc_offset_min: 0, weekdays_only: 0, active_days: 0 }), null, 'windows that never overlap give null');
  assert.ok(nextSend.effective(camp, TUE_10 + 5 * DAY, TUE_10, guard) >= TUE_10 + 5 * DAY, 'the step interval is never shortened');
});
h.test('settings: guardrail is validated and stored; engine holds sending until the guardrail opens', function () {
  return setup().then(function (c) {
    return h.expectReject(setGuard(c, { guard_enabled: true, guard_start_hour: 15, guard_end_hour: 12 }), 'validation').then(function () {
      return setGuard(c, { guard_enabled: true, guard_start_hour: 14, guard_end_hour: 18, guard_utc_offset_min: 0 });
    }).then(function () { return c.settings.get(c.a); }).then(function (r) {
      assert.strictEqual(r.settings.prefs.guard_enabled, 1); assert.strictEqual(r.settings.prefs.guard_start_hour, 14);
      return launch(c, 1);
    }).then(function () { return c.engine.tick(); }).then(function () {
      assert.strictEqual(c.sent.length, 0, 'campaign window is open at 10:00 but the guardrail is not');
      c.clock.t = TUE_10 + 4 * HOUR + 60000;
      return c.engine.tick();
    }).then(function () {
      assert.strictEqual(c.sent.length, 1, 'sends once the guardrail opens');
      return setGuard(c, { guard_enabled: false });
    });
  });
});

h.group('dedicated sender ownership');
h.test('a person who already got Email 1 keeps their sender when the campaign sender list changes', function () {
  return setup().then(function (c) {
    return c.senders.create(c.a, { label: 'S2', email: 's2@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' }).then(function (s2) {
      c.sid2 = s2.id; return launch(c, 4, [c.sid, c.sid2]);
    }).then(function () { return c.db.all('SELECT id, sender_id FROM campaign_leads ORDER BY id'); }).then(function (before) {
      assert.strictEqual(new Set(before.map(function (x) { return x.sender_id; })).size, 2, 'people are spread over both senders');
      c.before = before;
      c.clock.t += HOUR;
      return c.engine.tick();
    }).then(function () { c.clock.t += 2 * HOUR; return c.engine.tick(); }).then(function () {
      return c.camps.update(c.a, c.camp.id, { sender_ids: [c.sid2] });
    }).then(function () { return c.db.all('SELECT id, sender_id, current_step FROM campaign_leads ORDER BY id'); }).then(function (after) {
      var mid = after.filter(function (x) { return x.current_step > 0; });
      assert.ok(mid.length > 0, 'somebody was emailed');
      mid.forEach(function (x) { assert.strictEqual(x.sender_id, c.before.filter(function (b) { return b.id === x.id; })[0].sender_id, 'owner of an emailed person never changes'); });
      return c.db.all("SELECT DISTINCT m.sender_id AS s, cl.sender_id AS o FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.direction = 'out'");
    }).then(function (rows) { rows.forEach(function (r) { assert.strictEqual(r.s, r.o, 'every sent email came from the person\'s owner'); }); });
  });
});

h.group('counters');
h.test('sent today is healed upward from the messages table and never lowered', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () { return c.engine.tick(); }).then(function () {
      return c.db.run("UPDATE senders SET sent_today = 0 WHERE id = ?", [c.sid]);
    }).then(function () { return c.engine._healSentToday(c.clock.t); }).then(function () {
      return c.db.get('SELECT sent_today FROM senders WHERE id = ?', [c.sid]);
    }).then(function (r) {
      assert.strictEqual(r.sent_today, c.sent.length, 'counter matches the real number of sent emails');
      return c.db.run('UPDATE senders SET sent_today = 40 WHERE id = ?', [c.sid]).then(function () { return c.engine._healSentToday(c.clock.t); }).then(function () { return c.db.get('SELECT sent_today FROM senders WHERE id = ?', [c.sid]); });
    }).then(function (r) { assert.strictEqual(r.sent_today, 40, 'a higher stored value (provider quota mark) is kept'); });
  });
});

h.group('sending accounts backup / restore');
h.test('backup is encrypted, needs the login password, and restore merges: existing skipped, new added, no errors', function () {
  return setup().then(function (c) {
    var pw = 'correct horse battery';
    return c.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [password.hash(pw), c.a]).then(function () {
      return c.senders.create(c.a, { label: 'Work', email: 'work@corp.com', provider: 'smtp', username: 'work@corp.com', password: 'smtp-secret-pass', smtp_host: 'smtp.corp.com', smtp_port: 587, smtp_secure: 0, imap_host: 'imap.corp.com', imap_port: 993, daily_limit: 120 });
    }).then(function () {
      return Promise.all([h.expectReject(c.backup.export(c.a, 'wrong password', 'backup-pass-123'), 'invalid_credentials'), h.expectReject(c.backup.export(c.a, pw, 'short'), 'validation')]);
    }).then(function () { return c.backup.export(c.a, pw, 'backup-pass-123'); }).then(function (r) {
      assert.strictEqual(r.count, 2);
      var text = JSON.stringify(r.file);
      assert.ok(text.indexOf('smtp-secret-pass') === -1 && text.indexOf('work@corp.com') === -1 && text.indexOf('abcdefghijklmnop') === -1, 'nothing readable inside the file');
      c.file = r.file;
      return h.expectReject(c.backup.preview(c.a, r.file, 'wrong-pass-123'), 'validation');
    }).then(function () { return c.backup.preview(c.a, c.file, 'backup-pass-123'); }).then(function (p) {
      assert.strictEqual(p.existing, 2); assert.strictEqual(p.new, 0);
      assert.ok(JSON.stringify(p).indexOf('smtp-secret-pass') === -1, 'preview never returns passwords');
      return c.backup.restore(c.a, c.file, 'backup-pass-123');
    }).then(function (res) {
      assert.strictEqual(res.added.length, 0); assert.strictEqual(res.skipped_existing.length, 2); assert.strictEqual(res.failed.length, 0, 'duplicates are not errors');
      // Lose the work account (and pause S1), then restore only what is missing, selecting by checkbox.
      return c.db.run("DELETE FROM senders WHERE email = 'work@corp.com'").then(function () { return c.backup.preview(c.a, c.file, 'backup-pass-123'); });
    }).then(function (p) {
      assert.strictEqual(p.new, 1); assert.strictEqual(p.existing, 1);
      assert.deepStrictEqual(p.accounts.map(function (a) { return a.exists; }), [true, false]);
      return c.backup.restore(c.a, c.file, 'backup-pass-123', ['work@corp.com', 's1@gmail.com', 'nobody@x.com']);
    }).then(function (res) {
      assert.deepStrictEqual(res.added, ['work@corp.com']); assert.deepStrictEqual(res.skipped_existing, ['s1@gmail.com']); assert.deepStrictEqual(res.not_in_backup, ['nobody@x.com']);
      return c.db.get("SELECT * FROM senders WHERE email = 'work@corp.com'");
    }).then(function (row) {
      assert.strictEqual(row.daily_limit, 120); assert.strictEqual(row.smtp_host, 'smtp.corp.com'); assert.strictEqual(row.smtp_secure, 0);
      assert.strictEqual(vault.decrypt(row.password_enc, c.key, 'sender:' + row.id), 'smtp-secret-pass', 'password restored and re-encrypted for this server');
      return h.mkUser(c.db, 'b@x.com');
    }).then(function (b) {
      // Another user restoring the same file gets their own copies and never sees or changes the first user's accounts.
      return c.backup.restore(b, c.file, 'backup-pass-123').then(function (res) {
        assert.strictEqual(res.added.length, 2); return c.db.get('SELECT COUNT(*) AS n FROM senders WHERE user_id = ?', [c.a]);
      });
    }).then(function (r) { assert.strictEqual(r.n, 2); });
  });
});
h.test('restore reports a broken account without stopping the others; tampered or foreign files are refused', function () {
  return setup().then(function (c) {
    var pw = 'correct horse battery';
    return c.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [password.hash(pw), c.a]).then(function () { return c.backup.export(c.a, pw, 'backup-pass-123'); }).then(function (r) {
      var f = JSON.parse(JSON.stringify(r.file)); f.data = Buffer.from(Buffer.from(f.data, 'base64').map(function (b, i) { return i === 3 ? b ^ 1 : b; })).toString('base64');
      var f2 = JSON.parse(JSON.stringify(r.file)); f2.N = 1048576;
      return Promise.all([h.expectReject(c.backup.preview(c.a, f, 'backup-pass-123'), 'validation'), h.expectReject(c.backup.preview(c.a, f2, 'backup-pass-123'), 'validation'),
        h.expectReject(c.backup.preview(c.a, '{"hello":1}', 'backup-pass-123'), 'validation'), h.expectReject(c.backup.preview(c.a, null, 'backup-pass-123'), 'validation')]);
    });
  });
});

h.group('campaign next email = earliest valid sender time (single source of truth)');
// Reply tracking counts as armed and fresh, so the senders are not blocked by the tracking gate in these tests.
function armTracking(c) { return c.db.run('UPDATE senders SET imap_last_uid = 1, last_sync_at = ?, sync_error = NULL', [TUE_10]); }
function twoSenders(c) {
  return c.senders.create(c.a, { label: 'S2', email: 's2@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' }).then(function (s2) { c.sid2 = s2.id; return armTracking(c); }).then(function () { return launch(c, 4, [c.sid, c.sid2]); });
}
function senderMap(c) { return c.senders.list(c.a).then(function (rows) { var m = {}; rows.forEach(function (r) { m[r.id] = r; }); return m; }); }
h.test('campaign next email equals the earliest next email of its owner senders', function () {
  return setup().then(function (c) {
    return twoSenders(c).then(function () { return Promise.all([c.camps.get(c.a, c.camp.id), senderMap(c)]); }).then(function (r) {
      var st = r[0].stats, m = r[1], times = [m[c.sid].next_email_at, m[c.sid2].next_email_at].filter(Boolean);
      assert.ok(times.length === 2, 'both owners have waiting people');
      assert.strictEqual(st.next_send_at, Math.min.apply(null, times));
      assert.strictEqual(st.next_blocked, null);
    });
  });
});
h.test('a paused sender is excluded; if every owner is blocked the campaign reports why instead of a countdown', function () {
  return setup().then(function (c) {
    return twoSenders(c).then(function () { return c.senders.setStatus(c.a, c.sid, 'paused'); }).then(function () { return Promise.all([c.camps.get(c.a, c.camp.id), senderMap(c)]); }).then(function (r) {
      assert.strictEqual(r[1][c.sid].next_email_at, null);
      assert.strictEqual(r[1][c.sid].next_email_block, 'paused');
      assert.strictEqual(r[0].stats.next_send_at, r[1][c.sid2].next_email_at, 'only the active owner counts');
      return c.senders.setStatus(c.a, c.sid2, 'paused');
    }).then(function () { return c.camps.get(c.a, c.camp.id); }).then(function (r) {
      assert.strictEqual(r.stats.next_send_at, null);
      assert.strictEqual(r.stats.next_blocked, 'paused');
    });
  });
});
h.test('an owner with no capacity left today is not shown before the next UTC midnight (campaign and sender agree)', function () {
  return setup().then(function (c) {
    return armTracking(c).then(function () { return launch(c, 3, [c.sid]); }).then(function () {
      return c.db.run('UPDATE senders SET sent_today = daily_limit, sent_today_date = ? WHERE id = ?', [new Date(TUE_10).toISOString().slice(0, 10), c.sid]);
    }).then(function () { return Promise.all([c.camps.get(c.a, c.camp.id), senderMap(c)]); }).then(function (r) {
      var midnight = Date.UTC(2026, 10, 11);
      assert.ok(r[1][c.sid].next_email_at >= midnight);
      assert.strictEqual(r[0].stats.next_send_at, r[1][c.sid].next_email_at);
    });
  });
});

h.test('a sender whose reply tracking is not ready is reported as blocked, not given a countdown', function () {
  var gate = require('../src/lib/senderGate');
  return setup().then(function (c) {
    return launch(c, 3, [c.sid]).then(function () { gate.setRequired(true); return Promise.all([c.camps.get(c.a, c.camp.id), senderMap(c)]); }).then(function (r) {
      gate.setRequired(false);
      assert.strictEqual(r[1][c.sid].next_email_at, null);
      assert.strictEqual(r[1][c.sid].next_email_block, 'tracking');
      assert.strictEqual(r[0].stats.next_send_at, null);
      assert.strictEqual(r[0].stats.next_blocked, 'tracking');
    }, function (e) { gate.setRequired(false); throw e; });
  });
});

h.group('Home campaign health: every problem comes from one server list');
function alertsOf(c) {
  var svc = new AlertsService(c.db, { senders: c.senders, projects: new ProjectsService(c.db, { campaigns: c.camps, now: function () { return c.clock.t; } }), settings: c.settings, now: function () { return c.clock.t; } });
  return svc.list(c.a);
}
function keys(r) { return r.items.map(function (x) { return x.key; }); }
h.test('alerts cover sender problems, stalled and failed people, with counts that follow the real state', function () {
  return setup().then(function (c) {
    return twoSenders(c).then(function () { return alertsOf(c); }).then(function (r0) {
      assert.deepStrictEqual(r0.items.filter(function (x) { return x.level === 'critical'; }), [], 'a healthy setup has no critical alert');
      return c.db.run("UPDATE senders SET last_error = 'SMTP auth failed' WHERE id = ?", [c.sid]).then(function () { return c.db.run("UPDATE senders SET connection_error = 'timeout', health_score = 20 WHERE id = ?", [c.sid2]); })
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'error', status_note = 'x', next_send_at = NULL WHERE id = (SELECT MIN(id) FROM campaign_leads WHERE campaign_id = ?)", [c.camp.id]); })
        .then(function () { return alertsOf(c); });
    }).then(function (r) {
      var k = keys(r);
      assert.ok(k.indexOf('s:' + c.sid + ':err') !== -1, 'sender error');
      assert.ok(k.indexOf('s:' + c.sid2 + ':floor') !== -1, 'below the protection threshold');
      assert.ok(k.indexOf('s:' + c.sid2 + ':conn') !== -1, 'connection problem');
      assert.ok(k.indexOf('c:' + c.camp.id + ':people') !== -1, 'people that failed');
      assert.strictEqual(r.counts.total, r.items.length);
      assert.strictEqual(r.counts.critical + r.counts.warning, r.counts.total);
      assert.strictEqual(r.counts.unreviewed, r.items.length, 'nothing reviewed yet');
      return c.settings.setHealthDismissed(c.a, ['s:' + c.sid + ':err']).then(function () { return c.settings.setHealthSeen(c.a, [k[0]]); }).then(function () { return alertsOf(c); }).then(function (r2) {
        assert.strictEqual(keys(r2).indexOf('s:' + c.sid + ':err'), -1, 'dismissed alert is hidden');
        assert.strictEqual(r2.counts.dismissed, 1);
        assert.ok(r2.all_keys.indexOf('s:' + c.sid + ':err') !== -1, 'but still listed as existing so the dismissal is kept');
        assert.strictEqual(r2.counts.unreviewed, r2.items.length - (keys(r2).indexOf(k[0]) === -1 ? 0 : 1));
        return c.db.run('UPDATE senders SET health_score = 100, connection_error = NULL WHERE id = ?', [c.sid2]);
      }).then(function () { return alertsOf(c); }).then(function (r3) {
        assert.strictEqual(keys(r3).indexOf('s:' + c.sid2 + ':floor'), -1, 'resolved problems disappear and the counts follow');
        assert.strictEqual(keys(r3).indexOf('s:' + c.sid2 + ':conn'), -1);
      });
    });
  });
});
h.test('alerts show a campaign whose owner senders are all paused, and every alert (no cut at six)', function () {
  return setup().then(function (c) {
    return twoSenders(c).then(function () { return c.senders.setStatus(c.a, c.sid, 'paused'); }).then(function () { return c.senders.setStatus(c.a, c.sid2, 'paused'); }).then(function () { return alertsOf(c); }).then(function (r) {
      var k = keys(r);
      assert.ok(k.indexOf('s:' + c.sid + ':down') !== -1 && k.indexOf('s:' + c.sid2 + ':down') !== -1);
      assert.ok(k.indexOf('c:' + c.camp.id + ':stalled') !== -1, 'people waiting on paused owners are reported');
    });
  });
});

h.group('next email: overdue people, downtime, anchoring, People breakdown');
var state = require('../src/services/campaignState');
h.test('after downtime an overdue person goes out at the next valid window (not after midnight UTC) and the follow-up is timed from the real send', function () {
  return setup().then(function (c) {
    return armTracking(c).then(function () { return launch(c, 1, [c.sid]); }).then(function () { return c.engine.tick(); }).then(function () {
      return c.db.get('SELECT last_sent_at, next_send_at FROM campaign_leads LIMIT 1');
    }).then(function (cl) {
      assert.strictEqual(cl.next_send_at, cl.last_sent_at + 3 * DAY, 'follow-up is anchored to the real send time of the previous email');
      c.clock.t = cl.last_sent_at + 9 * DAY + 2 * HOUR;          // the system was down for days: the follow-up is long overdue (a weekday, window open)
      return armTracking(c).then(function () { return c.camps.get(c.a, c.camp.id); }).then(function (r) {
        assert.ok(r.stats.next_send_at - c.clock.t < HOUR, 'shown as due now / next window, not pushed to midnight');
        return c.engine.tick();
      }).then(function () { return c.db.get('SELECT status FROM campaign_leads LIMIT 1'); }).then(function (row) { assert.strictEqual(row.status, 'completed'); });
    });
  });
});
h.test('a paused owner still gets an exact projected countdown with the reason, on the campaign and on each person', function () {
  return setup().then(function (c) {
    return armTracking(c).then(function () { return launch(c, 2, [c.sid]); }).then(function () { return c.senders.setStatus(c.a, c.sid, 'paused'); }).then(function () { return Promise.all([c.camps.get(c.a, c.camp.id), c.camps.listLeads(c.a, c.camp.id, {}), senderMap(c)]); }).then(function (r) {
      assert.strictEqual(r[0].stats.next_send_at, null);
      assert.strictEqual(r[0].stats.next_blocked, 'paused');
      assert.ok(r[0].stats.next_projected_at >= c.clock.t, 'exact time it would go out once the sender is active again');
      r[1].items.forEach(function (p) { assert.strictEqual(p.next_at, null); assert.strictEqual(p.next_blocked, 'paused'); assert.ok(p.next_projected_at >= c.clock.t); });
      assert.ok(r[2][c.sid].next_email_projected_at >= c.clock.t);
    });
  });
});
h.test('People tab: Stop campaign breakdown (on request vs by you) with counts and filter', function () {
  return setup().then(function (c) {
    return armTracking(c).then(function () { return launch(c, 3, [c.sid]); }).then(function () { return c.db.all('SELECT id FROM campaign_leads ORDER BY id'); }).then(function (rows) {
      return state.stopLead(c.db, rows[0].id, c.camp.id, 'manual', c.clock.t).then(function () { return state.stopLead(c.db, rows[1].id, c.camp.id, 'not_interested', c.clock.t); });
    }).then(function () { return Promise.all([c.camps.listLeads(c.a, c.camp.id, { status: 'stopped' }), c.camps.listLeads(c.a, c.camp.id, { status: 'stopped', stop_source: 'you' }), c.camps.listLeads(c.a, c.camp.id, { status: 'stopped', stop_source: 'request' }), h.expectReject(c.camps.listLeads(c.a, c.camp.id, { status: 'active', stop_source: 'you' }), 'validation')]); }).then(function (r) {
      assert.strictEqual(r[0].counts.stopped, 2); assert.strictEqual(r[0].counts.stop_you, 1); assert.strictEqual(r[0].counts.stop_request, 1);
      assert.strictEqual(r[1].items.length, 1); assert.strictEqual(r[1].items[0].opt_out, 'manual_stop');
      assert.strictEqual(r[2].items.length, 1); assert.strictEqual(r[2].items[0].opt_out, 'not_interested');
      assert.strictEqual(r[0].counts.completed || 0, 0, 'stopped people are never counted as completed');
    });
  });
});

h.group('account recovery and the lifetime Forced pauses counter');
function badHistory(c) {
  var p = Promise.resolve(), i, t = c.clock.t - HOUR;
  for (i = 0; i < 30; i++) p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, kind, step_no, sent_at, created_at) VALUES (?,?,'out','sent','email',0,?,?)", [c.a, c.sid, t, t]); });
  for (i = 0; i < 5; i++) p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, kind, error_class, created_at) VALUES (?,?,'in','received','bounce','hard',?)", [c.a, c.sid, t]); });
  return p;
}
h.test('each automatic health pause adds 1 to Forced pauses (once per pause); a recovered account resumes and its stale warning disappears', function () {
  return setup().then(function (c) {
    return badHistory(c).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.status, 'paused'); assert.strictEqual(s.forced_pauses, 1, 'a second check of the same pause does not count again'); assert.ok(/Auto-paused/.test(s.last_error));
      return alertsOf(c);
    }).then(function (r) {
      assert.ok(keys(r).indexOf('s:' + c.sid + ':down') !== -1);
      c.clock.t += 31 * DAY;                                                // the bad results leave the 30-day window: health is back to 100
      return senderHealth.recompute(c.db, c.sid, c.clock.t);
    }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.status, 'active', 'recovered: switched back on'); assert.strictEqual(s.last_error, null, 'stale warning cleared'); assert.strictEqual(s.forced_pauses, 1, 'the lifetime counter is never reduced');
      return Promise.all([alertsOf(c), c.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sender.auto_resume'")]);
    }).then(function (r) {
      assert.deepStrictEqual(keys(r[0]).filter(function (k) { return k.indexOf('s:' + c.sid + ':') === 0; }), [], 'no outdated account alert is left');
      assert.strictEqual(r[1].n, 1);
    });
  });
});
h.test('a pause you made by hand is never lifted automatically and never counted as a forced pause', function () {
  return setup().then(function (c) {
    return c.senders.setStatus(c.a, c.sid, 'paused').then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
      assert.strictEqual(s.status, 'paused'); assert.strictEqual(s.forced_pauses, 0);
    });
  });
});
h.test('a dismissed alert that goes away and comes back shows again as new; queue stalls and unassigned people are reported', function () {
  return setup().then(function (c) {
    return armTracking(c).then(function () { return launch(c, 2, [c.sid]); }).then(function () { return c.db.run("UPDATE senders SET last_error = 'SMTP down' WHERE id = ?", [c.sid]); }).then(function () { return c.settings.setHealthDismissed(c.a, ['s:' + c.sid + ':err']); })
      .then(function () { return alertsOf(c); }).then(function (r) {
        assert.strictEqual(keys(r).indexOf('s:' + c.sid + ':err'), -1, 'dismissed');
        return c.db.run('UPDATE senders SET last_error = NULL WHERE id = ?', [c.sid]);
      }).then(function () { return alertsOf(c); }).then(function () { return c.db.run("UPDATE senders SET last_error = 'SMTP down again' WHERE id = ?", [c.sid]); })
      .then(function () { return alertsOf(c); }).then(function (r) {
        var it = r.items.filter(function (x) { return x.key === 's:' + c.sid + ':err'; })[0];
        assert.ok(it && it.is_new, 'the returning problem is visible and new');
        c.clock.t += 2 * HOUR; return alertsOf(c);                              // nobody ticked the engine: the emails are 2h late while a sender could send
      }).then(function (r) {
        assert.ok(keys(r).indexOf('c:' + c.camp.id + ':overdue') !== -1, 'queue stall');
        return c.db.run("UPDATE campaign_leads SET sender_id = NULL WHERE id = (SELECT MIN(id) FROM campaign_leads)");
      }).then(function () { return alertsOf(c); }).then(function (r) { assert.ok(keys(r).indexOf('c:' + c.camp.id + ':unassigned') !== -1, 'people without a sending account'); });
  });
});
h.test('changing the password or server clears an old connection problem; an old auto-pause note on a healthy active account is tidied', function () {
  return setup().then(function (c) {
    return c.db.run("UPDATE senders SET connection_error = 'Login failed', connection_error_at = 1, last_error = 'Login failed' WHERE id = ?", [c.sid])
      .then(function () { return c.senders.update(c.a, c.sid, { password: 'zyxwvutsrqponmlk' }); }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
        assert.strictEqual(s.connection_error, null); assert.strictEqual(s.last_error, null);
        return c.db.run("UPDATE senders SET last_error = 'Auto-paused: health score fell to 10 (too many bounces)' WHERE id = ?", [c.sid]);
      }).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
        assert.strictEqual(s.status, 'active'); assert.strictEqual(s.last_error, null);
      });
  });
});
h.test('a force-paused (health) account cannot be resumed normally; Force continue lifts it; a hand pause still resumes', function () {
  return setup().then(function (c) {
    return badHistory(c).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return h.expectReject(c.senders.setStatus(c.a, c.sid, 'active'), 'conflict'); })
      .then(function () { return c.senders.update(c.a, c.sid, { force_continue: true }); }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
        assert.strictEqual(s.status, 'active'); assert.strictEqual(s.health_paused, 0);
        return c.senders.setStatus(c.a, c.sid, 'paused');
      }).then(function (s) { assert.strictEqual(s.sender ? s.sender.status : s.status, 'paused'); return c.senders.setStatus(c.a, c.sid, 'active'); }).then(function (s) { assert.strictEqual(s.status, 'active'); });
  });
});
h.test('turning Force continue off while health is still low makes the account Force paused again (and counts it)', function () {
  return setup().then(function (c) {
    return badHistory(c).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); }).then(function () { return c.senders.update(c.a, c.sid, { force_continue: true }); })
      .then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
        assert.strictEqual(s.status, 'active'); assert.strictEqual(s.force_active, true); assert.ok(s.health_score < s.health_floor, 'health is still below the threshold while forced');
        return c.senders.update(c.a, c.sid, { force_continue: false });
      }).then(function () { return c.senders.get(c.a, c.sid); }).then(function (s) {
        assert.strictEqual(s.force_active, false); assert.strictEqual(s.status, 'paused'); assert.strictEqual(s.health_paused, 1); assert.strictEqual(s.forced_pauses, 2);
      });
  });
});

h.run();
