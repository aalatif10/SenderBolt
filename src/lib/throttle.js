'use strict';
// Sender limits and delay logic. The 400/day cap is a hard ceiling (leaves a 100-email buffer for manual mail on a personal Gmail account).

var HARD_DAILY_CAP = 400;

function clampDailyLimit(value) {
  var n = Math.floor(Number(value));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, HARD_DAILY_CAP);
}

// Warm-up ramp: starts at 5/day and grows ~25% per day, never above the
// sender's configured limit (itself capped at 400).
function warmupLimit(dayIndex, configuredLimit) {
  var cap = clampDailyLimit(configuredLimit);
  var d = Math.max(0, Math.floor(Number(dayIndex)) || 0);
  return Math.min(cap, Math.max(5, Math.round(5 * Math.pow(1.25, d))));
}

// cfg: { mode: 'fixed'|'random', fixedSec, minSec, maxSec }
function nextDelayMs(cfg, rnd) {
  rnd = rnd || Math.random;
  if (cfg.mode === 'random') {
    var lo = Math.max(1, Number(cfg.minSec) || 1);
    var hi = Math.max(lo, Number(cfg.maxSec) || lo);
    return Math.round((lo + rnd() * (hi - lo)) * 1000);
  }
  return Math.round(Math.max(1, Number(cfg.fixedSec) || 1) * 1000);
}

module.exports = { HARD_DAILY_CAP: HARD_DAILY_CAP, clampDailyLimit: clampDailyLimit, warmupLimit: warmupLimit, nextDelayMs: nextDelayMs };
