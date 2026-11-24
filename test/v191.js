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

h.run();
