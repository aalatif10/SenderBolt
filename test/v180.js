'use strict';
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

h.group('v1.8 sender protection levels and force continue');
h.test('protection level sets the health floor (low 30, medium 50, high 70); default is medium', function () {
  assert.strictEqual(health.floorFor({}), 50); assert.strictEqual(health.floorFor({ protection_level: 'low' }), 30); assert.strictEqual(health.floorFor({ protection_level: 'high' }), 70);
  assert.strictEqual(health.streakLimitFor({ protection_level: 'high' }), 3); assert.strictEqual(health.streakLimitFor({ protection_level: 'low' }), 8);
  return setup().then(function (c) {
    return c.senders.get(c.a, c.sid).then(function (s) {
      assert.strictEqual(s.protection_level, 'medium'); assert.strictEqual(s.health_floor, 50); assert.strictEqual(s.reply_detection, 1); assert.strictEqual(s.force_active, false);
      return h.expectReject(c.senders.update(c.a, c.sid, { protection_level: 'extreme' }), 'validation');
    });
  });
});
h.test('the engine honours the sender\'s level: score 60 sends on medium/low, not on high; score 40 sends only on low', function () {
  // The engine re-checks campaign health every 30 s (a campaign with no usable sender shows as "error", then recovers),
  // so each step below lets that much time pass.
  return setup().then(function (c) {
    return launch(c, 6).then(function () { return setSender(c, { health_score: 60, protection_level: 'high' }); })
      .then(function () { return tick(c); }).then(function (r) { assert.strictEqual(r.sent, 0, 'high protection pauses below 70'); return setSender(c, { protection_level: 'medium' }); })
      .then(function () { return tick(c, 40000); }).then(function (r) { assert.strictEqual(r.sent, 1, 'medium sends at 60'); return setSender(c, { health_score: 40, next_send_at: null }); })
      .then(function () { return tick(c, 40000); }).then(function (r) { assert.strictEqual(r.sent, 0, 'medium stops below 50'); return setSender(c, { protection_level: 'low' }); })
      .then(function () { return tick(c, 40000); }).then(function (r) { assert.strictEqual(r.sent, 1, 'low still sends at 40'); });
  });
});
h.test('force continue lifts the health floor for 72 hours, then protection applies again; it also resumes a paused sender', function () {
  return setup().then(function (c) {
    return launch(c, 6).then(function () { return setSender(c, { health_score: 10, status: 'paused', last_error: 'Auto-paused' }); })
      .then(function () { return c.senders.update(c.a, c.sid, { force_continue: true }); }).then(function (s) {
        assert.strictEqual(s.status, 'active', 'forcing a paused sender resumes it'); assert.strictEqual(s.force_active, true); assert.strictEqual(s.force_until, TUE_10 + health.FORCE_MS);
        return tick(c);
      }).then(function (r) { assert.strictEqual(r.sent, 1, 'sends although health is 10');
        return senderHealth.recompute(c.db, c.sid, c.clock.t);
      }).then(function () { return c.db.get('SELECT status FROM senders WHERE id = ?', [c.sid]); })
      .then(function (row) { assert.strictEqual(row.status, 'active', 'recompute does not auto-pause a forced sender'); return setSender(c, { health_score: 10, next_send_at: null }); })
      .then(function () { return tick(c, 73 * HOUR); }).then(function (r) { assert.strictEqual(r.sent, 0, 'override expired: protection applies again'); })
      .then(function () { return c.senders.update(c.a, c.sid, { force_continue: false }); }).then(function (s) { assert.strictEqual(s.force_active, false); assert.strictEqual(s.force_until, null); });
  });
});
h.test('an auto-pause still happens when a sender is NOT forced and falls below its own floor', function () {
  return setup().then(function (c) {
    return setSender(c, { protection_level: 'high' }).then(function () {
      // 30 sends, 5 bounce notices: 100 - 5/30*600 => 0, far under every floor
      var p = Promise.resolve();
      for (var i = 0; i < 30; i++) p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, kind, step_no, sent_at, created_at) VALUES (?,?,'out','sent','email',0,?,?)", [c.a, c.sid, c.clock.t - HOUR, c.clock.t - HOUR]); });
      for (var j = 0; j < 5; j++) p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, sender_id, direction, status, kind, error_class, created_at) VALUES (?,?,'in','received','bounce','hard',?)", [c.a, c.sid, c.clock.t - HOUR]); });
      return p;
    }).then(function () { return senderHealth.recompute(c.db, c.sid, c.clock.t); })
      .then(function () { return c.db.get('SELECT status FROM senders WHERE id = ?', [c.sid]); })
      .then(function (row) { assert.strictEqual(row.status, 'paused'); });
  });
});

