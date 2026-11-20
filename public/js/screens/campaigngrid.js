/* Campaign grid: the one campaign table layout used on Home (inside an expanded project) and on the Project page.
   Columns: Campaign, Status, Current state, Created, Progression, Performance (Scheduled, Sent, Opened, Replied, Successful), Actions (three-dots menu).
   SB.campaignGrid.table(items, opts)  items = rows of GET /api/campaign-table.
   opts.progress   'steps' (segmented step bar: Initial email, Follow-up 1..5, with a tooltip per step) or 'bar' (single percentage bar)
   opts.showProject show the project link under the campaign name
   opts.select     { sel: {id: name}, onChange() } adds a checkbox column
   opts.onChange   called after an action (pause, resume, duplicate, archive, rename) so the caller can reload */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;

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

  function act(c, path, okMsg, body, onChange) {
    return SB.api.post('/api/campaigns/' + c.id + '/' + path, body || {}).then(function (r) {
      (r.campaign && r.campaign.warnings || []).forEach(function (w) { ui.toast(w.message, true); });
      ui.toast(okMsg); return onChange && onChange();
    }, function (e) { ui.toast(SB.api.friendly(e), true); });
  }
  function renameModal(c, onChange) {
    var inp = h('input', { class: 'input', id: 'rn-name', maxlength: 100, value: c.name });
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    ui.modal({ title: 'Rename campaign', body: h('div', null, err, h('div', { class: 'field' }, h('label', { for: 'rn-name' }, 'Campaign name'), inp)), actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        return SB.api.patch('/api/campaigns/' + c.id, { name: inp.value }).then(function () { close(); ui.toast('Renamed'); if (onChange) onChange(); }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
      } }] });
  }
  function menuFor(c, onChange) {
    return SB.controls.rowMenu(function () {
      var items = [];
      if (c.status === 'active' && !c.archived) items.push({ label: 'Pause', icon: 'pause', tip: 'Stop sending until you resume. Nobody is lost.', onClick: function () {
        ui.confirm({ title: 'Pause "' + c.name + '"?', message: 'Sending stops until you resume. Nobody is lost.', confirmLabel: 'Pause', onConfirm: function () { return act(c, 'pause', 'Campaign paused', null, onChange); } }); } });
      else if (c.status === 'paused' && !c.archived) items.push({ label: 'Resume', icon: 'play', tip: 'Continue where sending stopped.', onClick: function () { act(c, 'resume', 'Campaign resumed', null, onChange); } });
      else items.push({ label: 'Pause', icon: 'pause', disabled: true, tip: c.archived ? 'Restore the campaign first.' : 'Only a running campaign can be paused.' });
      items.push({ label: 'Duplicate', icon: 'copy', tip: 'Create a draft copy with the same emails, schedule, accounts and people. Nothing is sent from the copy until you start it.', onClick: function () {
        ui.confirm({ title: 'Duplicate "' + c.name + '"?', message: 'A new draft is created in the same project with the same emails, sending days, accounts and people. Nothing is sent until you start it.', confirmLabel: 'Duplicate',
          onConfirm: function () { return SB.api.post('/api/campaigns/' + c.id + '/duplicate', {}).then(function (r) { ui.toast('Draft copy created'); location.hash = '#/campaign/' + r.campaign.id; }); } }); } });
      items.push({ label: c.archived ? 'Restore' : 'Archive', icon: 'archive', disabled: !c.archived && (c.status === 'active' || c.status === 'preparing'),
        tip: c.archived ? 'Show this campaign in the main list again.' : (c.status === 'active' ? 'Pause the campaign first.' : 'Hide this campaign from the main list. Results are kept.'),
        onClick: function () { act(c, 'archive', c.archived ? 'Campaign restored' : 'Campaign archived', { archived: !c.archived }, onChange); } });
      items.push({ label: 'Rename', icon: 'edit', tip: 'Change the campaign name.', onClick: function () { renameModal(c, onChange); } });
      return items;
    }, 'Actions for ' + c.name);
  }

  function progressCell(c, mode) {
    if (mode === 'steps') return h('td', { class: 'c-steps' }, ui.stepBar(c.step_progress, { compact: true }));
    var done = (c.stats.replied || 0) + (c.stats.completed || 0) + (c.stats.bounced || 0) + (c.stats.unsubscribed || 0);
    return h('td', { class: 'ct-prog', tip: fmt.num(done) + ' of ' + fmt.num(c.leads) + ' people finished. ' + SB.S.metric.progress }, ui.progress(c.progress_pct), h('div', { class: 'small faint', text: fmt.pct(c.progress_pct) }));
  }

  function row(c, o) {
    var m = c.metrics || {}, tracked = !!c.track_opens, emailed = m.emailed || 0, sel = o.select;
    function pctOf(n) { return emailed ? ' · ' + (Math.round(n / emailed * 1000) / 10) + '%' : ''; }
    var cb = null;
    if (sel) {
      cb = h('input', { type: 'checkbox', 'aria-label': 'Select campaign ' + c.name }); cb.checked = !!sel.sel[c.id];
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { if (cb.checked) sel.sel[c.id] = c.name; else delete sel.sel[c.id]; sel.onChange(); });
    }
    var tr = h('tr', { class: 'row-link' + (c.archived ? ' is-archived' : '') + (cb && cb.checked ? ' selected' : ''), tabindex: 0, on: { click: function () { location.hash = '#/campaign/' + c.id; }, keydown: function (e) { if (e.key === 'Enter' && e.target === tr) location.hash = '#/campaign/' + c.id; } } },
      cb ? h('td', { class: 'row-check' }, cb) : null,
      h('td', { class: 'ct-name' }, h('b', { class: 'ct-title', tip: c.name, text: c.name }),
        h('div', { class: 'small faint' },
          o.showProject ? h('a', { href: '#/project/' + c.project_id, tip: 'Open the project this campaign belongs to.', on: { click: function (e) { e.stopPropagation(); } }, text: c.project_name }) : null,
          o.showProject ? ' · ' : '', c.batches ? c.batches + ' batches · ' : '', fmt.num(c.leads) + (c.leads === 1 ? ' person' : ' people'))),
      h('td', null, pill(c.display_status)),
      h('td', { class: 'ct-state' }, currentState(c)),
      h('td', { class: 'nowrap', tip: fmt.tip(c.created_at), text: fmt.age(c.created_at) }),
      progressCell(c, o.progress),
      h('td', { class: 'num', tip: SB.S.perf.scheduled, text: fmt.num(c.scheduled) }),
      h('td', { class: 'num', tip: SB.S.perf.sent, text: fmt.num(c.sent) }),
      h('td', { class: 'num', tip: tracked ? SB.S.perf.opened : 'Open tracking is off for this campaign.' }, tracked ? h('span', null, fmt.num(m.opened || 0), h('span', { class: 'small faint', text: pctOf(m.opened || 0) })) : h('span', { class: 'faint', text: 'Off' })),
      h('td', { class: 'num', tip: SB.S.perf.replied }, fmt.num(m.replied || 0), h('span', { class: 'small faint', text: pctOf(m.replied || 0) })),
      h('td', { class: 'num', tip: SB.S.perf.successful }, fmt.num(m.interested || 0), h('span', { class: 'small faint', text: pctOf(m.interested || 0) })),
      h('td', { class: 'ct-act' }, menuFor(c, o.onChange)));
    return tr;
  }

  function table(items, o) {
    o = o || {}; o.progress = o.progress || 'bar';
    function th(label, tipText, cls) { return h('th', { class: cls || null, tip: tipText, text: label }); }
    var lead = 5 + (o.select ? 1 : 0), allCb = null;
    if (o.select) {
      allCb = h('input', { type: 'checkbox', 'aria-label': 'Select all shown campaigns' }); allCb.checked = items.length > 0 && items.every(function (c) { return !!o.select.sel[c.id]; });
      allCb.addEventListener('change', function () { items.forEach(function (c) { if (allCb.checked) o.select.sel[c.id] = c.name; else delete o.select.sel[c.id]; }); o.select.onChange(); });
    }
    return h('div', { class: 'table-wrap' + (o.flush ? '' : ' card table-card ct-wrap') }, h('table', { class: 'table ct-table' + (o.progress === 'steps' ? ' ct-steps-table' : '') },
      h('thead', null,
        h('tr', { class: 'ct-group' }, h('th', { colspan: lead }), h('th', { colspan: 5, class: 'ct-perf-h', tip: 'Results of this campaign so far. Hover a number for what it counts.' }, 'Performance'), h('th')),
        h('tr', null, o.select ? h('th', { class: 'row-check' }, allCb) : null,
          th('Campaign', 'The campaign name' + (o.showProject ? ' and the project it belongs to.' : '.')), th('Status', 'Where the campaign is now.'), th('Current state', 'What happens next, in days, hours and minutes.'),
          th('Created', 'How long ago it was created. Hover a value for the exact date.'),
          th('Progression', o.progress === 'steps' ? SB.S.steps.segTip + ' ' + SB.S.metric.progress : SB.S.metric.progress),
          th('Scheduled', SB.S.perf.scheduled, 'num'), th('Sent', SB.S.perf.sent, 'num'), th('Opened', SB.S.perf.opened, 'num'), th('Replied', SB.S.perf.replied, 'num'), th('Successful', SB.S.perf.successful, 'num'),
          h('th', { class: 'ct-act', 'aria-label': 'Actions' }))),
      h('tbody', null, items.map(function (c) { return row(c, o); }))));
  }

  SB.campaignGrid = { table: table, pill: pill, currentState: currentState };
})();
