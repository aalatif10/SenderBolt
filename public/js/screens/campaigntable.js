/* Campaigns table with its filter bar (Project page): total count, search, Status and Email accounts multi-selects, then the shared
   campaign grid (campaigngrid.js). Options: projectId (limit to one project), progress ('steps' | 'bar'), selectable + onMove (bulk bar: Move, Delete).
   Data: GET /api/campaign-table. */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};

  var STATUS_ORDER = ['active', 'archived', 'preparing', 'planned', 'completed', 'paused', 'error', 'draft'];

  SB.screens.campaignTable = function (opts) {
    opts = opts || {};
    var st = { q: '', status: [], senders: [], sel: {} }, data = null, built = false, stopPoll = null;
    var root = h('div', { class: 'ct' }), barBox = h('div', { class: 'ct-bar' }), tagsBox = h('div'), tableBox = h('div'), selBox = h('div');
    var total = h('span', { class: 'ct-total', tip: 'How many campaigns match the filters below.' });

    var search = h('input', { class: 'input', type: 'search', placeholder: 'Search campaigns by name', maxlength: 100, 'aria-label': 'Search campaigns' });
    var timer = null;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { st.q = search.value.trim(); load(); }, 200); });

    var statusMs = SB.controls.multiSelect({ label: 'Status', tip: 'Show only campaigns in these states. Nothing ticked shows every campaign except archived ones.',
      options: STATUS_ORDER.map(function (k) { return { value: k, label: SB.S.tableStatus[k].label }; }), selected: [], onApply: function (v) { st.status = v; load(); } });
    var acctMs = SB.controls.multiSelect({ label: 'Email accounts', tip: 'Show only campaigns that send from these accounts.', options: [], selected: [], emptyText: 'No sending accounts yet.',
      onApply: function (v) { st.senders = v; load(); } });
    barBox.appendChild(total); barBox.appendChild(h('div', { class: 'search' }, SB.icon('search'), search)); barBox.appendChild(statusMs.el); barBox.appendChild(acctMs.el);
    root.appendChild(barBox); root.appendChild(tagsBox); root.appendChild(tableBox); root.appendChild(selBox);

    function qs() {
      var p = [];
      if (st.q) p.push('q=' + encodeURIComponent(st.q));
      if (st.status.length) p.push('status=' + st.status.join(','));
      if (st.senders.length) p.push('sender_ids=' + st.senders.join(','));
      if (opts.projectId) p.push('project_id=' + encodeURIComponent(opts.projectId));
      return p.length ? '?' + p.join('&') : '';
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
        SB.mount(selBox, h('div'));
        SB.mount(tableBox, h('div', { class: 'card empty' }, h('h2', { text: any ? 'No campaigns match' : (opts.projectId ? 'No campaigns in this project yet' : 'No campaigns yet') }),
          h('p', { text: any ? 'Try a different search or filter.' : 'Create a campaign to start reaching out. Everything you send is tracked here.' }),
          any ? null : h('a', { class: 'btn btn-primary', href: '#/campaign/new' + (opts.projectId ? '/' + opts.projectId : '') }, SB.icon('plus'), 'New campaign')));
        return;
      }
      Object.keys(st.sel).forEach(function (k) { if (!data.items.some(function (c) { return c.id === Number(k); })) delete st.sel[k]; });
      var selIds = Object.keys(st.sel).map(Number), n = selIds.length;
      SB.mount(tableBox, SB.campaignGrid.table(data.items, { progress: opts.progress || 'bar', showProject: !opts.projectId, onChange: load,
        select: opts.selectable ? { sel: st.sel, onChange: paint } : null }));
      if (opts.selectable) SB.mount(selBox, h('div', null, SB.lists.selectionBar(n, 'campaign', [
        { label: 'Move to project', tip: 'Move the selected campaigns into another project, or into a new one.', onClick: function () { opts.onMove(selIds, function () { st.sel = {}; return load(); }); } },
        { label: 'Delete', kind: 'danger', icon: 'trash', onClick: function () {
          ui.confirm({ title: 'Delete ' + n + ' campaign' + (n === 1 ? '' : 's') + '?', message: 'This permanently deletes them with their batches and sending history. Running campaigns are skipped: pause them first.', confirmLabel: 'Delete forever', danger: true,
            onConfirm: function () { return SB.api.post('/api/campaigns/batch', { action: 'delete', ids: selIds }).then(function (res) { SB.lists.report(res, 'deleted'); st.sel = {}; return load(); }); } });
        } }], function () { st.sel = {}; paint(); }, data.items.length > n ? function () { data.items.forEach(function (c) { st.sel[c.id] = c.name; }); paint(); } : null)));
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