h.group('v1.8 reply detection switch and per-person reply handling');
h.test('with reply detection off the sender is no longer held back by a stale mailbox sync (requireReplyTracking)', function () {
  var t = TUE_10;
  var stale = { imap_host: 'imap.gmail.com', imap_last_uid: null, sync_error: null, last_sync_at: null, reply_detection: 1 };
  assert.strictEqual(sendEngine.trackingOk(stale, t, true), false);
  assert.strictEqual(sendEngine.trackingOk(Object.assign({}, stale, { reply_detection: 0 }), t, true), true);
});
h.test('a reply stops follow-ups ONLY for the person who replied; everyone else keeps going', function () {
  return setup().then(function (c) {
    return launch(c, 3).then(function () {
      return c.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.next_send_at, cl.lead_id, 1 AS stop_on_reply, l.email AS lead_email, 1 AS user_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY cl.id');
    }).then(function (rows) {
      return c.db.transaction(function (tx) { return c.sync._applyReply(tx, rows[0], false, c.clock.t, true); }).then(function () { return c.db.all('SELECT status FROM campaign_leads ORDER BY id'); })
        .then(function (st) { assert.deepStrictEqual(st.map(function (x) { return x.status; }), ['replied', 'active', 'active']); });
    });
  });
});
h.test('reply detection off: a normal reply does not stop follow-ups, a "stop campaign" request still does', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      return c.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.next_send_at, cl.lead_id, c.user_id, 1 AS stop_on_reply, l.email AS lead_email FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id JOIN leads l ON l.id = cl.lead_id ORDER BY cl.id');
    }).then(function (rows) {
      return c.db.transaction(function (tx) { return c.sync._applyReply(tx, rows[0], false, c.clock.t, false); })
        .then(function () { return c.db.get('SELECT status FROM campaign_leads WHERE id = ?', [rows[0].id]); })
        .then(function (r) { assert.strictEqual(r.status, 'active', 'normal reply ignored while detection is off'); return c.db.transaction(function (tx) { return c.sync._applyReply(tx, rows[0], true, c.clock.t, false); }); })
        .then(function () { return Promise.all([c.db.get('SELECT status FROM campaign_leads WHERE id = ?', [rows[0].id]), c.db.get('SELECT status FROM campaign_leads WHERE id = ?', [rows[1].id]), c.db.get('SELECT COUNT(*) AS n FROM suppression')]); })
        .then(function (r) { assert.strictEqual(r[0].status, 'unsubscribed', 'legal opt-out always honoured'); assert.strictEqual(r[1].status, 'active'); assert.strictEqual(r[2].n, 1); });
    });
  });
});
h.test('starting a campaign warns when a sender has reply detection off', function () {
  return setup().then(function (c) {
    return c.senders.update(c.a, c.sid, { imap_host: 'imap.gmail.com', reply_detection: false }).catch(function () { return null; }).then(function () { return setSender(c, { imap_host: 'imap.gmail.com', reply_detection: 0 }); })
      .then(function () { return launch(c, 2); }).then(function (r) { assert.ok(r.warnings.some(function (w) { return w.code === 'reply_detection_off'; }), JSON.stringify(r.warnings)); });
  });
});

