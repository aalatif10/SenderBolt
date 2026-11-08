'use strict';
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var tpl = require('../src/lib/template');
var split = require('../src/lib/split');
var Leads = require('../src/services/leads').Leads;
var Senders = require('../src/services/senders').Senders;
var CampaignsService = require('../src/services/campaigns').CampaignsService;

var STEPS = [
  { subject: 'Quick question about {{company|your domain}}', body_html: '<p>Hi {{first_name|there}},</p><p>{Interested|Curious} in selling?</p>' },
  { subject: '', body_html: '<p>Following up, {{first_name|there}}.</p>', delay_days: 3 },
  { subject: 'Last note', body_html: '<p>Final follow-up.</p>', delay_days: 5 }
];
function steps() { return JSON.parse(JSON.stringify(STEPS)); }

function setup() {
  return h.freshDb().then(function (db) {
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var leads = new Leads(db), senders = new Senders(db, key), camps = new CampaignsService(db);
    return h.mkUser(db, 'a@x.com').then(function (a) {
      return h.mkUser(db, 'b@x.com').then(function (b) {
        var c = { db: db, leads: leads, senders: senders, camps: camps, a: a, b: b, sids: [] };
        function mkSender(i) {
          return senders.create(a, { label: 'S' + i, email: 's' + i + '@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' }).then(function (s) { c.sids.push(s.id); });
        }
        return mkSender(1).then(function () { return mkSender(2); }).then(function () { return c; });
      });
    });
  });
}
// Import n leads (plus shared-company contacts) into a new folder; returns folder id.
function folderWith(c, userId, name, emails) {
  return c.leads.createFolder(userId, name).then(function (f) {
    return c.leads.importLeads(userId, f.id, 'paste', emails.join('\n')).then(function () { return f.id; });
  });
}
function manyEmails(n, tag) {
  var out = [];
  for (var i = 0; i < n; i++) out.push('u' + i + '@' + (tag || 'co') + i + '.com');
  return out;
}
function base(c, folder, extra) {
  return Object.assign({ name: 'Domain outreach', steps: steps(), sender_ids: [c.sids[0]], folder_id: folder }, extra || {});
}

