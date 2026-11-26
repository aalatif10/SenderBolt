'use strict';
// Sender health score (0-100). Hard bounces and spam complaints hurt a lot,
// replies help slightly. Below ~20 sends there is not enough data to judge.

var MIN_SAMPLE = 20;
var AUTO_PAUSE_BELOW = 50;

function computeHealth(s) {
  var sent = Number(s.sent) || 0;
  if (sent < MIN_SAMPLE) return 100;
  var bounceRate = (Number(s.hardBounces) || 0) / sent;
  var complaintRate = (Number(s.complaints) || 0) / sent;
  var replyRate = (Number(s.replies) || 0) / sent;
  var score = 100 - bounceRate * 100 * 6 - complaintRate * 100 * 50 + Math.min(5, replyRate * 100 * 0.5);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Protection levels (per sender): how early SenderBolt automatically pauses an account.
//  low    - pauses only when the account is clearly in trouble (score below 30; 8 failures in a row)
//  medium - the default (score below 50; 5 failures in a row)
//  high   - strictest, protects valuable accounts (score below 70; 3 failures in a row)
var LEVELS = {
  low: { pauseBelow: 30, streakLimit: 8 },
  medium: { pauseBelow: AUTO_PAUSE_BELOW, streakLimit: 5 },
  high: { pauseBelow: 70, streakLimit: 3 }
};
var LEVEL_NAMES = ['low', 'medium', 'high'];
// An account paused by the health protection is switched back on automatically once its score is this many points ABOVE its pause line
// (a margin, so one more bounce does not pause it again at once and inflate the Forced pauses counter).
var RESUME_MARGIN = 10;
var FORCE_MS = 72 * 3600000;      // a "force continue" override lasts 72 hours, then protection applies again

function level(sender) { return LEVELS[sender && sender.protection_level] || LEVELS.medium; }
function floorFor(sender) { return level(sender).pauseBelow; }
function streakLimitFor(sender) { return level(sender).streakLimit; }
function isForced(sender, now) { return !!(sender && sender.force_until && sender.force_until > now); }
// True when the automatic health rule should keep this sender from sending right now.
function isBelowFloor(sender, now) { return !isForced(sender, now) && Number(sender.health_score) < floorFor(sender); }

// ---- Health healing ----------------------------------------------------------------------------------------------
// A completed UTC day earns points when nothing severe happened: +1 for a calm day, +1 per 10 clean sends,
// +1 when at least one real reply came in. At most 10 per day (the sends part is limited by that same daily cap),
// so a badly hurt account needs days, never minutes.
// Any severe event that day (hard/policy bounce, refused recipient) earns nothing.
// A day with NO emails sent (account paused, down or idle) earns a flat `idle` points: resting is how a hurt account recovers.
var HEAL = { calm: 1, cleanPer: 10, cleanMax: 10, reply: 1, idle: 5, dayMax: 10, cap: 100 };
function healPoints(day) {
  if (!day || Number(day.severe) > 0) return 0;
  if (!(Number(day.sent) > 0)) return HEAL.idle;      // 0 emails sent that day: +5
  var pts = HEAL.calm + Math.min(HEAL.cleanMax, Math.floor((Number(day.sent) || 0) / HEAL.cleanPer)) + (Number(day.replies) > 0 ? HEAL.reply : 0);
  return Math.min(HEAL.dayMax, pts);
}
// Heal never exceeds what is needed to reach the cap, so it cannot hide a later drop of the base score.
function clampHeal(heal, base) { return Math.max(0, Math.min(Number(heal) || 0, HEAL.cap - (Number(base) || 0))); }
function effective(base, heal) { return Math.max(0, Math.min(HEAL.cap, (Number(base) || 0) + clampHeal(heal, base))); }

module.exports = { HEAL: HEAL, healPoints: healPoints, clampHeal: clampHeal, effective: effective, computeHealth: computeHealth, AUTO_PAUSE_BELOW: AUTO_PAUSE_BELOW, MIN_SAMPLE: MIN_SAMPLE, LEVELS: LEVELS, LEVEL_NAMES: LEVEL_NAMES, FORCE_MS: FORCE_MS, RESUME_MARGIN: RESUME_MARGIN,
  floorFor: floorFor, streakLimitFor: streakLimitFor, isForced: isForced, isBelowFloor: isBelowFloor };
