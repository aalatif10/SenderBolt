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
              h('td', null, h('div', { class: 'who' }, avatar(r.email), h('div', null, r.name ? h('b', { class: 'break', text: r.name }) : ui.email(r.email, 'strong', 'b'), r.name ? ui.email(r.email, 'small faint', 'div') : null))),
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
      // The campaign table rows carry the real next send time (sending window, days, time zone and sender allowance already applied).
      return Promise.all([SB.api.get('/api/campaign-table'), SB.api.get('/api/senders')]).then(function (r) {
        if (dead) return;
        var camps = r[0].items, senders = r[1].items, waiting = 0, running = 0;
        var live = camps.filter(function (c) { return ['active', 'planned', 'preparing', 'paused'].indexOf(c.display_status) !== -1; });
        live.forEach(function (c) { var s = c.stats || {}; waiting += (s.active || 0) + (s.pending || 0); if (c.display_status === 'active') running++; });
        var sentToday = 0, cap = 0; senders.forEach(function (s) { sentToday += s.sent_today || 0; if (s.status === 'active') cap += s.limit_today || 0; });
        SB.mount(topBox, h('div', { class: 'grid-tiles' },
          ui.tile('Running campaigns', fmt.num(running), 'of ' + fmt.num(live.length) + ' with people waiting', 'Campaigns that are sending right now.'),
          ui.tile('People waiting', fmt.num(waiting), 'for their next email', 'People who still have an email to receive in a running or paused campaign.'),
          ui.tile('Sent today', fmt.num(sentToday), cap ? 'of ' + fmt.num(cap) + ' daily capacity' : 'No active sender', 'Emails sent today compared with what your senders may send per day.')));
        if (!live.length) { SB.mount(box, h('div', { class: 'card empty' }, h('h2', { text: 'No pending emails' }), h('p', { text: 'There is nothing waiting. Start a campaign and its upcoming emails show up here.' }), h('a', { class: 'btn btn-primary', href: '#/campaign/new' }, SB.icon('plus'), 'New campaign'))); return; }
        live.sort(function (a, b) { var x = a.next_send_at, y = b.next_send_at; if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return x - y; });
        SB.mount(box, h('div', null, h('div', { class: 'section-title' }, h('h2', { text: 'Scheduled' })), h('div', { class: 'table-wrap card' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', { text: 'Campaign' }), h('th', { text: 'Status' }), h('th', { text: 'Sequence' }), h('th', { text: 'People waiting' }), h('th', null, 'Next email ', ui.info('When the next email in this campaign leaves, in days, hours and minutes. It already counts the sending days and hours, the time zone and each sending account’s daily limit.')))),
          h('tbody', null, live.map(function (c) {
            var s = c.stats || {};
            return h('tr', { class: 'row-link', on: { click: function () { location.hash = '#/campaign/' + c.id; } } }, h('td', null, h('b', { text: c.name })), h('td', null, SB.campaignGrid.pill(c.display_status)),
              h('td', { class: 'c-steps' }, c.step_progress ? ui.stepBar(c.step_progress, { compact: true }) : null), h('td', { text: fmt.num((s.active || 0) + (s.pending || 0)) }),
              h('td', { class: 'nowrap' }, SB.campaignGrid.currentState(c)));
          }))))));
      }, function (e) { if (!dead) fail(box, e); });
    }
    return { el: root, destroy: (function (stop) { return function () { dead = true; stop(); }; })(ui.poll(load, 15000)) };
  };

  // ---------------- Unsubscriptions ----------------
  function csvCell(x) { var t = String(x == null ? '' : x); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }
  SB.screens.unsubscriptions = function () {
    var root = h('div');
    var dl = h('button', { class: 'btn', type: 'button', tip: 'Download the addresses in the current tab as a CSV file.' }, SB.icon('download'), 'Download CSV');
    var panel = SB.suppress.panel({ tabs: [['all', 'All'], ['manual', 'Added by you'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced'], ['complaint', 'Complaints']],
      empty: { title: 'Nobody has unsubscribed or bounced', text: 'Addresses that opt out or bounce are blocked automatically and listed here. Addresses you add yourself appear under "Added by you".' } });
    root.appendChild(head('Unsubscriptions', 'People who will never be emailed again, whatever campaign they are in.', dl));
    root.appendChild(panel.el);
    dl.addEventListener('click', function () {
      var s = panel.getState(), rows = [], page = 1;
      (function next() {
        return SB.api.get('/api/suppression?page=' + page + '&pageSize=200&sort=email&dir=asc' + (s.group !== 'all' ? '&group=' + encodeURIComponent(s.group) : '') + (s.q ? '&q=' + encodeURIComponent(s.q) : '')).then(function (r) {
          rows = rows.concat(r.items); if (page * 200 < r.total && page < 50) { page++; return next(); }
        });
      })().then(function () {
        var lines = ['email,type,added'].concat(rows.map(function (r) { return [csvCell(r.email), csvCell(SB.suppress.kind(r.reason)[0]), csvCell(new Date(r.created_at).toISOString())].join(','); }));
        var url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' })), a = document.createElement('a');
        a.href = url; a.download = 'unsubscriptions.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      }, function (e) { ui.toast(SB.api.friendly(e)); });
    });
    return { el: root, destroy: function () { panel.destroy(); } };
  };
})();
