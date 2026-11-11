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
test('daily limit hard-capped at 400', function () {
  assert.strictEqual(throttle.clampDailyLimit(9999), 400);
  assert.strictEqual(throttle.clampDailyLimit(120), 120);
  assert.strictEqual(throttle.clampDailyLimit(-5), 1);
  assert.strictEqual(throttle.clampDailyLimit('abc'), 1);
});
test('warm-up paces: standard and gentle ramps, days-to-limit, cap respected', function () {
  assert.strictEqual(throttle.warmupLimit(0, 400, 'standard'), 5); assert.strictEqual(throttle.warmupLimit(0, 400, 'gentle'), 3);
  assert.strictEqual(throttle.warmupLimit(20, 400, 'standard'), 400); assert.strictEqual(throttle.warmupLimit(20, 400, 'gentle'), 49);
  assert.strictEqual(throttle.warmupLimit(5, 400, 'nonsense'), throttle.warmupLimit(5, 400, 'standard'), 'unknown pace falls back to standard');
  assert.strictEqual(throttle.warmupLimit(0, 2, 'standard'), 2, 'never above the configured limit, even at the start');
  assert.strictEqual(throttle.warmupDaysToLimit(400, 'standard'), 21); assert.strictEqual(throttle.warmupDaysToLimit(400, 'gentle'), 36);
  assert.strictEqual(throttle.warmupDaysToLimit(250, 'standard'), 19); assert.strictEqual(throttle.warmupDaysToLimit(3, 'standard'), 1);
  assert.strictEqual(throttle.warmupDaysToLimit(9999, 'standard'), 21, 'configured limit is clamped to the 400 cap first');
});
test('ramp index: only days that were really used move it (idle days, token days, day in progress)', function () {
  var base = { warmup_days: 0, sent_today: 0, sent_today_date: null, daily_limit: 100, warmup_pace: 'standard' };
  var ri = throttle.rampIndex;
  assert.strictEqual(ri(base, '2026-11-01'), 0, 'never sent');
  assert.strictEqual(ri(Object.assign({}, base, { sent_today: 5, sent_today_date: '2026-11-01' }), '2026-11-01'), 0, 'day in progress is not counted early');
  assert.strictEqual(ri(Object.assign({}, base, { sent_today: 3, sent_today_date: '2026-11-01' }), '2026-11-02'), 1, '3 of 5 allowed = enough');
  assert.strictEqual(ri(Object.assign({}, base, { sent_today: 2, sent_today_date: '2026-11-01' }), '2026-11-02'), 0, '2 of 5 = a token day, no step');
  assert.strictEqual(ri(Object.assign({}, base, { sent_today: 5, sent_today_date: '2026-11-01' }), '2026-12-20'), 1, 'a long idle gap adds nothing beyond the one real day');
  assert.strictEqual(ri(Object.assign({}, base, { warmup_days: 10, sent_today: 23, sent_today_date: '2026-11-01' }), '2026-11-02'), 10, '23 of 47 is under half: stays');
  assert.strictEqual(ri(Object.assign({}, base, { warmup_days: 10, sent_today: 24, sent_today_date: '2026-11-01' }), '2026-11-02'), 11, '24 of 47 is at least half');
  assert.strictEqual(throttle.dayCounts(0, 5), false); assert.strictEqual(throttle.dayCounts(1, 1), true);
});
test('warm-up penalty: gentle slow-down on rising bounces, never on tiny samples', function () {
  var p = throttle.warmupPenaltySteps;
  assert.strictEqual(p(19, 19), 0, 'under 20 sends = not enough data'); assert.strictEqual(p(100, 1), 0); assert.strictEqual(p(100, 2), 2);
  assert.strictEqual(p(100, 4), 4); assert.strictEqual(p(100, 6), 6); assert.strictEqual(p(100, 50), 6); assert.strictEqual(p(undefined, undefined), 0);
});
test('limitToday: warm-up OFF means full limit from day one; ON follows ramp, penalty and pace', function () {
  var s = { warmup_enabled: 0, warmup_days: 0, warmup_penalty: 3, sent_today: 0, sent_today_date: null, daily_limit: 250, warmup_pace: 'standard' };
  var lt = throttle.limitToday;
  assert.strictEqual(lt(s, '2026-11-01'), 250, 'toggle off: 250 right away, penalty ignored');
  assert.strictEqual(lt(Object.assign({}, s, { daily_limit: 9999 }), '2026-11-01'), 400, 'still capped at 400');
  assert.strictEqual(lt(Object.assign({}, s, { warmup_enabled: 1, warmup_penalty: 0 }), '2026-11-01'), 5);
  assert.strictEqual(lt(Object.assign({}, s, { warmup_enabled: 1, warmup_penalty: 0, warmup_pace: 'gentle' }), '2026-11-01'), 3);
  assert.strictEqual(lt(Object.assign({}, s, { warmup_enabled: 1, warmup_days: 10, warmup_penalty: 0 }), '2026-11-01'), 47);
  assert.strictEqual(lt(Object.assign({}, s, { warmup_enabled: 1, warmup_days: 10, warmup_penalty: 6 }), '2026-11-01'), 12, 'six steps back');
  assert.strictEqual(lt(Object.assign({}, s, { warmup_enabled: 1, warmup_days: 2, warmup_penalty: 6 }), '2026-11-01'), 5, 'never below the starting amount');
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
