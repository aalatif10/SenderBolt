'use strict';
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var Leads = require('../src/services/leads').Leads;
var CampaignsService = require('../src/services/campaigns').CampaignsService;
var D = require('../src/services/drafts');

function setup() {
  return h.freshDb().then(function (db) {
    return h.mkUser(db, 'a@x.com').then(function (a) {
      return h.mkUser(db, 'b@x.com').then(function (b) {
        return { db: db, a: a, b: b, drafts: new D.DraftsService(db), camps: new CampaignsService(db), leads: new Leads(db) };
      });
    });
  });
}

h.group('wizard drafts');
h.test('normalise whitelists, sanitises html and keeps half-typed delay', function () {
  var n = D.normalise({ step: 9, name: ' My\u0000 draft ', evil: 1, steps: [{ subject: 'a\r\nBcc: x', body_html: '<p onclick=1>hi</p><script>x</script>', delay_days: '14', extra: 1 }, { delay_days: 'abc' }], sender_ids: [1, 'x', 2.5, 3], folder_id: '7', lead_statuses: ['valid', 'bogus', 'valid'], split: { enabled: 1, batch_size: 26 } });
  assert.strictEqual(n.step, 0); assert.strictEqual(n.name, 'My draft'); assert.strictEqual(n.evil, undefined);
  assert.strictEqual(n.steps[0].subject, 'a Bcc: x'); assert.strictEqual(n.steps[0].body_html, '<p>hi</p>'); assert.strictEqual(n.steps[0].delay_days, 14);
  assert.strictEqual(n.steps[1].delay_days, null); assert.deepStrictEqual(n.sender_ids, [1, 3]); assert.strictEqual(n.folder_id, 7);
  assert.deepStrictEqual(n.lead_statuses, ['valid']); assert.strictEqual(n.split.enabled, true); assert.strictEqual(n.split.batch_size, 26);
  assert.strictEqual(D.normalise(null).steps.length, 0);
  assert.strictEqual(D.normalise({ steps: [1, 2, 3, 4, 5, 6, 7, 8] }).steps.length, 6);
});
h.test('create, save with rev, conflict, list, get, delete, ownership', function () {
  return setup().then(function (c) {
    return c.drafts.create(c.a, { data: { name: 'First', steps: [{ subject: 's', body_html: '<p>x</p>' }] } }).then(function (r) {
      var d = r.draft; assert.strictEqual(d.rev, 1); assert.strictEqual(d.name, 'First');
      return c.drafts.save(c.a, d.id, { rev: 1, data: { name: 'Second' } }).then(function (r2) {
        assert.strictEqual(r2.draft.rev, 2); assert.strictEqual(r2.draft.name, 'Second');
        return h.expectReject(c.drafts.save(c.a, d.id, { rev: 1, data: { name: 'Stale' } }), 'conflict');
      }).then(function () { return h.expectReject(c.drafts.save(c.a, d.id, { data: {} }), 'validation'); })
        .then(function () { return h.expectReject(c.drafts.get(c.b, d.id), 'not_found'); })
        .then(function () { return h.expectReject(c.drafts.remove(c.b, d.id), 'not_found'); })
        .then(function () { return c.drafts.list(c.a, {}); }).then(function (l) { assert.strictEqual(l.drafts.length, 1); assert.strictEqual(l.drafts[0].name, 'Second'); return c.drafts.list(c.b, {}); })
        .then(function (l) { assert.strictEqual(l.drafts.length, 0); return c.drafts.remove(c.a, d.id); })
        .then(function () { return h.expectReject(c.drafts.get(c.a, d.id), 'not_found'); });
    });
  });
});
h.test('project must be owned; draft cap enforced', function () {
  return setup().then(function (c) {
    return c.db.run("INSERT INTO projects (user_id, name, created_at, updated_at) VALUES (?, 'P', 1, 1)", [c.b]).then(function (p) {
      return h.expectReject(c.drafts.create(c.a, { project_id: p.lastID, data: {} }), 'not_found');
    }).then(function () {
      var chain = Promise.resolve();
      for (var i = 0; i < D.MAX_DRAFTS; i++) chain = chain.then(function () { return c.drafts.create(c.a, { data: {} }); });
      return chain.then(function () { return h.expectReject(c.drafts.create(c.a, { data: {} }), 'conflict'); });
    });
  });
});
h.test('variable coverage counts leads missing a variable without a fallback', function () {
  return setup().then(function (c) {
    return c.leads.createFolder(c.a, 'F').then(function (f) {
      return c.leads.importLeads(c.a, f.id, 'csv', 'email,first name,company\nann@x.com,Ann,Acme\nbob@y.com,,\ncy@z.com,Cy,\n').then(function () {
        return c.camps.variableCoverage(c.a, { folder_id: f.id, steps: [{ subject: 'Hi {{first_name}}', body_html: '<p>{{company}} {{first_name|there}}</p>' }] });
      });
    }).then(function (r) {
      assert.strictEqual(r.total, 3); assert.strictEqual(r.leads_affected, 2);
      var m = {}; r.variables.forEach(function (x) { m[x.name] = x.missing; });
      assert.strictEqual(m.first_name, 1); assert.strictEqual(m.company, 2);
      return h.expectReject(c.camps.variableCoverage(c.a, { steps: [] }), 'validation');
    });
  });
});
h.run();
