'use strict';
// Sender health: recomputed from the last 30 days of real results, and a sender that falls below
// the threshold is paused automatically (protects the Gmail account's reputation).
var health = require('../lib/health');
var throttle = require('../lib/throttle');
var audit = require('./audit');

var WINDOW_MS = 30 * 86400000;
var RECENT_MS = 7 * 86400000;      // window for the warm-up slow-down

// db may be a Database or a tx. Returns the new score.
function recompute(db, senderId, now) {
  var score, since = now - WINDOW_MS, recent = now - RECENT_MS, sent = 0, bouncedLater = 0, rejected = 0, replies = 0, sent7 = 0, bounced7 = 0;
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
    // Same counting over the last 7 days only: drives how much the warm-up ramp is slowed.
    return db.get("SELECT (SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'sent' AND step_no IS NOT NULL AND sent_at >= ?) AS sent, " +
      "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'in' AND kind = 'bounce' AND error_class IN ('hard','policy') AND created_at >= ?) AS bounced, " +
      "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'failed' AND error_class IN ('recipient','policy') AND created_at >= ?) AS rejected",
      [senderId, recent, senderId, recent, senderId, recent]);
  }).then(function (r7) {
    sent7 = r7.sent + r7.rejected; bounced7 = r7.bounced + r7.rejected;
    var base = health.computeHealth({ sent: sent + rejected, hardBounces: bouncedLater + rejected, replies: replies, complaints: 0 });
    var severeNow = bouncedLater + rejected;
    var penalty = throttle.warmupPenaltySteps(sent7, bounced7);
    return db.get('SELECT health_heal, health_severe_n FROM senders WHERE id = ?', [senderId]).then(function (hs) {
      // A NEW severe event cancels the healing earned so far: the score must show the problem honestly.
      var heal = hs && severeNow > hs.health_severe_n ? 0 : health.clampHeal(hs ? hs.health_heal : 0, base);
      score = health.effective(base, heal);
      return db.run('UPDATE senders SET health_score = ?, health_base = ?, health_heal = ?, health_severe_n = ?, warmup_penalty = ? WHERE id = ?', [score, base, heal, severeNow, penalty, senderId]);
    }).then(function () {
      return db.get('SELECT protection_level, force_until FROM senders WHERE id = ?', [senderId]);
    }).then(function (lv) {
      // The pause threshold depends on the sender's protection level; a "force continue" override skips the pause.
      var probe = { health_score: score, protection_level: lv && lv.protection_level, force_until: lv && lv.force_until };
      if (!health.isBelowFloor(probe, now)) {
        // Recovered: an account the health protection paused is switched back on once it is clearly above its line, and the stale
        // warning is cleared (Needs attention, Home alerts). A pause the owner made by hand is never lifted (health_paused = 0).
        // An ACTIVE, healthy account must not keep an old automatic-pause note (for example after the owner switched it on by hand).
        var tidy = db.run("UPDATE senders SET last_error = NULL WHERE id = ? AND status = 'active' AND last_error LIKE 'Auto-paused:%'", [senderId]);
        if (score < Math.min(100, health.floorFor(probe) + health.RESUME_MARGIN)) return tidy.then(function () { return score; });
        return db.run("UPDATE senders SET status = 'active', last_error = NULL, health_paused = 0, next_send_at = NULL, updated_at = ? WHERE id = ? AND status = 'paused' AND health_paused = 1", [now, senderId])
          .then(function (r) {
            if (!(r && r.changes > 0)) return score;
            return db.get('SELECT user_id FROM senders WHERE id = ?', [senderId]).then(function (u) {
              return u ? audit.log(db, { userId: u.user_id, action: 'sender.auto_resume', entity: 'sender', entityId: senderId, meta: { health_score: score } }, function () { return now; }) : null;
            }).then(function () { return score; });
          });
      }
      // Lifetime counter: +1 each time the protection pauses the account (only on the active -> paused change, so it counts pauses, not checks).
      return db.run("UPDATE senders SET status = 'paused', health_paused = 1, forced_pauses = forced_pauses + 1, last_error = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        ['Auto-paused: health score fell to ' + score + ' (too many bounces)', now, senderId]).then(function () { return score; });
    });
  });
}

// ---- daily healing ---------------------------------------------------------------------------------------------------
function utcDay(t) { return new Date(t).toISOString().slice(0, 10); }
function dayMs(str) { return Date.parse(str + 'T00:00:00Z'); }

// Credits every COMPLETED UTC day since the last credited one (max 30 days of catch-up; the first call only starts the clock,
// it never grants retroactive points). Then recomputes the score. Safe to call as often as you like.
function healDaily(db, senderId, now) {
  var yesterday = utcDay(now - 86400000);
  return db.get('SELECT health_heal, health_heal_day, health_base, health_score FROM senders WHERE id = ?', [senderId]).then(function (s) {
    if (!s) return null;
    if (!s.health_heal_day) return db.run('UPDATE senders SET health_heal_day = ? WHERE id = ?', [yesterday, senderId]).then(function () { return recompute(db, senderId, now); });
    if (s.health_heal_day >= yesterday) return null;
    var days = [], d = s.health_heal_day;
    while (d < yesterday && days.length < 30) { d = utcDay(dayMs(d) + 86400000); days.push(d); }
    var heal = s.health_heal, base = s.health_base === null || s.health_base === undefined ? s.health_score : s.health_base;
    return days.reduce(function (p, day) {
      return p.then(function () {
        var from = dayMs(day), to = from + 86400000;
        return db.get("SELECT " +
          "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'sent' AND step_no IS NOT NULL AND sent_at >= ? AND sent_at < ?) AS sent, " +
          "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'in' AND kind = 'email' AND created_at >= ? AND created_at < ?) AS replies, " +
          "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'in' AND kind = 'bounce' AND error_class IN ('hard','policy') AND created_at >= ? AND created_at < ?) + " +
          "(SELECT COUNT(*) FROM messages WHERE sender_id = ? AND direction = 'out' AND status = 'failed' AND error_class IN ('recipient','policy') AND created_at >= ? AND created_at < ?) AS severe",
          [senderId, from, to, senderId, from, to, senderId, from, to, senderId, from, to]).then(function (r) {
          heal = r.severe > 0 ? Math.floor(heal / 2) : health.clampHeal(heal + health.healPoints(r), base);
        });
      });
    }, Promise.resolve()).then(function () {
      return db.run('UPDATE senders SET health_heal = ?, health_heal_day = ? WHERE id = ?', [heal, yesterday, senderId]);
    }).then(function () { return recompute(db, senderId, now); });
  });
}

module.exports = { recompute: recompute, healDaily: healDaily, WINDOW_MS: WINDOW_MS };
