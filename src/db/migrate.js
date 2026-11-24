'use strict';
// Forward-only SQL migrations. Each file runs in a transaction and is recorded
// with a checksum; editing an already-applied migration is refused.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function checksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function listMigrations(dir) {
  return fs.readdirSync(dir)
    .filter(function (f) { return /^\d{3}_[a-z0-9_]+\.sql$/.test(f); })
    .sort()
    .map(function (f) {
      var sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { version: parseInt(f.slice(0, 3), 10), name: f, sql: sql, checksum: checksum(sql) };
    });
}

function migrate(db, dir) {
  dir = dir || path.join(__dirname, 'migrations');
  return db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    'version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  ).then(function () {
    return db.all('SELECT version, checksum FROM schema_migrations');
  }).then(function (rows) {
    var applied = {};
    rows.forEach(function (r) { applied[r.version] = r.checksum; });
    var pending = [];
    listMigrations(dir).forEach(function (m) {
      if (applied[m.version] !== undefined) {
        if (applied[m.version] !== m.checksum) {
          throw new Error('Migration ' + m.name + ' was modified after being applied');
        }
      } else { pending.push(m); }
    });
    return pending.reduce(function (p, m) {
      // A file that starts with "-- sb:fk-off" rebuilds a table: foreign keys must be OFF while it runs (the pragma is ignored
      // inside a transaction, so it is switched before it), and they are verified and switched back on afterwards.
      var fkOff = /^\s*--\s*sb:fk-off/.test(m.sql);
      return p.then(function () { return fkOff ? db.raw.exec('PRAGMA foreign_keys = OFF;') : null; }).then(function () {
        return db.transaction(function (tx) {
          // tx has no exec; split-free execution goes through raw inside the lock
          return db.raw.exec(m.sql).then(function () {
            return tx.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)',
              [m.version, m.name, m.checksum, Date.now()]);
          }).then(function () {
            return fkOff ? tx.all('PRAGMA foreign_key_check').then(function (bad) { if (bad.length) throw new Error('Migration ' + m.name + ' left ' + bad.length + ' broken foreign key(s)'); }) : null;
          });
        });
      }).then(function () { return fkOff ? db.raw.exec('PRAGMA foreign_keys = ON;') : null; },
        function (e) { return (fkOff ? db.raw.exec('PRAGMA foreign_keys = ON;') : Promise.resolve()).then(function () { throw e; }); })
        .then(function () { return m.name; });
    }, Promise.resolve()).then(function () { return pending.map(function (m) { return m.name; }); });
  });
}

module.exports = { migrate: migrate };
