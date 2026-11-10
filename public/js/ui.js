/* Shared UI pieces: toasts, confirm/modal, slide-over panel, status pill, tiles, polling. */
(function () {
  'use strict';
  var h = SB.h;
  var toastBox = null;

  function toast(msg, bad) {
    if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
    var t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    toastBox.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, bad ? 6000 : 3500);
  }

  function overlay(cls, content, onClose) {
    var prev = document.activeElement;
    var ov = h('div', { class: 'overlay ' + (cls || ''), role: 'dialog', 'aria-modal': 'true' }, content);
    function close() { document.removeEventListener('keydown', key); if (ov.parentNode) ov.parentNode.removeChild(ov); if (prev && prev.focus) prev.focus(); if (onClose) onClose(); }
    function key(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    var first = ov.querySelector('input,textarea,select,button.btn-primary,button');
    if (first) first.focus();
    return close;
  }

  // modal({ title, body: Node, actions: [{label, kind, onClick(close) -> maybe Promise}] })
  function modal(o) {
    var close, buttons = (o.actions || []).map(function (a) {
      var b = h('button', { class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : ''), type: 'button' }, a.label);
      b.addEventListener('click', function () {
        if (!a.onClick) return close();
        b.disabled = true;
        Promise.resolve(a.onClick(close)).then(function () { b.disabled = false; }, function () { b.disabled = false; });
      });
      return b;
    });
    close = overlay('', h('div', { class: 'modal' }, h('h2', { text: o.title }), o.body, h('div', { class: 'modal-actions' }, buttons)));
    return close;
  }

  function confirmBox(o) {   // { title, message, confirmLabel, danger, onConfirm() -> Promise }
    return modal({ title: o.title, body: h('p', { class: 'muted', text: o.message }), actions: [
      { label: 'Cancel' },
      { label: o.confirmLabel || 'Confirm', kind: o.danger ? 'danger' : 'primary', onClick: function (close) { return Promise.resolve(o.onConfirm()).then(close, function (e) { toast(SB.api.friendly(e), true); }); } }
    ] });
  }

  function panel(title) {   // slide-over; returns { body, close }
    var body = h('div'), close;
    var head = h('div', { class: 'panel-head' }, h('h2', { text: title }), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Close', on: { click: function () { close(); } } }, SB.icon('x')));
    close = overlay('side', h('div', { class: 'panel' }, head, body));
    return { body: body, close: close };
  }

  function statusPill(status) {
    var s = SB.S.status[status] || SB.S.status.draft;
    return h('span', { class: 'pill pill-' + (SB.S.status[status] ? status : 'draft'), tip: s.tip + '', 'data-status': status }, s.label);
  }
  function info(text) { return h('span', { class: 'info-dot', tip: text }, 'i'); }
  function tile(label, value, note, tip, attn) {
    return h('div', { class: 'tile' + (attn ? ' attn' : '') }, h('div', { class: 'label' }, label, tip ? info(tip) : null), h('div', { class: 'value' + (/^\d[\d,.%]*$/.test(String(value)) ? '' : ' value-text'), text: value }), note ? h('div', { class: 'note', text: note }) : null);
  }
  function progress(pctValue) {
    var bar = h('span'); bar.style.width = Math.max(0, Math.min(100, pctValue || 0)) + '%';      // CSSOM is allowed by CSP (inline attributes are not)
    return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pctValue || 0) }, bar);
  }
  function sentimentBar(s) {
    var total = (s.interested + s.more_info + s.not_interested + s.neutral) || 0;
    function seg(cls, n) { var e = h('span', { class: cls }); e.style.width = (total ? n / total * 100 : 0) + '%'; return e; }
    return h('div', null,
      h('div', { class: 'senti', 'aria-label': 'Reply sentiment' }, seg('s-int', s.interested), seg('s-more', s.more_info), seg('s-not', s.not_interested), seg('s-neu', s.neutral)),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 's-int' }), 'Interested ' + s.interested), h('span', null, h('i', { class: 's-more' }), 'More info ' + s.more_info),
        h('span', null, h('i', { class: 's-not' }), 'Not interested ' + s.not_interested)));
  }

  // Runs fn now and every `ms` while the tab is visible. Returns stop().
  function poll(fn, ms) {
    var timer = null, stopped = false;
    function tick() { if (stopped) return; if (document.hidden) return; Promise.resolve().then(fn).catch(function () {}); }
    function onVis() { if (!document.hidden) tick(); }
    tick(); timer = setInterval(tick, ms); document.addEventListener('visibilitychange', onVis);
    return function stop() { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }

  SB.ui = { toast: toast, modal: modal, confirm: confirmBox, panel: panel, statusPill: statusPill, info: info, tile: tile, progress: progress, sentimentBar: sentimentBar, poll: poll };
})();
