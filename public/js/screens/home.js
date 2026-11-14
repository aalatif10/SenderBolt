/* Home: "what should I do now?" + live tiles + projects. Refreshes every 10 s while the tab is visible. */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};

  function newProjectModal() {
    var name = h('input', { class: 'input', id: 'np-name', maxlength: 100, placeholder: 'e.g. Q4 domain outreach' });
    var desc = h('textarea', { class: 'input', id: 'np-desc', maxlength: 500, placeholder: 'Optional notes for yourself' });
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var body = h('div', null, err,
      h('div', { class: 'field' }, h('label', { for: 'np-name' }, 'Project name'), name),
      h('div', { class: 'field' }, h('label', { for: 'np-desc' }, 'Description'), desc),
      h('p', { class: 'small muted', text: 'A project groups related campaigns (for example different versions of the same email) so you can see their results together.' }));
    ui.modal({ title: 'New project', body: body, actions: [
      { label: 'Cancel' },
      { label: 'Create project', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        return SB.api.post('/api/projects', { name: name.value, description: desc.value }).then(function (r) { close(); location.hash = '#/project/' + r.project.id; }, function (e) {
          err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e;
        });
      } }
    ] });
    return name;
  }

  function projectCard(p, st, repaint) {
    var t = p.totals, on = !!st.sel[p.id], any = Object.keys(st.sel).length > 0;
    var cb = h('input', { type: 'checkbox', class: 'pc-check', 'aria-label': 'Select project ' + p.name });
    cb.checked = on;
    cb.addEventListener('change', function () { if (cb.checked) st.sel[p.id] = p.name; else delete st.sel[p.id]; repaint(); });
    return h('div', { class: 'pc-wrap' + (on ? ' selected' : '') + (any ? ' sel-mode' : '') }, cb,
      h('a', { class: 'card project-card', href: '#/project/' + p.id },
        h('div', { class: 'top' }, h('h3', { text: p.name }), ui.statusPill(p.status)),
        p.campaign_count ? ui.progress(t.progress_pct) : h('div', { class: 'small faint', text: 'No campaigns yet' }),
        h('div', { class: 'kv' },
          h('span', { tip: SB.S.metric.sent }, h('b', { text: fmt.num(t.sent) }), 'sent'),
          h('span', { tip: SB.S.metric.replied }, h('b', { text: fmt.num(t.replied) }), 'replies'),
          h('span', { tip: SB.S.metric.bounced }, h('b', { text: fmt.num(t.bounced) }), 'bounced'),
          h('span', { tip: SB.S.metric.next }, h('b', { text: fmt.until(t.next_send_at) }), 'next email'))));
  }

  var STATUS_CHIPS = [
    { key: 'all', label: 'All', match: null, tip: 'Every project.' },
    { key: 'active', label: 'Running', match: ['active'], tip: 'Projects with a campaign that is sending right now.' },
    { key: 'paused', label: 'Paused', match: ['paused'], tip: 'Projects whose campaigns are paused.' },
    { key: 'completed', label: 'Finished', match: ['completed'], tip: 'Projects where every campaign has finished.' },
    { key: 'draft', label: 'Draft', match: ['draft', 'preparing'], tip: 'Projects with campaigns that have not been started yet.' },
    { key: 'error', label: 'Needs attention', match: ['error'], tip: 'Projects blocked by a problem, such as a sender that cannot send.' },
    { key: 'empty', label: 'No campaigns', match: ['empty'], tip: 'Projects without any campaign yet.' }
  ];
  var SORTS = [
    { key: 'recent', label: 'Recently updated', cmp: function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0) || b.id - a.id; } },
    { key: 'name', label: 'Name (A-Z)', cmp: function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; } },
    { key: 'replies', label: 'Most replies', cmp: function (a, b) { return b.totals.replied - a.totals.replied || b.id - a.id; } },
    { key: 'sent', label: 'Most emails sent', cmp: function (a, b) { return b.totals.sent - a.totals.sent || b.id - a.id; } },
    { key: 'next', label: 'Next email soonest', cmp: function (a, b) { var x = a.totals.next_send_at, y = b.totals.next_send_at; if (x === y) return b.id - a.id; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return x - y; } }
  ];

  function nextStep(senders, leadsTotal, projects) {
    var s;
    if (!senders.length) s = { t: 'Connect your first Gmail account', d: 'SenderBolt sends from your own accounts using a Google App Password.', l: 'Add a sender', h: '#/senders' };
    else if (!leadsTotal) s = { t: 'Add the people you want to contact', d: 'Paste emails or import a CSV file into a folder.', l: 'Add leads', h: '#/leads' };
    else if (!projects) s = { t: 'Create your first project', d: 'A project holds your campaigns and shows their results together.', l: 'New project', act: true };
    if (!s) return null;
    var btn = s.act ? h('button', { class: 'btn btn-primary', type: 'button', on: { click: newProjectModal } }, SB.icon('plus'), s.l) : h('a', { class: 'btn btn-primary', href: s.h }, s.l);
    return h('div', { class: 'card next-step' }, h('div', { class: 'txt' }, h('h2', { text: 'Next step: ' + s.t }), h('p', { class: 'muted', text: s.d })), btn);
  }

  SB.screens.home = function () {
    var root = h('div'), topSlot = h('div'), listSlot = h('div');
    var head = h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Home' }), h('p', { class: 'sub', text: 'Your outreach at a glance.' })),
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '#/campaign/new', id: 'home-new-campaign' }, SB.icon('plus'), 'New campaign'),
        h('button', { class: 'btn', type: 'button', on: { click: newProjectModal } }, 'New project')));
    var st = { q: '', status: 'all', sort: 'recent', archived: false, sel: {} }, data = null, built = false;
    var tb = SB.lists.toolbar({ placeholder: 'Search projects', label: 'Search projects', sorts: SORTS, sort: st.sort,
      onSearch: function (q) { st.q = q; paintList(); }, onSort: function (k) { st.sort = k; paintList(); } });
    var chipsBox = h('div'), tagsBox = h('div'), barBox = h('div'), gridBox = h('div');
    root.appendChild(head); root.appendChild(topSlot);
    root.appendChild(listSlot);
    SB.mount(listSlot, h('div', null, h('div', { class: 'section-title' }, h('h2', { text: 'Projects' })), tb.el, chipsBox, tagsBox, gridBox, barBox));

    function visible() {
      if (!data) return [];
      var chip = STATUS_CHIPS.filter(function (c) { return c.key === st.status; })[0] || STATUS_CHIPS[0];
      var cmp = SORTS.filter(function (x) { return x.key === st.sort; })[0].cmp;
      return data.items.filter(function (p) { return SB.lists.has(p.name + ' ' + (p.description || ''), st.q) && (!chip.match || chip.match.indexOf(p.status) !== -1); }).sort(cmp);
    }
    function reload() { st.sel = {}; return load(); }
    function batch(action, ids) {
      return SB.api.post('/api/projects/batch', { action: action, ids: ids }).then(function (r) {
        SB.lists.report(r, { archive: 'archived', restore: 'restored', delete: 'deleted' }[action]);
        st.sel = {}; return load();
      });
    }
    function paintList() {
      if (!data) return;
      var items = visible(), selIds = Object.keys(st.sel).map(Number).filter(function (id) { return data.items.some(function (p) { return p.id === id; }); });
      Object.keys(st.sel).forEach(function (k) { if (selIds.indexOf(Number(k)) === -1) delete st.sel[k]; });
      var chips = STATUS_CHIPS.map(function (c) { return { key: c.key, label: c.label, tip: c.tip, n: c.match ? data.items.filter(function (p) { return c.match.indexOf(p.status) !== -1; }).length : data.items.length }; })
        .filter(function (c) { return c.key === 'all' || c.n > 0 || c.key === st.status; });
      var view = h('div', { class: 'chips filter-chips' }, SB.lists.chips(chips, st.status, function (k) { st.status = k; paintList(); }),
        h('button', { type: 'button', class: 'chip' + (st.archived ? ' on' : ''), 'aria-pressed': st.archived ? 'true' : 'false', tip: 'Projects you archived. Their results are kept.',
          on: { click: function () { st.archived = !st.archived; st.status = 'all'; reload(); } } }, 'Archived'));
      SB.mount(chipsBox, view);
      var tags = [];
      if (st.q) tags.push({ label: 'Search: ' + st.q, onRemove: function () { st.q = ''; tb.search.value = ''; paintList(); } });
      if (st.status !== 'all') tags.push({ label: 'Status: ' + STATUS_CHIPS.filter(function (c) { return c.key === st.status; })[0].label, onRemove: function () { st.status = 'all'; paintList(); } });
      SB.mount(tagsBox, h('div', null, SB.lists.tags(tags, function () { st.q = ''; tb.search.value = ''; st.status = 'all'; paintList(); })));
      if (!data.items.length) {
        SB.mount(gridBox, h('div', { class: 'card empty' }, h('h2', { text: st.archived ? 'No archived projects' : 'No projects yet' }),
          h('p', { text: st.archived ? 'Projects you archive appear here.' : 'Create a project to organise your campaigns and see their results in one place.' }),
          st.archived ? null : h('button', { class: 'btn btn-primary', type: 'button', on: { click: newProjectModal } }, SB.icon('plus'), 'New project')));
      } else if (!items.length) {
        SB.mount(gridBox, h('div', { class: 'card empty' }, h('h2', { text: 'No projects match' }), h('p', { text: 'Try a different search or status.' })));
      } else {
        SB.mount(gridBox, h('div', { class: 'project-grid' }, items.map(function (p) { return projectCard(p, st, paintList); })));
      }
      var names = selIds.length;
      var acts = [{ label: st.archived ? 'Restore' : 'Archive', tip: st.archived ? 'Show these projects in the main list again.' : 'Hide these projects from the main list. Results are kept.',
        onClick: function () { batch(st.archived ? 'restore' : 'archive', selIds); } },
        { label: 'Delete', kind: 'danger', icon: 'trash', onClick: function () {
          ui.confirm({ title: 'Delete ' + names + ' project' + (names === 1 ? '' : 's') + '?', message: 'This permanently deletes the selected projects, all their campaigns and sending history. Projects with a running campaign are skipped: pause them first.',
            confirmLabel: 'Delete forever', danger: true, onConfirm: function () { return batch('delete', selIds); } });
        } }];
      SB.mount(barBox, h('div', null, SB.lists.selectionBar(names, 'project', acts, function () { st.sel = {}; paintList(); }, items.length > names ? function () { items.forEach(function (p) { st.sel[p.id] = p.name; }); paintList(); } : null)));
    }

    function render(r) {
      var drafts = r[4].drafts, senders = r[1].items, projects = r[0].items, leads = r[2].stats.total, unread = r[3].unread;
      data = r[0];
      var sent = 0, cap = 0;
      senders.forEach(function (s) { sent += s.sent_today; if (s.status === 'active') cap += s.limit_today; });
      var badSenders = senders.filter(function (s) { return s.status !== 'active' || s.last_error; });
      var attn = badSenders.length + (r[0].counts.error || 0);
      var attnNote = badSenders.length ? badSenders[0].label + ': ' + (badSenders[0].last_error || (badSenders[0].status === 'paused' ? 'paused' : badSenders[0].status)) : (r[0].counts.error ? 'A campaign is blocked' : 'Everything looks healthy');
      var tiles = h('div', { class: 'grid-tiles' },
        ui.tile('Sent today', fmt.num(sent), cap ? 'of ' + fmt.num(cap) + ' daily capacity' : 'No active sender', 'Emails sent today across all your senders, compared with what they are allowed to send per day.'),
        ui.tile('Replies waiting', fmt.num(unread), unread ? 'Unread conversations' : 'You are all caught up', 'Conversations with a reply you have not opened yet.'),
        ui.tile('Projects running', fmt.num(r[0].counts.active), 'of ' + fmt.num(projects.length) + ' projects', 'Projects with at least one campaign currently sending.'),
        ui.tile('Needs attention', fmt.num(attn), attnNote, 'Senders that are paused or reporting an error, and campaigns that are blocked.', attn > 0));
      SB.mount(topSlot, h('div', null, st.archived ? null : nextStep(senders, leads, projects.length), tiles,
        drafts.length ? h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Drafts' }), ui.info('Campaigns you started writing but have not created yet. Everything you typed is saved.'))), SB.screens.draftList(drafts, load)) : null));
      paintList(); built = true;
    }

    function load() {
      return Promise.all([SB.api.get('/api/projects' + (st.archived ? '?archived=1' : '')), SB.api.get('/api/senders'), SB.api.get('/api/stats'), SB.api.get('/api/inbox?limit=1'), SB.api.get('/api/drafts')]).then(render, function (e) {
        if (e.code !== 'offline' && !built) SB.mount(topSlot, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    SB.mount(topSlot, h('div', { class: 'skeleton' }));
    return { el: root, destroy: ui.poll(load, 10000) };
  };
})();
