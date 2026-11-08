'use strict';
// Shared mini test harness (no framework; runs on old Node versions).
var assert = require('assert');
var database = require('../src/db');
var migrate = require('../src/db/migrate').migrate;

var tests = [], passed = 0, failed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function group(name) { tests.push({ group: name }); }

function freshDb() {
  return database.open(':memory:').then(function (db) { return migrate(db).then(function () { return db; }); });
}
function mkUser(db, addr) {
  return db.run('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)', [addr, 'x', 1]).then(function (r) { return r.lastID; });
}
function expectReject(promise, code) {
  return promise.then(function () { throw new Error('expected rejection' + (code ? ' ' + code : '')); },
    function (e) { if (code) assert.strictEqual(e.code, code, 'got ' + e.code + ': ' + e.message); return e; });
}

function run() {
  var chain = Promise.resolve();
  tests.forEach(function (t) {
    chain = chain.then(function () {
      if (t.group) { console.log(t.group); return; }
      return Promise.resolve().then(t.fn).then(function () { passed++; console.log('  ok   ' + t.name); },
        function (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); });
    });
  });
  return chain.then(function () { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); });
}

module.exports = { test: test, group: group, run: run, freshDb: freshDb, mkUser: mkUser, expectReject: expectReject };
