/* Project page: roll-up numbers and the campaigns table with segmented step bars. Clicking a campaign opens the Studio (studio.js). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui, M = SB.S.metric;
  SB.screens = SB.screens || {};

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
    var loaded = false, built = false, data = null;
    var topSlot = h('div'), listSlot = h('div');

    function render(p) {
      var t = p.totals;
      var head = h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', p.name),
        h('div', { class: 'page-head' },
          h('div', null, h('div', { class: 'actions' }, h('h1', { text: p.name }), ui.statusPill(p.status)), p.description ? h('p', { class: 'sub', text: p.description }) : null, p.created_at ? h('p', { class: 'small faint', tip: fmt.tip(p.created_at), text: fmt.created(p.created_at) }) : null),
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
    }

    var ctable = SB.screens.campaignTable({ projectId: id, progress: 'steps', selectable: true, onMove: moveModal });
    SB.mount(listSlot, h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h2', { text: 'Campaigns' }), ui.info('Click a campaign to open its Studio: edit emails that have not gone out yet, see who opened, replied or opted out, and follow every step.'))), ctable.el));

    function moveModal(ids, done) {
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
            return SB.api.post('/api/campaigns/batch', body).then(function (res) { close(); SB.lists.report(res, 'moved'); return done(); },
              function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
          } }] });
      }, function (e) { ui.toast(SB.api.friendly(e), true); });
    }

    function load() {
      return SB.api.get('/api/projects/' + id).then(function (r) { loaded = true; render(r.project); }, function (e) {
        if (e.status === 404) { SB.mount(body, h('div', { class: 'card empty' }, h('h2', { text: 'Project not found' }), h('a', { class: 'btn', href: '#/' }, 'Back to Home'))); return; }
        if (!loaded && e.code !== 'offline') SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    var stop = ui.poll(load, 10000);
    return { el: root, destroy: function () { stop(); ctable.destroy(); } };
  };
})();
