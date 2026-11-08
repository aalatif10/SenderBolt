'use strict';
// Database wrapper: driver selection, safe PRAGMAs, and a serialized executor so
// transactions on the single connection can never interleave with other queries.
//
// IMPORTANT: inside db.transaction(fn), use the `tx` object passed to fn, never
// the outer db (the outer db waits for the transaction and would deadlock).

function pickDriver(explicit) {
  var want = explicit || process.env.SENDERBOLT_DB_DRIVER;
  if (want === 'sqlite3' || want === 'node:sqlite') return want;
  try { require.resolve('sqlite3'); return 'sqlite3'; } catch (e) { return 'node:sqlite'; }
}

function Database(raw, driver) {
  this.raw = raw;
  this.driver = driver;
  this._tail = Promise.resolve();
}

Database.prototype._exclusive = function (fn) {
  var next = this._tail.then(fn, fn);
  this._tail = next.then(function () {}, function () {});
  return next;
};

['run', 'get', 'all', 'exec'].forEach(function (m) {
  Database.prototype[m] = function (sql, params) {
    var raw = this.raw;
    return this._exclusive(function () { return raw[m](sql, params); });
  };
});

Database.prototype.transaction = function (fn) {
  var raw = this.raw;
  var tx = {
    run: function (s, p) { return raw.run(s, p); },
    get: function (s, p) { return raw.get(s, p); },
    all: function (s, p) { return raw.all(s, p); }
  };
  return this._exclusive(function () {
    return raw.exec('BEGIN IMMEDIATE').then(function () {
      return Promise.resolve().then(function () { return fn(tx); }).then(function (result) {
        return raw.exec('COMMIT').then(function () { return result; });
      }, function (err) {
        return raw.exec('ROLLBACK').then(function () { throw err; }, function () { throw err; });
      });
    });
  });
};

Database.prototype.close = function () {
  var raw = this.raw;
  return this._exclusive(function () { return raw.close(); });
};

function open(file, opts) {
  opts = opts || {};
  var driver = pickDriver(opts.driver);
  var adapter = driver === 'sqlite3' ? require('./adapters/sqlite3') : require('./adapters/nodesqlite');
  return adapter.open(file).then(function (raw) {
    return raw.exec(
      'PRAGMA journal_mode = WAL;' +
      'PRAGMA foreign_keys = ON;' +
      'PRAGMA busy_timeout = 5000;' +
      'PRAGMA synchronous = NORMAL;' +
      'PRAGMA secure_delete = ON;'
    ).then(function () { return new Database(raw, driver); });
  });
}

module.exports = { open: open, Database: Database };
