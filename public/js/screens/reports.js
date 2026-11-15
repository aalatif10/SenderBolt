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

  SB.screens.reports = function () {
    var root = h('div'), body = h('div', null, h('div', { class: 'skeleton' })), dead = false, st = { days: 30, campaign: '', sender: '' }, opts = null;
    var periodSel = h('select', { class: 'input', 'aria-label': 'Period' }, PERIODS.map(function (p) { return h('option', { value: p[0] }, p[1]); })); periodSel.value = '30';
    var campSel = h('select', { class: 'input', 'aria-label': 'Campaign' }, h('option', { value: '' }, 'All campaigns'));
    var sendSel = h('select', { class: 'input', 'aria-label': 'Sender' }, h('option', { value: '' }, 'All senders'));
    var exportBtn = h('button', { class: 'btn btn-sm', type: 'button', disabled: true, tip: 'Download the daily numbers and the campaign table as a CSV file for Excel or Google Sheets.' }, SB.icon('download'), 'Export CSV');
    var last = null;
    periodSel.addEventListener('change', function () { st.days = Number(periodSel.value); load(); });
    campSel.addEventListener('change', function () { st.campaign = campSel.value; load(); });
    sendSel.addEventListener('change', function () { st.sender = sendSel.value; load(); });
    exportBtn.addEventListener('click', function () { if (last) exportCsv(last); });
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Reports' }), h('p', { class: 'sub', text: 'How your outreach performs, how people move through your sequences and when they answer.' })), h('div', { class: 'actions' }, exportBtn)));
    root.appendChild(h('div', { class: 'toolbar report-filters' }, periodSel, campSel, sendSel));
    root.appendChild(body);

    function fillFilters(d) {
      if (opts) return; opts = true;
      d.campaigns.forEach(function (c) { campSel.appendChild(h('option', { value: c.id }, c.name)); });
      d.senders.forEach(function (s) { sendSel.appendChild(h('option', { value: s.id }, s.label || s.email)); });
    }

    function paint(d) {
      var t = d.totals, p = d.previous, f = d.funnel, tracked = t.opened > 0 || p.opened > 0;
      if (!t.sent && !p.sent) {
        SB.mount(body, h('div', { class: 'card empty' }, h('h2', { text: 'No emails sent in this period' }), h('p', { text: 'Once campaigns start sending, results appear here: replies, sentiment, best days and more.' }), h('a', { class: 'btn btn-primary', href: '#/' }, 'Go to Home')));
        return;
      }
      var days = d.series.map(function (s) { var dt = new Date(s.date + 'T00:00:00Z'); return { date: s.date, label: (d.range.days > 60 ? dt.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })), s: s }; });
      var sentSum = Object.keys(d.sentiment).reduce(function (a, k) { return a + d.sentiment[k]; }, 0);
      SB.mount(body, h('div', null,
        h('div', { class: 'grid-tiles kpis' },
          kpi('Emails sent', t.sent, p.sent, SB.S.metric.sent), kpi('People contacted', t.contacted, p.contacted, 'People whose first email went out in this period.'),
          tracked ? kpi('Open rate', t.open_rate, p.open_rate, SB.S.metric.opens, { points: true, text: fmt.pct(t.open_rate) }) : ui.tile('Open rate', 'Not tracked', 'Turn on open tracking per campaign', SB.S.metric.opens),
          kpi('Reply rate', t.reply_rate, p.reply_rate, 'People who wrote back divided by emails sent. Out-of-office and bounce notices do not count.', { points: true, text: fmt.pct(t.reply_rate), note: fmt.num(t.replied) + ' replied' }),
          kpi('Interested', t.interested, p.interested, 'Replies tagged "Interested" in your Inbox.', { note: fmt.pct(t.interested_rate) + ' of replies' }),
          kpi('Bounce rate', t.bounce_rate, p.bounce_rate, SB.S.metric.bounceRate, { points: true, good: 'down', text: fmt.pct(t.bounce_rate), attn: t.bounce_rate > 3, note: fmt.num(t.bounced) + ' bounced' })),
        h('div', { class: 'rp-grid' },
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Emails sent per day' }), ui.info(R.seriesTip)),
            columns(days.map(function (x) { return { label: x.label, value: x.s.sent, tip: x.date + ': ' + x.s.sent + ' sent, ' + x.s.opened + ' opened' }; }), 'c-sent', { label: 'Emails sent per day' })),
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Replies per day' }), ui.info(R.seriesTip)),
            columns(days.map(function (x) { return { label: x.label, value: x.s.replied, tip: x.date + ': ' + x.s.replied + ' repl' + (x.s.replied === 1 ? 'y' : 'ies') + (x.s.bounced ? ', ' + x.s.bounced + ' bounced' : '') }; }), 'c-reply', { label: 'Replies per day' }))),
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
          h('tbody', null, d.senders.map(function (s) { return h('tr', null, h('td', null, h('b', { text: s.label || s.email }), s.label && s.email ? h('div', { class: 'small faint', text: s.email }) : null), h('td', { text: fmt.num(s.sent) }), h('td', { text: fmt.num(s.replied) }), h('td', { text: fmt.pct(s.reply_rate) }),
            h('td', null, s.bounce_rate > 3 ? h('span', { class: 'chip chip-bad', tip: 'Above 3%: this account is at risk. Pause it and clean your list.' }, fmt.pct(s.bounce_rate)) : fmt.pct(s.bounce_rate))); }))))) : null,
        h('p', { class: 'hint pad-t', text: 'Opens are estimates (some mail apps load images automatically, others block them); replies are the reliable signal. Changes compare with the previous period of the same length.' })));
    }

    function load() {
      SB.mount(body, h('div', { class: 'skeleton' }));
      var q = '?days=' + st.days + '&tz=' + (-new Date().getTimezoneOffset()) + (st.campaign ? '&campaign_id=' + st.campaign : '') + (st.sender ? '&sender_id=' + st.sender : '');
      return SB.api.get('/api/reports' + q).then(function (d) { if (dead) return; last = d; exportBtn.disabled = false; fillFilters(d); paint(d); },
        function (e) { if (!dead) SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    load();
    return { el: root, destroy: function () { dead = true; } };
  };
})();
