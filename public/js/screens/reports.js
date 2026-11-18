/* public/js/screens/reports.js - Reports page (#/reports).
   One call to GET /api/reports draws everything: KPI tiles with change against the previous period, outreach over time,
   conversion funnel, per-step performance, reply sentiment, best weekdays, campaign leaderboard and sender performance.
   Charts are plain SVG built with SB.svg (attributes only, no markup strings, no libraries, CSP-safe). */
(function () {
  'use strict';
  var h = SB.h, svg = SB.svg, fmt = SB.fmt, ui = SB.ui, R = SB.S.reports;
  SB.screens = SB.screens || {};

  var PERIODS = [[7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months'], [365, 'Last year']];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Column chart: data = [{ label, value, tip }], cls = bar colour class. Axis shows 0, half and max.
  function columns(data, cls, o) {
    o = o || {};
    var W = 640, H = 190, L = 34, B = 24, T = 8, n = data.length, max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var step = (W - L) / n, bw = Math.max(2, Math.min(28, step * 0.7)), kids = [];
    [0, 0.5, 1].forEach(function (f) {
      var y = T + (H - B - T) * (1 - f);
      kids.push(svg('line', { x1: L, x2: W, y1: y, y2: y, class: 'ch-grid' }));
      kids.push(svg('text', { x: L - 6, y: y + 4, class: 'ch-axis', 'text-anchor': 'end', text: fmt.num(Math.round(max * f * 10) / 10) }));
    });
    var every = Math.max(1, Math.ceil(n / (o.maxLabels || 8)));
    data.forEach(function (d, i) {
      var ht = (H - B - T) * (d.value / max), x = L + i * step + (step - bw) / 2;
      kids.push(svg('rect', { x: x, y: T + (H - B - T) - ht, width: bw, height: Math.max(ht, d.value > 0 ? 2 : 0), rx: 2, class: 'ch-bar ' + cls }, svg('title', { text: d.tip || (d.label + ': ' + fmt.num(d.value)) })));
      if (i % every === 0) kids.push(svg('text', { x: x + bw / 2, y: H - 6, class: 'ch-axis', 'text-anchor': 'middle', text: d.label }));
    });
    return svg.apply(null, ['svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.label || 'Chart', preserveAspectRatio: 'xMidYMid meet' }].concat(kids));
  }

  // Horizontal bars with label and value on the left / right: rows = [{ label, value, of, cls, tip, note }]
  function hbars(rows) {
    return h('div', { class: 'hbars' }, rows.map(function (r) {
      var fill = h('span', { class: r.cls || '' }); fill.style.width = Math.max(r.value > 0 ? 1.5 : 0, Math.min(100, r.of ? r.value / r.of * 100 : 0)) + '%';
      return h('div', { class: 'hbar', tip: r.tip }, h('div', { class: 'hb-top' }, h('span', { text: r.label }), h('b', { text: fmt.num(r.value) + (r.of ? '  ·  ' + fmt.pct(r.value / r.of * 100) : '') })), h('div', { class: 'hb-track' }, fill), r.note ? h('div', { class: 'small faint', text: r.note }) : null);
    }));
  }

  // KPI tile with change vs the previous period. good: 'up' (higher is better) or 'down' (lower is better)
  function kpi(label, value, prev, tip, o) {
    o = o || {};
    var delta = null;
    if (prev !== null && prev !== undefined) {
      var d = o.points ? Math.round((value - prev) * 10) / 10 : (prev === 0 ? (value === 0 ? 0 : null) : Math.round((value - prev) / prev * 1000) / 10);
      if (d !== null && d !== 0) {
        var up = d > 0, good = (o.good === 'down') ? !up : up;
        delta = h('span', { class: 'delta ' + (good ? 'good' : 'bad'), tip: 'Compared with the previous period of the same length (' + (o.points ? fmt.pct(prev) : fmt.num(prev)) + ').' }, (up ? '▲ ' : '▼ ') + Math.abs(d) + (o.points ? ' pts' : '%'));
      } else if (d === 0) delta = h('span', { class: 'delta flat', text: 'no change' });
      else delta = h('span', { class: 'delta flat', text: 'new' });
    }
    var t = ui.tile(label, o.text || fmt.num(value), o.note || null, tip, o.attn);
    if (delta) t.appendChild(h('div', { class: 'note' }, delta));
    return t;
  }

  function cell(v) { var s = String(v === null || v === undefined ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }   // quoted; a leading = + - @ can never be read as a formula
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.setAttribute('href', URL.createObjectURL(blob)); a.setAttribute('download', name);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.getAttribute('href')); }, 2000);
  }
  function exportCsv(d) {
    var rows = [['Date', 'Emails sent', 'Opened', 'Replies', 'Bounces']].concat(d.series.map(function (s) { return [s.date, s.sent, s.opened, s.replied, s.bounced]; }));
    rows.push([], ['Campaign', 'Emails sent', 'Opened', 'Replied', 'Open rate %', 'Reply rate %']);
    d.campaigns.forEach(function (c) { rows.push([c.name, c.sent, c.opened, c.replied, c.open_rate, c.reply_rate]); });
    download('senderbolt-report-' + fmt.todayUtc() + '.csv', rows.map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n');
  }


  // ---- smooth line chart with area fill; points = [{ label, value, tip }] ----
  // Four equal gridline steps of 1, 2, 5 or 10 x 10^n so the axis labels are round numbers.
  function niceMax(v) { var raw = Math.max(v, 1) / 4, p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p * 4; }
  function lineChart(points, label) {
    var W = 720, H = 260, L = 44, R = 14, T = 12, B = 30, n = points.length, max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([1])));
    var kids = [], iw = W - L - R, ih = H - T - B;
    function X(i) { return L + (n === 1 ? iw / 2 : iw * i / (n - 1)); } function Y(v) { return T + ih * (1 - v / max); }
    for (var g = 0; g <= 4; g++) {
      var gy = T + ih * g / 4;
      kids.push(svg('line', { x1: L, x2: W - R, y1: gy, y2: gy, class: 'ch-grid' })); kids.push(svg('text', { x: L - 8, y: gy + 4, class: 'ch-axis', 'text-anchor': 'end', text: fmt.num(Math.round(max * (1 - g / 4))) }));
    }
    var every = Math.max(1, Math.ceil(n / 8));
    points.forEach(function (p, i) { if (i % every === 0) kids.push(svg('text', { x: X(i), y: H - 8, class: 'ch-axis', 'text-anchor': 'middle', text: p.label })); });
    // Catmull-Rom to Bezier, clamped so the curve never dips below zero.
    var d = '';
    if (n === 1) d = 'M' + X(0) + ',' + Y(points[0].value);
    else for (var i = 0; i < n; i++) {
      if (i === 0) { d = 'M' + X(0) + ',' + Y(points[0].value); continue; }
      var p0 = points[Math.max(0, i - 2)], p1 = points[i - 1], p2 = points[i], p3 = points[Math.min(n - 1, i + 1)];
      var x0 = X(Math.max(0, i - 2)), x1 = X(i - 1), x2 = X(i), x3 = X(Math.min(n - 1, i + 1));
      var c1y = Math.min(Y(0), Math.max(T, Y(p1.value) + (Y(p2.value) - Y(p0.value)) / 6)), c2y = Math.min(Y(0), Math.max(T, Y(p2.value) - (Y(p3.value) - Y(p1.value)) / 6));
      d += ' C' + (x1 + (x2 - x0) / 6) + ',' + c1y + ' ' + (x2 - (x3 - x1) / 6) + ',' + c2y + ' ' + x2 + ',' + Y(p2.value);
    }
    if (n > 1) kids.push(svg('path', { d: d + ' L' + X(n - 1) + ',' + Y(0) + ' L' + X(0) + ',' + Y(0) + ' Z', class: 'ln-area' }));
    kids.push(svg('path', { d: d, class: 'ln-line' }));
    points.forEach(function (p, i) { kids.push(svg('circle', { cx: X(i), cy: Y(p.value), r: n > 45 ? 2 : 4, class: 'ln-dot', tabindex: 0 }, svg('title', { text: p.tip }))); });
    return svg.apply(null, ['svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart line-chart', role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' }].concat(kids));
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(iso) { return MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)); }
  // Day -> as is; Week -> starts on Monday; Month -> calendar month. Sums the chosen metric.
  function group(series, metric, mode) {
    var out = [], idx = {};
    series.forEach(function (s) {
      var key = s.date, label = dayLabel(s.date);
      if (mode === 'week') { var dt = new Date(s.date + 'T00:00:00Z'), back = (dt.getUTCDay() + 6) % 7; dt = new Date(dt.getTime() - back * 86400000); key = dt.toISOString().slice(0, 10); label = 'Week of ' + dayLabel(key); }
      else if (mode === 'month') { key = s.date.slice(0, 7); label = MONTHS[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4); }
      if (idx[key] === undefined) { idx[key] = out.length; out.push({ label: label, short: mode === 'month' ? label.slice(0, 3) : (mode === 'week' ? dayLabel(key) : label), value: 0 }); }
      out[idx[key]].value += s[metric];
    });
    return out;
  }
  var METRICS = [['sent', 'Emails sent'], ['opened', 'Opens'], ['replied', 'Replies'], ['bounced', 'Bounces']];
  function domainOf(email) { var i = String(email || '').lastIndexOf('@'); return i === -1 ? '(unknown)' : email.slice(i + 1).toLowerCase(); }

  SB.screens.reports = function () {
    var root = h('div'), body = h('div', null, h('div', { class: 'skeleton' })), dead = false, last = null, opts = false;
    var st = { tab: 'campaigns', days: 7, campaign: '', sender: '', mode: 'day', metric: 'sent', top: 'sent' };
    var TABS = [['campaigns', 'Campaigns'], ['team', 'Team members'], ['accounts', 'Email accounts'], ['domains', 'Email domains']];
    var periodSel = h('select', { class: 'input input-sm', 'aria-label': 'Period' }, PERIODS.map(function (p) { return h('option', { value: p[0] }, p[1]); })); periodSel.value = String(st.days);
    var campSel = h('select', { class: 'input input-sm', 'aria-label': 'Campaign' }, h('option', { value: '' }, 'All campaigns'));
    var sendSel = h('select', { class: 'input input-sm', 'aria-label': 'Email account' }, h('option', { value: '' }, 'All email accounts'));
    var exportBtn = h('button', { class: 'btn btn-sm', type: 'button', disabled: true, tip: 'Download the daily numbers and the campaign table as a CSV file for Excel or Google Sheets.' }, SB.icon('download'), 'Export CSV');
    var tabsBox = h('div'), filtersBox = h('div');
    periodSel.addEventListener('change', function () { st.days = Number(periodSel.value); load(); });
    campSel.addEventListener('change', function () { st.campaign = campSel.value; load(); });
    sendSel.addEventListener('change', function () { st.sender = sendSel.value; load(); });
    exportBtn.addEventListener('click', function () { if (last) exportCsv(last); });
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Reporting' }), h('p', { class: 'sub', text: 'How your outreach performs: totals, trends over time and your best campaigns, accounts and domains.' })), h('div', { class: 'actions' }, exportBtn)));
    root.appendChild(tabsBox); root.appendChild(body);

    function insights(d, slot) {
      var t = d.totals, p = d.previous, f = d.funnel, tracked = t.opened > 0 || p.opened > 0;
      var days = d.series.map(function (s) { var dt = new Date(s.date + 'T00:00:00Z'); return { date: s.date, label: (d.range.days > 60 ? dt.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })), s: s }; });
      var sentSum = Object.keys(d.sentiment).reduce(function (a, k) { return a + d.sentiment[k]; }, 0);
      SB.mount(slot, h('div', null,
        h('div', { class: 'rp-grid' },
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Conversion funnel' }), ui.info(R.funnelTip)),
            f.contacted ? h('div', null, h('div', { class: 'section-title' }), hbars([
              { label: 'Contacted', value: f.contacted, of: f.contacted, cls: 'c-sent', tip: 'People whose first email was sent in this period.' },
              { label: 'Got a follow-up', value: f.followed_up, of: f.contacted, cls: 'c-sent2', tip: 'People who were still in the sequence and received at least one follow-up.' },
              { label: 'Replied', value: f.replied, of: f.contacted, cls: 'c-reply', tip: 'People who wrote back (any reply).' },
              { label: 'Interested', value: f.interested, of: f.contacted, cls: 'c-int', tip: 'People whose reply you or SenderBolt tagged "Interested".' }]),
              h('div', { class: 'funnel-foot small muted' }, h('span', null, fmt.num(f.bounced) + ' bounced'), h('span', null, fmt.num(f.opted_out) + ' opted out'), h('span', null, fmt.num(f.still_running) + ' still in sequence')))
              : h('p', { class: 'muted pad-t', text: 'No first emails went out in this period.' })),
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Performance by email' }), ui.info(R.stepsTip)),
            d.steps.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table compact-table' }, h('thead', null, h('tr', null, h('th', { text: 'Email' }), h('th', { text: 'Sent' }), h('th', { text: 'Opened' }), h('th', { text: 'Replies' }), h('th', { text: 'Reply rate' }))),
              h('tbody', null, d.steps.map(function (s) { return h('tr', null, h('td', { text: s.step === 0 ? 'First email' : 'Follow-up ' + s.step }), h('td', { text: fmt.num(s.sent) }), h('td', { text: tracked ? fmt.num(s.opened) + ' (' + fmt.pct(s.open_rate) + ')' : '—' }), h('td', { text: fmt.num(s.replied) }), h('td', null, h('b', { text: fmt.pct(s.reply_rate) }))); }))))
              : h('p', { class: 'muted pad-t', text: 'Nothing sent yet.' }))),
        h('div', { class: 'rp-grid' },
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Reply sentiment' }), ui.info(R.sentimentTip)),
            sentSum ? h('div', null, h('div', { class: 'section-title' }), ui.sentimentBar(d.sentiment), h('p', { class: 'small muted pad-t', text: fmt.num(d.sentiment.out_of_office) + ' out-of-office and ' + fmt.num(d.sentiment.unclassified) + ' untagged replies are not shown in the bar.' })) : h('p', { class: 'muted pad-t', text: 'No replies in this period.' })),
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Replies by weekday' }), ui.info(R.weekdayTip)),
            columns(d.weekday.map(function (n, i) { return { label: WEEKDAYS[i], value: n, tip: WEEKDAYS[i] + ': ' + n + ' repl' + (n === 1 ? 'y' : 'ies') }; }), 'c-reply', { label: 'Replies by weekday', maxLabels: 7 }))),
        h('div', { class: 'section-title' }, h('h2', { text: 'Campaigns' })),
        d.campaigns.length ? h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Campaign' }), h('th', { text: 'Sent' }), h('th', { text: 'Opened' }), h('th', { text: 'Replied' }), h('th', { text: 'Reply rate' }))),
          h('tbody', null, d.campaigns.map(function (c) { return h('tr', { class: 'row-link', on: { click: function () { location.hash = '#/campaign/' + c.id + '/overview'; } } }, h('td', null, h('a', { href: '#/campaign/' + c.id + '/overview', text: c.name })), h('td', { text: fmt.num(c.sent) }), h('td', { text: tracked ? fmt.num(c.opened) + ' (' + fmt.pct(c.open_rate) + ')' : '—' }), h('td', { text: fmt.num(c.replied) }), h('td', null, h('b', { text: fmt.pct(c.reply_rate) }))); }))))) : null,
        h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Sender accounts' }), ui.info('Per sending account. A bounce rate above 3% can damage the account\'s reputation: pause it and check your list quality.'))),
        d.senders.length ? h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Account' }), h('th', { text: 'Sent' }), h('th', { text: 'Replies' }), h('th', { text: 'Reply rate' }), h('th', { text: 'Bounce rate' }))),
          h('tbody', null, d.senders.map(function (s) { return h('tr', null, h('td', null, s.label ? h('b', { text: s.label }) : ui.email(s.email, 'strong', 'b'), s.label && s.email ? ui.email(s.email, 'small faint', 'div') : null), h('td', { text: fmt.num(s.sent) }), h('td', { text: fmt.num(s.replied) }), h('td', { text: fmt.pct(s.reply_rate) }),
            h('td', null, s.bounce_rate > 3 ? h('span', { class: 'chip chip-bad', tip: 'Above 3%: this account is at risk. Pause it and clean your list.' }, fmt.pct(s.bounce_rate)) : fmt.pct(s.bounce_rate))); }))))) : null,
        h('p', { class: 'hint pad-t', text: 'Opens are estimates (some mail apps load images automatically, others block them); replies are the reliable signal. Changes compare with the previous period of the same length.' })));
    }

    function paintTabs() {
      SB.mount(tabsBox, h('div', { class: 'segs tabs studio-tabs', role: 'tablist' }, TABS.map(function (t) {
        return h('button', { type: 'button', class: 'seg' + (t[0] === st.tab ? ' active' : ''), role: 'tab', 'aria-selected': t[0] === st.tab ? 'true' : 'false', on: { click: function () { st.tab = t[0]; st.top = 'sent'; if (st.sender || st.campaign) { st.sender = ''; st.campaign = ''; campSel.value = ''; sendSel.value = ''; paintTabs(); load(); return; } paintTabs(); if (last) paint(last); } } }, t[1]);
      })));
    }
    function fillFilters(d) {
      if (opts) return; opts = true;
      d.campaigns.forEach(function (c) { campSel.appendChild(h('option', { value: c.id }, c.name)); });
      d.senders.forEach(function (s) { sendSel.appendChild(h('option', { value: s.id }, s.label || s.email)); });
    }
    function pctN(n, den) { return (den ? fmt.pct(Math.round(n / den * 1000) / 10) : '0%') + ' (' + fmt.num(n) + ')'; }
    function metric(icon, label, value, sub, tipText) {
      return h('div', { class: 'rp-metric', tip: tipText }, h('div', { class: 'rp-m-label' }, SB.icon(icon), label), h('div', { class: 'rp-m-value' }, h('b', { text: value }), sub ? h('span', { class: 'small muted', text: sub }) : null));
    }
    // Rows for the "Top ..." list and the table under it, depending on the tab.
    function rowsFor(d) {
      var t = d.totals;
      if (st.tab === 'campaigns') return { title: 'Top campaigns', noun: 'Campaign', rows: d.campaigns.map(function (c) { return { name: c.name, sub: '', sent: c.sent, opened: c.opened, replied: c.replied, bounced: null, href: '#/campaign/' + c.id + '/overview' }; }) };
      if (st.tab === 'team') return { title: 'Team members', noun: 'Member', rows: [{ name: 'You', sub: 'SenderBolt is a single-user workspace: everything you send is shown here.', sent: t.sent, opened: t.opened, replied: t.replied, bounced: t.bounced }] };
      if (st.tab === 'accounts') return { title: 'Top email accounts', noun: 'Account', rows: d.senders.map(function (x) { return { name: x.label || x.email, sub: x.label ? x.email : '', sent: x.sent, opened: null, replied: x.replied, bounced: x.bounced }; }) };
      var dm = {}; d.senders.forEach(function (x) { var k = domainOf(x.email); dm[k] = dm[k] || { name: k, sub: '', sent: 0, opened: null, replied: 0, bounced: 0 }; dm[k].sent += x.sent; dm[k].replied += x.replied; dm[k].bounced += x.bounced; });
      return { title: 'Top email domains', noun: 'Domain', rows: Object.keys(dm).map(function (k) { return dm[k]; }) };
    }
    function paint(d) {
      var t = d.totals;
      SB.mount(filtersBox, h('div', { class: 'rp-filters' }, st.tab === 'accounts' ? sendSel : campSel, periodSel));
      if (!t.sent && !d.previous.sent) {
        SB.mount(body, h('div', null, h('div', { class: 'card empty' }, h('h2', { text: 'No emails sent in this period' }), h('p', { text: 'Once campaigns start sending, results appear here. Try a longer period.' }), h('a', { class: 'btn btn-primary', href: '#/' }, 'Go to campaigns')))); return;
      }
      var tracked = t.opened > 0 || d.previous.opened > 0;
      var strip = h('div', { class: 'rp-strip' },
        metric('mail', 'Sent', fmt.num(t.sent), '', SB.S.metric.sent),
        metric('alert', 'Bounces', fmt.pct(t.bounce_rate), '(' + fmt.num(t.bounced) + ')', SB.S.metric.bounceRate),
        metric('eye', 'Opens', tracked ? fmt.pct(t.open_rate) : '—', tracked ? '(' + fmt.num(t.opened) + ')' : 'not tracked', SB.S.metric.opens),
        metric('bolt', 'Clicks', '—', 'not tracked', 'SenderBolt does not rewrite your links, which keeps emails out of spam folders. Replies are the signal to watch.'),
        metric('inbox', 'Replies', fmt.pct(t.reply_rate), '(' + fmt.num(t.replied) + ')', 'People who wrote back divided by emails sent. Out-of-office and bounce notices do not count.'),
        metric('check', 'Successful', t.sent ? fmt.pct(Math.round(t.interested / t.sent * 1000) / 10) : '0%', '(' + fmt.num(t.interested) + ')', 'Replies tagged "Interested" in your Inbox.'));
      var seg = function (key, label) { return h('button', { type: 'button', class: 'seg' + (st.mode === key ? ' active' : ''), on: { click: function () { st.mode = key; paint(d); } } }, label); };
      var metricSel = h('select', { class: 'input input-sm', 'aria-label': 'Metric' }, METRICS.map(function (m) { return h('option', { value: m[0] }, m[1]); })); metricSel.value = st.metric;
      metricSel.addEventListener('change', function () { st.metric = metricSel.value; paint(d); });
      var pts = group(d.series, st.metric, st.mode).map(function (p) { return { label: p.short, value: p.value, tip: p.label + ': ' + fmt.num(p.value) + ' ' + (METRICS.filter(function (m) { return m[0] === st.metric; })[0][1]).toLowerCase() }; });
      var chart = h('div', { class: 'card rp-chart' }, h('div', { class: 'rp-chart-bar' }, h('div', { class: 'segs' }, seg('day', 'Day'), seg('week', 'Week'), seg('month', 'Month')), metricSel, ui.info(R.seriesTip)), lineChart(pts, 'Trend of ' + st.metric));
      var rf = rowsFor(d), key = st.top;
      var topSel = h('select', { class: 'input input-sm', 'aria-label': 'Rank by' }, [['sent', 'Emails sent'], ['replied', 'Replies']].concat(rf.rows.some(function (r) { return r.opened !== null; }) && tracked ? [['opened', 'Opens']] : []).map(function (m) { return h('option', { value: m[0] }, m[1]); })); topSel.value = key;
      topSel.addEventListener('change', function () { st.top = topSel.value; paint(d); });
      var ranked = rf.rows.slice().sort(function (a, b) { return (b[key] || 0) - (a[key] || 0); }).slice(0, 8);
      var top = h('div', { class: 'card rp-top' }, h('div', { class: 'rp-top-h' }, h('h3', { text: rf.title }), topSel),
        ranked.length ? h('ol', { class: 'rp-top-list' }, ranked.map(function (r, i) {
          return h('li', null, h('span', { class: 'rp-rank small faint', text: '#' + (i + 1) }), h('div', { class: 'rp-top-name' }, r.href ? h('a', { href: r.href, text: r.name }) : h('span', { text: r.name }), r.sub ? h('div', { class: 'small faint', text: r.sub }) : null), h('b', { class: 'rp-top-n', text: fmt.num(r[key] || 0) }));
        })) : h('p', { class: 'muted', text: 'Nothing to rank yet.' }));
      var tbl = h('div', { class: 'card flush rp-table' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { text: rf.noun }), h('th', { class: 'num', text: 'Sent' }), h('th', { class: 'num', text: 'Opens' }), h('th', { class: 'num', text: 'Replies' }), h('th', { class: 'num', text: 'Bounces' }))),
        h('tbody', null, rf.rows.map(function (r) {
          return h('tr', null, h('td', null, r.href ? h('a', { href: r.href, text: r.name }) : h('b', { text: r.name }), r.sub ? h('div', { class: 'small faint', text: r.sub }) : null), h('td', { class: 'num', text: fmt.num(r.sent) }),
            h('td', { class: 'num', text: r.opened === null || !tracked ? '—' : pctN(r.opened, r.sent) }), h('td', { class: 'num', text: pctN(r.replied, r.sent) }),
            h('td', { class: 'num' + (r.bounced !== null && r.sent && r.bounced / r.sent > 0.03 ? ' bad' : ''), text: r.bounced === null ? '—' : pctN(r.bounced, r.sent) }));
        })))));
      var ins = h('div');
      SB.mount(body, h('div', null, h('div', { class: 'rp-over' }, h('h2', { text: 'Overview' }), filtersBox), strip, h('div', { class: 'rp-main' }, chart, top), h('div', { class: 'section-title' }, h('h2', { text: rf.title.replace('Top ', '') })), tbl,
        st.tab === 'campaigns' ? h('div', null, h('div', { class: 'section-title' }, h('h2', { text: 'Insights' })), ins) : null));
      if (st.tab === 'campaigns') insights(d, ins);
    }

    function load() {
      SB.mount(body, h('div', { class: 'skeleton' }));
      var q = '?days=' + st.days + '&tz=' + (-new Date().getTimezoneOffset()) + (st.campaign ? '&campaign_id=' + st.campaign : '') + (st.sender ? '&sender_id=' + st.sender : '');
      return SB.api.get('/api/reports' + q).then(function (d) { if (dead) return; last = d; exportBtn.disabled = false; fillFilters(d); paintTabs(); paint(d); },
        function (e) { if (!dead) SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    load();
    return { el: root, destroy: function () { dead = true; } };
  };
})();
