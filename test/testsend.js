'use strict';
// "Send me a test email": composed like a campaign email, sent only from the user's own active sender, no campaign side effects.
var assert = require('assert');
var crypto = require('crypto');
var h = require('./helpers');
var vault = require('../src/lib/vault');
var Senders = require('../src/services/senders').Senders;
var SendEngine = require('../src/engine/sendEngine').SendEngine;
var TestSendService = require('../src/services/testSend').TestSendService;

function setup(mode, fail) {
  return h.freshDb().then(function (db) {
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex')), sent = [];
    var mailer = { mode: mode, send: function (creds, mail) { sent.push({ creds: creds, mail: mail }); return fail ? Promise.reject(Object.assign(new Error('535 Authentication failed'), { code: 'EAUTH' })) : Promise.resolve({}); }, verify: function () { return Promise.resolve(true); } };
    var engine = new SendEngine(db, { key: key, mailer: mailer, unsubSecret: 'unsub-secret-for-tests-0123456789abcdef', publicOrigin: 'https://app.example' });
    var c = { db: db, sent: sent, senders: new Senders(db, key), svc: new TestSendService(db, { engine: engine, mailer: mailer }) };
    return h.mkUser(db, 'a@x.com').then(function (a) {
      return h.mkUser(db, 'b@x.com').then(function (b) {
        c.a = { id: a, email: 'owner@x.com' }; c.b = { id: b, email: 'other@x.com' };
        return c.senders.create(a, { label: 'S1', email: 's1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop', signature_html: '<b>Sig</b><script>x</script>' });
      });
    }).then(function (s) { c.sid = s.id; return c; });
  });
}

h.group('test email');
h.test('live: sends one [TEST] email to the owner, rendered with sample data, sanitized, no unsubscribe link', function () {
  return setup('live').then(function (c) {
    return c.svc.send(c.a, { sender_id: c.sid, subject: 'Hi {{first_name|there}}', body_html: '<p onclick=x>Hello {{first_name}} at {{company}}</p><script>alert(1)</script>' }).then(function (r) {
      assert.strictEqual(r.delivered, true); assert.strictEqual(r.to, 'owner@x.com'); assert.strictEqual(c.sent.length, 1);
      var m = c.sent[0].mail;
      assert.strictEqual(m.to, 'owner@x.com'); assert.strictEqual(m.subject, '[TEST] Hi Alex');
      assert.ok(m.html.indexOf('Hello Alex at Acme Domains') !== -1); assert.ok(!/script|onclick/.test(m.html));
      assert.ok(m.html.indexOf('<b>Sig</b>') !== -1 && m.html.indexOf('app.example/u/') === -1);
      assert.ok(!/\r|\n/.test(m.subject));
      return Promise.all([c.db.get('SELECT COUNT(*) AS n FROM messages'), c.db.get('SELECT sent_today FROM senders WHERE id = ?', [c.sid]), c.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'test_email.send'")]);
    }).then(function (r) { assert.strictEqual(r[0].n, 0); assert.strictEqual(r[1].sent_today, 0); assert.strictEqual(r[2].n, 1); });
  });
});
h.test('dry-run mode sends nothing and says so; follow-up with blank subject becomes Re:', function () {
  return setup('dry-run').then(function (c) {
    return c.svc.send(c.a, { sender_id: c.sid, subject: '', previous_subject: 'Re: Question', body_html: '<p>x</p>' }).then(function (r) {
      assert.strictEqual(r.dry_run, true); assert.strictEqual(r.delivered, false); assert.strictEqual(c.sent.length, 0); assert.strictEqual(r.subject, '[TEST] Re: Question');
    });
  });
});
h.test('validation, other recipient, missing fields reported, ownership, inactive sender, send failure is friendly', function () {
  return setup('live').then(function (c) {
    function bad(patch, code) { return h.expectReject(c.svc.send(c.a, Object.assign({ sender_id: c.sid, subject: 's', body_html: '<p>x</p>' }, patch)), code); }
    return bad({ to: 'not an email' }, 'validation').then(function () { return bad({ to: 'a@b.com\r\nBcc: x@y.com' }, 'validation'); })
      .then(function () { return bad({ subject: '' }, 'validation'); }).then(function () { return bad({ body_html: '<p><br></p>' }, 'validation'); })
      .then(function () { return bad({ sender_id: 'x' }, 'validation'); })
      .then(function () { return h.expectReject(c.svc.send(c.b, { sender_id: c.sid, subject: 's', body_html: '<p>x</p>' }), 'not_found'); })
      .then(function () { return c.svc.send(c.a, { sender_id: c.sid, to: 'me@mine.com', subject: 's', body_html: '<p>{{niche}}</p>' }); })
      .then(function (r) { assert.strictEqual(r.to, 'me@mine.com'); assert.deepStrictEqual(r.missing, ['niche']); assert.strictEqual(c.sent[c.sent.length - 1].mail.to, 'me@mine.com'); return c.db.run("UPDATE senders SET status = 'paused'"); })
      .then(function () { return bad({}, 'conflict'); });
  }).then(function () { return setup('live', true); }).then(function (c) {
    return c.svc.send(c.a, { sender_id: c.sid, subject: 's', body_html: '<p>x</p>' }).then(function () { throw new Error('should fail'); }, function (e) {
      assert.strictEqual(e.code, 'conflict'); assert.ok(/not sent/.test(e.message)); assert.ok(!/535|abcdefghijklmnop/.test(e.message));
    });
  });
});
h.run();
