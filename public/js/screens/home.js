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
    return h('div', { class: 'hx-stat', tip: tipText }, h('span', { text: label }), h('b', { text: value }), sub ? h('i', { text: sub }) : null);
  }

  // The aggregated PROJECT row has the same fields as a campaign row (status, current state, progression, performance), but every number is the total
  // over the project's campaigns. The campaigns listed under an open project keep their own numbers.
  function projectAgg(p) {
    var r = p.row || { display_status: 'empty', next_send_at: null, next_kind: null, start_at: null, track_opens: 0, metrics: {}, step_progress: [], scheduled: 0, sent: 0, leads: 0, stats: {}, progress_pct: 0 };
    return Object.assign({}, r, { id: p.id, name: p.name, created_at: p.created_at, archived: false });
  }

  function projectMenu(p, st, ops) {
    return SB.controls.rowMenu(function () {
      return [
        { label: 'Open project', icon: 'eye', tip: 'See the project page with its totals and campaigns.', onClick: function () { location.hash = '#/project/' + p.id; } },
        { label: 'New campaign', icon: 'plus', tip: 'Add a campaign to this project.', onClick: function () { location.hash = '#/campaign/new/' + p.id; } },
        p.status === 'paused' ? { label: 'Resume', icon: 'play', tip: 'Continue sending for the paused campaigns in this project.', onClick: function () { ops.batch('resume', [p.id]); } }
          : { label: 'Pause', icon: 'pause', disabled: p.status !== 'active' || st.archived, tip: p.status === 'active' ? 'Stop sending for every running campaign in this project until you resume. Nobody is lost.' : 'Only a project with a running campaign can be paused.',
            onClick: function () { ops.batch('pause', [p.id]); } },
        { label: st.archived ? 'Restore' : 'Archive', icon: 'archive', tip: st.archived ? 'Show this project in the main list again.' : 'Hide this project from the main list. Results are kept.', onClick: function () { ops.batch(st.archived ? 'restore' : 'archive', [p.id]); } },
        { label: 'Delete', icon: 'trash', tip: 'Permanently delete the project, its campaigns and history.', onClick: function () {
          ui.confirm({ title: 'Delete "' + p.name + '"?', message: 'This permanently deletes the project, all its campaigns and sending history. A project with a running campaign is skipped: pause it first.', confirmLabel: 'Delete forever', danger: true, onConfirm: function () { return ops.batch('delete', [p.id]); } });
        } }
      ];
    }, 'Actions for ' + p.name);
  }

  // One project row (same columns as a campaign row) + its campaigns when open.
  function projectRows(p, st, repaint, toggle, ops) {
    var on = !!st.sel[p.id], open = !!st.open[p.id], out = [], agg = projectAgg(p);
    var cb = h('input', { type: 'checkbox', 'aria-label': 'Select project ' + p.name }); cb.checked = on;
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
    cb.addEventListener('change', function () { if (cb.checked) st.sel[p.id] = p.name; else delete st.sel[p.id]; repaint(); });
    var chev = h('button', { class: 'hx-chev' + (open ? ' open' : ''), type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': (open ? 'Hide' : 'Show') + ' campaigns in ' + p.name,
      tip: open ? 'Hide the campaigns in this project.' : 'Show the campaigns in this project with their own results.', on: { click: function (e) { e.stopPropagation(); toggle(p.id); } } }, SB.icon('chevron'));
    var sub = (p.campaign_count ? fmt.num(p.campaign_count) + ' campaign' + (p.campaign_count === 1 ? '' : 's') + ' · ' + fmt.num(p.totals.leads) + (p.totals.leads === 1 ? ' person' : ' people') : 'No campaigns yet');
    var tr = h('tr', { class: 'proj-row' + (on ? ' selected' : '') + (open ? ' is-open' : '') },
      h('td', { class: 'row-check' }, cb),
      h('td', { class: 'ct-name' }, h('div', { class: 'proj-name' }, chev, h('div', { class: 'proj-title' }, h('a', { class: 'hx-name ct-title', href: '#/project/' + p.id, tip: 'Open the project: ' + p.name, text: p.name }),
        h('div', { class: 'small faint', tip: 'Totals over every campaign in this project.' }, sub)))));
    SB.campaignGrid.dataCells(agg, { progress: 'steps' }).forEach(function (td) { tr.appendChild(td); });
    tr.appendChild(h('td', { class: 'ct-act' }, projectMenu(p, st, ops)));
    out.push(tr);
    if (open) {
      var d = st.detail[p.id], cols = 12;
      if (!d) out.push(h('tr', { class: 'sub-note' }, h('td', { colspan: cols }, h('div', { class: 'skeleton' }))));
      else if (d.error) out.push(h('tr', { class: 'sub-note' }, h('td', { colspan: cols }, h('div', { class: 'form-error', text: d.error }))));
      else if (!d.campaigns.length) out.push(h('tr', { class: 'sub-note' }, h('td', { colspan: cols }, h('div', { class: 'hx-empty' }, h('span', { class: 'muted', text: 'This project has no campaigns yet.' }), h('a', { class: 'btn btn-sm btn-primary', href: '#/campaign/new/' + p.id }, SB.icon('plus'), 'New campaign')))));
      else d.campaigns.forEach(function (c) { out.push(SB.campaignGrid.row(c, { progress: 'steps', showProject: false, lead: true, rowClass: 'sub-row', onChange: st.refresh })); });
    }
    return out;
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
    var st = { q: '', status: 'all', sort: 'recent', archived: false, sel: {}, open: {}, detail: {}, refresh: function () { return load(); } }, data = null, built = false;
    var tb = SB.lists.toolbar({ placeholder: 'Search projects', label: 'Search projects', sorts: SORTS, sort: st.sort,
      onSearch: function (q) { st.q = q; paintList(); }, onSort: function (k) { st.sort = k; paintList(); } });
    var chipsBox = h('div'), tagsBox = h('div'), barBox = h('div', { class: 'hx-bar' }), gridBox = h('div');
    root.appendChild(head); root.appendChild(topSlot);
    root.appendChild(listSlot);
    SB.mount(listSlot, h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Projects and Campaigns' }), ui.info('Your projects, each holding its campaigns. Open a project with the arrow to see its campaigns, their progress and results.'))),
      tb.el, chipsBox, tagsBox, barBox, gridBox));

    function visible() {
      if (!data) return [];
      var chip = STATUS_CHIPS.filter(function (c) { return c.key === st.status; })[0] || STATUS_CHIPS[0];
      var cmp = SORTS.filter(function (x) { return x.key === st.sort; })[0].cmp;
      return data.items.filter(function (p) { return SB.lists.has(p.name + ' ' + (p.description || ''), st.q) && (!chip.match || chip.match.indexOf(p.status) !== -1); }).sort(cmp);
    }
    function fetchDetail(id) {
      return SB.api.get('/api/campaign-table?project_id=' + id).then(function (r) { st.detail[id] = { campaigns: r.items || [] }; }, function (e) { st.detail[id] = { error: SB.api.friendly(e) }; });
    }
    function toggle(id) {
      if (st.open[id]) { delete st.open[id]; paintList(); return; }
      st.open[id] = true; paintList(); fetchDetail(id).then(paintList);
    }
    function reload() { st.sel = {}; return load(); }
    function batch(action, ids) {
      return SB.api.post('/api/projects/batch', { action: action, ids: ids }).then(function (r) {
        SB.lists.report(r, { archive: 'archived', restore: 'restored', delete: 'deleted', pause: 'paused', resume: 'resumed' }[action]);
        st.sel = {}; return load();
      });
    }
    function paintList() {
      if (!data) return;
      var items = visible(), selIds = Object.keys(st.sel).map(Number).filter(function (id) { return data.items.some(function (p) { return p.id === id; }); });
      Object.keys(st.sel).forEach(function (k) { if (selIds.indexOf(Number(k)) === -1) delete st.sel[k]; });
      var chips = STATUS_CHIPS.map(function (c) { return { key: c.key, label: c.label, tip: c.tip, n: c.match ? data.items.filter(function (p) { return c.match.indexOf(p.status) !== -1; }).length : data.items.length }; })
        .filter(function (c) { return c.key === 'all' || c.n > 0 || c.key === st.status; });
      var view = h('div', { class: 'filter-row' }, SB.lists.chips(chips, st.status, function (k) { st.status = k; paintList(); }),
        h('button', { type: 'button', class: 'chip chip-archived' + (st.archived ? ' on' : ''), 'aria-pressed': st.archived ? 'true' : 'false', tip: 'Projects you archived. Their results are kept.',
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
        var allCb = h('input', { type: 'checkbox', 'aria-label': 'Select all shown projects' }); allCb.checked = items.length > 0 && items.every(function (p) { return !!st.sel[p.id]; });
        allCb.addEventListener('change', function () { items.forEach(function (p) { if (allCb.checked) st.sel[p.id] = p.name; else delete st.sel[p.id]; }); paintList(); });
        var ops = { batch: batch };
        SB.mount(gridBox, h('div', { class: 'hx-list' },
          h('div', { class: 'hx-toolbar' }, h('span', { class: 'small muted', text: items.length + ' project' + (items.length === 1 ? '' : 's') }),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Open or close every project at once.', on: { click: function () { items.forEach(function (p) { if (allOpen) delete st.open[p.id]; else { st.open[p.id] = true; fetchDetail(p.id); } }); paintList(); } } }, allOpen ? 'Collapse all' : 'Expand all')),
          h('div', { class: 'card table-card ct-wrap table-wrap' }, h('table', { class: 'table ct-table ct-steps-table pc-table' },
            SB.campaignGrid.head({ progress: 'steps', lead: true, firstHead: 'Project / Campaign', firstTip: 'Projects, with their campaigns underneath when open. A project row shows the totals of all its campaigns; each campaign row shows only its own numbers.' }, allCb),
            h('tbody', null, items.reduce(function (acc, p) { return acc.concat(projectRows(p, st, paintList, toggle, ops)); }, []))))));
      }
      var names = selIds.length;
      var anyPaused = selIds.some(function (id) { return data.items.some(function (p) { return p.id === id && p.status === 'paused'; }); });
      var acts = [{ label: 'Pause', icon: 'pause', tip: 'Stop sending for every running campaign in the selected projects. Nobody is lost.', onClick: function () { batch('pause', selIds); } }]
        .concat(anyPaused ? [{ label: 'Resume', icon: 'play', tip: 'Continue sending for the paused campaigns in the selected projects.', onClick: function () { batch('resume', selIds); } }] : [])
        .concat([{ label: st.archived ? 'Restore' : 'Archive', tip: st.archived ? 'Show these projects in the main list again.' : 'Hide these projects from the main list. Results are kept.',
        onClick: function () { batch(st.archived ? 'restore' : 'archive', selIds); } },
        { label: 'Delete', kind: 'danger', icon: 'trash', onClick: function () {
          ui.confirm({ title: 'Delete ' + names + ' project' + (names === 1 ? '' : 's') + '?', message: 'This permanently deletes the selected projects, all their campaigns and sending history. Projects with a running campaign are skipped: pause them first.',
            confirmLabel: 'Delete forever', danger: true, onConfirm: function () { return batch('delete', selIds); } });
        } }]);
      SB.mount(barBox, h('div', null, SB.lists.selectionBar(names, 'project', acts, function () { st.sel = {}; paintList(); }, items.length > names ? function () { items.forEach(function (p) { st.sel[p.id] = p.name; }); paintList(); } : null)));
    }

    function render(r) {
      var drafts = r[4].drafts, senders = r[1].items, projects = r[0].items, leads = r[2].stats.total, unread = r[3].unread;
      data = r[0];
      SB.status = SB.status || {};
      Object.keys(st.open).forEach(function (k) { if (!data.items.some(function (p) { return String(p.id) === k; })) { delete st.open[k]; delete st.detail[k]; } });
      var sent = 0, cap = 0;
      senders.forEach(function (s) { sent += s.sent_today; if (s.status === 'active') cap += s.limit_today; });
      var attnNote = r[7].counts.dismissed ? 'No active alerts (' + r[7].counts.dismissed + ' dismissed, they return if the problem comes back)' : 'Everything looks healthy';
      // At-a-glance row: replies waiting, people waiting for an email, today's sending, and a health list of anything that needs action.
      var waiting = 0; projects.forEach(function (p) { waiting += p.totals.active || 0; });
      // Every alert comes from the server (GET /api/alerts: senders, campaigns, people, bounces, limits); nothing is filtered or cut here.
      var al = r[7], seen = (r[6] && r[6].settings && r[6].settings.health_seen) || [], dismissed = (r[6] && r[6].settings && r[6].settings.health_dismissed) || [];
      var allKeys = al.all_keys;
      var alerts = al.items.map(function (x) { return { key: x.key, lvl: x.level, t: x.title, d: x.detail, href: x.href, l: x.action, isNew: x.is_new }; });
      var critical = al.counts.critical, unseen = al.counts.unreviewed;
      // Reviewed state lives on the server (nothing is stored in the browser); only alerts still showing are kept, so a problem that returns counts as new.
      function markSeen(keys) { return SB.api.put('/api/settings/health-seen', { keys: keys }).then(function () { return load(); }, function (e) { ui.toast(SB.api.friendly(e), true); }); }
      function dismiss(key) { return SB.api.put('/api/settings/health-dismissed', { keys: dismissed.concat([key]).filter(function (k) { return allKeys.indexOf(k) !== -1; }) }).then(function () { return load(); }, function (e) { ui.toast(SB.api.friendly(e), true); }); }
      function glance(icon, label, value, note, href, btn, tipText) {
        return h('div', { class: 'card glance', tip: tipText }, h('div', { class: 'glance-h' }, SB.icon(icon), h('span', { text: label })),
          h('div', { class: 'glance-v' }, h('b', { text: value }), h('span', { class: 'muted', text: note })), h('a', { class: 'btn btn-sm', href: href }, btn));
      }
      var health = h('div', { class: 'card glance-health' }, h('div', { class: 'glance-h' },
        h('span', { class: 'health-badge', tip: unseen ? fmt.num(unseen) + (unseen === 1 ? ' alert you have not reviewed yet' : ' alerts you have not reviewed yet') : 'Nothing new to review' }, SB.icon('alert'), unseen ? h('span', { class: 'dot-n' + (alerts.some(function (x) { return x.isNew && x.lvl === 'critical'; }) ? ' crit' : ''), text: unseen > 9 ? '9+' : String(unseen) }) : null),
        h('span', { text: 'Campaign health' }),
        critical ? h('span', { class: 'pill pill-error', tip: 'Problems that can hurt your sending accounts and need action now.', text: fmt.num(critical) + ' critical' }) : null,
        alerts.length > critical ? h('span', { class: 'pill pill-paused', tip: 'Problems worth a look that are not urgent.', text: fmt.num(alerts.length - critical) + (alerts.length - critical === 1 ? ' warning' : ' warnings') }) : null,
        ui.info('Problems found in your campaigns and sending accounts, most urgent first. The badge counts alerts you have not reviewed yet. Nothing here means all is well.'),
        unseen ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Mark everything here as reviewed. A problem that comes back will show as new again.', on: { click: function () { markSeen(alerts.map(function (x) { return x.key; })); } } }, 'Mark all reviewed') : null),
        alerts.length ? h('div', { class: 'health-list' }, alerts.map(function (x) {
          return h('div', { class: 'health-item ' + x.lvl }, h('div', null, h('b', { text: x.t }), x.isNew ? h('span', { class: 'tag tag-new', text: 'New' }) : null, h('div', { class: 'small muted', text: x.d })), h('div', { class: 'health-side' }, h('div', { class: 'health-top' }, h('span', { class: 'small faint', text: x.lvl === 'critical' ? 'Critical' : 'Warning' }),
            h('button', { class: 'health-x', type: 'button', 'aria-label': 'Dismiss: ' + x.t, tip: 'Hide this alert. It comes back only if the problem goes away and returns.', on: { click: function () { dismiss(x.key); } } }, SB.icon('x'))),
            h('a', { class: 'btn btn-sm', href: x.href, on: { click: function () { if (x.isNew) SB.api.put('/api/settings/health-seen', { keys: seen.concat([x.key]).filter(function (k) { return alerts.some(function (a) { return a.key === k; }); }) }).catch(function () {}); } } }, x.l)));
        })) : h('p', { class: 'muted', text: attnNote.replace(/\.$/, '') + '.' }));
      var ov = r[5];
      function stat(icon, label, value, note, href, tipText) {
        return h('a', { class: 'card stat-card', href: href, tip: tipText }, h('div', { class: 'stat-h' }, SB.icon(icon), h('span', { text: label })),
          h('div', { class: 'stat-v', text: fmt.num(value) }), h('div', { class: 'stat-n small muted', text: note }));
      }
      var tiles = h('div', { class: 'overview' },
        h('div', { class: 'stat-row' },
          stat('send', 'Active', ov.active_campaigns, ov.active_campaigns === 1 ? 'campaign running' : 'campaigns running', '#/', 'Campaigns that are sending right now.'),
          stat('inbox', 'Replies', ov.replies, (ov.replies === 1 ? 'person' : 'people') + ', all time' + (ov.replies_unread ? ' · ' + fmt.num(ov.replies_unread) + ' unread' : ' · all read'), '#/inbox', 'Everyone who ever wrote back to one of your emails, with how many replies you have not opened yet.'),
          stat('mail', 'Sent today', sent, cap ? 'of ' + fmt.num(cap) + ' daily capacity' : 'no active sender', '#/senders', 'Emails sent since midnight, compared with what your active sending accounts may send per day.'),
          stat('clock', 'Scheduled', ov.scheduled, 'upcoming emails', '#/queue', 'Every email still to go out in running campaigns: first emails and follow-ups, for people who have not replied or opted out.')),
        health);
      SB.mount(topSlot, h('div', null, st.archived ? null : nextStep(senders, leads, projects.length), tiles,
        drafts.length ? h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Drafts' }), ui.info('Campaigns you started writing but have not created yet. Everything you typed is saved.'))), SB.screens.draftList(drafts, load)) : null));
      paintList(); built = true;
      // Keep expanded projects fresh without flicker: refetch quietly, repaint once everything is back.
      var ids = Object.keys(st.open); if (ids.length) Promise.all(ids.map(function (k) { return fetchDetail(Number(k)); })).then(paintList);
    }

    function load() {
      return Promise.all([SB.api.get('/api/projects' + (st.archived ? '?archived=1' : '')), SB.api.get('/api/senders'), SB.api.get('/api/stats'), SB.api.get('/api/inbox?limit=1'), SB.api.get('/api/drafts'), SB.api.get('/api/overview?tz=' + (-new Date().getTimezoneOffset())), SB.api.get('/api/settings'), SB.api.get('/api/alerts')]).then(render, function (e) {
        if (e.code !== 'offline' && !built) SB.mount(topSlot, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    SB.mount(topSlot, h('div', { class: 'skeleton' }));
    var stopHome = ui.poll(load, 10000);
    return { el: root, destroy: stopHome };
  };
})();
