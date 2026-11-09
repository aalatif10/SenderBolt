'use strict';
// Sender health: recomputed from the last 30 days of real results, and a sender that falls below
// the threshold is paused automatically (protects the Gmail account's reputation).
var health = require('../lib/health');

var WINDOW_MS = 30 * 86400000;

// db may be a Database or a tx. Returns the new score.
function recompute(db, senderId, now) {
  var since = now - WINDOW_MS, sent = 0, bouncedLater = 0, rejected = 0, replies = 0;
  return db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'sent' AND step_no IS NOT NULL AND sent_at >= ?", [senderId, since]).then(function (r) {
    sent = r.n;     // accepted by our SMTP provider
    // bounce notices that came back to the mailbox later (these refer to emails counted in `sent`)
    return db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND direction = 'in' AND kind = 'bounce' AND error_class IN ('hard','policy') AND created_at >= ?", [senderId, since]);
  }).then(function (r) {
    bouncedLater = r.n;
    // emails the receiving server refused during sending (never counted in `sent`)
    return db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'failed' AND error_class IN ('recipient','policy') AND created_at >= ?", [senderId, since]);
  }).then(function (r) {
    rejected = r.n;
    return db.get("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND direction = 'in' AND kind = 'email' AND created_at >= ?", [senderId, since]);
  }).then(function (r) {
    replies = r.n;
    var score = health.computeHealth({ sent: sent + rejected, hardBounces: bouncedLater + rejected, replies: replies, complaints: 0 });
    return db.run('UPDATE senders SET health_score = ? WHERE id = ?', [score, senderId]).then(function () {
      if (score >= health.AUTO_PAUSE_BELOW) return score;
      return db.run("UPDATE senders SET status = 'paused', last_error = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        ['Auto-paused: health score fell to ' + score + ' (too many bounces)', now, senderId]).then(function () { return score; });
    });
  });
}

module.exports = { recompute: recompute, WINDOW_MS: WINDOW_MS };