h.group('template engine');
h.test('variables, fallbacks, html escaping, spintax, missing list', function () {
  var vars = { first_name: 'Ann', company: '' };
  var r = tpl.render('Hi {{first_name}} at {{company|your company}} {{ 9bad }} {{x_y|}}', vars, { html: true });
  assert.strictEqual(r.text, 'Hi Ann at your company {{ 9bad }} ');          // invalid names stay literal; empty fallback renders nothing
  assert.deepStrictEqual(tpl.render('{{ spaced }}', {}, { html: true }).missing, ['spaced']);
  var r2 = tpl.render('Hi {{first_name}} {{last_name}}', vars, { html: true });
  assert.deepStrictEqual(r2.missing, ['last_name']);
  assert.strictEqual(tpl.render('{{first_name}}', { first_name: '<script>alert(1)</script>' }, { html: true }).text, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(tpl.render('x{{a}}', { a: ' ' }, { html: true, }).missing[0], 'a');
});
h.test('values are never re-scanned; subject mode strips line breaks (no header injection)', function () {
  assert.strictEqual(tpl.render('{{a}}', { a: '{{b}} {x|y}' }, { html: true, rnd: function () { return 0; } }).text, '{{b}} {x|y}');
  var subj = tpl.render('Hello {{first_name}}', { first_name: 'Bob\r\nBcc: evil@x.com' }, { html: false }).text;
  assert.ok(subj.indexOf('\n') === -1 && subj.indexOf('\r') === -1);
});
h.test('spintax is seedable; CSS braces and prototype keys are safe', function () {
  var a = tpl.render('{A|B|C} {D|E}', {}, { rnd: split.mulberry32(3) }).text, b = tpl.render('{A|B|C} {D|E}', {}, { rnd: split.mulberry32(3) }).text;
  assert.strictEqual(a, b);
  assert.strictEqual(tpl.render('<style>a{color:red}</style>', {}, { html: true }).text, '<style>a{color:red}</style>');
  assert.deepStrictEqual(tpl.render('{{constructor}} {{__proto__}} {{hasownproperty}}', {}, { html: true }).missing, ['constructor', 'hasownproperty']);
  assert.deepStrictEqual(tpl.findVariables('{{a}} {{b|x}} {{a}}'), ['a', 'b']);
  var v = tpl.leadVars({ email: 'x@y.com', first_name: 'A', custom: '{"niche":"ai","email":"hacked@x.com","Bad Key":"z"}' });
  assert.strictEqual(v.niche, 'ai'); assert.strictEqual(v.email, 'x@y.com'); assert.strictEqual(v['Bad Key'], undefined);
});

h.group('smart split engine');
function mkLeads() {
  var l = [], i, id = 1;
  for (i = 0; i < 4; i++) l.push({ id: id++, email: 'p' + i + '@big.com' });
  for (i = 0; i < 3; i++) l.push({ id: id++, email: 'p' + i + '@mid.com' });
  for (i = 0; i < 53; i++) l.push({ id: id++, email: 'u' + i + '@solo' + i + '.com' });
  return l;
}
h.test('same-company contacts land in different batches; sizes exact; deterministic', function () {
  var leads = mkLeads(), b1 = split.splitSpread(leads, 15, 42), b2 = split.splitSpread(leads, 15, 42), b3 = split.splitSpread(leads, 15, 43);
  assert.deepStrictEqual(b1.map(function (b) { return b.length; }), [15, 15, 15, 15]);
  assert.strictEqual(split.countConflicts(b1), 0);
  assert.deepStrictEqual(b1, b2);
  assert.notDeepStrictEqual(b1, b3);
  var all = [].concat.apply([], b1).map(function (x) { return x.id; }).sort(function (x, y) { return x - y; });
  assert.deepStrictEqual(all, leads.map(function (x) { return x.id; }));          // nothing lost or duplicated
});
h.test('remainder batch and unavoidable conflicts are handled', function () {
  var leads = []; for (var i = 0; i < 80; i++) leads.push({ id: i + 1, email: 'u' + i + '@d' + i + '.com' });
  assert.deepStrictEqual(split.splitSpread(leads, 26, 1).map(function (b) { return b.length; }), [26, 26, 26, 2]);
  var crowd = []; for (var j = 0; j < 6; j++) crowd.push({ id: j + 1, email: 'p' + j + '@same.com' });
  for (j = 0; j < 6; j++) crowd.push({ id: 10 + j, email: 'q' + j + '@o' + j + '.com' });
  assert.strictEqual(split.countConflicts(split.splitSpread(crowd, 3, 5)), 6 - 4);   // 6 contacts, 4 batches: minimum is 2
});

h.group('campaigns: create and split');
h.test('single campaign: eligibility rules (invalid, suppressed, roles, other users)', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', ['a@good.com', 'b@good.com', 'c@good.com', 'info@good.com', 'bad@good.com']).then(function (f) {
      return c.db.run("UPDATE leads SET verify_status = 'invalid' WHERE email = 'bad@good.com'").then(function () { return c.leads.addSuppression(c.a, ['c@good.com']); })
        .then(function () { return c.camps.create(c.a, base(c, f, { exclude_role: true })); })
        .then(function (camp) {
          assert.strictEqual(camp.status, 'draft'); assert.strictEqual(camp.stats.total, 2); assert.strictEqual(camp.is_split, false);
          assert.strictEqual(camp.steps.length, 3); assert.strictEqual(camp.steps[1].subject, ''); assert.strictEqual(camp.steps[1].delay_days, 3);
          assert.strictEqual(camp.senders.length, 1);
          return c.camps.create(c.a, base(c, f, { name: 'With roles', skip_in_active: false }));
        }).then(function (camp2) { assert.strictEqual(camp2.stats.total, 3); });      // a, b, info (invalid + suppressed still excluded)
    });
  });
});
h.test('validation: steps, settings, senders, source', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', ['a@good.com']).then(function (f) {
      function bad(patch, field) { return h.expectReject(c.camps.create(c.a, Object.assign(base(c, f), patch)), 'validation').then(function (e) { assert.ok(e.details[field], field + ' expected: ' + JSON.stringify(e.details)); }); }
      var seven = []; for (var i = 0; i < 7; i++) seven.push({ subject: 's', body_html: 'b', delay_days: 1 });
      return bad({ name: '   ' }, 'name')
        .then(function () { return bad({ steps: [] }, 'steps'); })
        .then(function () { return bad({ steps: seven }, 'steps'); })
        .then(function () { return bad({ steps: [{ subject: 'Hi\r\nBcc: evil@x.com', body_html: 'b' }] }, 'steps'); })
        .then(function () { return bad({ steps: [{ subject: '', body_html: 'b' }] }, 'steps'); })
        .then(function () { return bad({ steps: [{ subject: 's', body_html: 'b' }, { subject: '', body_html: 'x', delay_days: 99 }] }, 'steps'); })
        .then(function () { return bad({ steps: [{ subject: 's', body_html: '   ' }] }, 'steps'); })
        .then(function () { return bad({ sender_ids: [] }, 'sender_ids'); })
        .then(function () { return bad({ sender_ids: [99999] }, 'sender_ids'); })
        .then(function () { return bad({ sender_ids: ['1; DROP TABLE senders'] }, 'sender_ids'); })
        .then(function () { return bad({ window_start_hour: 18, window_end_hour: 9 }, 'window_end_hour'); })
        .then(function () { return bad({ utc_offset_min: 5000 }, 'utc_offset_min'); })
        .then(function () { return bad({ lead_statuses: ['valid', 'x'] }, 'lead_statuses'); })
        .then(function () { return bad({ split: { batch_size: 0 } }, 'batch_size'); })
        .then(function () { return bad({ split: { batch_size: 10, seed: -1 } }, 'seed'); })
        .then(function () { return bad({ folder_id: undefined }, 'folder_id'); });
    });
  });
});
h.test('cross-user isolation: folders, senders, campaigns', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', ['a@good.com']).then(function (f) {
      return c.senders.create(c.b, { label: 'B', email: 'bb@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' }).then(function (bs) {
        return h.expectReject(c.camps.create(c.b, base(c, f, { sender_ids: [bs.id] })), 'not_found')              // B using A's folder
          .then(function () { return h.expectReject(c.camps.create(c.a, base(c, f, { sender_ids: [bs.id] })), 'validation'); })   // A using B's sender
          .then(function () { return c.camps.create(c.a, base(c, f)); })
          .then(function (camp) {
            return h.expectReject(c.camps.get(c.b, camp.id), 'not_found')
              .then(function () { return h.expectReject(c.camps.start(c.b, camp.id), 'not_found'); })
              .then(function () { return h.expectReject(c.camps.update(c.b, camp.id, { name: 'x' }), 'not_found'); })
              .then(function () { return h.expectReject(c.camps.remove(c.b, camp.id), 'not_found'); })
              .then(function () { return h.expectReject(c.camps.listLeads(c.b, camp.id), 'not_found'); })
              .then(function () { return c.camps.list(c.b); }).then(function (l) { assert.strictEqual(l.total, 0); });
          });
      });
    });
  });
});
h.test('Smart Split: 80 leads by 26 gives 26/26/26/2, sequence replicated, companies separated', function () {
  return setup().then(function (c) {
    var emails = [], i;
    for (i = 0; i < 4; i++) emails.push('p' + i + '@big.com');
    for (i = 0; i < 76; i++) emails.push('u' + i + '@solo' + i + '.com');
    return folderWith(c, c.a, 'F', emails).then(function (f) {
      return c.camps.previewSplit(c.a, { folder_id: f, batch_size: 26, seed: 99 }).then(function (pv) {
        assert.deepStrictEqual(pv.sizes, [26, 26, 26, 2]); assert.strictEqual(pv.total, 80); assert.strictEqual(pv.same_company_in_one_batch, 0);
        return c.camps.create(c.a, base(c, f, { split: { batch_size: 26, seed: 99 } }));
      }).then(function (camp) {
        assert.strictEqual(camp.is_split, true); assert.strictEqual(camp.parts.length, 4); assert.strictEqual(camp.split_seed, 99);
        assert.deepStrictEqual(camp.parts.map(function (p) { return p.stats.total; }), [26, 26, 26, 2]);
        assert.strictEqual(camp.stats.total, 80);
        assert.ok(/ - Part 1\/4$/.test(camp.parts[0].name));
        return c.db.all('SELECT campaign_id, COUNT(*) AS n FROM campaign_steps GROUP BY campaign_id').then(function (rows) {
          assert.strictEqual(rows.length, 5); rows.forEach(function (r) { assert.strictEqual(r.n, 3); });          // main + 4 parts all hold the sequence
          return c.db.get('SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ?', [camp.id]);
        }).then(function (r) {
          assert.strictEqual(r.n, 0);                                                                              // main itself holds no leads
          return c.db.all("SELECT cl.campaign_id AS cid FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.domain = 'big.com'");
        }).then(function (rows) {
          var distinct = {}; rows.forEach(function (x) { distinct[x.cid] = true; });
          assert.strictEqual(Object.keys(distinct).length, 4);                                                      // 4 big.com contacts in 4 different parts
          return c.db.get('SELECT COUNT(*) AS n FROM campaign_senders');
        }).then(function (r) { assert.strictEqual(r.n, 5); });
      });
    });
  });
});
h.test('same seed reproduces the same split; batch larger than list means no split', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(40)).then(function (f) {
      return c.camps._plan(c.a, { folder_id: f }, { batch_size: 10, seed: 5 }).then(function (p1) {
        return c.camps._plan(c.a, { folder_id: f }, { batch_size: 10, seed: 5 }).then(function (p2) {
          assert.deepStrictEqual(p1.batches, p2.batches);
          return c.camps._plan(c.a, { folder_id: f }, { batch_size: 10, seed: 6 }).then(function (p3) { assert.notDeepStrictEqual(p1.batches, p3.batches); });
        });
      }).then(function () { return c.camps.create(c.a, base(c, f, { split: { batch_size: 500 } })); })
        .then(function (camp) { assert.strictEqual(camp.is_split, false); assert.strictEqual(camp.stats.total, 40); return h.expectReject(c.camps.previewSplit(c.a, { folder_id: f, batch_size: 0 }), 'validation'); });
    });
  });
});
h.test('specific lead ids as the source; no eligible leads is a clear error', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', ['a@good.com', 'b@good.com', 'c@good.com']).then(function (f) {
      return c.db.all('SELECT id FROM leads ORDER BY id').then(function (rows) {
        return c.camps.create(c.a, { name: 'Picked', steps: steps(), sender_ids: [c.sids[0]], lead_ids: [rows[0].id, rows[2].id, rows[2].id, 99999] });
      }).then(function (camp) {
        assert.strictEqual(camp.stats.total, 2);
        return h.expectReject(c.camps.create(c.a, { name: 'Empty', steps: steps(), sender_ids: [c.sids[0]], lead_ids: [99999] }), 'validation');
      });
    });
  });
});

