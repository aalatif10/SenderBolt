(function () {
  'use strict';
  function num(x) { return Number(x || 0).toLocaleString('en-US'); }
  function pct(x) { return (Math.round(Number(x || 0) * 10) / 10) + '%'; }
  // "in 4m", "in 2h 10m", "in 3d"; null -> dash
  function until(ts) {
    if (ts === null || ts === undefined) return '—';
    var s = Math.round((ts - Date.now()) / 1000);
    if (s <= 30) return 'any moment';
    var m = Math.round(s / 60);
    if (m < 60) return 'in ' + m + 'm';
    var hr = Math.floor(m / 60);
    if (hr < 24) return 'in ' + hr + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    return 'in ' + Math.round(hr / 24) + 'd';
  }
  function ago(ts) {
    if (!ts) return '—';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
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
  SB.fmt = { num: num, pct: pct, until: until, ago: ago, full: full, todayUtc: todayUtc, date: date, dateTime: dateTime, day: day, created: created, tip: tip, hour12: hour12, hourRange: hourRange, todayAt: todayAt, isoDate: isoDate };
})();
