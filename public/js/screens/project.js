/* Project page: roll-up numbers, campaigns table, drill-down panel (batches + per-step funnel). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui, M = SB.S.metric;
  SB.screens = SB.screens || {};

  function lifecycle(c, reload) {
    var label, path, msg, kind = 'primary';
    if (c.status === 'draft') { label = 'Start'; path = 'start'; msg = 'Emails will start going out to ' + fmt.num(c.leads) + ' people, following your schedule and each sender\'s daily limit.'; }
    else if (c.status === 'active') { label = 'Pause'; path = 'pause'; msg = 'Sending stops until you resume. Nobody is lost.'; kind = 'plain'; }
    else if (c.status === 'paused') { label = 'Resume'; path = 'resume'; msg = 'Sending continues where it stopped.'; }
    else return null;
    return h('button', { class: 'btn btn-sm ' + (kind === 'primary' ? 'btn-primary' : ''), type: 'button', on: { click: function (e) {
      e.stopPropagation();
      ui.confirm({ title: label + ' "' + c.name + '"?', message: msg, confirmLabel: label, onConfirm: function () {
        return SB.api.post('/api/campaigns/' + c.id + '/' + path).then(function (r) {
          (r.campaign && r.campaign.warnings || []).forEach(function (w) { ui.toast(w.message, true); });
          ui.toast(label === 'Start' ? 'Campaign started' : label === 'Pause' ? 'Campaign paused' : 'Campaign resumed'); reload();
        });
      } });
    } } }, SB.icon(path === 'pause' ? 'pause' : 'play', 'icon'), label);
  }

  function drillDown(c) {
    var p = ui.panel(c.name), box = p.body;
    box.appendChild(h('div', { class: 'skeleton' }));
    SB.api.get('/api/campaigns/' + c.id + '/analytics').then(function (a) {
      var t = a.totals, camp = a.campaign;
      var maxStep = a.steps.reduce(function (m, s) { return Math.max(m, s.sent); }, 0) || 1;
      SB.mount(box, h('div', null,
        h('div', { class: 'actions pad-b' }, ui.statusPill(camp.status)),
        h('div', { class: 'grid-tiles compact' },
          ui.tile('Emailed', fmt.num(t.emailed), null, M.emailed), ui.tile('Replied', fmt.num(t.replied), fmt.pct(t.reply_rate) + ' reply rate', M.replied),
          ui.tile('Bounced', fmt.num(t.bounced), fmt.pct(t.bounce_rate) + ' bounce rate', M.bounced), t.opens_tracked ? ui.tile('Opens', fmt.num(t.opens), fmt.pct(t.open_rate) + ' of emailed (approx.)', M.opens) : ui.tile('Opens', 'Not tracked', null, M.opens)),
        t.replied ? h('div', { class: 'card' }, h('h3', { text: 'Reply sentiment' }), h('div', { class: 'section-title' }), ui.sentimentBar(t.sentiment)) : null,
        h('div', { class: 'section-title' }, h('h3', { text: 'Emails sent per step' })),
        a.steps.length ? h('div', { class: 'card' }, a.steps.map(function (s) {
          return h('div', { class: 'field' }, h('label', { text: (s.step === 0 ? 'First email' : 'Follow-up ' + s.step) + ' \u00b7 ' + fmt.num(s.sent) + ' sent' }), ui.progress(s.sent / maxStep * 100));
        })) : h('p', { class: 'muted', text: 'Nothing sent yet.' }),
        a.batches.length ? h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h3', { text: 'Batches' }), ui.info('Large lists are split into smaller batches that send in parallel, so contacts at the same company are not emailed at the same moment.'))),
          h('div', { class: 'table-wrap card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Batch' }), h('th', { text: 'Status' }), h('th', { text: 'Progress' }), h('th', { text: 'Replies' }))),
            h('tbody', null, a.batches.map(function (b) { return h('tr', null, h('td', { text: b.name.replace(/^.* - /, '') }), h('td', null, ui.statusPill(b.status)), h('td', null, ui.progress(b.progress_pct)), h('td', { text: fmt.num(b.metrics.replied) })); }))))) : null));
    }, function (e) { SB.mount(box, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
  }

  function editModal(p, reload) {
    var name = h('input', { class: 'input', id: 'ep-name', maxlength: 100, value: p.name });
    var desc = h('textarea', { class: 'input', id: 'ep-desc', maxlength: 500 }); desc.value = p.description || '';
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    ui.modal({ title: 'Edit project', body: h('div', null, err, h('div', { class: 'field' }, h('label', { for: 'ep-name' }, 'Name'), name), h('div', { class: 'field' }, h('label', { for: 'ep-desc' }, 'Description'), desc)), actions: [
      { label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: function (close) {
        return SB.api.patch('/api/projects/' + p.id, { name: name.value, description: desc.value }).then(function () { close(); reload(); }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
      } }] });
  }

  SB.screens.project = function (params) {
    var id = params.id, root = h('div'), body = h('div', null, h('div', { class: 'skeleton' })); root.appendChild(body);
    var loaded = false, built = false, data = null, st = { q: '', status: 'all', sort: 'recent', sel: {} };
    var topSlot = h('div'), listSlot = h('div');

    function render(p) {
      var t = p.totals;
      var head = h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', p.name),
        h('div', { class: 'page-head' },
          h('div', null, h('div', { class: 'actions' }, h('h1', { text: p.name }), ui.statusPill(p.status)), p.description ? h('p', { class: 'sub', text: p.description }) : null),
          h('div', { class: 'actions' },
            h('a', { class: 'btn btn-sm btn-primary', href: '#/campaign/new/' + p.id, id: 'project-new-campaign' }, SB.icon('plus'), 'New campaign'),
            h('button', { class: 'btn btn-sm', type: 'button', on: { click: function () { editModal(p, load); } } }, 'Edit'),
            h('button', { class: 'btn btn-sm', type: 'button', on: { click: function () {
              ui.confirm({ title: p.archived ? 'Restore project?' : 'Archive project?', message: p.archived ? 'It will appear in your project list again.' : 'It disappears from the main list. Results are kept. You cannot archive while campaigns are running.',
                confirmLabel: p.archived ? 'Restore' : 'Archive', onConfirm: function () { return SB.api.patch('/api/projects/' + p.id, { archived: !p.archived }).then(function () { location.hash = '#/'; }); } });
            } } }, p.archived ? 'Restore' : 'Archive'),
            h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: function () {
              ui.confirm({ title: 'Delete "' + p.name + '"?', message: 'This permanently deletes the project, its ' + p.campaign_count + ' campaign(s) and their sending history. Pause anything that is running first. This cannot be undone.',
                confirmLabel: 'Delete forever', danger: true, onConfirm: function () { return SB.api.del('/api/projects/' + p.id).then(function () { ui.toast('Project deleted'); location.hash = '#/'; }); } });
            } } }, 'Delete'))));
      var tiles = h('div', { class: 'grid-tiles' },
        ui.tile('People', fmt.num(t.leads), null, M.leads), ui.tile('Emails sent', fmt.num(t.sent), null, M.sent),
        ui.tile('Replied', fmt.num(t.replied), fmt.pct(t.reply_rate) + ' of emailed', M.replied), ui.tile('Bounced', fmt.num(t.bounced), fmt.pct(t.bounce_rate) + ' of emailed', M.bounced, t.bounce_rate > 3),
        (t.opens_tracked ? ui.tile('Opens', fmt.num(t.opens), fmt.pct(t.open_rate) + ' of emailed (approx.)', M.opens) : ui.tile('Opens', 'Not tracked', 'Use replies instead', M.opens)), ui.tile('Next email', fmt.until(t.next_send_at), null, M.next));
      data = p;
      if (!built) { built = true; SB.mount(body, h('div', null, topSlot, listSlot)); }
      SB.mount(topSlot, h('div', null, head, tiles, t.replied ? h('div', { class: 'card' }, h('h3', null, 'Reply sentiment'), h('div', { class: 'section-title' }), ui.sentimentBar(t.sentiment)) : null));
      paintCampaigns();
    }

    var CHIPS = [
      { key: 'all', label: 'All', match: null }, { key: 'active', label: 'Running', match: ['active'], tip: 'Campaigns that are sending right now.' },
      { key: 'paused', label: 'Paused', match: ['paused'] }, { key: 'completed', label: 'Finished', match: ['completed'] },
      { key: 'draft', label: 'Draft', match: ['draft', 'preparing'], tip: 'Written but not started yet.' }, { key: 'error', label: 'With error', match: ['error'], tip: 'Blocked by a problem, such as a sender that cannot send.' }];
    var SORTS = [
      { key: 'recent', label: 'Newest first', cmp: function (a, b) { return b.created_at - a.created_at || b.id - a.id; } },
      { key: 'name', label: 'Name (A-Z)', cmp: function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; } },
      { key: 'progress', label: 'Most complete', cmp: function (a, b) { return b.progress_pct - a.progress_pct; } },
      { key: 'replies', label: 'Most replies', cmp: function (a, b) { return b.metrics.replied - a.metrics.replied; } },
      { key: 'sent', label: 'Most emails sent', cmp: function (a, b) { return b.sent - a.sent; } },
      { key: 'next', label: 'Next email soonest', cmp: function (a, b) { var x = a.next_send_at, y = b.next_send_at; if (x === y) return 0; if (x === null) return 1; if (y === null) return -1; return x - y; } }];
    var tb = SB.lists.toolbar({ placeholder: 'Search campaigns', label: 'Search campaigns', sorts: SORTS, sort: st.sort,
      onSearch: function (q) { st.q = q; paintCampaigns(); }, onSort: function (k) { st.sort = k; paintCampaigns(); } });
    var chipsBox = h('div'), tagsBox = h('div'), tableBox = h('div'), barBox = h('div');
    SB.mount(listSlot, h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Campaigns' }), ui.info('Click a campaign to see its batches and how many emails went out at each step.'))),
      tb.el, chipsBox, tagsBox, tableBox, barBox));

    function moveModal(ids) {
      Promise.all([SB.api.get('/api/projects')]).then(function (r) {
        var others = r[0].items.filter(function (x) { return x.id !== data.id; });
        var sel = h('select', { class: 'input', id: 'mv-project', 'aria-label': 'Destination project' }, others.map(function (x) { return h('option', { value: x.id }, x.name); }),
          h('option', { value: 'new' }, '+ New project...'));
        var nm = h('input', { class: 'input hidden', id: 'mv-name', maxlength: 100, placeholder: 'New project name' });
        sel.addEventListener('change', function () { nm.classList.toggle('hidden', sel.value !== 'new'); if (sel.value === 'new') nm.focus(); });
        if (!others.length) { sel.value = 'new'; nm.classList.remove('hidden'); }
        var err = h('div', { class: 'form-error hidden', role: 'alert' });
        ui.modal({ title: 'Move ' + ids.length + ' campaign' + (ids.length === 1 ? '' : 's'), body: h('div', null, err,
          h('div', { class: 'field' }, h('label', { for: 'mv-project' }, 'Move to'), sel), h('div', { class: 'field' }, nm),
          h('p', { class: 'small muted', text: 'Batches move with their campaign. Sending is not interrupted and nothing is sent again.' })),
          actions: [{ label: 'Cancel' }, { label: 'Move', kind: 'primary', onClick: function (close) {
            var body = { action: 'move', ids: ids };
            if (sel.value === 'new') body.new_project_name = nm.value; else body.project_id = Number(sel.value);
            return SB.api.post('/api/campaigns/batch', body).then(function (res) { close(); SB.lists.report(res, 'moved'); st.sel = {}; return load(); },
              function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
          } }] });
      }, function (e) { ui.toast(SB.api.friendly(e), true); });
    }

    function paintCampaigns() {
      if (!data) return;
      var all = data.campaigns, chip = CHIPS.filter(function (c) { return c.key === st.status; })[0] || CHIPS[0];
      var cmp = SORTS.filter(function (x) { return x.key === st.sort; })[0].cmp;
      var items = all.filter(function (c) { return SB.lists.has(c.name, st.q) && (!chip.match || chip.match.indexOf(c.status) !== -1); }).sort(cmp);
      Object.keys(st.sel).forEach(function (k) { if (!all.some(function (c) { return c.id === Number(k); })) delete st.sel[k]; });
      var selIds = Object.keys(st.sel).map(Number);
      SB.mount(chipsBox, SB.lists.chips(CHIPS.map(function (c) { return { key: c.key, label: c.label, tip: c.tip, n: c.match ? all.filter(function (x) { return c.match.indexOf(x.status) !== -1; }).length : all.length }; })
        .filter(function (c) { return c.key === 'all' || c.n > 0 || c.key === st.status; }), st.status, function (k) { st.status = k; paintCampaigns(); }));
      var tags = [];
      if (st.q) tags.push({ label: 'Search: ' + st.q, onRemove: function () { st.q = ''; tb.search.value = ''; paintCampaigns(); } });
      if (st.status !== 'all') tags.push({ label: 'Status: ' + chip.label, onRemove: function () { st.status = 'all'; paintCampaigns(); } });
      SB.mount(tagsBox, h('div', null, SB.lists.tags(tags, function () { st.q = ''; tb.search.value = ''; st.status = 'all'; paintCampaigns(); })));
      if (!all.length) {
        SB.mount(tableBox, h('div', { class: 'card empty' }, h('h2', { text: 'No campaigns in this project yet' }), h('p', { text: 'Write your emails, choose who receives them and pick your senders. Your progress is saved as you go.' }),
          h('a', { class: 'btn btn-primary', href: '#/campaign/new/' + data.id }, SB.icon('plus'), 'New campaign')));
      } else if (!items.length) {
        SB.mount(tableBox, h('div', { class: 'card empty' }, h('h2', { text: 'No campaigns match' }), h('p', { text: 'Try a different search or status.' })));
      } else {
        var allCb = h('input', { type: 'checkbox', 'aria-label': 'Select all shown campaigns' }); allCb.checked = items.every(function (c) { return !!st.sel[c.id]; });
        allCb.addEventListener('change', function () { items.forEach(function (c) { if (allCb.checked) st.sel[c.id] = c.name; else delete st.sel[c.id]; }); paintCampaigns(); });
        SB.mount(tableBox, h('div', { class: 'table-wrap card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { class: 'row-check' }, allCb),
          h('th', { text: 'Campaign' }), h('th', { text: 'Status' }), h('th', null, 'Progress ', ui.info(M.progress)), h('th', { text: 'Sent' }), h('th', { text: 'Replies' }), h('th', { text: 'Bounced' }), h('th', { text: 'Next email' }), h('th'))),
          h('tbody', null, items.map(function (c) {
            var cb = h('input', { type: 'checkbox', 'aria-label': 'Select campaign ' + c.name }); cb.checked = !!st.sel[c.id];
            cb.addEventListener('click', function (e) { e.stopPropagation(); });
            cb.addEventListener('change', function () { if (cb.checked) st.sel[c.id] = c.name; else delete st.sel[c.id]; paintCampaigns(); });
            return h('tr', { class: 'row-link' + (cb.checked ? ' selected' : ''), on: { click: function () { drillDown(c); } } },
              h('td', { class: 'row-check' }, cb),
              h('td', null, h('b', { text: c.name }), c.batches ? h('div', { class: 'small faint', text: c.batches + ' batches' }) : null), h('td', null, ui.statusPill(c.status)),
              h('td', null, h('div', { class: 'small', text: fmt.pct(c.progress_pct) }), ui.progress(c.progress_pct)),
              h('td', { text: fmt.num(c.sent) }), h('td', { text: fmt.num(c.metrics.replied) }), h('td', { text: fmt.num(c.stats.bounced) }), h('td', { text: fmt.until(c.next_send_at) }),
              h('td', null, h('div', { class: 'actions' }, c.status === 'draft' ? h('a', { class: 'btn btn-sm', href: '#/campaign/edit/' + c.id, tip: 'Change the emails, senders or schedule before you start.', on: { click: function (e) { e.stopPropagation(); } } }, 'Edit') : null, lifecycle(c, load), h('span', { class: 'faint' }, SB.icon('chevron')))));
          })))));
      }
      var n = selIds.length;
      SB.mount(barBox, h('div', null, SB.lists.selectionBar(n, 'campaign', [
        { label: 'Move to project', tip: 'Move the selected campaigns into another project, or into a new one.', onClick: function () { moveModal(selIds); } },
        { label: 'Delete', kind: 'danger', icon: 'trash', onClick: function () {
          ui.confirm({ title: 'Delete ' + n + ' campaign' + (n === 1 ? '' : 's') + '?', message: 'This permanently deletes them with their batches and sending history. Running campaigns are skipped: pause them first.', confirmLabel: 'Delete forever', danger: true,
            onConfirm: function () { return SB.api.post('/api/campaigns/batch', { action: 'delete', ids: selIds }).then(function (res) { SB.lists.report(res, 'deleted'); st.sel = {}; return load(); }); } });
        } }], function () { st.sel = {}; paintCampaigns(); }, items.length > n ? function () { items.forEach(function (c) { st.sel[c.id] = c.name; }); paintCampaigns(); } : null)));
    }
    function load() {
      return SB.api.get('/api/projects/' + id).then(function (r) { loaded = true; render(r.project); }, function (e) {
        if (e.status === 404) { SB.mount(body, h('div', { class: 'card empty' }, h('h2', { text: 'Project not found' }), h('a', { class: 'btn', href: '#/' }, 'Back to Home'))); return; }
        if (!loaded && e.code !== 'offline') SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    return { el: root, destroy: ui.poll(load, 10000) };
  };
})();
