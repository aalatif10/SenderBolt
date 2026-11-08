'use strict';
// Production adapter for the `sqlite3` npm package (prebuilt binaries, no compiler
// needed on older Node/Windows). NOTE: written against the documented sqlite3 API
// but not yet executed in this environment (package could not be installed here).

function open(file) {
  var sqlite3 = require('sqlite3');
  return new Promise(function (resolve, reject) {
    var db = new sqlite3.Database(file, function (err) {
      if (err) return reject(err);
      resolve({
        exec: function (sql) {
          return new Promise(function (res, rej) { db.exec(sql, function (e) { e ? rej(e) : res(); }); });
        },
        run: function (sql, params) {
          return new Promise(function (res, rej) {
            db.run(sql, params || [], function (e) { e ? rej(e) : res({ changes: this.changes, lastID: this.lastID }); });
          });
        },
        get: function (sql, params) {
          return new Promise(function (res, rej) { db.get(sql, params || [], function (e, row) { e ? rej(e) : res(row); }); });
        },
        all: function (sql, params) {
          return new Promise(function (res, rej) { db.all(sql, params || [], function (e, rows) { e ? rej(e) : res(rows); }); });
        },
        close: function () {
          return new Promise(function (res, rej) { db.close(function (e) { e ? rej(e) : res(); }); });
        }
      });
    });
  });
}

module.exports = { open: open };
