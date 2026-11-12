'use strict';
// Projects: migration of existing data, hierarchy, roll-up analytics, guards and isolation.
var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var h = require('./helpers');
var database = require('../src/db');
var migrate = require('../src/db/migrate').migrate;
var vault = require('../src/lib/vault');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var ProjectsService = require('../src/services/projects').ProjectsService;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var InboxSync = require('../src/engine/inboxSync').InboxSync;

var HOUR = 3600000;
var TUE_10 = Date.UTC(2026, 10, 10, 10, 0, 0);
var STEPS = [{ subject: 'About {{company|your domain}}', body_html: '<p>Interested in selling?</p>' }, { subject: '', body_html: '<p>Following up.</p>', delay_days: 3 }];

function setup() {
  return h.freshDb().then(function (db) {
    var clock = { t: TUE_10 }, now = function () { return clock.t; };
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex')), sent = [];
    var mailer = { send: function (creds, mail) { sent.push(mail); return Promise.resolve({ messageId: mail.messageId }); }, verify: function () { return Promise.resolve(true); } };
    var box = { queue: [] };
    var mailbox = { baseline: function () { return Promise.resolve({ uidValidity: 1, lastUid: 0 }); },
      fetchSince: function (cr, st) { var m = box.queue.filter(function (x) { return x.uid > st.lastUid; }); return Promise.resolve({ uidValidity: 1, lastUid: m.length ? m[m.length - 1].uid : st.lastUid, messages: m }); } };
    var c = { db: db, clock: clock, sent: sent, box: box, leads: new Leads(db), senders: new Senders(db, key, { now: now }), camps: new CampaignsService(db, { now: now }) };
    c.projects = new ProjectsService(db, { campaigns: c.camps, now: now });
    c.engine = new SendEngine(db, { key: key, mailer: mailer, now: now, unsubSecret: 'unsub-secret-for-tests-0123456789abcdef' });
    c.sync = new InboxSync(db, { key: key, mailbox: mailbox, now: now });
    return h.mkUser(db, 'a@x.com').then(function (a) { c.a = a; return h.mkUser(db, 'b@x.com'); }).then(function (b) {
      c.b = b; return c.senders.create(c.a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}
function mk(c, name, n, extra) {
  var emails = [], i;
  for (i = 0; i < n; i++) emails.push(name.toLowerCase().replace(/\W/g, '') + i + '@co' + i + '.com');
  return c.leads.createFolder(c.a, 'F-' + name).then(function (f) {
    return c.leads.importLeads(c.a, f.id, 'paste', emails.join('\n')).then(function () {
      return c.camps.create(c.a, Object.assign({ name: name, steps: JSON.parse(JSON.stringify(STEPS)), sender_ids: [c.sid], folder_id: f.id }, extra || {}));
    });
  });
}
function armedSync(c) { return c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid]).then(function (s) { return c.sync.syncSender(s); }); }

h.group('projects: migration 004 on existing data');
h.test('existing campaigns get their own project; cap clamped to 400; triggers enforce the cap', function () {
  var dir = path.join(os.tmpdir(), 'sb-mig-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir);
  var src = path.join(__dirname, '..', 'src', 'db', 'migrations');
  fs.readdirSync(src).filter(function (f) { return f < '004'; }).forEach(function (f) { fs.copyFileSync(path.join(src, f), path.join(dir, f)); });
  return database.open(':memory:').then(function (db) {
    return migrate(db, dir).then(function () { return h.mkUser(db, 'old@x.com'); }).then(function (uid) {
      var ins = "INSERT INTO senders (user_id,label,email,provider,username,password_enc,smtp_host,smtp_port,daily_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
      return db.run(ins, [uid, 'l', 'e@x.com', 'smtp', 'u', 'p', 'h.com', 587, 500, 1, 1])
        .then(function () { return db.run("INSERT INTO campaigns (user_id, name, status, created_at, updated_at) VALUES (?, 'Old main', 'draft', 5, 5)", [uid]); })
        .then(function (m) { return db.run("INSERT INTO campaigns (user_id, parent_id, name, status, created_at, updated_at) VALUES (?, ?, 'Old part', 'draft', 5, 5)", [uid, m.lastID]); })
        .then(function () { return migrate(db); })
        .then(function (applied) { assert.deepStrictEqual(applied, ['004_projects.sql', '005_warmup.sql', '006_wizard_drafts.sql']); return Promise.all([db.get('SELECT daily_limit, warmup_days, warmup_penalty, warmup_pace FROM senders'), db.all('SELECT * FROM projects'), db.all('SELECT id, parent_id, project_id FROM campaigns ORDER BY id')]); })
        .then(function (r) {
          assert.strictEqual(r[0].daily_limit, 400); assert.deepStrictEqual([r[0].warmup_days, r[0].warmup_penalty, r[0].warmup_pace], [0, 0, 'standard'], 'old senders get safe warm-up defaults'); assert.strictEqual(r[1].length, 1); assert.strictEqual(r[1][0].name, 'Old main');
          assert.strictEqual(r[2][0].project_id, r[1][0].id); assert.strictEqual(r[2][1].project_id, null, 'parts belong through their main campaign');
          return h.expectReject(db.run('UPDATE senders SET daily_limit = 450'));
        }).then(function () { return h.expectReject(db.run(ins, [uid, 'l', 'e2@x.com', 'smtp', 'u', 'p', 'h.com', 587, 401, 1, 1])); })
        .then(function () { return db.run('UPDATE senders SET daily_limit = 400'); });
    });
  });
});

h.group('projects: hierarchy and creation');
h.test('a campaign without a project gets its own; with project_id it joins it; foreign/archived/invalid ids refused', function () {
  return setup().then(function (c) {
    return mk(c, 'Solo', 2).then(function (solo) {
      assert.ok(solo.project_id);
      return c.projects.get(c.a, solo.project_id);
    }).then(function (p) {
      assert.strictEqual(p.name, 'Solo'); assert.strictEqual(p.campaign_count, 1); assert.strictEqual(p.status, 'draft');
      return c.projects.create(c.a, { name: 'Q4 push', description: 'domains' });
    }).then(function (pj) {
      assert.strictEqual(pj.status, 'empty'); c.pj = pj.id;
      return mk(c, 'Variant A', 3, { project_id: pj.id }).then(function () { return mk(c, 'Variant B', 3, { project_id: pj.id }); });
    }).then(function () { return c.projects.get(c.a, c.pj); }).then(function (p) {
      assert.strictEqual(p.campaign_count, 2); assert.deepStrictEqual(p.campaigns.map(function (x) { return x.name; }).sort(), ['Variant A', 'Variant B']);
      return c.projects.create(c.b, { name: 'B project' });
    }).then(function (bp) {
      return h.expectReject(mk(c, 'Steal', 1, { project_id: bp.id }), 'validation')
        .then(function () { return h.expectReject(mk(c, 'Bad', 1, { project_id: 'x' }), 'validation'); })
        .then(function () { return c.projects.update(c.a, c.pj, { archived: true }); })
        .then(function () { return h.expectReject(mk(c, 'Late', 1, { project_id: c.pj }), 'validation'); })
        .then(function () { return c.camps.list(c.a, { project_id: String(c.pj) }); });
    }).then(function (l) { assert.strictEqual(l.total, 2); return h.expectReject(c.camps.list(c.a, { project_id: 'zz' }), 'validation'); });
  });
});
h.test('names validated; projects are isolated per user (IDOR)', function () {
  return setup().then(function (c) {
    return h.expectReject(c.projects.create(c.a, { name: '   ' }), 'validation').then(function () { return h.expectReject(c.projects.create(c.a, { name: 'x\u0000y' }), 'validation'); })
      .then(function () { return h.expectReject(c.projects.create(c.a, { name: 'ok', description: new Array(600).join('x') }), 'validation'); })
      .then(function () { return c.projects.create(c.a, { name: "Robert'); DROP TABLE projects;--" }); })
      .then(function (p) {
        assert.ok(p.name.indexOf('DROP') !== -1);
        return h.expectReject(c.projects.get(c.b, p.id), 'not_found').then(function () { return h.expectReject(c.projects.update(c.b, p.id, { name: 'x' }), 'not_found'); })
          .then(function () { return h.expectReject(c.projects.remove(c.b, p.id), 'not_found'); })
          .then(function () { return c.projects.list(c.b); }).then(function (l) { assert.strictEqual(l.items.length, 0); return c.projects.list(c.a); })
          .then(function (l) { assert.strictEqual(l.items.length, 1); });
      });
  });
});

h.group('projects: analytics roll-up and drill-down');
h.test('project totals equal the sum of its campaigns; drill-down shows batches and the step funnel; opens are honestly not tracked', function () {
  return setup().then(function (c) {
    return c.projects.create(c.a, { name: 'Roll' }).then(function (pj) {
      c.pj = pj.id;
      return mk(c, 'Alpha', 4, { project_id: pj.id, split: { batch_size: 2, seed: 1 } }).then(function (a) { c.alpha = a; return mk(c, 'Beta', 2, { project_id: pj.id }); });
    }).then(function (b) {
      c.beta = b;
      return c.camps.start(c.a, c.alpha.id).then(function () { return c.camps.start(c.a, c.beta.id); });
    }).then(function () { return c.db.run('UPDATE senders SET warmup_enabled = 0'); }).then(function () { return armedSync(c); }).then(function () {
      var p = Promise.resolve(), i;
      for (i = 0; i < 12; i++) p = p.then(function () { c.clock.t += HOUR / 2; return c.engine.tick(); });
      return p;
    }).then(function () {
      assert.strictEqual(c.sent.length, 6, 'all 6 first emails went out');
      var first = c.sent[0], second = c.sent[1];
      c.box.queue.push({ uid: 1, messageId: '<r1@m>', references: [], from: first.to, to: 's1@gmail.com', subject: 'Re', date: c.clock.t, text: 'Yes, interested. Call me', inReplyTo: first.messageId });
      c.box.queue.push({ uid: 2, messageId: '<r2@m>', references: [], from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', to: 's1@gmail.com', subject: 'Failure', date: c.clock.t,
        text: '550 5.1.1 user unknown', dsn: 'Final-Recipient: rfc822; ' + second.to + '\nAction: failed\nStatus: 5.1.1', inReplyTo: second.messageId });
      return c.db.get('SELECT * FROM senders WHERE id = ?', [c.sid]).then(function (s) { return c.sync.syncSender(s); });
    }).then(function () { return c.projects.get(c.a, c.pj); }).then(function (p) {
      var sum = p.campaigns.reduce(function (n, x) { return n + x.sent; }, 0);
      assert.strictEqual(p.totals.sent, sum); assert.strictEqual(p.totals.sent, 6); assert.strictEqual(p.totals.leads, 6);
      assert.strictEqual(p.totals.emailed, 6); assert.strictEqual(p.totals.replied, 1); assert.strictEqual(p.totals.sentiment.interested, 1);
      assert.strictEqual(p.totals.bounced, 1); assert.strictEqual(p.totals.reply_rate, 16.7); assert.strictEqual(p.totals.bounce_rate, 16.7);
      assert.strictEqual(p.totals.opens, null); assert.strictEqual(p.totals.opens_tracked, false);
      assert.strictEqual(p.campaigns.reduce(function (n, x) { return n + x.metrics.replied; }, 0), 1);
      assert.strictEqual(p.status, 'active');
      return c.projects.campaignAnalytics(c.a, c.alpha.id);
    }).then(function (a) {
      assert.strictEqual(a.campaign.batches, 2); assert.strictEqual(a.batches.length, 2); assert.strictEqual(a.project_id, c.pj);
      assert.strictEqual(a.batches.reduce(function (n, b) { return n + b.sent; }, 0), a.campaign.sent, 'batches add up to their campaign');
      assert.strictEqual(a.steps.length, 1); assert.strictEqual(a.steps[0].step, 0); assert.strictEqual(a.steps[0].sent, 4);
      return h.expectReject(c.projects.campaignAnalytics(c.b, c.alpha.id), 'not_found');
    }).then(function () { return c.projects.list(c.a); }).then(function (l) {
      assert.strictEqual(l.items[0].totals.sent, 6); assert.strictEqual(l.items[0].campaigns, undefined); assert.strictEqual(l.overall.projects, 1); assert.strictEqual(l.counts.active, 1);
    });
  });
});

h.group('projects: guards');
h.test('cannot archive or delete while sending; delete removes campaigns and batches', function () {
  return setup().then(function (c) {
    return c.projects.create(c.a, { name: 'G' }).then(function (pj) {
      c.pj = pj.id; return mk(c, 'Gx', 4, { project_id: pj.id, split: { batch_size: 2, seed: 2 } });
    }).then(function (camp) {
      c.camp = camp; return c.camps.start(c.a, camp.id);
    }).then(function () { return h.expectReject(c.projects.update(c.a, c.pj, { archived: true }), 'conflict'); })
      .then(function () { return h.expectReject(c.projects.remove(c.a, c.pj), 'conflict'); })
      .then(function () { return c.camps.pause(c.a, c.camp.id); })
      .then(function () { return c.projects.remove(c.a, c.pj); })
      .then(function () { return Promise.all([c.db.get('SELECT COUNT(*) AS n FROM campaigns'), c.db.get('SELECT COUNT(*) AS n FROM projects'), c.db.get('SELECT COUNT(*) AS n FROM campaign_leads')]); })
      .then(function (r) { assert.strictEqual(r[0].n, 0); assert.strictEqual(r[1].n, 0); assert.strictEqual(r[2].n, 0); });
  });
});
h.test('renaming and archiving an idle project works and archived projects leave the default list', function () {
  return setup().then(function (c) {
    return c.projects.create(c.a, { name: 'Old' }).then(function (p) {
      return c.projects.update(c.a, p.id, { name: 'Renamed', description: 'x', archived: true });
    }).then(function (p) {
      assert.strictEqual(p.name, 'Renamed'); assert.strictEqual(p.archived, true);
      return Promise.all([c.projects.list(c.a), c.projects.list(c.a, { archived: '1' })]);
    }).then(function (r) { assert.strictEqual(r[0].items.length, 0); assert.strictEqual(r[1].items.length, 1); });
  });
});

h.run();