h.group('v1.8 send priority');
h.test('followups_first / new_first / balanced decide who goes next when both are due', function () {
  function run(mode, expectStep) {
    return setup().then(function (c) {
      return launch(c, 2).then(function () {
        return c.db.run('INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)', [c.a, 1]);
      }).then(function () {
        return c.db.run('UPDATE user_settings SET prefs = ? WHERE user_id = ?', [JSON.stringify({ priority_mode: mode }), c.a]);
      }).then(function () {
        return c.db.all('SELECT id FROM campaign_leads ORDER BY id');
      }).then(function (ids) {
        // person 0: follow-up due 1 hour ago (step 1); person 1: first email due 2 hours ago (older)
        return c.db.run('UPDATE campaign_leads SET current_step = 1, next_send_at = ? WHERE id = ?', [c.clock.t - HOUR, ids[0].id])
          .then(function () { return c.db.run('UPDATE campaign_leads SET current_step = 0, next_send_at = ? WHERE id = ?', [c.clock.t - 2 * HOUR, ids[1].id]); })
          .then(function () { return tick(c); })
          .then(function () { return c.db.get("SELECT step_no FROM messages WHERE direction = 'out' ORDER BY id LIMIT 1"); })
          .then(function (m) { assert.strictEqual(m.step_no, expectStep, mode); });
      });
    });
  }
  return run('followups_first', 1).then(function () { return run('new_first', 0); }).then(function () { return run('balanced', 0); });
});
h.test('priority is a system preference: validated, defaults to follow-ups first, and campaigns no longer carry it', function () {
  var Settings = require('../src/services/settings').SettingsService;
  return setup().then(function (c) {
    var svc = new Settings(c.db);
    return svc.get(c.a).then(function (r) {
      assert.strictEqual(r.settings.prefs.priority_mode, 'followups_first');
      return h.expectReject(svc.update(c.a, { prefs: { priority_mode: 'whenever' } }), 'validation');
    }).then(function () { return svc.update(c.a, { prefs: { priority_mode: 'new_first' } }); })
      .then(function () { return svc.get(c.a); }).then(function (r) {
        assert.strictEqual(r.settings.prefs.priority_mode, 'new_first');
        return launch(c, 1, { priority_mode: 'balanced' }, false);
      }).then(function (camp) { assert.strictEqual(camp.settings.priority_mode, undefined, 'a campaign has no priority of its own'); });
  });
});

h.group('v1.8 scheduled start');
h.test('start date: validated in the campaign time zone, first email waits for the first sending hour of that day', function () {
  return setup().then(function (c) {
    return h.expectReject(launch(c, 1, { start_date: '2026-11-09' }, false), 'validation')
      .then(function () { return h.expectReject(launch(c, 1, { start_date: '11/12/2026' }, false), 'validation'); })
      .then(function () { return h.expectReject(launch(c, 1, { start_date: '2027-06-01' }, false), 'validation'); })
      .then(function () { return launch(c, 3, { start_date: '2026-11-12' }, false); })
      .then(function (camp) {
        assert.strictEqual(camp.settings.start_date, '2026-11-12'); assert.strictEqual(camp.settings.start_at, Date.UTC(2026, 10, 12, 9, 0, 0));
        return c.camps.start(c.a, camp.id);
      }).then(function () { return c.db.all('SELECT next_send_at FROM campaign_leads'); })
      .then(function (rows) {
        rows.forEach(function (r) { assert.strictEqual(r.next_send_at, Date.UTC(2026, 10, 12, 9, 0, 0)); });
        return tick(c);
      }).then(function (r) { assert.strictEqual(r.sent, 0, 'nothing goes out before the start date');
        c.clock.t = Date.UTC(2026, 10, 12, 9, 30, 0); return c.engine.tick();
      }).then(function (r) { assert.strictEqual(r.sent, 1, 'it begins on the start date'); });
  });
});
h.test('the start date follows the time zone; it can be cleared or changed before start, never after', function () {
  return setup().then(function (c) {
    return launch(c, 2, { start_date: '2026-11-12', utc_offset_min: 120 }, false).then(function (camp) {
      assert.strictEqual(camp.settings.start_at, Date.UTC(2026, 10, 12, 7, 0, 0), '09:00 local at UTC+2');
      return c.camps.update(c.a, camp.id, { start_date: null }).then(function (u) { assert.strictEqual(u.settings.start_at, null); return c.camps.update(c.a, camp.id, { start_date: '2026-11-15' }); })
        .then(function (u) { assert.strictEqual(u.settings.start_date, '2026-11-15'); return c.camps.update(c.a, camp.id, { window_start_hour: 10 }); })
        .then(function (u) { assert.strictEqual(u.settings.start_date, '2026-11-15', 'same local day after an hours change'); assert.strictEqual(u.settings.start_at, Date.UTC(2026, 10, 15, 8, 0, 0)); return c.camps.start(c.a, camp.id); })
        .then(function () { return h.expectReject(c.camps.update(c.a, camp.id, { start_date: '2026-11-20' }), 'conflict'); });
    });
  });
});

