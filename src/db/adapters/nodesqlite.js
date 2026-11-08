'use strict';
// Adapter over Node's built-in node:sqlite (Node 22+). Used for local tests and
// development on modern Node. Production on Windows 7 uses adapters/sqlite3.js.

function open(file) {
  var mod = require('node:sqlite');
  var db = new mod.DatabaseSync(file);
  function plain(row) { return row ? Object.assign({}, row) : undefined; }
  return Promise.resolve({
    exec: function (sql) { try { db.exec(sql); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
    run: function (sql, params) {
      try {
        var st = db.prepare(sql);
        var r = st.run.apply(st, params || []);
        return Promise.resolve({ changes: Number(r.changes), lastID: Number(r.lastInsertRowid) });
      } catch (e) { return Promise.reject(e); }
    },
    get: function (sql, params) {
      try { var st = db.prepare(sql); return Promise.resolve(plain(st.get.apply(st, params || []))); }
      catch (e) { return Promise.reject(e); }
    },
    all: function (sql, params) {
      try { var st = db.prepare(sql); return Promise.resolve(st.all.apply(st, params || []).map(plain)); }
      catch (e) { return Promise.reject(e); }
    },
    close: function () { try { db.close(); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
  });
}

module.exports = { open: open };
