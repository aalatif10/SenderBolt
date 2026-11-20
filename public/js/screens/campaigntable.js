/* Campaigns table (Home): every campaign in one filterable list, Hunter-style.
   Filter bar: total count, search, Status and Email accounts multi-selects. Columns: Campaign, Status, Current state, Created,
   Progression, Performance (Scheduled, Sent, Opened, Replied, Successful), Actions (three-dots menu).
   Data: GET /api/campaign-table. Actions use the campaign endpoints (pause/resume, duplicate, archive, rename). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};

  var STATUS_ORDER = ['active', 'archived', 'preparing', 'planned', 'completed', 'paused', 'error', 'draft'];

  function pill(status) {
    var s = SB.S.tableStatus[status] || SB.S.tableStatus.draft;
    return h('span', { class: 'pill pill-' + status, tip: s.tip, 'data-status': status }, s.label);
  }

  // "Current state": what is happening right now, in plain words, with real days/hours/minutes.
  function currentState(c) {
    var ds = c.display_status;
    if (ds === 'active') {
      if (c.next_send_at === null || c.next_send_at === undefined) return h('span', { class: 'muted', tip: 'Nobody is due right now, or the accounts for this campaign are paused.' }, 'Waiting for an active sender');
      var follow = c.next_kind === 'follow_up';
      return h('span', { tip: fmt.full(c.next_send_at) }, h('b', { text: follow ? 'Next follow-up ' : 'Next email ' }), fmt.until(c.next_send_at));
    }
    if (ds === 'planned') return h('span', { tip: fmt.full(c.start_at) }, h('b', { text: 'Starts ' }), fmt.date(c.start_at), h('span', { class: 'small faint', text: ' (' + fmt.until(c.next_send_at || c.start_at) + ')' }));
    if (ds === 'paused') return h('span', { class: 'muted', text: 'Paused' });
    if (ds === 'completed') return h('span', { class: 'muted', text: 'All people finished' });
    if (ds === 'draft') return h('span', { class: 'muted', text: 'Not started yet' });
    if (ds === 'preparing') return h('span', { class: 'muted', text: 'Setting up…' });
    if (ds === 'error') return h('span', { class: 'bad-text', tip: 'Open the campaign to see what is blocking it.', text: 'Blocked, needs your attention' });
    if (ds === 'archived') return h('span', { class: 'muted', text: 'Archived' });
    return h('span', { class: 'faint', text: '—' });
  }

  SB.screens.campaignTable = function (opts) {
    opts = opts || {};
    var st = { q: '', status: [], senders: [] }, data = null, built = false, stopPoll = null;
    var root = h('div', { class: 'ct' }), barBox = h('div', { class: 'ct-bar' }), tagsBox = h('div'), tableBox = h('div');
    var total = h('span', { class: 'ct-total', tip: 'How many campaigns match the filters below.' });

    var search = h('input', { class: 'input', type: 'search', placeholder: 'Search campaigns by name', maxlength: 100, 'aria-label': 'Search campaigns' });
    var timer = null;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { st.q = search.value.trim(); load(); }, 200); });

    var statusMs = SB.controls.multiSelect({ label: 'Status', tip: 'Show only campaigns in these states. Nothing ticked shows every campaign except archived ones.',
      options: STATUS_ORDER.map(function (k) { return { value: k, label: SB.S.tableStatus[k].label }; }), selected: [], onApply: function (v) { st.status = v; load(); } });
    var acctMs = SB.controls.multiSelect({ label: 'Email accounts', tip: 'Show only campaigns that send from these accounts.', options: [], selected: [], emptyText: 'No sending accounts yet.',
      onApply: function (v) { st.senders = v; load(); } });
    barBox.appendChild(total); barBox.appendChild(h('div', { class: 'search' }, SB.icon('search'), search)); barBox.appendChild(statusMs.el); barBox.appendChild(acctMs.el);
    root.appendChild(barBox); root.appendChild(tagsBox); root.appendChild(tableBox);

    function qs() {
      var p = [];
      if (st.q) p.push('q=' + encodeURIComponent(st.q));
      if (st.status.length) p.push('status=' + st.status.join(','));
      if (st.senders.length) p.push('sender_ids=' + st.senders.join(','));
      return p.length ? '?' + p.join('&') : '';
    }

    function act(c, path, okMsg, body) {
      return SB.api.post('/api/campaigns/' + c.id + '/' + path, body || {}).then(function (r) {
        (r.campaign && r.campaign.warnings || []).forEach(function (w) { ui.toast(w.message, true); });
        ui.toast(okMsg); return load();
      }, function (e) { ui.toast(SB.api.friendly(e), true); });
    }
    function renameModal(c) {
      var inp = h('input', { class: 'input', id: 'rn-name', maxlength: 100, value: c.name });
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      ui.modal({ title: 'Rename campaign', body: h('div', null, err, h('div', { class: 'field' }, h('label', { for: 'rn-name' }, 'Campaign name'), inp)), actions: [
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', onClick: function (close) {
          err.classList.add('hidden');
          return SB.api.patch('/api/campaigns/' + c.id, { name: inp.value }).then(function () { close(); ui.toast('Renamed'); load(); }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
        } }] });
    }
    function menuFor(c) {
      return SB.controls.rowMenu(function () {
        var items = [];
        if (c.status === 'active' && !c.archived) items.push({ label: 'Pause', icon: 'pause', tip: 'Stop sending until you resume. Nobody is lost.', onClick: function () {
          ui.confirm({ title: 'Pause "' + c.name + '"?', message: 'Sending stops until you resume. Nobody is lost.', confirmLabel: 'Pause', onConfirm: function () { return act(c, 'pause', 'Campaign paused'); } }); } });
        else if (c.status === 'paused' && !c.archived) items.push({ label: 'Resume', icon: 'play', tip: 'Continue where sending stopped.', onClick: function () { act(c, 'resume', 'Campaign resumed'); } });
        else items.push({ label: 'Pause', icon: 'pause', disabled: true, tip: c.archived ? 'Restore the campaign first.' : 'Only a running campaign can be paused.' });
        items.push({ label: 'Duplicate', icon: 'copy', tip: 'Create a draft copy with the same emails, schedule, accounts and people. Nothing is sent from the copy until you start it.', onClick: function () {
          ui.confirm({ title: 'Duplicate "' + c.name + '"?', message: 'A new draft is created in the same project with the same emails, sending days, accounts and people. Nothing is sent until you start it.', confirmLabel: 'Duplicate',
            onConfirm: function () { return SB.api.post('/api/campaigns/' + c.id + '/duplicate', {}).then(function (r) { ui.toast('Draft copy created'); location.hash = '#/campaign/' + r.campaign.id; }); } }); } });
        items.push({ label: c.archived ? 'Restore' : 'Archive', icon: 'archive', disabled: !c.archived && (c.status === 'active' || c.status === 'preparing'),
          tip: c.archived ? 'Show this campaign in the main list again.' : (c.status === 'active' ? 'Pause the campaign first.' : 'Hide this campaign from the main list. Results are kept.'),
          onClick: function () { act(c, 'archive', c.archived ? 'Campaign restored' : 'Campaign archived', { archived: !c.archived }); } });
        items.push({ label: 'Rename', icon: 'edit', tip: 'Change the campaign name.', onClick: function () { renameModal(c); } });
        return items;
      }, 'Actions for ' + c.name);
    }

    function row(c) {
      var m = c.metrics || {}, tracked = !!c.track_opens, emailed = m.emailed || 0;
      function pctOf(n) { return emailed ? ' · ' + (Math.round(n / emailed * 1000) / 10) + '%' : ''; }
      var done = (c.stats.replied || 0) + (c.stats.completed || 0) + (c.stats.bounced || 0) + (c.stats.unsubscribed || 0);
      var tr = h('tr', { class: 'row-link' + (c.archived ? ' is-archived' : ''), tabindex: 0, on: { click: function () { location.hash = '#/campaign/' + c.id; }, keydown: function (e) { if (e.key === 'Enter' && e.target === tr) location.hash = '#/campaign/' + c.id; } } },
        h('td', { class: 'ct-name' }, h('b', { class: 'ct-title', tip: c.name, text: c.name }),
          h('div', { class: 'small faint' }, h('a', { href: '#/project/' + c.project_id, tip: 'Open the project this campaign belongs to.', on: { click: function (e) { e.stopPropagation(); } }, text: c.project_name }),
            c.batches ? ' · ' + c.batches + ' batches' : '', ' · ' + fmt.num(c.leads) + (c.leads === 1 ? ' person' : ' people'))),
        h('td', null, pill(c.display_status)),
        h('td', { class: 'ct-state' }, currentState(c)),
        h('td', { class: 'nowrap', tip: fmt.tip(c.created_at), text: fmt.age(c.created_at) }),
        h('td', { class: 'ct-prog', tip: fmt.num(done) + ' of ' + fmt.num(c.leads) + ' people finished. ' + SB.S.metric.progress }, ui.progress(c.progress_pct), h('div', { class: 'small faint', text: fmt.pct(c.progress_pct) })),
        h('td', { class: 'num', tip: SB.S.perf.scheduled, text: fmt.num(c.scheduled) }),
        h('td', { class: 'num', tip: SB.S.perf.sent, text: fmt.num(c.sent) }),
        h('td', { class: 'num', tip: tracked ? SB.S.perf.opened : 'Open tracking is off for this campaign.' }, tracked ? h('span', null, fmt.num(m.opened || 0), h('span', { class: 'small faint', text: pctOf(m.opened || 0) })) : h('span', { class: 'faint', text: 'Off' })),
        h('td', { class: 'num', tip: SB.S.perf.replied }, fmt.num(m.replied || 0), h('span', { class: 'small faint', text: pctOf(m.replied || 0) })),
        h('td', { class: 'num', tip: SB.S.perf.successful }, fmt.num(m.interested || 0), h('span', { class: 'small faint', text: pctOf(m.interested || 0) })),
        h('td', { class: 'ct-act' }, menuFor(c)));
      return tr;
    }

    function paint() {
      if (!data) return;
      total.textContent = fmt.num(data.total) + (data.total === 1 ? ' campaign' : ' campaigns');
      acctMs.setOptions(data.senders.map(function (s) { return { value: s.id, label: s.email, sub: s.label && s.label !== s.email ? s.label : null }; }));
      var tags = [];
      if (st.q) tags.push({ label: 'Search: ' + st.q, onRemove: function () { st.q = ''; search.value = ''; load(); } });
      st.status.forEach(function (k) { tags.push({ label: 'Status: ' + SB.S.tableStatus[k].label, onRemove: function () { st.status = st.status.filter(function (x) { return x !== k; }); statusMs.setSelected(st.status); load(); } }); });
      st.senders.forEach(function (id) {
        var s = data.senders.filter(function (x) { return x.id === id; })[0];
        tags.push({ label: 'Account: ' + (s ? s.email : id), onRemove: function () { st.senders = st.senders.filter(function (x) { return x !== id; }); acctMs.setSelected(st.senders); load(); } });
      });
      SB.mount(tagsBox, h('div', null, SB.lists.tags(tags, function () { st.q = ''; search.value = ''; st.status = []; st.senders = []; statusMs.setSelected([]); acctMs.setSelected([]); load(); })));
      var any = data.counts.all > 0 || data.counts.archived > 0;
      if (!data.items.length) {
        SB.mount(tableBox, h('div', { class: 'card empty' }, h('h2', { text: any ? 'No campaigns match' : 'No campaigns yet' }),
          h('p', { text: any ? 'Try a different search or filter.' : 'Create a campaign to start reaching out. Everything you send is tracked here.' }),
          any ? null : h('a', { class: 'btn btn-primary', href: '#/campaign/new' }, SB.icon('plus'), 'New campaign')));
        return;
      }
      function th(label, tipText, cls) { return h('th', { class: cls || null, tip: tipText, text: label }); }
      SB.mount(tableBox, h('div', { class: 'card table-card ct-wrap' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table ct-table' },
        h('thead', null,
          h('tr', { class: 'ct-group' }, h('th', { colspan: 5 }), h('th', { colspan: 5, class: 'ct-perf-h', tip: 'Results of this campaign so far. Hover a number for what it counts.' }, 'Performance'), h('th')),
          h('tr', null, th('Campaign', 'The campaign name and the project it belongs to.'), th('Status', 'Where the campaign is now.'), th('Current state', 'What happens next, in days, hours and minutes.'),
            th('Created', 'How long ago it was created. Hover a value for the exact date.'), th('Progression', SB.S.metric.progress),
            th('Scheduled', SB.S.perf.scheduled, 'num'), th('Sent', SB.S.perf.sent, 'num'), th('Opened', SB.S.perf.opened, 'num'), th('Replied', SB.S.perf.replied, 'num'), th('Successful', SB.S.perf.successful, 'num'),
            h('th', { class: 'ct-act', 'aria-label': 'Actions' }))),
        h('tbody', null, data.items.map(row))))));
    }

    function load() {
      return SB.api.get('/api/campaign-table' + qs()).then(function (r) { data = r; built = true; paint(); }, function (e) {
        if (e.code !== 'offline' && !built) SB.mount(tableBox, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    SB.mount(tableBox, h('div', { class: 'skeleton' }));
    stopPoll = ui.poll(load, 10000);
    return { el: root, reload: load, destroy: function () { if (stopPoll) stopPoll(); SB.controls.close(); } };
  };
})();
