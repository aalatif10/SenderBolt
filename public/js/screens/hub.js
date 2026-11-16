/* Outreach hub screens (public/js/screens/hub.js): Engagement, Queue and Unsubscriptions.
   Frontend only: they read existing endpoints (/api/campaigns, /api/campaigns/:id/opens, /api/suppression, /api/senders).
     engagement      one row per person who opened anything: opens, campaign, last activity (open tracking must be on)
     queue           what is waiting to go out: per running campaign, people waiting and the countdown to the next email
     unsubscriptions everyone who must not be emailed, filtered All / Unsubscribed / Bounced, searchable, CSV download */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};

  function head(title, sub, actions) {
    return h('div', { class: 'page-head' }, h('div', null, h('h1', { text: title }), sub ? h('p', { class: 'sub', text: sub }) : null), actions ? h('div', { class: 'actions' }, actions) : null);
  }
  function fail(slot, e) { SB.mount(slot, h('div', { class: 'form-error', text: SB.api.friendly(e) })); }
  function mainCampaigns(items) { return (items || []).filter(function (c) { return !c.parent_id; }); }
  function initials(email) { return String(email || '?').slice(0, 2).toUpperCase(); }
  function hue(email) { var n = 0, i; for (i = 0; i < email.length; i++) n = (n * 31 + email.charCodeAt(i)) % 360; return n; }
  function avatar(email) { var a = h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(email) }); a.setAttribute('data-h', String(Math.round(hue(String(email)) / 45))); return a; }
  function filterBar(count, label, controls) { return h('div', { class: 'hub-bar' }, h('span', { class: 'hub-count', text: fmt.num(count) + ' ' + label }), h('div', { class: 'hub-filters' }, controls)); }

  // ---------------- Engagement ----------------
  SB.screens.engagement = function () {
    var root = h('div'), dead = false, rows = [], st = { q: '', min: 0, camp: 'all' }, box = h('div'), barBox = h('div'), warn = h('div');
    root.appendChild(head('Engagement', 'Who opened your emails, how many times, and when they last did.'));
    root.appendChild(warn); root.appendChild(barBox); root.appendChild(box);
    SB.mount(box, h('div', { class: 'skeleton' }));

    function paint() {
      var camps = {}; rows.forEach(function (r) { camps[r.campaign_id] = r.campaign; });
      var list = rows.filter(function (r) { return (st.camp === 'all' || String(r.campaign_id) === st.camp) && r.opens > st.min && (!st.q || r.email.toLowerCase().indexOf(st.q.toLowerCase()) !== -1); });
      var q = h('input', { class: 'input', type: 'search', placeholder: 'Search recipients', 'aria-label': 'Search recipients', maxlength: 100, value: st.q });
      q.addEventListener('input', function () { st.q = q.value; paintTable(); });
      var minSel = h('select', { class: 'input', 'aria-label': 'Opens filter', tip: 'Show everyone, or only people who opened more than once.' }, [h('option', { value: 0 }, 'Opens: any'), h('option', { value: 1 }, 'Opened more than once'), h('option', { value: 2 }, 'Opened more than twice')]);
      minSel.value = String(st.min); minSel.addEventListener('change', function () { st.min = Number(minSel.value); paint(); });
      var campSel = h('select', { class: 'input', 'aria-label': 'Campaign filter' }, [h('option', { value: 'all' }, 'All campaigns')].concat(Object.keys(camps).map(function (id) { return h('option', { value: id }, camps[id]); })));
      campSel.value = st.camp; campSel.addEventListener('change', function () { st.camp = campSel.value; paint(); });
      SB.mount(barBox, filterBar(list.length, 'recipient' + (list.length === 1 ? '' : 's'), [q, minSel, campSel]));
      paintTable();
      function paintTable(l) {
        var shown = rows.filter(function (r) { return (st.camp === 'all' || String(r.campaign_id) === st.camp) && r.opens > st.min && (!st.q || r.email.toLowerCase().indexOf(st.q.toLowerCase()) !== -1); });
        if (!rows.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'No opens recorded yet' }), h('p', { text: 'When someone opens a tracked email, they appear here with their open count and last activity.' }))); return; }
        if (!shown.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'Nobody matches' }), h('p', { text: 'Try a different search or filter.' }))); return; }
        SB.mount(box, h('div', { class: 'table-wrap card' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', { text: 'Recipient' }), h('th', { text: 'Campaign' }), h('th', null, 'Opens ', ui.info('How many times this person opened your emails in this campaign. Counts are estimates.')), h('th', { text: 'Last activity' }), h('th'))),
          h('tbody', null, shown.slice(0, 500).map(function (r) {
            return h('tr', { class: 'row-link', on: { click: function () { location.hash = '#/campaign/' + r.campaign_id + '/opens'; } } },
              h('td', null, h('div', { class: 'who' }, avatar(r.email), h('div', null, h('b', { class: 'break', text: r.name || r.email }), r.name ? h('div', { class: 'small faint', text: r.email }) : null))),
              h('td', { text: r.campaign }), h('td', null, h('span', { class: 'eye', tip: 'Opened ' + r.opens + ' time' + (r.opens === 1 ? '' : 's') }, SB.icon('eye'), String(r.opens))),
              h('td', { class: 'nowrap', tip: fmt.full(r.last) }, 'Opened · ' + fmt.ago(r.last)), h('td', null, h('span', { class: 'faint' }, SB.icon('chevron'))));
          })))));
      }
    }

    SB.api.get('/api/campaigns').then(function (r) {
      var camps = mainCampaigns(r.items).slice(0, 40);
      return Promise.all(camps.map(function (c) {
        return SB.api.get('/api/campaigns/' + c.id + '/opens?limit=500').then(function (o) { return { c: c, o: o }; }, function () { return { c: c, o: null }; });
      }));
    }).then(function (res) {
      if (dead) return;
      var byKey = {}, tracked = 0;
      res.forEach(function (x) {
        if (!x.o || !x.o.tracking_enabled) return; tracked++;
        x.o.rows.forEach(function (r) {
          var k = x.c.id + '|' + r.email.toLowerCase(), row = byKey[k];
          var last = r.last_opened_at || r.first_opened_at || 0;
          if (!row) row = byKey[k] = { email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(' '), campaign_id: x.c.id, campaign: x.c.name, opens: 0, last: 0 };
          row.opens += r.opens; if (last > row.last) row.last = last;
        });
      });
      rows = Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) { return b.last - a.last; });
      if (!tracked) SB.mount(warn, h('div', { class: 'banner banner-warn inline', role: 'status' }, SB.icon('alert'), 'No campaign has open tracking switched on. Turn on "Track email opens" in a campaign’s settings to fill this page.'));
      else if (SB.status && SB.status.public_origin_set === false) SB.mount(warn, h('div', { class: 'banner banner-warn inline', role: 'status' }, SB.icon('alert'), SB.S.studio.trackingInactive));
      paint();
    }, function (e) { if (!dead) fail(box, e); });
    return { el: root, destroy: function () { dead = true; } };
  };

  // ---------------- Queue ----------------
  SB.screens.queue = function () {
    var root = h('div'), dead = false, topBox = h('div'), box = h('div');
    root.appendChild(head('Queue', 'What is waiting to go out, and when the next email leaves.'));
    root.appendChild(topBox); root.appendChild(box);
    SB.mount(box, h('div', { class: 'skeleton' }));
    function load() {
      return Promise.all([SB.api.get('/api/campaigns'), SB.api.get('/api/senders')]).then(function (r) {
        if (dead) return;
        var camps = mainCampaigns(r[0].items), senders = r[1].items, waiting = 0, running = 0;
        var live = camps.filter(function (c) { return c.status === 'active' || c.status === 'preparing' || c.status === 'paused'; });
        live.forEach(function (c) { var s = c.stats || {}; waiting += (s.active || 0) + (s.pending || 0); if (c.status === 'active') running++; });
        var sentToday = 0, cap = 0; senders.forEach(function (s) { sentToday += s.sent_today || 0; if (s.status === 'active') cap += s.limit_today || 0; });
        SB.mount(topBox, h('div', { class: 'grid-tiles' },
          ui.tile('Running campaigns', fmt.num(running), 'of ' + fmt.num(live.length) + ' with people waiting', 'Campaigns that are sending right now.'),
          ui.tile('People waiting', fmt.num(waiting), 'for their next email', 'People who still have an email to receive in a running or paused campaign.'),
          ui.tile('Sent today', fmt.num(sentToday), cap ? 'of ' + fmt.num(cap) + ' daily capacity' : 'No active sender', 'Emails sent today compared with what your senders may send per day.')));
        if (!live.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'No pending emails' }), h('p', { text: 'There is nothing waiting. Start a campaign and its upcoming emails show up here.' }), h('a', { class: 'btn btn-primary', href: '#/campaign/new' }, SB.icon('plus'), 'New campaign'))); return; }
        live.sort(function (a, b) { var x = a.next_send_at, y = b.next_send_at; if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return x - y; });
        SB.mount(box, h('div', null, h('div', { class: 'section-title' }, h('h2', { text: 'Scheduled' })), h('div', { class: 'table-wrap card' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', { text: 'Campaign' }), h('th', { text: 'Status' }), h('th', { text: 'Sequence' }), h('th', { text: 'People waiting' }), h('th', null, 'Next email ', ui.info('When the next email in this campaign is due. Emails only go out inside the sending window.')))),
          h('tbody', null, live.map(function (c) {
            var s = c.stats || {};
            return h('tr', { class: 'row-link', on: { click: function () { location.hash = '#/campaign/' + c.id; } } }, h('td', null, h('b', { text: c.name })), h('td', null, ui.statusPill(c.status)),
              h('td', { class: 'c-steps' }, c.step_progress ? ui.stepBar(c.step_progress, { compact: true }) : null), h('td', { text: fmt.num((s.active || 0) + (s.pending || 0)) }),
              h('td', { class: 'nowrap', tip: c.next_send_at ? fmt.full(c.next_send_at) : '' }, c.status === 'active' ? fmt.until(c.next_send_at) : '-'));
          }))))));
      }, function (e) { if (!dead) fail(box, e); });
    }
    return { el: root, destroy: (function (stop) { return function () { dead = true; stop(); }; })(ui.poll(load, 15000)) };
  };

  // ---------------- Unsubscriptions ----------------
  var KIND = { unsubscribed: ['Unsubscribed', 'They asked not to be emailed (link or "stop campaign").'], replied_stop: ['Unsubscribed', 'They replied "stop campaign".'], bounced: ['Bounced', 'The address does not exist or rejected the email.'], complaint: ['Complaint', 'They marked an email as spam.'], manual: ['Added by you', 'You added this address to the do-not-email list.'] };
  function csvCell(x) { var t = String(x == null ? '' : x); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }
  SB.screens.unsubscriptions = function () {
    var root = h('div'), dead = false, all = [], st = { q: '', kind: 'all' }, bar = h('div'), box = h('div');
    var dl = h('button', { class: 'btn', type: 'button', tip: 'Download the addresses shown here as a CSV file.' }, SB.icon('download'), 'Download CSV');
    root.appendChild(head('Unsubscriptions', 'People who will never be emailed again, whatever campaign they are in.', dl)); root.appendChild(bar); root.appendChild(box);
    SB.mount(box, h('div', { class: 'skeleton' }));
    function group(r) { return r.reason === 'bounced' ? 'bounced' : (r.reason === 'unsubscribed' || r.reason === 'replied_stop') ? 'unsubscribed' : 'other'; }
    function shown() { return all.filter(function (r) { return (st.kind === 'all' || group(r) === st.kind) && (!st.q || r.email.toLowerCase().indexOf(st.q.toLowerCase()) !== -1); }); }
    function paint() {
      var n = { all: all.length, unsubscribed: 0, bounced: 0 }; all.forEach(function (r) { var g = group(r); if (n[g] !== undefined) n[g]++; });
      var q = h('input', { class: 'input', type: 'search', placeholder: 'Search…', 'aria-label': 'Search addresses', maxlength: 100, value: st.q });
      q.addEventListener('input', function () { st.q = q.value; paintTable(); SB.mount(cnt, document.createTextNode(fmt.num(shown().length) + ' recipients')); });
      var cnt = h('span', { class: 'hub-count', text: fmt.num(shown().length) + ' recipients' });
      var tabs = h('div', { class: 'segs tabs hub-tabs', role: 'tablist' }, [['all', 'All'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced']].map(function (t) {
        return h('button', { type: 'button', class: 'seg' + (st.kind === t[0] ? ' active' : ''), role: 'tab', 'aria-selected': st.kind === t[0] ? 'true' : 'false', on: { click: function () { st.kind = t[0]; paint(); } } }, t[1] + ' (' + fmt.num(n[t[0]]) + ')');
      }));
      SB.mount(bar, h('div', { class: 'hub-bar' }, cnt, h('div', { class: 'hub-filters' }, q, tabs)));
      paintTable();
    }
    function paintTable() {
      var l = shown();
      if (!all.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'Nobody has unsubscribed or bounced' }), h('p', { text: 'Addresses that opt out or bounce are blocked automatically and listed here.' }))); return; }
      if (!l.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'Nothing matches' }), h('p', { text: 'Try a different search or tab.' }))); return; }
      SB.mount(box, h('div', { class: 'table-wrap card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Email address' }), h('th', { text: 'Type' }), h('th', { text: 'Added' }))),
        h('tbody', null, l.slice(0, 1000).map(function (r) {
          var k = KIND[r.reason] || [r.reason, ''];
          return h('tr', null, h('td', { class: 'break', text: r.email }), h('td', null, h('span', { class: 'pill pill-' + (r.reason === 'bounced' ? 'error' : 'paused'), tip: k[1], text: k[0] })), h('td', { class: 'nowrap', tip: fmt.full(r.created_at), text: fmt.ago(r.created_at) }));
        })))));
    }
    dl.addEventListener('click', function () {
      var lines = ['email,type,added'].concat(shown().map(function (r) { return [csvCell(r.email), csvCell((KIND[r.reason] || [r.reason])[0]), csvCell(new Date(r.created_at).toISOString())].join(','); }));
      var url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' })), a = document.createElement('a');
      a.href = url; a.download = 'unsubscriptions.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });
    (function loadAll(page) {
      SB.api.get('/api/suppression?page=' + page + '&pageSize=200').then(function (r) {
        if (dead) return; all = all.concat(r.items);
        if (all.length < r.total && page < 25) return loadAll(page + 1);
        paint();
      }, function (e) { if (!dead) fail(box, e); });
    })(1);
    return { el: root, destroy: function () { dead = true; } };
  };
})();