h.group('campaigns: start, pause, resume, delete');
h.test('start assigns senders round-robin, re-checks suppression, sets schedule and estimate', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(10)).then(function (f) {
      return c.camps.create(c.a, base(c, f, { sender_ids: c.sids })).then(function (camp) {
        return c.leads.addSuppression(c.a, ['u3@co3.com']).then(function () { return c.camps.start(c.a, camp.id); });   // unsubscribed AFTER creation
      }).then(function (started) {
        assert.strictEqual(started.status, 'active');
        assert.strictEqual(started.stats.unsubscribed, 1); assert.strictEqual(started.stats.active, 9);
        assert.ok(started.stats.next_send_at > 0);
        assert.strictEqual(started.estimate.emails_total_max, 9 * 3);
        assert.ok(started.estimate.daily_capacity >= 100);
        return c.db.all("SELECT sender_id, COUNT(*) AS n FROM campaign_leads WHERE status = 'active' GROUP BY sender_id");
      }).then(function (rows) {
        assert.strictEqual(rows.length, 2); assert.ok(Math.abs(rows[0].n - rows[1].n) <= 1);                             // evenly shared between 2 senders
        return c.db.get("SELECT COUNT(*) AS n FROM campaign_leads WHERE status = 'active' AND sender_id IS NULL");
      }).then(function (r) { assert.strictEqual(r.n, 0); });
    });
  });
});
h.test('start guards: only drafts, paused or foreign senders blocked', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(4)).then(function (f) {
      return c.camps.create(c.a, base(c, f, { sender_ids: c.sids })).then(function (camp) {
        return c.senders.setStatus(c.a, c.sids[1], 'paused').then(function () { return h.expectReject(c.camps.start(c.a, camp.id), 'validation'); })
          .then(function () { return c.senders.setStatus(c.a, c.sids[1], 'active'); })
          .then(function () { return c.camps.start(c.a, camp.id); })
          .then(function () { return h.expectReject(c.camps.start(c.a, camp.id), 'conflict'); })
          .then(function () { return h.expectReject(c.senders.remove(c.a, c.sids[0]), 'conflict'); });                   // sender in an active campaign cannot be deleted
      });
    });
  });
});
h.test('pause/resume/delete on a split campaign affect all parts and the derived status', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(30)).then(function (f) {
      return c.camps.create(c.a, base(c, f, { split: { batch_size: 10, seed: 1 } })).then(function (camp) {
        return h.expectReject(c.camps.pause(c.a, camp.id), 'conflict')
          .then(function () { return c.camps.start(c.a, camp.id); })
          .then(function (s) { assert.strictEqual(s.status, 'active'); assert.ok(s.parts.every(function (p) { return p.status === 'active'; })); return h.expectReject(c.camps.remove(c.a, camp.id), 'conflict'); })
          .then(function () { return c.camps.pause(c.a, camp.id); })
          .then(function (p) { assert.strictEqual(p.status, 'paused'); assert.strictEqual(p.stats.next_send_at, null); return c.camps.resume(c.a, camp.id); })
          .then(function (r) {
            assert.strictEqual(r.status, 'active');
            return c.camps.pause(c.a, r.parts[0].id);                                          // pause only one part
          }).then(function () { return c.camps.get(c.a, camp.id); })
          .then(function (m) { assert.strictEqual(m.status, 'active'); assert.strictEqual(m.parts[0].status, 'paused'); return h.expectReject(c.camps.update(c.a, camp.id, { steps: steps() }), 'conflict'); })
          .then(function () { return h.expectReject(c.camps.remove(c.a, camp.parts[0].id), 'validation'); })   // parts cannot be deleted alone
          .then(function () { return c.camps.pause(c.a, camp.id); })
          .then(function () { return c.camps.remove(c.a, camp.id); })
          .then(function () { return c.db.get('SELECT (SELECT COUNT(*) FROM campaigns) AS c, (SELECT COUNT(*) FROM campaign_leads) AS l, (SELECT COUNT(*) FROM campaign_steps) AS s'); })
          .then(function (r) { assert.deepStrictEqual([r.c, r.l, r.s], [0, 0, 0]); });          // everything cascaded
      });
    });
  });
});
h.test('leads already in an active campaign are skipped by the next campaign', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(6)).then(function (f) {
      return c.camps.create(c.a, base(c, f)).then(function (c1) { return c.camps.start(c.a, c1.id); })
        .then(function () { return h.expectReject(c.camps.create(c.a, base(c, f, { name: 'Second' })), 'validation'); })
        .then(function () { return c.camps.create(c.a, base(c, f, { name: 'Second', skip_in_active: false })); })
        .then(function (c2) { assert.strictEqual(c2.stats.total, 6); });
    });
  });
});

