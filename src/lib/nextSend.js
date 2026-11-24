'use strict';
// "When will the next email really go out?" Pure helpers shared by senders, campaigns and projects.
// An email is due at a time, but it only goes out when the campaign's sending window is open (hours + days, in the campaign's
// own UTC offset) and its optional start date has been reached. These helpers apply those rules so the UI can show a real
// countdown instead of a vague "any moment".

var DAY = 86400000;

// Earliest time >= t at which campaign c (window_start_hour, window_end_hour, utc_offset_min, weekdays_only, active_days, start_at)
// is allowed to send. Returns null when no day is selected / the window is empty.
function nextWindowOpen(c, t) {
  var from = Math.max(t, c.start_at || 0), off = (c.utc_offset_min || 0) * 60000;
  var sh = c.window_start_hour === undefined || c.window_start_hour === null ? 0 : c.window_start_hour;
  var eh = c.window_end_hour === undefined || c.window_end_hour === null ? 24 : c.window_end_hour;
  var mask = c.active_days ? c.active_days : (c.weekdays_only ? 62 : 127);
  if (eh <= sh || !(mask & 127)) return null;
  var local = from + off, dayStart = Math.floor(local / DAY) * DAY;
  for (var i = 0; i < 9; i++) {
    var d = dayStart + i * DAY, dow = new Date(d).getUTCDay();
    if (!(mask & (1 << dow))) continue;
    var open = d + sh * 3600000, close = d + eh * 3600000;
    if (local < close) return Math.max(local, open) - off;
  }
  return null;
}

// System guardrail (Settings -> System preferences): an optional window every campaign must stay inside, on top of its own
// sending window. `guard` is null (off) or a window object in the same shape as a campaign
// { window_start_hour, window_end_hour, utc_offset_min, weekdays_only }.
// Earliest time >= t that is inside BOTH the campaign window and the guardrail. The two windows are periodic, so the loop
// converges within a few steps; null means they never overlap (for example 9-12 vs 14-18), so nothing could ever be sent.
function nextAllowed(c, t, guard) {
  if (!guard) return nextWindowOpen(c, t);
  var cur = t;
  for (var i = 0; i < 24; i++) {
    var a = nextWindowOpen(c, cur);
    if (a === null) return null;
    var g = nextWindowOpen(guard, a);
    if (g === null) return null;
    if (g === a) return a;
    cur = g;
  }
  return null;
}

// due: the time the work is ready (ms) -> the time it can really be sent. The step interval is never shortened: the result is
// always >= due, it only moves later when a window (campaign or guardrail) is closed.
function effective(c, due, now, guard) { return nextAllowed(c, Math.max(due, now), guard); }

module.exports = { nextWindowOpen: nextWindowOpen, nextAllowed: nextAllowed, effective: effective };
