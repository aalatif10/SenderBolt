/* Shared list controls: search + status chips with counts + sort + removable filter tags + sticky selection bar.
   Nothing here touches innerHTML; every label goes through textContent. */
(function () {
  'use strict';
  var h = SB.h;
  SB.lists = SB.lists || {};

  // Status chips: items = [{ key, label, n, tip }]; the active one is highlighted. Chips with n === 0 are dimmed, not hidden.
  SB.lists.chips = function (items, current, onPick) {
    return h('div', { class: 'chips filter-chips', role: 'group', 'aria-label': 'Filter by status' }, items.map(function (it) {
      var on = it.key === current;
      return h('button', { type: 'button', class: 'chip' + (on ? ' on' : '') + (it.n === 0 && !on ? ' dim' : ''), 'aria-pressed': on ? 'true' : 'false', tip: it.tip,
        on: { click: function () { onPick(it.key); } } }, it.label, h('span', { class: 'chip-n', text: String(it.n) }));
    }));
  };

  // Search box + sort select. Returns { el, search }. The search input is created once so typing is never interrupted by a refresh.
  SB.lists.toolbar = function (o) {
    var search = h('input', { class: 'input', type: 'search', placeholder: o.placeholder || 'Search', maxlength: 100, 'aria-label': o.label || 'Search' });
    var timer = null;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { o.onSearch(search.value.trim()); }, 150); });
    var sort = null;
    if (o.sorts) {
      sort = h('select', { class: 'input', 'aria-label': 'Sort by' }, o.sorts.map(function (s) { return h('option', { value: s.key }, s.label); }));
      sort.value = o.sort; sort.addEventListener('change', function () { o.onSort(sort.value); });
    }
    return { el: h('div', { class: 'toolbar' }, h('div', { class: 'search' }, SB.icon('search'), search), sort, o.extra || null), search: search, sort: sort };
  };

  // Sortable column header: first click sorts ascending, second descending. cur = { sort, dir }; onSort(key, dir).
  // defaultDir lets date-like columns start with "newest first". Renders as <th> with an accessible aria-sort.
  SB.lists.sortHeader = function (label, key, cur, onSort, o) {
    o = o || {};
    var on = cur.sort === key, dir = on ? cur.dir : null;
    var btn = h('button', { type: 'button', class: 'th-sort' + (on ? ' on' : ''), tip: o.tip || ('Sort by ' + label.toLowerCase() + (on ? (dir === 'asc' ? ' (high to low next)' : ' (low to high next)') : '')),
      on: { click: function () { onSort(key, on ? (dir === 'asc' ? 'desc' : 'asc') : (o.defaultDir || 'asc')); } } }, label, h('span', { class: 'arrow', 'aria-hidden': 'true' }, on ? (dir === 'asc' ? '\u25B2' : '\u25BC') : '\u21C5'));
    return h('th', { class: o.cls || null, 'aria-sort': on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' }, btn, o.info || null);
  };

  // Removable tags for active filters: tags = [{ label, onRemove }] (+ a "Clear all" link when there are several).
  SB.lists.tags = function (tags, onClear) {
    if (!tags.length) return null;
    return h('div', { class: 'filter-tags' }, tags.map(function (t) {
      return h('span', { class: 'ftag' }, t.label, h('button', { type: 'button', class: 'ftag-x', 'aria-label': 'Remove filter ' + t.label, on: { click: t.onRemove } }, '×'));
    }), tags.length > 1 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: onClear } }, 'Clear all') : null);
  };

  // Sticky bar shown while something is selected: actions = [{ label, kind, icon, tip, onClick }]
  SB.lists.selectionBar = function (count, noun, actions, onClear, onAll, allLabel) {
    if (!count) return null;
    return h('div', { class: 'sel-bar', role: 'region', 'aria-label': 'Selection actions' },
      h('b', { text: count + ' ' + noun + (count === 1 ? '' : 's') + ' selected' }),
      onAll ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: onAll } }, allLabel || 'Select all shown') : null,
      h('div', { class: 'actions' }, actions.map(function (a) {
        return h('button', { type: 'button', class: 'btn btn-sm' + (a.kind ? ' btn-' + a.kind : ''), tip: a.tip, on: { click: a.onClick } }, a.icon ? SB.icon(a.icon) : null, a.label);
      }), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: onClear } }, 'Clear')));
  };

  // Summarises a batch result as a toast: "3 deleted. 1 could not be: <reason>".
  SB.lists.report = function (r, verbPast) {
    var msg = r.done.length + ' ' + verbPast + (r.failed.length ? '. ' + r.failed.length + ' could not be: ' + r.failed[0].message : '');
    SB.ui.toast(msg, r.failed.length > 0 && r.done.length === 0);
  };

  SB.lists.has = function (text, q) { return !q || String(text || '').toLowerCase().indexOf(q.toLowerCase()) !== -1; };
})();
