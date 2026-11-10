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
          ui.tile('Bounced', fmt.num(t.bounced), fmt.pct(t.bounce_rate) + ' bounce rate', M.bounced), ui.tile('Opens', 'Not tracked', null, M.opens)),
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
    var loaded = false;

    function render(p) {
      var t = p.totals;
      var head = h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', p.name),
        h('div', { class: 'page-head' },
          h('div', null, h('div', { class: 'actions' }, h('h1', { text: p.name }), ui.statusPill(p.status)), p.description ? h('p', { class: 'sub', text: p.description }) : null),
          h('div', { class: 'actions' },
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
        ui.tile('Opens', 'Not tracked', 'Use replies instead', M.opens), ui.tile('Next email', fmt.until(t.next_send_at), null, M.next));
      var campaigns = p.campaigns.length
        ? h('div', { class: 'table-wrap card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null,
          h('th', { text: 'Campaign' }), h('th', { text: 'Status' }), h('th', null, 'Progress ', ui.info(M.progress)), h('th', { text: 'Sent' }), h('th', { text: 'Replies' }), h('th', { text: 'Bounced' }), h('th', { text: 'Next email' }), h('th'))),
          h('tbody', null, p.campaigns.map(function (c) {
            return h('tr', { class: 'row-link', on: { click: function () { drillDown(c); } } },
              h('td', null, h('b', { text: c.name }), c.batches ? h('div', { class: 'small faint', text: c.batches + ' batches' }) : null), h('td', null, ui.statusPill(c.status)),
              h('td', { style: null }, h('div', { class: 'small', text: fmt.pct(c.progress_pct) }), ui.progress(c.progress_pct)),
              h('td', { text: fmt.num(c.sent) }), h('td', { text: fmt.num(c.metrics.replied) }), h('td', { text: fmt.num(c.stats.bounced) }), h('td', { text: fmt.until(c.next_send_at) }),
              h('td', null, h('div', { class: 'actions' }, lifecycle(c, load), h('span', { class: 'faint' }, SB.icon('chevron')))));
          }))))
        : h('div', { class: 'card empty' }, h('h2', { text: 'No campaigns in this project yet' }), h('p', { text: 'The campaign builder is the next screen being built. Campaigns you create through it will appear here.' }));
      SB.mount(body, h('div', null, head, tiles,
        t.replied ? h('div', { class: 'card' }, h('h3', null, 'Reply sentiment'), h('div', { class: 'section-title' }), ui.sentimentBar(t.sentiment)) : null,
        h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Campaigns' }), ui.info('Click a campaign to see its batches and how many emails went out at each step.'))), campaigns));
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
