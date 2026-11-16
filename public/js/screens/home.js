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

  function rate(n) { return n === null || n === undefined ? '-' : fmt.num(n) + '%'; }
  function stat(label, value, tipText, sub) {
    return h('div', { class: 'hx-stat', tip: tipText }, h('b', { text: value }), h('span', { text: label }), sub ? h('i', { text: sub }) : null);
  }

  // One Hunter-style project row. The chevron expands it to show its campaigns underneath, loaded on demand.
  function projectRow(p, st, repaint, toggle) {
    var t = p.totals, on = !!st.sel[p.id], open = !!st.open[p.id], any = Object.keys(st.sel).length > 0;
    var cb = h('input', { type: 'checkbox', class: 'pc-check', 'aria-label': 'Select project ' + p.name });
    cb.checked = on;
    cb.addEventListener('change', function () { if (cb.checked) st.sel[p.id] = p.name; else delete st.sel[p.id]; repaint(); });
    var chev = h('button', { class: 'hx-chev' + (open ? ' open' : ''), type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': (open ? 'Hide' : 'Show') + ' campaigns in ' + p.name,
      tip: open ? 'Hide the campaigns in this project.' : 'Show the campaigns in this project with their results.', on: { click: function () { toggle(p.id); } } }, SB.icon('chevron'));
    var head = h('div', { class: 'hx-head' }, chev,
      h('div', { class: 'hx-title' }, h('a', { class: 'hx-name', href: '#/project/' + p.id, text: p.name }),
        h('div', { class: 'small faint', text: p.campaign_count ? fmt.num(p.campaign_count) + ' campaign' + (p.campaign_count === 1 ? '' : 's') + ' \u00b7 ' + fmt.num(t.leads) + ' people' : 'No campaigns yet' })),
      ui.statusPill(p.status),
      p.campaign_count ? h('div', { class: 'hx-stats' },
        stat('Sent', fmt.num(t.sent), SB.S.metric.sent),
        stat('Opened', t.opens_tracked ? rate(t.open_rate) : 'Off', t.opens_tracked ? 'Share of delivered emails that were opened at least once. Open counts are estimates.' : 'Open tracking is off for these campaigns.'),
        stat('Replied', rate(t.reply_rate), SB.S.metric.replied, fmt.num(t.replied) + ' people'),
        stat('Bounced', rate(t.bounce_rate), SB.S.metric.bounced, fmt.num(t.bounced) + ' people'),
        stat('Next email', fmt.until(t.next_send_at), SB.S.metric.next)) : h('div', { class: 'hx-stats' }),
      h('div', { class: 'hx-prog' }, p.campaign_count ? ui.progress(t.progress_pct) : null));
    var body = null;
    if (open) {
      var d = st.detail[p.id];
      if (!d) body = h('div', { class: 'hx-body' }, h('div', { class: 'skeleton' }));
      else if (d.error) body = h('div', { class: 'hx-body' }, h('div', { class: 'form-error', text: d.error }));
      else body = h('div', { class: 'hx-body' }, campaignTable(d.campaigns, p));
    }
    return h('div', { class: 'pc-wrap hx-row' + (on ? ' selected' : '') + (any ? ' sel-mode' : '') + (open ? ' is-open' : '') }, cb, head, body);
  }

  function campaignTable(list, p) {
    if (!list.length) return h('div', { class: 'hx-empty' }, h('span', { class: 'muted', text: 'This project has no campaigns yet.' }), h('a', { class: 'btn btn-sm btn-primary', href: '#/campaign/new/' + p.id }, SB.icon('plus'), 'New campaign'));
    var M = SB.S.metric;
    return h('div', { class: 'hx-table' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { text: 'Campaign' }), h('th', { text: 'Status' }), h('th', { text: 'Sequence' }), h('th', { text: 'Sent', tip: M.sent }), h('th', { text: 'Opened', tip: 'People who opened at least one email, and the share of delivered emails.' }),
        h('th', { text: 'Replied', tip: M.replied }), h('th', { text: 'Bounced', tip: M.bounced }), h('th', { text: 'Next email', tip: M.next }))),
      h('tbody', null, list.map(function (c) {
        var m = c.metrics || {}, tracked = !!c.track_opens, emailed = m.emailed || 0;
        function pctOf(n) { return emailed ? Math.round(n / emailed * 1000) / 10 + '%' : '0%'; }
        return h('tr', { class: 'row-link', on: { click: function () { location.hash = '#/campaign/' + c.id; } } },
          h('td', null, h('b', { text: c.name }), c.batches ? h('div', { class: 'small faint', text: c.batches + ' batches' }) : null),
          h('td', null, ui.statusPill(c.status)),
          h('td', { class: 'c-steps' }, ui.stepBar(c.step_progress, { compact: true })),
          h('td', { text: fmt.num(c.sent) }),
          h('td', { tip: tracked ? 'Opens are estimates: some mail apps block the tracking image.' : 'Open tracking is off for this campaign.' }, tracked ? h('span', null, fmt.num(m.opened || 0), h('span', { class: 'small faint', text: ' \u00b7 ' + pctOf(m.opened || 0) })) : h('span', { class: 'faint', text: 'Off' })),
          h('td', null, fmt.num(m.replied || 0), h('span', { class: 'small faint', text: ' \u00b7 ' + pctOf(m.replied || 0) })),
          h('td', null, fmt.num(c.stats.bounced), h('span', { class: 'small faint', text: ' \u00b7 ' + pctOf(c.stats.bounced) })),
          h('td', { text: fmt.until(c.next_send_at) }));
      }))));
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
    var head = h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Campaigns' }), h('p', { class: 'sub', text: 'Your projects and campaigns at a glance.' })),
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '#/campaign/new', id: 'home-new-campaign' }, SB.icon('plus'), 'New campaign'),
        h('button', { class: 'btn', type: 'button', on: { click: newProjectModal } }, 'New project')));
    var st = { q: '', status: 'all', sort: 'recent', archived: false, sel: {}, open: {}, detail: {} }, data = null, built = false;
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
    function fetchDetail(id) {
      return SB.api.get('/api/projects/' + id).then(function (r) { st.detail[id] = { campaigns: r.project.campaigns || [] }; }, function (e) { st.detail[id] = { error: SB.api.friendly(e) }; });
    }
    function toggle(id) {
      if (st.open[id]) { delete st.open[id]; paintList(); return; }
      st.open[id] = true; paintList(); fetchDetail(id).then(paintList);
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
        var allOpen = items.every(function (p) { return !!st.open[p.id]; });
        SB.mount(gridBox, h('div', { class: 'hx-list' },
          h('div', { class: 'hx-toolbar' }, h('span', { class: 'small muted', text: items.length + ' project' + (items.length === 1 ? '' : 's') }),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Open or close every project at once.', on: { click: function () { items.forEach(function (p) { if (allOpen) delete st.open[p.id]; else { st.open[p.id] = true; fetchDetail(p.id); } }); paintList(); } } }, allOpen ? 'Collapse all' : 'Expand all')),
          items.map(function (p) { return projectRow(p, st, paintList, toggle); })));
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
      SB.status = SB.status || {};
      Object.keys(st.open).forEach(function (k) { if (!data.items.some(function (p) { return String(p.id) === k; })) { delete st.open[k]; delete st.detail[k]; } });
      var sent = 0, cap = 0;
      senders.forEach(function (s) { sent += s.sent_today; if (s.status === 'active') cap += s.limit_today; });
      var badSenders = senders.filter(function (s) { return s.status !== 'active' || s.last_error; });
      var attn = badSenders.length + (r[0].counts.error || 0);
      var attnNote = badSenders.length ? badSenders[0].label + ': ' + (badSenders[0].last_error || (badSenders[0].status === 'paused' ? 'paused' : badSenders[0].status)) : (r[0].counts.error ? 'A campaign is blocked' : 'Everything looks healthy');
      // At-a-glance row: replies waiting, people waiting for an email, today's sending, and a health list of anything that needs action.
      var waiting = 0; projects.forEach(function (p) { waiting += p.totals.active || 0; });
      var alerts = [];
      projects.forEach(function (p) {
        var t = p.totals;
        if (t.emailed >= 20 && t.bounce_rate >= 5) alerts.push({ lvl: 'critical', t: p.name + ': high bounce rate (' + t.bounce_rate + '%)', d: 'Pause the campaign and verify your lead list to protect your sending accounts.', href: '#/project/' + p.id, l: 'Review' });
        else if (t.errors) alerts.push({ lvl: 'warning', t: p.name + ': a campaign is blocked', d: 'Open the project to see which campaign needs attention.', href: '#/project/' + p.id, l: 'Review' });
      });
      badSenders.forEach(function (s) { alerts.push({ lvl: s.status === 'active' ? 'warning' : 'critical', t: (s.label || s.email) + ': ' + (s.last_error ? 'reporting an error' : s.status), d: s.last_error || 'This account is not sending right now.', href: '#/senders', l: 'Open' }); });
      function glance(icon, label, value, note, href, btn, tipText) {
        return h('div', { class: 'card glance', tip: tipText }, h('div', { class: 'glance-h' }, SB.icon(icon), h('span', { text: label })),
          h('div', { class: 'glance-v' }, h('b', { text: value }), h('span', { class: 'muted', text: note })), h('a', { class: 'btn btn-sm', href: href }, btn));
      }
      var health = h('div', { class: 'card glance-health' }, h('div', { class: 'glance-h' }, SB.icon('alert'), h('span', { text: 'Campaign health' }), alerts.length ? h('span', { class: 'pill pill-error', text: String(alerts.length) }) : null,
        ui.info('Problems found in your campaigns and sending accounts, most urgent first. Nothing here means all is well.')),
        alerts.length ? h('div', { class: 'health-list' }, alerts.sort(function (x, y) { return x.lvl === y.lvl ? 0 : x.lvl === 'critical' ? -1 : 1; }).slice(0, 6).map(function (x) {
          return h('div', { class: 'health-item ' + x.lvl }, h('div', null, h('b', { text: x.t }), h('div', { class: 'small muted', text: x.d })), h('div', { class: 'health-side' }, h('span', { class: 'small faint', text: x.lvl === 'critical' ? 'Critical' : 'Warning' }), h('a', { class: 'btn btn-sm', href: x.href }, x.l)));
        })) : h('p', { class: 'muted', text: attnNote + '.' }));
      var tiles = h('div', { class: 'glance-row' },
        h('div', { class: 'glance-col' },
          glance('inbox', 'Replies', fmt.num(unread), 'unread', '#/inbox', 'Go to inbox', 'Conversations with a reply you have not opened yet.'),
          glance('clock', 'Waiting', fmt.num(waiting), 'people', '#/queue', 'Go to queue', 'People who still have an email to receive in a running campaign.')),
        h('div', { class: 'glance-col' },
          glance('send', 'Sent today', fmt.num(sent), cap ? 'of ' + fmt.num(cap) : 'no active sender', '#/senders', 'Sending accounts', 'Emails sent today compared with what your senders may send per day.'),
          glance('chart', 'Projects running', fmt.num(r[0].counts.active), 'of ' + fmt.num(projects.length), '#/reports', 'Reporting', 'Projects with at least one campaign currently sending.')),
        health);
      SB.mount(topSlot, h('div', null, st.archived ? null : nextStep(senders, leads, projects.length), tiles,
        drafts.length ? h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Drafts' }), ui.info('Campaigns you started writing but have not created yet. Everything you typed is saved.'))), SB.screens.draftList(drafts, load)) : null));
      paintList(); built = true;
      // Keep expanded projects fresh without flicker: refetch quietly, repaint once everything is back.
      var ids = Object.keys(st.open); if (ids.length) Promise.all(ids.map(function (k) { return fetchDetail(Number(k)); })).then(paintList);
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
