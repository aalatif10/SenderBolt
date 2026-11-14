'use strict';
// Live mailbox adapter: library loading must never leave a half-initialised state or crash the process.
var assert = require('assert');
var h = require('./helpers');
var mailbox = require('../src/engine/mailbox');

h.group('mailbox adapter: library loading');
h.test('mailparser missing: clear error, no TypeError; retried (and works) once the package loads', function () {
  var mailparserOk = false, calls = [];
  var fakeImap = function () { throw new Error('should not connect in this test'); };
  var req = function (name) {
    calls.push(name);
    if (name === 'imap') return fakeImap;
    if (name === 'mailparser') { if (!mailparserOk) throw new Error("Cannot find module 'mailparser'"); return { simpleParser: function () { return Promise.resolve({}); } }; }
    throw new Error('unexpected ' + name);
  };
  var mb = mailbox.createLive({ require: req });
  var creds = { host: 'imap.gmail.com', port: 993, user: 'a@gmail.com', pass: 'x' };
  function fail() { return mb.baseline(creds).then(function () { return null; }, function (e) { return e; }); }
  return fail().then(function (first) {
    assert.ok(first && first.code === 'mailbox_libs' && /mailparser/.test(first.message) && !/simpleParser of undefined/.test(first.message), String(first));
    return fail();
  }).then(function (second) {
    assert.ok(second && second.code === 'mailbox_libs' && !(second instanceof TypeError));     // still the same clear error
    mailparserOk = true; return fail();
  }).then(function (third) { assert.ok(!third || third.code !== 'mailbox_libs', 'after the package loads there is no library error'); });
});
h.test('a mailparser without simpleParser is rejected with a clear message', function () {
  var mb = mailbox.createLive({ require: function (n) { return n === 'imap' ? function () {} : {}; } });
  return mb.baseline({}).then(function () { assert.fail('should reject'); }, function (err) { assert.ok(err.code === 'mailbox_libs' && /simpleParser/.test(err.message)); });
});
h.run();
