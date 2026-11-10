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
  function full(ts) { return ts ? new Date(ts).toLocaleString() : ''; }
  function todayUtc() { return new Date().toISOString().slice(0, 10); }
  SB.fmt = { num: num, pct: pct, until: until, ago: ago, full: full, todayUtc: todayUtc };
})();
