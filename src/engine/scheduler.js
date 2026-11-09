'use strict';
// Drives the engine: send tick every 5s, reply sync every 60s, health recompute hourly.
// Each job is single-flight and never throws out of the timer. 'off' mode starts nothing.
var senderHealth = require('../services/senderHealth');

function Scheduler(db, engine, inboxSync, opts) {
  this.db = db; this.engine = engine; this.inboxSync = inboxSync;
  this.mode = opts.mode; this.log = opts.log || function () {};
  this.tickMs = opts.tickMs || 5000; this.syncMs = opts.syncMs || 60000; this.healthMs = opts.healthMs || 3600000;
  this.timers = [];
  this.started = false;
}

Scheduler.prototype.start = function () {
  var self = this;
  if (this.started || this.mode === 'off') return Promise.resolve();
  this.started = true;
  function every(ms, fn) {
    var t = setInterval(function () { Promise.resolve().then(fn).catch(function (e) { self.log('scheduler: ' + (e && e.message)); }); }, ms);
    if (t.unref) t.unref();
    self.timers.push(t);
  }
  return this.engine.recoverInterrupted().then(function () { return self.inboxSync.syncAll(); }).catch(function (e) { self.log('startup: ' + e.message); }).then(function () {
    every(self.tickMs, function () { return self.engine.tick(); });
    every(self.syncMs, function () { return self.inboxSync.syncAll(); });
    every(self.healthMs, function () { return self.recomputeHealth(); });
  });
};

Scheduler.prototype.recomputeHealth = function () {
  var db = this.db, now = Date.now();
  return db.all("SELECT id FROM senders WHERE status <> 'disabled'").then(function (rows) {
    return rows.reduce(function (p, r) { return p.then(function () { return senderHealth.recompute(db, r.id, now); }); }, Promise.resolve());
  });
};

Scheduler.prototype.stop = function () { this.timers.forEach(clearInterval); this.timers = []; this.started = false; };

module.exports = { Scheduler: Scheduler };
