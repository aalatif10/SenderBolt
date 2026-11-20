/* Reusable controls: multi-select filter dropdown (Select all / Clear / Apply filters) and the row action menu (the three-dots button).
   Panels are position:fixed so table scrollers never clip them; positions are set through the CSSOM (allowed by the CSP).
   Every label goes through textContent (no innerHTML). */
(function () {
  'use strict';
  var h = SB.h;
  SB.controls = SB.controls || {};
  var openPanel = null;     // only one panel is open at a time

  function closeOpen() { if (openPanel) { var p = openPanel; openPanel = null; p(); } }
  document.addEventListener('mousedown', function (e) { if (openPanel && !(e.target.closest && e.target.closest('.pop-panel, .pop-trigger'))) closeOpen(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOpen(); });
  window.addEventListener('resize', closeOpen);
  window.addEventListener('scroll', function (e) { if (openPanel && !(e.target && e.target.closest && e.target.closest('.pop-panel'))) closeOpen(); }, true);

  function place(panel, trigger, alignRight) {
    var r = trigger.getBoundingClientRect(), w = panel.offsetWidth || 260, hgt = panel.offsetHeight || 200;
    var left = alignRight ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8 && r.top - hgt - 6 > 8) top = r.top - hgt - 6;       // flip above when there is no room below
    panel.style.left = left + 'px'; panel.style.top = top + 'px';
  }

  // multiSelect({ label, options: [{ value, label, sub? }], selected: [values], onApply(values), emptyText, tip })
  // Returns { el, setOptions(list), setSelected(values) }. Nothing selected = "no filter" (shows everything).
  SB.controls.multiSelect = function (o) {
    var options = o.options || [], applied = (o.selected || []).slice(), draft = applied.slice(), panel = null;
    var btnLabel = h('span', { class: 'ms-label' }), count = h('span', { class: 'ms-count hidden' });
    var btn = h('button', { type: 'button', class: 'btn ms-btn pop-trigger', 'aria-haspopup': 'true', 'aria-expanded': 'false', tip: o.tip }, btnLabel, count, h('span', { class: 'ms-caret', 'aria-hidden': 'true' }, '▾'));
    function paintButton() {
      btnLabel.textContent = o.label;
      count.textContent = String(applied.length); count.classList.toggle('hidden', !applied.length);
      btn.classList.toggle('on', applied.length > 0);
    }
    function close() { if (!panel) return; if (panel.parentNode) panel.parentNode.removeChild(panel); panel = null; btn.setAttribute('aria-expanded', 'false'); if (openPanel === close) openPanel = null; }
    function apply() { applied = draft.slice(); paintButton(); close(); if (o.onApply) o.onApply(applied.slice()); }
    function build() {
      var search = options.length > 8 ? h('input', { class: 'input ms-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search ' + o.label }) : null;
      var list = h('div', { class: 'ms-list', role: 'listbox', 'aria-multiselectable': 'true' });
      function paintList() {
        var q = search ? search.value.trim().toLowerCase() : '';
        SB.clear(list);
        var shown = options.filter(function (x) { return !q || (x.label + ' ' + (x.sub || '')).toLowerCase().indexOf(q) !== -1; });
        if (!shown.length) list.appendChild(h('div', { class: 'ms-empty small muted', text: o.emptyText || 'Nothing to choose from yet.' }));
        shown.forEach(function (x) {
          var cb = h('input', { type: 'checkbox' }); cb.checked = draft.indexOf(x.value) !== -1;
          cb.addEventListener('change', function () { var i = draft.indexOf(x.value); if (cb.checked && i === -1) draft.push(x.value); if (!cb.checked && i !== -1) draft.splice(i, 1); });
          list.appendChild(h('label', { class: 'ms-opt', role: 'option' }, cb, h('span', { class: 'ms-opt-t' }, h('span', { text: x.label, class: 'ms-opt-l' }), x.sub ? h('span', { class: 'small faint', text: x.sub }) : null)));
        });
      }
      if (search) search.addEventListener('input', paintList);
      paintList();
      var all = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: function () { draft = options.map(function (x) { return x.value; }); paintList(); } } }, 'Select all');
      var clr = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: function () { draft = []; paintList(); } } }, 'Clear');
      var ok = h('button', { type: 'button', class: 'btn btn-primary btn-sm', on: { click: apply } }, 'Apply filters');
      return h('div', { class: 'pop-panel ms-panel', role: 'dialog', 'aria-label': o.label + ' filter' }, search, h('div', { class: 'ms-tools' }, all, clr), list, h('div', { class: 'ms-foot' }, ok));
    }
    btn.addEventListener('click', function () {
      if (panel) { close(); return; }
      closeOpen(); draft = applied.slice(); panel = build(); document.body.appendChild(panel); place(panel, btn, false);
      btn.setAttribute('aria-expanded', 'true'); openPanel = close;
      var first = panel.querySelector('input'); if (first) first.focus();
    });
    paintButton();
    return { el: btn, setOptions: function (list) { options = list; }, setSelected: function (v) { applied = v.slice(); draft = v.slice(); paintButton(); } };
  };

  // rowMenu([{ label, icon?, danger?, onClick }]) -> the three-dots button. Items may also be { divider: true }.
  SB.controls.rowMenu = function (items, label) {
    var panel = null;
    var btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm row-menu-btn pop-trigger', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label || 'Actions', tip: 'Actions' }, '⋮');
    function close() { if (!panel) return; if (panel.parentNode) panel.parentNode.removeChild(panel); panel = null; btn.setAttribute('aria-expanded', 'false'); if (openPanel === close) openPanel = null; }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel) { close(); return; }
      closeOpen();
      var list = typeof items === 'function' ? items() : items;
      panel = h('div', { class: 'pop-panel menu-panel', role: 'menu' }, list.map(function (it) {
        if (it.divider) return h('div', { class: 'menu-div' });
        return h('button', { type: 'button', role: 'menuitem', class: 'menu-item' + (it.danger ? ' danger' : ''), disabled: it.disabled ? 'disabled' : null, tip: it.tip,
          on: { click: function (ev) { ev.stopPropagation(); close(); if (it.onClick) it.onClick(); } } }, it.icon ? SB.icon(it.icon) : null, it.label);
      }));
      document.body.appendChild(panel); place(panel, btn, true); btn.setAttribute('aria-expanded', 'true'); openPanel = close;
      var first = panel.querySelector('button:not([disabled])'); if (first) first.focus();
    });
    return btn;
  };

  SB.controls.close = closeOpen;
})();
