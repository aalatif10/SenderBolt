'use strict';
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var Senders = require('../src/services/senders').Senders;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var TestSendService = require('../src/services/testSend').TestSendService;
var SettingsService = require('../src/services/settings').SettingsService;
var Sessions = require('../src/services/sessions').Sessions;

function setup() {
  return h.freshDb().then(function (db) {
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex')), sent = [];
    var mailer = { mode: 'live', send: function (c, m) { sent.push(m); return Promise.resolve({}); }, verify: function () { return Promise.resolve(true); } };
    var engine = new SendEngine(db, { key: key, mailer: mailer });
    var c = { db: db, sent: sent, senders: new Senders(db, key), settings: new SettingsService(db), svc: new TestSendService(db, { engine: engine, mailer: mailer }) };
    return h.mkUser(db, 'a@x.com').then(function (a) { return h.mkUser(db, 'b@x.com').then(function (b) { c.a = a; c.b = b; return c; }); });
  });
}
function mk(c, label, sig) { return c.senders.create(c.a, { label: label, email: label + '@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop', signature_html: sig || undefined }); }
var U = function (c) { return { id: c.a, email: 'owner@x.com' }; };

h.group('settings: default signature');
h.test('save sanitizes, blank clears, too long and wrong type are rejected, per-user', function () {
  return setup().then(function (c) {
    return c.settings.get(c.a).then(function (r) { assert.strictEqual(r.settings.default_signature_html, null); return c.settings.update(c.a, { default_signature_html: '<p onclick=x>Best,<br>Sam</p><script>x</script>' }); })
      .then(function (r) { assert.strictEqual(r.settings.default_signature_html, '<p>Best,<br>Sam</p>'); return c.settings.get(c.b); })
      .then(function (r) { assert.strictEqual(r.settings.default_signature_html, null); return h.expectReject(c.settings.update(c.a, { default_signature_html: 5 }), 'validation'); })
      .then(function () { return h.expectReject(c.settings.update(c.a, { default_signature_html: '<p>' + new Array(10050).join('a') + '</p>' }), 'validation'); })
      .then(function () { return c.settings.update(c.a, { default_signature_html: '<p><br></p>' }); })
      .then(function (r) { assert.strictEqual(r.settings.default_signature_html, null); });
  });
});
h.test('default signature is used only for senders without their own', function () {
  return setup().then(function (c) {
    var s1, s2;
    return mk(c, 'plain').then(function (a) { s1 = a; return mk(c, 'own', '<i>Own sig</i>'); }).then(function (b) { s2 = b; return c.settings.update(c.a, { default_signature_html: '<b>Default sig</b>' }); })
      .then(function () { return c.svc.send(U(c), { sender_id: s1.id, subject: 's', body_html: '<p>x</p>' }); })
      .then(function () { return c.svc.send(U(c), { sender_id: s2.id, subject: 's', body_html: '<p>x</p>' }); })
      .then(function () {
        assert.ok(c.sent[0].html.indexOf('<b>Default sig</b>') !== -1);
        assert.ok(c.sent[1].html.indexOf('<i>Own sig</i>') !== -1 && c.sent[1].html.indexOf('Default sig') === -1);
      });
  });
});
h.group('sessions list');
h.test('lists only the user\'s live sessions, flags the current one, exposes no token', function () {
  return h.freshDb().then(function (db) {
    var clock = { t: 1000000 }, ses = new Sessions(db, { secret: crypto.randomBytes(32).toString('hex'), now: function () { return clock.t; } }), tokA;
    return h.mkUser(db, 'a@x.com').then(function (a) { return h.mkUser(db, 'b@x.com').then(function (b) {
      return ses.create(a, '1.1.1.1', 'UA-1').then(function (s1) { tokA = s1.token || s1; return ses.create(a, '2.2.2.2', 'UA-2'); }).then(function () { return ses.create(b, '3.3.3.3', 'UA-3'); })
        .then(function () { return ses.listForUser(a, tokA); }).then(function (list) {
          assert.strictEqual(list.length, 2); assert.strictEqual(list.filter(function (x) { return x.current; }).length, 1);
          assert.ok(!JSON.stringify(list).match(/token/i)); assert.ok(list.every(function (x) { return x.ip && x.user_agent; }));
          return ses.destroyAllForUser(a, tokA);
        }).then(function () { return ses.listForUser(a, tokA); }).then(function (list) { assert.strictEqual(list.length, 1); assert.strictEqual(list[0].current, true); });
    }); });
  });
});
h.run();