h.group('v1.8 do-not-email list: sorting, filters, Unblock, Delete');
function seedSuppression(c) {
  var rows = [['b@x.com', 'manual', 3], ['a@x.com', 'unsubscribed', 1], ['d@x.com', 'bounced', 2], ['c@x.com', 'replied_stop', 5], ['e@x.com', 'complaint', 4]];
  return rows.reduce(function (p, r) { return p.then(function () { return c.db.run('INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?,?,?,?)', [c.a, r[0], r[1], r[2] * 1000]); }); }, Promise.resolve());
}
h.test('listSuppression: sort by email/reason/date both ways, group filters, search and always-true counts', function () {
  return setup().then(function (c) {
    return seedSuppression(c).then(function () { return c.leads.listSuppression(c.a, 1, 50, { sort: 'email', dir: 'asc' }); }).then(function (r) {
      assert.deepStrictEqual(r.items.map(function (x) { return x.email; }), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
      assert.deepStrictEqual(r.counts, { all: 5, unsubscribed: 2, bounced: 1, complaint: 1, manual: 1 });
      return c.leads.listSuppression(c.a, 1, 50, { sort: 'created_at', dir: 'desc' });
    }).then(function (r) { assert.strictEqual(r.items[0].email, 'c@x.com'); return c.leads.listSuppression(c.a, 1, 50, { group: 'unsubscribed', sort: 'email', dir: 'desc' }); })
      .then(function (r) { assert.deepStrictEqual(r.items.map(function (x) { return x.email; }), ['c@x.com', 'a@x.com']); assert.strictEqual(r.counts.all, 5, 'counts ignore the filter'); return c.leads.listSuppression(c.a, 1, 50, { group: 'manual' }); })
      .then(function (r) { assert.strictEqual(r.total, 1); return c.leads.listSuppression(c.a, 1, 50, { q: 'd@' }); })
      .then(function (r) { assert.strictEqual(r.total, 1); assert.strictEqual(r.items[0].email, 'd@x.com'); return h.expectReject(c.leads.listSuppression(c.a, 1, 50, { group: 'zzz' }), 'validation'); });
  });
});
h.test('Unblock removes the block in bulk, keeps the lead, and sends a bounced address back to "unverified"', function () {
  return setup().then(function (c) {
    return c.leads.createFolder(c.a, 'F').then(function (f) { return c.leads.importLeads(c.a, f.id, 'paste', 'd@x.com\na@x.com'); })
      .then(function () { return c.db.run("UPDATE leads SET verify_status = 'invalid', verify_error = 'hard_bounce' WHERE email = 'd@x.com'"); })
      .then(function () { return seedSuppression(c); })
      .then(function () { return c.leads.removeSuppression(c.a, { emails: ['d@x.com', 'a@x.com', 'nobody@x.com', 'D@X.COM'] }); })
      .then(function (r) {
        assert.strictEqual(r.removed, 2); assert.strictEqual(r.needs_recheck, 1);
        return Promise.all([c.db.get('SELECT COUNT(*) AS n FROM suppression'), c.db.get("SELECT verify_status FROM leads WHERE email = 'd@x.com'"), c.db.get("SELECT COUNT(*) AS n FROM leads")]);
      }).then(function (r) { assert.strictEqual(r[0].n, 3); assert.strictEqual(r[1].verify_status, 'unverified'); assert.strictEqual(r[2].n, 2, 'leads are kept');
        return h.expectReject(c.leads.removeSuppression(c.a, { emails: [] }), 'validation'); });
  });
});
h.test('Delete is permanent: block and the lead are erased, except people who are inside a campaign', function () {
  return setup().then(function (c) {
    return launch(c, 2).then(function () {
      return c.leads.importLeads(c.a, c.folder.id, 'paste', 'gone@x.com');
    }).then(function () { return c.db.run("INSERT INTO suppression (user_id, email, reason, created_at) VALUES (?, 'gone@x.com', 'manual', 1), (?, 'p0@co0.com', 'manual', 2)", [c.a, c.a]); })
      .then(function () { return c.leads.deleteSuppression(c.a, { emails: ['gone@x.com', 'p0@co0.com'] }); })
      .then(function (r) {
        assert.strictEqual(r.deleted, 2); assert.strictEqual(r.leads_deleted, 1); assert.strictEqual(r.kept_in_campaigns, 1);
        return Promise.all([c.db.get("SELECT COUNT(*) AS n FROM leads WHERE email = 'gone@x.com'"), c.db.get("SELECT COUNT(*) AS n FROM leads WHERE email = 'p0@co0.com'"), c.db.get('SELECT COUNT(*) AS n FROM suppression')]);
      }).then(function (r) { assert.strictEqual(r[0].n, 0); assert.strictEqual(r[1].n, 1); assert.strictEqual(r[2].n, 0); });
  });
});
h.test('another user cannot unblock or delete my entries (user-scoped)', function () {
  return setup().then(function (c) {
    return seedSuppression(c).then(function () { return h.mkUser(c.db, 'b@x.com'); }).then(function (b) {
      return c.leads.removeSuppression(b, { emails: ['a@x.com'] }).then(function (r) { assert.strictEqual(r.removed, 0); return c.leads.deleteSuppression(b, { emails: ['a@x.com'] }); });
    }).then(function (r) { assert.strictEqual(r.deleted, 0); return c.db.get('SELECT COUNT(*) AS n FROM suppression'); }).then(function (r) { assert.strictEqual(r.n, 5); });
  });
});

h.group('v1.8 lead status filter');
h.test('status accepts a comma group (risky + catch-all) and rejects unknown values', function () {
  return setup().then(function (c) {
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      c.f = f; return c.leads.importLeads(c.a, f.id, 'paste', 'a@x.com\nb@x.com\nc@x.com\nd@x.com');
    }).then(function () {
      return c.db.run("UPDATE leads SET verify_status = CASE email WHEN 'a@x.com' THEN 'valid' WHEN 'b@x.com' THEN 'risky' WHEN 'c@x.com' THEN 'catch_all' ELSE 'invalid' END");
    }).then(function () { return c.leads.listLeads(c.a, c.f.id, { status: 'risky,catch_all' }); }).then(function (r) {
      assert.strictEqual(r.total, 2); return c.leads.listLeads(c.a, c.f.id, { status: 'invalid' });
    }).then(function (r) { assert.strictEqual(r.total, 1); return h.expectReject(c.leads.listLeads(c.a, c.f.id, { status: 'risky,hax' }), 'validation'); });
  });
});

