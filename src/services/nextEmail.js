'use strict';
// nextEmail.js - the ONE place that decides "when will the next email really go out?".
// Senders cards, the campaign summary, the campaigns table and the project totals all read from here, so they can never disagree.
//
// A waiting person (status 'active') in a running campaign is emailed by their OWNER sender only. For every (owner sender,
// campaign) pair the earliest time is:
//   due   = the person's own due time (step delay already applied when the previous email went out), but not before the sender's
//           own throttle time (the random pause between two emails)
//   if the owner has no capacity left today (daily limit / warm-up) -> not before the next UTC midnight
//   then moved forward to the first moment both the campaign's sending window (+ start date) AND the owner's system guardrail are open.
// It never returns a time earlier than the step delay allows. An owner that cannot send at all right now (paused, disabled,
// health below its protection threshold, reply tracking broken) contributes nothing: that is "blocked", not a countdown.
// A sender's time is the earliest over its campaigns; a campaign's time is the earliest over the senders that own its waiting people.
var nextSend = require('../lib/nextSend');
var health = require('../lib/health');
var gate = require('../lib/senderGate');
var senders = require('./senders');

function utcDate(t) { return new Date(t).toISOString().slice(0, 10); }
function nextMidnight(t) { var d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }

// Why a sender cannot send at all right now (null = it can). Same order of checks as the engine's filter.
function blockedReason(s, now, requireTracking) {
  if (s.status !== 'active') return 'paused';
  if (health.isBelowFloor(s, now)) return 'health';
  if (!gate.trackingOk(s, now, requireTracking)) return 'tracking';
  return null;
}

// -> { bySender: {id: ms}, byCampaign: {id: ms}, senderBlock: {id: reason}, campaignBlock: {id: reason} }  (ids without an entry have no waiting people)
// opts.campaignIds limits the work to those campaigns; opts.guard is the owner's system guardrail window (or null).
function compute(db, userId, now, opts) {
  opts = opts || {};
  var ids = opts.campaignIds || null, guard = opts.guard || null, requireTracking = opts.requireTracking !== undefined ? !!opts.requireTracking : gate.isRequired();
  var filter = ids ? ' AND c.id IN (' + ids.map(function () { return '?'; }).join(',') + ')' : '';
  return db.all('SELECT cl.sender_id AS sid, c.id AS cid, c.window_start_hour, c.window_end_hour, c.utc_offset_min, c.weekdays_only, c.active_days, c.start_at, ' +
    'MIN(MAX(cl.next_send_at, COALESCE(s.next_send_at, 0))) AS due, s.status AS s_status, s.health_score, s.protection_level, s.force_until, s.imap_host, s.reply_detection, ' +
    's.imap_last_uid, s.sync_error, s.sync_transient, s.last_sync_at, s.daily_limit, s.sent_today, s.sent_today_date, s.warmup_enabled, s.warmup_started_at, s.warmup_days, s.warmup_pace, s.warmup_penalty ' +
    'FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id JOIN senders s ON s.id = cl.sender_id ' +
    "WHERE c.user_id = ? AND cl.status = 'active' AND c.status = 'active' AND cl.removed_at IS NULL" + filter + ' GROUP BY cl.sender_id, c.id', [userId].concat(ids || [])).then(function (groups) {
    var out = { bySender: {}, byCampaign: {}, senderBlock: {}, campaignBlock: {} }, today = utcDate(now);
    groups.forEach(function (g) {
      var sender = { status: g.s_status, health_score: g.health_score, protection_level: g.protection_level, force_until: g.force_until, imap_host: g.imap_host, reply_detection: g.reply_detection,
        imap_last_uid: g.imap_last_uid, sync_error: g.sync_error, sync_transient: g.sync_transient, last_sync_at: g.last_sync_at, daily_limit: g.daily_limit, sent_today: g.sent_today,
        sent_today_date: g.sent_today_date, warmup_enabled: g.warmup_enabled, warmup_started_at: g.warmup_started_at, warmup_days: g.warmup_days, warmup_pace: g.warmup_pace, warmup_penalty: g.warmup_penalty };
      var why = blockedReason(sender, now, requireTracking), at = null;
      if (why) {
        if (!out.senderBlock[g.sid]) out.senderBlock[g.sid] = why;
        if (!out.campaignBlock[g.cid]) out.campaignBlock[g.cid] = why;
        return;
      }
      var due = Number(g.due);
      if (senders.capacityToday(sender, today, now) <= 0) due = Math.max(due, nextMidnight(now));
      at = nextSend.effective(g, due, now, guard);
      if (at === null) return;       // the windows never overlap: no time exists
      if (out.bySender[g.sid] === undefined || at < out.bySender[g.sid]) out.bySender[g.sid] = at;
      if (out.byCampaign[g.cid] === undefined || at < out.byCampaign[g.cid]) out.byCampaign[g.cid] = at;
    });
    // A sender or campaign that has at least one usable time is not "blocked".
    Object.keys(out.bySender).forEach(function (k) { delete out.senderBlock[k]; });
    Object.keys(out.byCampaign).forEach(function (k) { delete out.campaignBlock[k]; });
    return out;
  });
}

module.exports = { compute: compute, blockedReason: blockedReason };
