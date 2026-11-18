/* public/js/suppress.js - shared actions for the do-not-email list (Leads > Do-not-email list and the Unsubscriptions page).
   Two different removals, kept clearly apart:
     Unblock  ("Remove from list")  lifts the block; the person stays in your leads and can be emailed again by future campaigns.
     Delete                          permanent: the entry is erased and the address is purged from your lead lists.
   Both work on many addresses at once (the server takes up to 1000 per call; this file chunks larger selections). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui, CHUNK = 1000;
  SB.suppress = SB.suppress || {};

  var KIND = {
    unsubscribed: ['Unsubscribed', 'They asked not to be emailed (unsubscribe link).', 'paused'], replied_stop: ['Unsubscribed', 'They replied "stop campaign".', 'paused'],
    bounced: ['Bounced', 'The address does not exist or rejected the email.', 'error'], complaint: ['Complaint', 'They marked an email as spam.', 'error'],
    manual: ['Added by you', 'You added this address to the do-not-email list.', 'draft']
  };
  SB.suppress.KIND = KIND;
  function kind(reason) { return KIND[reason] || [String(reason), '', 'draft']; }
  SB.suppress.kind = kind;
  // Same grouping the server uses for its tabs.
  SB.suppress.group = function (reason) { return reason === 'replied_stop' ? 'unsubscribed' : reason; };

  // Runs one request per chunk and adds up the numbers. path: '/api/suppression/remove' | '/api/suppression/delete'.
  function run(path, emails) {
    var parts = [], total = {};
    for (var i = 0; i < emails.length; i += CHUNK) parts.push(emails.slice(i, i + CHUNK));
    return parts.reduce(function (p, part) {
      return p.then(function () {
        return SB.api.post(path, { emails: part }).then(function (r) { Object.keys(r).forEach(function (k) { if (typeof r[k] === 'number') total[k] = (total[k] || 0) + r[k]; }); });
      });
    }, Promise.resolve()).then(function () { return total; });
  }

  function who(n) { return fmt.num(n) + (n === 1 ? ' address' : ' addresses'); }

  // Remove from list / Unblock.
  SB.suppress.unblock = function (emails, done) {
    if (!emails.length) return;
    ui.confirm({ title: 'Remove ' + who(emails.length) + ' from the list?', confirmLabel: 'Remove from list', danger: true,
      message: 'They are unblocked: future campaigns can email them again, and they stay in your lead lists. Bounced addresses go back to "not checked" so you verify them first. Only do this if the person asked to hear from you again; emailing people who opted out can get your accounts reported.',
      onConfirm: function () {
        return run('/api/suppression/remove', emails).then(function (r) {
          ui.toast(fmt.num(r.removed || 0) + ' removed from the list' + (r.needs_recheck ? ' · ' + fmt.num(r.needs_recheck) + ' need to be checked again' : '')); if (done) done();
        });
      } });
  };

  // Delete (permanent).
  SB.suppress.del = function (emails, done) {
    if (!emails.length) return;
    ui.confirm({ title: 'Permanently delete ' + who(emails.length) + '?', confirmLabel: 'Delete permanently', danger: true,
      message: 'This cannot be undone. The entries are erased for good and the addresses are also deleted from your lead lists (people inside a running or paused campaign stay in it). If you import them again they WILL be emailed, so do not delete people who unsubscribed or complained. Use "Remove from list" if you only want to unblock them.',
      onConfirm: function () {
        return run('/api/suppression/delete', emails).then(function (r) {
          ui.toast(fmt.num(r.deleted || 0) + ' deleted' + (r.leads_deleted ? ' · ' + fmt.num(r.leads_deleted) + ' also removed from your lists' : '') + (r.kept_in_campaigns ? ' · ' + fmt.num(r.kept_in_campaigns) + ' kept in their campaigns' : '')); if (done) done();
        });
      } });
  };

  // Bulk bar: "N selected [Select all M] ... [Remove from list / Unblock] [Delete] [Clear]".
  // o = { count, total, onAll, onClear, emails: function () -> [..], done }
  SB.suppress.bar = function (o) {
    if (!o.count) return null;
    return h('div', { class: 'bulk-bar', role: 'region', 'aria-label': 'Selection actions' },
      h('span', { class: 'count', text: fmt.num(o.count) + ' selected' }),
      o.total > o.count && o.onAll ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: o.onAll } }, 'Select all ' + fmt.num(o.total)) : null,
      h('button', { class: 'btn btn-sm', type: 'button', tip: 'Unblock these people. They stay in your lists and can be emailed again by future campaigns.', on: { click: function () { SB.suppress.unblock(o.emails(), o.done); } } }, SB.icon('undo'), 'Remove from list / Unblock'),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', tip: 'Erase these entries for good and delete the addresses from your lead lists. Cannot be undone.', on: { click: function () { SB.suppress.del(o.emails(), o.done); } } }, SB.icon('trash'), 'Delete'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: o.onClear } }, 'Clear'));
  };

  // Full list panel used by both screens. o = { tabs: [[group,label],...] (first is the default), empty: {title, text, action}, onAdd, extraHead }
  // Returns { el, reload, destroy }. Sorting, filtering and paging are done by the server; the selection survives paging.
  SB.suppress.panel = function (o) {
    var st = { page: 1, size: 50, total: 0, items: [], counts: {}, group: o.tabs[0][0], q: '', sort: 'created_at', dir: 'desc', sel: {}, req: 0, dead: false };
    var root = h('div'), bar = h('div'), selBox = h('div'), listBox = h('div'), qTimer = null;
    root.appendChild(bar); root.appendChild(selBox); root.appendChild(listBox);

    function qs() {
      var a = ['page=' + st.page, 'pageSize=' + st.size, 'sort=' + st.sort, 'dir=' + st.dir];
      if (st.group !== 'all') a.push('group=' + encodeURIComponent(st.group));
      if (st.q) a.push('q=' + encodeURIComponent(st.q));
      return a.join('&');
    }
    function selected() { return Object.keys(st.sel); }
    function filterTotal() { return st.group === 'all' ? (st.counts.all || 0) : (st.counts[st.group] || 0); }
    function load() {
      var my = ++st.req;
      return SB.api.get('/api/suppression?' + qs()).then(function (r) {
        if (my !== st.req || st.dead) return;
        if (!r.items.length && r.total > 0 && st.page > 1) { st.page = Math.ceil(r.total / st.size); return load(); }
        st.items = r.items; st.total = r.total; st.counts = r.counts || {}; paint();
      }, function (e) { if (!st.dead && e.code !== 'offline') SB.mount(listBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    function afterAction() { st.sel = {}; return load(); }

    function paintBar() {
      var q = h('input', { class: 'input', type: 'search', placeholder: 'Search addresses…', 'aria-label': 'Search addresses', maxlength: 100, value: st.q });
      q.addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { st.q = q.value.trim(); st.page = 1; load(); }, 250); });
      var tabs = h('div', { class: 'segs tabs hub-tabs', role: 'tablist' }, o.tabs.map(function (t) {
        var n = t[0] === 'all' ? st.counts.all : st.counts[t[0]];
        return h('button', { type: 'button', class: 'seg' + (st.group === t[0] ? ' active' : ''), role: 'tab', 'aria-selected': st.group === t[0] ? 'true' : 'false',
          on: { click: function () { if (st.group === t[0]) return; st.group = t[0]; st.page = 1; st.sel = {}; load(); } } }, t[1] + (n === undefined ? '' : ' (' + fmt.num(n) + ')'));
      }));
      SB.mount(bar, h('div', { class: 'hub-bar' }, h('span', { class: 'hub-count', text: fmt.num(st.total) + (st.total === 1 ? ' address' : ' addresses') }), h('div', { class: 'hub-filters' }, q, tabs)));
      // keep focus in the search box while typing (the bar is repainted after each result)
      if (document.activeElement === document.body && st.q) { var i = bar.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    }
    function selectAllMatching() {
      var all = {}, page = 1;
      ui.toast('Selecting…');
      (function next() {
        return SB.api.get('/api/suppression?page=' + page + '&pageSize=200&sort=email&dir=asc' + (st.group !== 'all' ? '&group=' + encodeURIComponent(st.group) : '') + (st.q ? '&q=' + encodeURIComponent(st.q) : '')).then(function (r) {
          r.items.forEach(function (x) { all[x.email] = 1; });
          if (page * 200 < r.total && page < 50) { page++; return next(); }
          st.sel = all; paint();
        });
      })().catch(function (e) { ui.toast(SB.api.friendly(e)); });
    }
    function paint() {
      if (st.dead) return;
      paintBar();
      var n = selected().length;
      SB.mount(selBox, SB.suppress.bar({ count: n, total: filterTotal(), onAll: n < filterTotal() ? selectAllMatching : null, onClear: function () { st.sel = {}; paint(); }, emails: selected, done: afterAction }) || h('span'));
      if (!st.total && !st.q && st.group === o.tabs[0][0] && !(st.counts.all)) {
        var e = o.empty || {};
        SB.mount(listBox, h('div', { class: 'card empty' }, h('h2', { text: e.title || 'Nobody is blocked yet' }), h('p', { text: e.text || '' }), o.onAdd ? h('button', { class: 'btn btn-primary', type: 'button', on: { click: o.onAdd } }, SB.icon('plus'), 'Add emails') : null));
        return;
      }
      if (!st.items.length) { SB.mount(listBox, h('div', { class: 'card empty' }, h('h2', { text: 'Nothing matches' }), h('p', { text: 'Try a different search or tab.' }))); return; }
      var pageEmails = st.items.map(function (r) { return r.email; });
      var allOnPage = pageEmails.every(function (x) { return st.sel[x]; });
      var master = h('input', { type: 'checkbox', checked: allOnPage, 'aria-label': 'Select all on this page', tip: 'Select everyone on this page',
        on: { change: function () { pageEmails.forEach(function (x) { if (master.checked) st.sel[x] = 1; else delete st.sel[x]; }); paint(); } } });
      var cur = { sort: st.sort, dir: st.dir };
      function onSort(k, d) { st.sort = k; st.dir = d; st.page = 1; load(); }
      var rows = st.items.map(function (r) {
        var k = kind(r.reason), on = !!st.sel[r.email];
        var cb = h('input', { type: 'checkbox', checked: on, 'aria-label': 'Select ' + r.email, on: { change: function () { if (cb.checked) st.sel[r.email] = 1; else delete st.sel[r.email]; paint(); } } });
        return h('tr', { class: on ? 'row-sel' : null }, h('td', { class: 'check-col' }, cb), h('td', null, ui.email(r.email)),
          h('td', null, h('span', { class: 'pill pill-' + k[2], tip: k[1], text: k[0] })), h('td', { class: 'nowrap small muted', tip: fmt.full(r.created_at), text: fmt.date(r.created_at) }));
      });
      SB.mount(listBox, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { class: 'check-col' }, master), SB.lists.sortHeader('Email address', 'email', cur, onSort), SB.lists.sortHeader('Type', 'reason', cur, onSort), SB.lists.sortHeader('Added', 'created_at', cur, onSort, { defaultDir: 'desc' }))),
        h('tbody', null, rows))), h('div', { class: 'table-foot' }, SB.suppress.pager(st.page, st.size, st.total, function (p) { st.page = p; load(); }))));
    }
    load();
    return { el: root, reload: load, getState: function () { return st; }, destroy: function () { st.dead = true; clearTimeout(qTimer); } };
  };

  SB.suppress.pager = function (page, size, total, go) {
    var pages = Math.max(1, Math.ceil(total / size)), from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
    return h('div', { class: 'pager' }, h('span', { class: 'small muted', text: 'Showing ' + fmt.num(from) + '–' + fmt.num(to) + ' of ' + fmt.num(total) }),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, on: { click: function () { go(page - 1); } } }, 'Previous'),
        h('span', { class: 'small muted pager-n', text: 'Page ' + page + ' of ' + pages }), h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages, on: { click: function () { go(page + 1); } } }, 'Next')));
  };
})();
