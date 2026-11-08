'use strict';
// Plain assert test runner (no framework, works on old Node versions).
var assert = require('assert');
var crypto = require('crypto');
var vault = require('../src/lib/vault');
var password = require('../src/lib/password');
var email = require('../src/lib/email');
var csv = require('../src/lib/csv');
var split = require('../src/lib/split');
var throttle = require('../src/lib/throttle');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('vault');
var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
test('encrypt/decrypt roundtrip', function () {
  assert.strictEqual(vault.decrypt(vault.encrypt('app-pass-1234', key, 'sender:1'), key, 'sender:1'), 'app-pass-1234');
});
test('ciphertext differs each time (random IV)', function () {
  assert.notStrictEqual(vault.encrypt('x', key), vault.encrypt('x', key));
});
test('wrong AAD is rejected', function () {
  assert.throws(function () { vault.decrypt(vault.encrypt('x', key, 'sender:1'), key, 'sender:2'); });
});
test('tampered ciphertext is rejected', function () {
  var t = vault.encrypt('secret', key).split('.');
  var ct = Buffer.from(t[3], 'base64'); ct[0] ^= 1; t[3] = ct.toString('base64');
  assert.throws(function () { vault.decrypt(t.join('.'), key); });
});
test('bad key format is rejected', function () {
  assert.throws(function () { vault.loadKey('abc'); });
});

console.log('password');
test('hash and verify', function () {
  var h = password.hash('correct horse battery');
  assert.ok(password.verify('correct horse battery', h));
  assert.ok(!password.verify('wrong password!!', h));
  assert.ok(!password.verify('x', 'garbage'));
});
test('short password rejected', function () { assert.throws(function () { password.hash('short'); }); });

console.log('email');
test('valid and invalid syntax', function () {
  assert.ok(email.checkSyntax('John.Doe+x@Example.co.uk').ok);
  ['', 'a@b', 'a@@b.com', '.a@b.com', 'a..b@c.com', 'a@-b.com', 'a b@c.com', 'a@b.c0m'].forEach(function (bad) {
    assert.ok(!email.checkSyntax(bad).ok, bad);
  });
});
test('CR/LF injection rejected', function () {
  assert.ok(!email.checkSyntax('a@b.com\r\nBcc: x@y.com').ok);
  assert.throws(function () { email.assertSafeHeader('Hi\r\nBcc: evil@x.com', 'subject'); });
});
test('role address and domain', function () {
  assert.ok(email.isRoleAddress('Info@acme.com'));
  assert.ok(!email.isRoleAddress('jane@acme.com'));
  assert.strictEqual(email.domainOf('A@ACME.com'), 'acme.com');
});

console.log('csv');
test('parses quotes, commas, newlines, BOM', function () {
  var rows = csv.parse('﻿email,name\r\na@b.com,"Doe, ""J""\nx"\r\n');
  assert.deepStrictEqual(rows, [['email', 'name'], ['a@b.com', 'Doe, "J"\nx']]);
});
test('sniffs semicolon delimiter', function () {
  assert.deepStrictEqual(csv.parse('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});
test('formula injection neutralized', function () {
  ['=1+1', '+cmd', '-2', '@SUM(A1)'].forEach(function (v) { assert.strictEqual(csv.sanitizeCell(v)[0], "'"); });
  assert.strictEqual(csv.sanitizeCell('hello'), 'hello');
  assert.strictEqual(csv.stringify([['=HYPERLINK("x")', 'ok']]), '"\'=HYPERLINK(""x"")",ok\r\n');
});
test('unterminated quote throws', function () { assert.throws(function () { csv.parse('a,"b'); }); });

console.log('split');
function mk(n, domains) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ id: i, email: 'u' + i + '@d' + (i % domains) + '.com' });
  return out;
}
test('same seed gives same shuffle; permutation preserved', function () {
  var leads = mk(50, 10);
  var a = split.shuffle(leads, 42), b = split.shuffle(leads, 42);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a.map(function (l) { return l.id; }).sort(function (x, y) { return x - y; }), leads.map(function (l) { return l.id; }));
});
test('batch split handles remainder (80 by 26 = 26/26/26/2)', function () {
  var sizes = split.splitBatches(mk(80, 5), 26).map(function (b) { return b.length; });
  assert.deepStrictEqual(sizes, [26, 26, 26, 2]);
  assert.deepStrictEqual(split.previewSizes(80, 26), sizes);
});
test('invalid batch size rejected', function () {
  assert.throws(function () { split.splitBatches([], 0); });
  assert.throws(function () { split.previewSizes(10, 'x'); });
});
test('domain-aware shuffle keeps same-domain leads apart', function () {
  var leads = [];
  for (var i = 0; i < 6; i++) leads.push({ id: i, email: 'p' + i + '@big.com' });
  for (var j = 0; j < 12; j++) leads.push({ id: 10 + j, email: 'p' + j + '@o' + j + '.com' });
  var out = split.domainAwareShuffle(leads, 7);
  assert.strictEqual(out.length, leads.length);
  var pos = [];
  out.forEach(function (l, idx) { if (/@big\.com$/.test(l.email)) pos.push(idx); });
  for (var k = 1; k < pos.length; k++) assert.ok(pos[k] - pos[k - 1] >= 2, 'big.com contacts adjacent');
});

console.log('throttle');
test('daily limit hard-capped at 500', function () {
  assert.strictEqual(throttle.clampDailyLimit(9999), 500);
  assert.strictEqual(throttle.clampDailyLimit(120), 120);
  assert.strictEqual(throttle.clampDailyLimit(-5), 1);
  assert.strictEqual(throttle.clampDailyLimit('abc'), 1);
});
test('warm-up ramps and respects cap', function () {
  assert.strictEqual(throttle.warmupLimit(0, 500), 5);
  assert.ok(throttle.warmupLimit(10, 500) > throttle.warmupLimit(3, 500));
  assert.strictEqual(throttle.warmupLimit(100, 80), 80);
});
test('delay modes', function () {
  assert.strictEqual(throttle.nextDelayMs({ mode: 'fixed', fixedSec: 30 }), 30000);
  var d = throttle.nextDelayMs({ mode: 'random', minSec: 20, maxSec: 60 }, function () { return 0.5; });
  assert.strictEqual(d, 40000);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
