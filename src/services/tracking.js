'use strict';
// Open tracking: records that the pixel of one sent email was requested. Counts are approximate by nature
// (blocked images, privacy proxies and prefetching mail apps), so the UI labels them as such.
var track = require('../lib/track');

function TrackingService(db, opts) { this.db = db; this.secret = opts.secret; this.now = opts.now || Date.now; }

// Never throws and never reveals whether a token was valid: the caller always serves the same image.
TrackingService.prototype.recordOpen = function (token) {
  var self = this, v = track.verify(this.secret, token);
  if (!v) return Promise.resolve(false);
  var t = this.now();
  return this.db.run("UPDATE messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE idempotency_key = ? AND direction = 'out' AND status = 'sent'",
    [t, 'cl:' + v.clId + ':s:' + v.step]).then(function (r) { return r.changes > 0; }, function () { return false; });
};

module.exports = { TrackingService: TrackingService };
