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
  // Long email addresses are cut with "..." so they never break a layout; the full address is always in the tooltip.
  // tag: element to build (default span). Use SB.ui.email(addr) wherever an address is shown.
  function emailText(addr, extraClass, tag) {
    var a = String(addr == null ? '' : addr);
    return h(tag || 'span', { class: 'email-trunc' + (extraClass ? ' ' + extraClass : ''), tip: a, text: a });
  }
  // A date with a full date-time + "x days ago" tooltip. prefix: e.g. 'Created '.
  function dateStamp(ts, prefix, cls) {
    return h('span', { class: cls || 'date-stamp', tip: SB.fmt.tip(ts) }, (prefix || '') + SB.fmt.date(ts));
  }
  function info(text) { return h('span', { class: 'info-dot', tip: text }, 'i'); }
  function tile(label, value, note, tip, attn) {
    return h('div', { class: 'tile' + (attn ? ' attn' : '') }, h('div', { class: 'label' }, label, tip ? info(tip) : null), h('div', { class: 'value' + (/^\d[\d,.%]*$/.test(String(value)) ? '' : ' value-text'), text: value }), note ? h('div', { class: 'note', text: note }) : null);
  }
  function progress(pctValue) {
    var bar = h('span'); bar.style.width = Math.max(0, Math.min(100, pctValue || 0)) + '%';      // CSSOM is allowed by CSP (inline attributes are not)
    return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pctValue || 0) }, bar);
  }
  // Hunter-style segmented bar: one segment per email step, each filled by sent / capacity.
  // steps: [{ step, sent, capacity, pct }]. compact = bar only (tables); otherwise adds "Email 1  34 / 112" captions.
  function stepState(s) {
    if (s.capacity > 0 && s.sent >= s.capacity) return { icon: 'check', cls: 'done', text: 'finished' };
    if (s.sent > 0) return { icon: 'play', cls: 'run', text: SB.fmt.num(s.sent) + ' / ' + SB.fmt.num(s.capacity) };
    return { icon: 'hourglass', cls: 'wait', text: 'not started' };
  }
  // One shared popover (position: fixed, so table scrollers never clip it) listing every step and where it stands.
  var pop = null;
  function showStepPop(anchor, steps) {
    if (!pop) { pop = h('div', { class: 'step-pop', role: 'tooltip' }); document.body.appendChild(pop); }
    var P = SB.S.steps;
    SB.mount(pop, h('div', null, steps.map(function (s) {
      var st = stepState(s);
      return h('div', { class: 'sp-row sp-' + st.cls }, SB.icon(st.icon), h('span', { class: 'sp-name', text: s.step === 0 ? 'Initial email' : P.follow(s.step) }), h('b', { text: st.text }));
    })));
    pop.classList.add('on');
    var r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
    var top = r.top - ph - 10; if (top < 8) top = r.bottom + 10;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function hideStepPop() { if (pop) pop.classList.remove('on'); }
  function stepBar(steps, opts) {
    opts = opts || {};
    var P = SB.S.steps;
    if (!steps || !steps.length) return h('span', { class: 'faint small', text: '\u2014' });
    var segs = steps.map(function (s) {
      var fill = h('span'); fill.style.width = Math.max(0, Math.min(100, s.capacity ? s.sent / s.capacity * 100 : 0)) + '%';
      return h('div', { class: 'stepseg' + (s.capacity && s.sent >= s.capacity ? ' full' : '') + (s.sent === 0 ? ' idle' : '') }, h('div', { class: 'stepfill' }, fill),
        opts.compact ? null : h('div', { class: 'stepcap' }, h('span', { class: 'small', text: s.step === 0 ? P.short : P.shortFollow(s.step) }), h('b', { class: 'small', text: SB.fmt.num(s.sent) + ' / ' + SB.fmt.num(s.capacity) })));
    });
    var bar = h('div', { class: 'stepbar' + (opts.compact ? ' compact' : ''), tabindex: 0, role: 'img',
      'aria-label': steps.map(function (s) { return (s.step === 0 ? 'Initial email' : P.follow(s.step)) + ' ' + stepState(s).text; }).join(', ') });
    segs.forEach(function (x) { bar.appendChild(x); });
    // Re-read the steps on every hover so a background refresh never shows stale numbers.
    bar.addEventListener('mouseenter', function () { showStepPop(bar, steps); });
    bar.addEventListener('focus', function () { showStepPop(bar, steps); });
    bar.addEventListener('mouseleave', hideStepPop); bar.addEventListener('blur', hideStepPop);
    return bar;
  }
  // Badge for people who were stopped: kind is 'stop_campaign' | 'unsubscribe_link' | 'bounce'
  function optBadge(kind, big) {
    var o = kind && SB.S.optout[kind];
    if (!o) return null;
    return h('span', { class: 'optbadge ob-' + kind + (big ? ' big' : ''), tip: o.tip }, SB.icon(kind === 'bounce' ? 'alert' : 'ban'), o.label);
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

  // Start / Pause / Resume button shared by the project table and the Studio. c = { status, name, people }
  function lifecycleButton(c, reload, id, small) {
    var label, path, msg, kind = 'primary';
    if (c.status === 'draft') { label = 'Start'; path = 'start'; msg = 'Emails will start going out to ' + SB.fmt.num(c.people) + ' people, following your schedule and each sender\'s daily limit.'; }
    else if (c.status === 'active') { label = 'Pause'; path = 'pause'; msg = 'Sending stops until you resume. Nobody is lost.'; kind = 'plain'; }
    else if (c.status === 'paused') { label = 'Resume'; path = 'resume'; msg = 'Sending continues where it stopped.'; }
    else return null;
    return h('button', { class: (small === false ? 'btn ' : 'btn btn-sm ') + (kind === 'primary' ? 'btn-primary' : ''), type: 'button', on: { click: function (e) {
      e.stopPropagation();
      confirmBox({ title: label + ' "' + c.name + '"?', message: msg, confirmLabel: label, onConfirm: function () {
        return SB.api.post('/api/campaigns/' + id + '/' + path).then(function (r) {
          (r.campaign && r.campaign.warnings || []).forEach(function (w) { toast(w.message, true); });
          toast(label === 'Start' ? 'Campaign started' : label === 'Pause' ? 'Campaign paused' : 'Campaign resumed'); reload();
        });
      } });
    } } }, SB.icon(path === 'pause' ? 'pause' : 'play', 'icon'), label);
  }

  // Runs fn now and every `ms` while the tab is visible. Returns stop().
  function poll(fn, ms) {
    var timer = null, stopped = false;
    function tick() { if (stopped) return; if (document.hidden) return; Promise.resolve().then(fn).catch(function () {}); }
    function onVis() { if (!document.hidden) tick(); }
    tick(); timer = setInterval(tick, ms); document.addEventListener('visibilitychange', onVis);
    return function stop() { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }

  SB.ui = { email: emailText, dateStamp: dateStamp, toast: toast, modal: modal, confirm: confirmBox, panel: panel, statusPill: statusPill, info: info, tile: tile, progress: progress, lifecycleButton: lifecycleButton, stepBar: stepBar, optBadge: optBadge, sentimentBar: sentimentBar, poll: poll };
})();