h.group('v1.8 campaign People: sort, risky filter, history-preserving removal');
h.test('people sorting is whitelisted; sort by email/status works both ways', function () {
  return setup().then(function (c) {
    return launch(c, 4).then(function () { return c.camps.listLeads(c.a, c.camp.id, { sort: 'email', dir: 'desc' }); }).then(function (r) {
      assert.deepStrictEqual(r.items.map(function (x) { return x.email; }), ['p3@co3.com', 'p2@co2.com', 'p1@co1.com', 'p0@co0.com']);
      return c.camps.listLeads(c.a, c.camp.id, { sort: 'opens', dir: 'asc' });
    }).then(function (r) { assert.strictEqual(r.items.length, 4); return c.camps.listLeads(c.a, c.camp.id, { sort: 'replied', dir: 'desc' }); })
      .then(function () { return h.expectReject(c.camps.listLeads(c.a, c.camp.id, { sort: 'password_enc; DROP TABLE leads' }), 'validation'); });
  });
});
h.test('risky filter + counts; bulk-removing bounced people hides them but keeps status, messages and analytics', function () {
  return setup().then(function (c) {
    return launch(c, 4).then(function () { return c.db.all('SELECT cl.id, l.id AS lid FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id ORDER BY cl.id'); }).then(function (rows) {
      c.rows = rows;
      return c.db.run("UPDATE leads SET verify_status = 'risky' WHERE id = ?", [rows[0].lid])
        .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'bounced', next_send_at = NULL WHERE id IN (?, ?)", [rows[1].id, rows[2].id]); })
        .then(function () { return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, sender_id, lead_id, direction, status, kind, step_no, sent_at, created_at) VALUES (?,?,?,?,'out','sent','email',0,?,?)", [c.a, rows[1].id, c.sid, rows[1].lid, c.clock.t, c.clock.t]); })
        .then(function () { return c.camps.listLeads(c.a, c.camp.id, { risk: 'risky' }); });
    }).then(function (r) {
      assert.strictEqual(r.total, 1); assert.strictEqual(r.items[0].verify_status, 'risky'); assert.strictEqual(r.counts.risky, 1); assert.strictEqual(r.counts.bounced, 2); assert.strictEqual(r.counts.all, 4);
      return c.camps.bulkLeads(c.a, c.camp.id, { action: 'remove', ids: [c.rows[1].id, c.rows[2].id] });
    }).then(function (r) {
      assert.strictEqual(r.done.length, 2); assert.strictEqual(r.skipped.length, 0);
      return Promise.all([c.camps.listLeads(c.a, c.camp.id, { status: 'bounced' }), c.camps.listLeads(c.a, c.camp.id, {}), c.db.all('SELECT status, removed_at FROM campaign_leads WHERE id IN (?, ?)', [c.rows[1].id, c.rows[2].id]),
        c.db.get("SELECT COUNT(*) AS n FROM messages WHERE campaign_lead_id = ?", [c.rows[1].id]), c.camps.get(c.a, c.camp.id)]);
    }).then(function (r) {
      assert.strictEqual(r[0].total, 0, 'hidden from the list'); assert.strictEqual(r[1].total, 2); assert.strictEqual(r[1].counts.all, 2, 'counts match what is listed');
      r[2].forEach(function (x) { assert.strictEqual(x.status, 'bounced', 'status untouched'); assert.ok(x.removed_at); });
      assert.strictEqual(r[3].n, 1, 'message history kept'); assert.strictEqual(r[4].stats.bounced, 2, 'campaign analytics keep the bounces');
    });
  });
});

h.test('Home health: dismissed alerts are stored per user, validated, separate from reviewed ones', function () {
  var SettingsService = require('../src/services/settings').SettingsService;
  return setup().then(function (c) {
    var svc = new SettingsService(c.db);
    return h.expectReject(svc.setHealthDismissed(c.a, ['nope']), 'validation').then(function () { return svc.setHealthDismissed(c.a, ['p:1:bounce']); })
      .then(function (r) { assert.deepStrictEqual(r.health_dismissed, ['p:1:bounce']); return svc.get(c.a); })
      .then(function (r) { assert.deepStrictEqual(r.settings.health_dismissed, ['p:1:bounce']); assert.deepStrictEqual(r.settings.health_seen, []); return svc.setHealthDismissed(c.a, []); })
      .then(function () { return svc.get(c.a); }).then(function (r) { assert.deepStrictEqual(r.settings.health_dismissed, []); });
  });
});

h.test('Home health: reviewed alert keys are stored per user, validated, and only the keys sent are kept', function () {
  var SettingsService = require('../src/services/settings').SettingsService;
  return setup().then(function (c) {
    var st = new SettingsService(c.db, { now: function () { return c.clock.t; } });
    return st.get(c.a).then(function (r) {
      assert.deepStrictEqual(r.settings.health_seen, []);
      return st.setHealthSeen(c.a, ['p:1:bounce', 's:2:err', 'p:1:bounce']);
    }).then(function (r) {
      assert.deepStrictEqual(r.health_seen, ['p:1:bounce', 's:2:err']);
      return st.setHealthSeen(c.a, ['s:2:err']);
    }).then(function () { return st.get(c.a); }).then(function (r) {
      assert.deepStrictEqual(r.settings.health_seen, ['s:2:err'], 'resolved alerts drop off so a returning problem is new again');
      return h.expectReject(st.setHealthSeen(c.a, ["x'; DROP TABLE users;--"]), 'validation');
    }).then(function () { return h.expectReject(st.setHealthSeen(c.a, 'nope'), 'validation'); })
      .then(function () { return c.db.get("SELECT 1 AS x FROM user_settings WHERE user_id = ?", [c.a]); })
      .then(function (r) { assert.ok(r); });
  });
});

h.run();
