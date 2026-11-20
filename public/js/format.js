(function () {
  'use strict';
  function num(x) { return Number(x || 0).toLocaleString('en-US'); }
  function pct(x) { return (Math.round(Number(x || 0) * 10) / 10) + '%'; }
  // Countdown in days, hours and minutes only (never seconds): "in 2d 4h 15m", "in 3h", "in 12m". Anything under a minute reads "in 1m".
  // "Due" means due now: it is shown as "in 1m" too, because the engine picks work up within its next 5-second cycle and then spaces emails by the sender's delay.
  function span(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000)), d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60), mi = m % 60, out = [];
    if (d) out.push(d + 'd'); if (hr) out.push(hr + 'h'); if (mi || !out.length) out.push(mi + 'm');
    return out.join(' ');
  }
  function until(ts) { return ts === null || ts === undefined ? '\u2014' : 'in ' + span(ts - Date.now()); }
  function ago(ts) {
    if (!ts) return '—';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  // "11 minutes ago", "1 hour ago", "3 days ago": the full-word age used in tables (hover for the exact date and time).
  function age(ts) {
    if (!ts) return '';
    var m = Math.floor((Date.now() - ts) / 60000);
    function u(n, w) { return n + ' ' + w + (n === 1 ? '' : 's') + ' ago'; }
    if (m < 1) return 'just now'; if (m < 60) return u(m, 'minute');
    var hr = Math.floor(m / 60); if (hr < 24) return u(hr, 'hour');
    var d = Math.floor(hr / 24); if (d < 30) return u(d, 'day');
    var mo = Math.floor(d / 30); if (mo < 12) return u(mo, 'month');
    return u(Math.floor(d / 365), 'year');
  }
  // ---- dates: one professional style everywhere ("Nov 12, 2026" / "Nov 12, 2026, 3:45 PM"), always in the viewer's own zone ----
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function clock(d) { var hr = d.getHours(), m = d.getMinutes(); return (hr % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (hr < 12 ? 'AM' : 'PM'); }
  function date(ts) { if (!ts) return ''; var d = new Date(ts); return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  function dateTime(ts) { return ts ? date(ts) + ', ' + clock(new Date(ts)) : ''; }
  // "Today", "Yesterday", or the date; used where a calendar day reads better than "3d ago".
  function day(ts) {
    if (!ts) return '';
    var d = new Date(ts), t = new Date(), a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), b = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    var diff = Math.round((b - a) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : date(ts);
  }
  // "Created Nov 12, 2026" - the standard creation line for lists, campaigns and projects (full date and time on hover via tip()).
  function created(ts) { return ts ? 'Created ' + date(ts) : ''; }
  function tip(ts) { return ts ? dateTime(ts) + ' (' + ago(ts) + ')' : ''; }
  function full(ts) { return dateTime(ts); }
  // Sending hours are stored as 0-24; people read them as 12-hour clock times: 9 -> "9:00 AM", 17 -> "5:00 PM", 24 -> "12:00 AM".
  function hour12(hr) { hr = Number(hr); var h24 = hr % 24; return (h24 % 12 || 12) + ':00 ' + (h24 < 12 ? 'AM' : 'PM'); }
  function hourRange(from, to) { return hour12(from) + ' to ' + hour12(to); }
  // Today's calendar date (YYYY-MM-DD) at a UTC offset in minutes: the earliest value a campaign start-date picker may offer.
  function todayAt(offsetMin) { return new Date(Date.now() + (offsetMin || 0) * 60000).toISOString().slice(0, 10); }
  // "2026-11-12" -> "Nov 12, 2026" without any time-zone shift.
  function isoDate(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : ''; }
  function todayUtc() { return new Date().toISOString().slice(0, 10); }
  SB.fmt = { num: num, pct: pct, until: until, span: span, age: age, ago: ago, full: full, todayUtc: todayUtc, date: date, dateTime: dateTime, day: day, created: created, tip: tip, hour12: hour12, hourRange: hourRange, todayAt: todayAt, isoDate: isoDate };
})();
