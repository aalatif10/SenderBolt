'use strict';
// Sender limits, warm-up ramp and delay logic. Everything here is pure (no database, no clock).
// The 400/day cap is a hard ceiling (leaves a 100-email buffer for manual mail on a personal Gmail account).

var HARD_DAILY_CAP = 400;

function clampDailyLimit(value) {
  var n = Math.floor(Number(value));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, HARD_DAILY_CAP);
}

// ---- warm-up --------------------------------------------------------------------------------------
// A new (or rarely used) account starts small and grows. Warm-up is OPTIONAL per sender: when it is off,
// the sender simply uses its configured daily limit from day one (see limitToday below).
//   standard: 5/day, +25% per ramp day  -> reaches 400/day on ramp day 21
//   gentle:   3/day, +15% per ramp day  -> reaches 400/day on ramp day 36
var PACES = { standard: { start: 5, growth: 1.25 }, gentle: { start: 3, growth: 1.15 } };
var PACE_NAMES = Object.keys(PACES);
var DAY_COUNTS_FRACTION = 0.5;     // a day only advances the ramp if the sender used at least half of that day's allowance
var PENALTY_MIN_SENT = 20;         // fewer sends than this in 7 days is too little data to judge bounces

function warmupLimit(dayIndex, configuredLimit, pace) {
  var cap = clampDailyLimit(configuredLimit), p = PACES[pace] || PACES.standard;
  var d = Math.max(0, Math.floor(Number(dayIndex)) || 0);
  return Math.min(cap, Math.max(p.start, Math.round(p.start * Math.pow(p.growth, d))));
}

// Ramp day number (1-based) on which the configured limit is first reached.
function warmupDaysToLimit(configuredLimit, pace) {
  var cap = clampDailyLimit(configuredLimit), d = 0;
  while (warmupLimit(d, cap, pace) < cap && d < 1000) d++;
  return d + 1;
}

// Did a finished day (sentCount emails against that day's ramp allowance) earn a step up the ramp?
function dayCounts(sentCount, allowance) {
  return (Number(sentCount) || 0) >= Math.max(1, Math.ceil(allowance * DAY_COUNTS_FRACTION));
}

// Position on the ramp (0-based) for the UTC day dateStr. Only days the sender really sent mail move it:
//  - idle days (paused, no campaign, holidays) do NOT advance the ramp;
//  - a token day (one email when 30 were allowed) does NOT advance it either (see dayCounts);
//  - the day that is still in progress is never counted early, so the limit cannot jump mid-day.
// `sender` needs: warmup_days, sent_today, sent_today_date, daily_limit, warmup_pace.
// sent_today / sent_today_date describe the LAST day the sender sent (they are only reset by the next send).
function rampIndex(sender, dateStr) {
  var done = Math.max(0, Math.floor(Number(sender.warmup_days)) || 0);
  if (!sender.sent_today_date || sender.sent_today_date === dateStr) return done;
  var lastDayAllowance = warmupLimit(done, sender.daily_limit, sender.warmup_pace);
  return done + (dayCounts(sender.sent_today, lastDayAllowance) ? 1 : 0);
}

// Hard-bounce rate over the last 7 days -> how many ramp steps to step back (each step is ~20% less volume).
// Gentle by design: it never goes below the starting amount, and auto-pause (health < 50) still backs it up.
function warmupPenaltySteps(sent7, bounced7) {
  var sent = Number(sent7) || 0;
  if (sent < PENALTY_MIN_SENT) return 0;
  var rate = (Number(bounced7) || 0) / sent;
  if (rate >= 0.06) return 6;
  if (rate >= 0.04) return 4;
  if (rate >= 0.02) return 2;
  return 0;
}

// What this sender may send on UTC day dateStr (before subtracting what it already sent).
function limitToday(sender, dateStr) {
  if (!sender.warmup_enabled) return clampDailyLimit(sender.daily_limit);      // warm-up off: full speed from day one
  var idx = Math.max(0, rampIndex(sender, dateStr) - (Number(sender.warmup_penalty) || 0));
  return warmupLimit(idx, sender.daily_limit, sender.warmup_pace);
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

module.exports = {
  HARD_DAILY_CAP: HARD_DAILY_CAP, PACES: PACES, PACE_NAMES: PACE_NAMES, PENALTY_MIN_SENT: PENALTY_MIN_SENT,
  clampDailyLimit: clampDailyLimit, warmupLimit: warmupLimit, warmupDaysToLimit: warmupDaysToLimit, dayCounts: dayCounts,
  rampIndex: rampIndex, warmupPenaltySteps: warmupPenaltySteps, limitToday: limitToday, nextDelayMs: nextDelayMs
};