h.group('campaigns: dashboard data');
h.test('list: filter counts, search, sender filter, progress, next send, aggregates', function () {
  return setup().then(function (c) {
    return Promise.all([folderWith(c, c.a, 'F1', manyEmails(20, 'a')), folderWith(c, c.a, 'F2', manyEmails(5, 'b')), folderWith(c, c.a, 'F3', manyEmails(5, 'c'))]).then(function (fs) {
      var A, B, C;
      return c.camps.create(c.a, base(c, fs[0], { name: 'Alpha launch', split: { batch_size: 10, seed: 2 }, sender_ids: [c.sids[0]] })).then(function (x) { A = x; return c.camps.start(c.a, A.id); })
        .then(function () { return c.camps.create(c.a, base(c, fs[1], { name: 'Beta draft', sender_ids: [c.sids[1]] })); }).then(function (x) { B = x; })
        .then(function () { return c.camps.create(c.a, base(c, fs[2], { name: 'Gamma paused', sender_ids: [c.sids[1]] })); })
        .then(function (x) { C = x; return c.camps.start(c.a, C.id); }).then(function () { return c.camps.pause(c.a, C.id); })
        .then(function () {
          // simulate engine activity on Alpha part 1: 3 replied, 2 completed, 7 sent emails
          return c.db.all('SELECT id FROM campaign_leads WHERE campaign_id = ? ORDER BY position', [A.parts[0].id]);
        }).then(function (cls) {
          var t = Date.now();
          return c.db.run("UPDATE campaign_leads SET status = 'replied' WHERE id IN (?,?,?)", [cls[0].id, cls[1].id, cls[2].id])
            .then(function () { return c.db.run("UPDATE campaign_leads SET status = 'completed' WHERE id IN (?,?)", [cls[3].id, cls[4].id]); })
            .then(function () {
              var p = Promise.resolve();
              for (var i = 0; i < 7; i++) (function (i) {
                p = p.then(function () { return c.db.run("INSERT INTO messages (user_id, campaign_lead_id, direction, status, created_at, sent_at) VALUES (?,?,'out','sent',?,?)", [c.a, cls[i].id, t, t]); });
              })(i);
              return p;
            });
        }).then(function () { return c.camps.list(c.a, {}); })
        .then(function (l) {
          assert.deepStrictEqual(l.counts, { all: 3, active: 1, paused: 1, completed: 0, draft: 1, error: 0 });
          var alpha = l.items.filter(function (i) { return i.name === 'Alpha launch'; })[0];
          assert.strictEqual(alpha.status, 'active'); assert.strictEqual(alpha.parts.length, 2);
          assert.strictEqual(alpha.stats.total, 20); assert.strictEqual(alpha.stats.done, 5); assert.strictEqual(alpha.stats.progress_pct, 25); assert.strictEqual(alpha.stats.sent, 7);
          assert.strictEqual(alpha.parts[0].stats.progress_pct, 50); assert.strictEqual(alpha.parts[1].stats.progress_pct, 0);   // individual vs aggregate analytics
          assert.ok(alpha.stats.next_send_at > 0);
          var gamma = l.items.filter(function (i) { return i.name === 'Gamma paused'; })[0];
          assert.strictEqual(gamma.status, 'paused'); assert.strictEqual(gamma.stats.next_send_at, null);
          return c.camps.list(c.a, { status: 'draft' });
        }).then(function (l) { assert.deepStrictEqual(l.items.map(function (i) { return i.name; }), ['Beta draft']); assert.strictEqual(l.counts.all, 3); return c.camps.list(c.a, { q: 'gam' }); })
        .then(function (l) { assert.strictEqual(l.total, 1); assert.strictEqual(l.counts.all, 1); return c.camps.list(c.a, { sender_id: String(c.sids[1]) }); })
        .then(function (l) { assert.deepStrictEqual(l.items.map(function (i) { return i.name; }).sort(), ['Beta draft', 'Gamma paused']); return h.expectReject(c.camps.list(c.a, { status: 'x; drop' }), 'validation'); })
        .then(function () { return h.expectReject(c.camps.list(c.a, { sender_id: 'abc' }), 'validation'); })
        .then(function () { return c.camps.listLeads(c.a, A.id, { status: 'replied' }); })
        .then(function (r) { assert.strictEqual(r.total, 3); assert.ok(r.items[0].sender_email); return c.camps.listLeads(c.a, A.id, { pageSize: 8, page: 3 }); })
        .then(function (r) { assert.strictEqual(r.total, 20); assert.strictEqual(r.items.length, 4); return h.expectReject(c.camps.listLeads(c.a, A.id, { status: 'bogus' }), 'validation'); });
    });
  });
});
h.test('update: rename propagates to parts; steps replicate to every part while draft', function () {
  return setup().then(function (c) {
    return folderWith(c, c.a, 'F', manyEmails(30)).then(function (f) {
      return c.camps.create(c.a, base(c, f, { split: { batch_size: 10, seed: 3 } })).then(function (camp) {
        var next = steps().slice(0, 2); next[0].subject = 'New subject';
        return c.camps.update(c.a, camp.id, { name: 'Renamed', steps: next, sender_ids: c.sids, window_start_hour: 8, window_end_hour: 12 }).then(function (u) {
          assert.strictEqual(u.name, 'Renamed'); assert.strictEqual(u.parts[2].name, 'Renamed - Part 3/3');
          assert.strictEqual(u.steps.length, 2); assert.strictEqual(u.settings.window_start_hour, 8); assert.strictEqual(u.senders.length, 2);
          return c.db.all("SELECT c.id, COUNT(DISTINCT s.id) AS steps, MAX(CASE WHEN s.step_no = 0 THEN s.subject END) AS subj, (SELECT COUNT(*) FROM campaign_senders cs WHERE cs.campaign_id = c.id) AS snd, c.window_end_hour AS we FROM campaigns c JOIN campaign_steps s ON s.campaign_id = c.id GROUP BY c.id");
        }).then(function (rows) {
          assert.strictEqual(rows.length, 4);
          rows.forEach(function (r) { assert.strictEqual(r.steps, 2); assert.strictEqual(r.subj, 'New subject'); assert.strictEqual(r.snd, 2); assert.strictEqual(r.we, 12); });
          return h.expectReject(c.camps.update(c.a, camp.id, { window_start_hour: 20, window_end_hour: 10 }), 'validation');
        }).then(function () { return c.camps.start(c.a, camp.id); })
          .then(function () { return h.expectReject(c.camps.update(c.a, camp.id, { steps: steps() }), 'conflict'); })
          .then(function () { return c.camps.update(c.a, camp.id, { name: 'Rename while running is fine' }); })
          .then(function (u) { assert.strictEqual(u.name, 'Rename while running is fine'); });
      });
    });
  });
});
h.test('template preview: sample and real lead, escaping, missing variables', function () {
  return setup().then(function (c) {
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'csv', 'email,first name,company,niche\nann@x.com,"<b>Ann</b>",,crypto\n').then(function () { return c.db.get('SELECT id FROM leads'); });
    }).then(function (lead) {
      return c.camps.previewTemplate(c.a, { subject: 'Hi {{first_name}} - {{company|your firm}}', body_html: '<p>{{first_name}} {{niche}} {{unknown}}</p>', lead_id: lead.id }).then(function (p) {
        assert.strictEqual(p.sample, false);
        assert.ok(p.subject.indexOf('your firm') !== -1);
        assert.ok(p.body_html.indexOf('&lt;b&gt;Ann&lt;/b&gt;') !== -1 && p.body_html.indexOf('crypto') !== -1);
        assert.deepStrictEqual(p.missing, ['unknown']);
        return c.camps.previewTemplate(c.a, { subject: 'Hi {{first_name}}', body_html: 'x' });
      }).then(function (s) { assert.strictEqual(s.sample, true); assert.strictEqual(s.subject, 'Hi Alex'); return h.expectReject(c.camps.previewTemplate(c.b, { subject: 's', body_html: 'b', lead_id: lead.id }), 'not_found'); });
    });
  });
});

h.run();
