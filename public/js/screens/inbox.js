/* public/js/screens/inbox.js - Unified Inbox: every reply from every sender account and campaign in one place.
   Left: conversations (filters: sentiment, unread, campaign, account, search). Right: the full thread (our emails,
   their replies, auto-replies, bounces), sentiment tagging and a quick-reply box. Slide-over thread on small screens.
   Replies are shown as PLAIN TEXT only (textContent): the server never exposes incoming HTML. */
(function () {
  'use strict';
  var h = SB.h, ui = SB.ui, fmt = SB.fmt, I = SB.S.inbox;
  SB.screens = SB.screens || {};
  var ORDER = ['interested', 'more_info', 'not_interested', 'neutral'];

  function senti(key) { var s = I.sentiment[key] || I.sentiment.neutral; return h('span', { class: 'tag tag-' + s.cls, tip: s.tip }, s.label); }
  function who(it) { var n = [it.first_name, it.last_name].filter(Boolean).join(' '); return n || it.lead_email; }

  SB.screens.inbox = function () {
    var root = h('div'), state = { sentiment: '', unread: false, q: '', campaign: '', sender: '', offset: 0, sel: null };
    var PAGE = 30, listEl = h('div', { class: 'ib-list', role: 'list' }), chipsEl = h('div', { class: 'ib-chips' }), threadEl = h('div', { class: 'ib-thread' });
    var foot = h('div', { class: 'ib-foot' }), dead = false, camps = [], sndrs = [], lastData = null, panel = null, searchTimer = null, listSeq = 0, threadSeq = 0;

    // ---------- filters ----------
    var search = h('input', { class: 'input', type: 'search', placeholder: 'Search name, company, subject…', 'aria-label': 'Search replies', maxlength: 100 });
    search.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { state.q = search.value.trim(); state.offset = 0; loadList(); }, 300); });
    var campSel = h('select', { class: 'input', 'aria-label': 'Campaign' }), sndSel = h('select', { class: 'input', 'aria-label': 'Sender account' });
    campSel.addEventListener('change', function () { state.campaign = campSel.value; state.offset = 0; loadList(); });
    sndSel.addEventListener('change', function () { state.sender = sndSel.value; state.offset = 0; loadList(); });
    function fillSelects() {
      SB.clear(campSel); campSel.appendChild(h('option', { value: '' }, 'All campaigns')); camps.forEach(function (c) { campSel.appendChild(h('option', { value: c.id }, c.name)); }); campSel.value = state.campaign;
      SB.clear(sndSel); sndSel.appendChild(h('option', { value: '' }, 'All accounts')); sndrs.forEach(function (s) { sndSel.appendChild(h('option', { value: s.id }, s.email)); }); sndSel.value = state.sender;
    }
    function paintChips(counts, unread) {
      SB.clear(chipsEl);
      function chip(label, on, count, tip, fn, cls) {
        return h('button', { type: 'button', class: 'chip ib-chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), tip: tip, 'aria-pressed': on ? 'true' : 'false', on: { click: fn } }, label, count !== null ? h('span', { class: 'ib-count', text: String(count) }) : null);
      }
      var all = ORDER.reduce(function (a, k) { return a + (counts[k] || 0); }, 0);
      chipsEl.appendChild(chip('All', !state.sentiment && !state.unread, all, 'Every conversation with a reply.', function () { state.sentiment = ''; state.unread = false; state.offset = 0; loadList(); }));
      chipsEl.appendChild(chip('Unread', state.unread, unread, 'Conversations with a reply you have not opened.', function () { state.unread = !state.unread; state.offset = 0; loadList(); }));
      ORDER.forEach(function (k) {
        if (k === 'neutral' && !counts.neutral && state.sentiment !== 'neutral') return;
        chipsEl.appendChild(chip(I.sentiment[k].label, state.sentiment === k, counts[k] || 0, I.sentiment[k].tip, function () { state.sentiment = state.sentiment === k ? '' : k; state.offset = 0; loadList(); }, 'chip-' + I.sentiment[k].cls));
      });
    }

    // ---------- list ----------
    function qs() {
      var p = ['limit=' + PAGE, 'offset=' + state.offset];
      if (state.sentiment) p.push('sentiment=' + encodeURIComponent(state.sentiment)); if (state.unread) p.push('unread=1');
      if (state.campaign) p.push('campaign_id=' + encodeURIComponent(state.campaign)); if (state.sender) p.push('sender_id=' + encodeURIComponent(state.sender));
      if (state.q) p.push('q=' + encodeURIComponent(state.q));
      return p.join('&');
    }
    function row(it) {
      var on = state.sel === it.campaign_lead_id;
      var b = h('button', { type: 'button', role: 'listitem', class: 'ib-row' + (on ? ' on' : '') + (it.unread ? ' unread' : ''), 'data-id': it.campaign_lead_id, on: { click: function () { openThread(it.campaign_lead_id); } } },
        h('div', { class: 'ib-row-top' }, h('span', { class: 'ib-name', text: who(it) }), h('span', { class: 'ib-time faint small', tip: fmt.full(it.received_at), text: fmt.ago(it.received_at) })),
        h('div', { class: 'ib-subj', text: it.subject || '(no subject)' }),
        h('div', { class: 'ib-snip small muted', text: (it.snippet || '').replace(/\s+/g, ' ') }),
        h('div', { class: 'ib-row-bot' }, senti(it.sentiment), it.unread ? h('span', { class: 'ib-dot', tip: it.unread + ' unread', 'aria-label': 'Unread' }) : null,
          h('span', { class: 'small faint ib-meta', text: [it.company, it.campaign_name].filter(Boolean).join(' · ') })));
      return b;
    }
    function loadList() {
      var mine = ++listSeq;
      return SB.api.get('/api/inbox?' + qs()).then(function (d) {
        if (dead || mine !== listSeq) return;
        lastData = d; paintChips(d.counts, d.unread);
        SB.clear(listEl);
        if (!d.items.length) {
          var filtered = state.sentiment || state.unread || state.q || state.campaign || state.sender;
          listEl.appendChild(h('div', { class: 'ib-empty' }, SB.icon('inbox', 'icon-lg'), h('p', { class: 'muted', text: filtered ? I.emptyFiltered : I.empty })));
        } else d.items.forEach(function (it) { listEl.appendChild(row(it)); });
        SB.clear(foot);
        if (d.total > PAGE) {
          var from = d.offset + 1, to = Math.min(d.offset + d.items.length, d.total);
          foot.appendChild(h('span', { class: 'small muted', text: from + '-' + to + ' of ' + fmt.num(d.total) }));
          foot.appendChild(h('div', { class: 'actions' },
            h('button', { class: 'btn btn-sm', type: 'button', disabled: d.offset ? null : true, on: { click: function () { state.offset = Math.max(0, state.offset - PAGE); loadList(); } } }, 'Newer'),
            h('button', { class: 'btn btn-sm', type: 'button', disabled: d.offset + PAGE < d.total ? null : true, on: { click: function () { state.offset += PAGE; loadList(); } } }, 'Older')));
        }
      }, function (e) { if (!dead && e.code !== 'offline') SB.mount(listEl, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    // ---------- thread ----------
    function msgLabel(m) {
      if (m.direction === 'in') return m.kind === 'email' ? null : I.kinds[m.kind] || 'Notice';
      if (m.status === 'failed') return 'Not delivered';
      if (m.step_no === null || m.step_no === undefined) return 'Your reply';
      return m.step_no === 0 ? 'First email' : 'Follow-up ' + m.step_no;
    }
    function bubble(m, lead) {
      var out = m.direction === 'out', label = msgLabel(m), when = m.sent_at || m.received_at || m.created_at;
      return h('div', { class: 'ib-msg ' + (out ? 'out' : 'in') + (m.kind !== 'email' && !out ? ' sys' : '') + (m.status === 'failed' ? ' failed' : '') },
        h('div', { class: 'ib-msg-head small' }, h('b', { text: out ? 'You' : (lead.first_name || lead.email) }), label ? h('span', { class: 'tag tag-sys', text: label }) : null, h('span', { class: 'faint', tip: fmt.full(when), text: fmt.ago(when) })),
        m.subject ? h('div', { class: 'ib-msg-subj small muted', text: m.subject }) : null,
        h('div', { class: 'ib-msg-body', text: m.body_text || '' }),
        m.status === 'failed' && m.error ? h('div', { class: 'small bad', text: 'Could not be delivered.' }) : null);
    }
    function paintThread(d, into, opts) {
      var c = d.conversation, lead = c.lead, msgs = d.messages;
      var lastIn = null; msgs.forEach(function (m) { if (m.direction === 'in' && m.kind === 'email') lastIn = m; });
      var body = h('textarea', { class: 'input ib-reply', id: 'ib-reply', rows: 5, maxlength: 20000, placeholder: 'Write your reply…', 'aria-label': 'Reply', disabled: c.suppressed ? true : null });
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      var send = h('button', { class: 'btn btn-primary', type: 'button', id: 'ib-send', disabled: c.suppressed ? true : null, tip: I.replyTip }, SB.icon('send'), 'Send reply');
      send.addEventListener('click', function () {
        if (!body.value.trim()) { err.textContent = 'Write a message first.'; err.classList.remove('hidden'); return; }
        err.classList.add('hidden'); send.disabled = true;
        SB.api.post('/api/inbox/threads/' + c.id + '/reply', { body: body.value }).then(function () { ui.toast('Reply sent'); return openThread(c.id, true); }, function (e) {
          send.disabled = false; err.textContent = SB.api.friendly(e); err.classList.remove('hidden');
        });
      });
      var tags = lastIn ? h('div', { class: 'ib-tags' }, h('span', { class: 'small muted' }, 'Tag: ', ui.info(I.sentimentTip)), ORDER.map(function (k) {
        return h('button', { type: 'button', class: 'chip ib-chip chip-' + I.sentiment[k].cls + (lastIn.sentiment === k ? ' on' : ''), tip: I.sentiment[k].tip, on: { click: function () {
          SB.api.post('/api/inbox/messages/' + lastIn.id + '/sentiment', { sentiment: k }).then(function () { return Promise.all([openThread(c.id, true), loadList()]); }, function (e) { ui.toast(SB.api.friendly(e), true); });
        } } }, I.sentiment[k].label);
      })) : null;
      var node = h('div', { class: 'ib-thread-in' },
        h('div', { class: 'ib-thread-head' },
          h('div', null, h('h2', { text: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email }),
            h('div', { class: 'small muted', text: [lead.email, lead.company].filter(Boolean).join(' · ') }),
            h('div', { class: 'small faint', text: 'Campaign: ' + c.campaign_name + (c.sender ? ' · via ' + c.sender.email : '') })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', type: 'button', tip: 'Show this conversation as unread again.', on: { click: function () {
            SB.api.post('/api/inbox/threads/' + c.id + '/read', { read: false }).then(function () { ui.toast('Marked unread'); if (panel) { panel.close(); panel = null; } state.sel = null; SB.mount(threadEl, emptyThread()); loadList(); });
          } } }, 'Mark unread'))),
        c.suppressed ? h('div', { class: 'callout warn', text: I.blocked }) : null,
        tags, h('div', { class: 'ib-msgs' }, msgs.map(function (m) { return bubble(m, lead); })),
        h('div', { class: 'ib-compose' }, err, body, h('div', { class: 'ib-compose-foot' }, h('span', { class: 'small faint', text: I.plainNote }), send)));
      SB.mount(into, node);
      var box = node.querySelector('.ib-msgs'); if (box) box.scrollTop = box.scrollHeight;
      if (!opts || !opts.keepFocus) { /* keep focus where the user is */ }
    }
    function emptyThread() { return h('div', { class: 'ib-empty' }, SB.icon('inbox', 'icon-lg'), h('p', { class: 'muted', text: 'Select a conversation to read it and reply.' })); }
    function openThread(id, refreshOnly) {
      state.sel = id; var mine = ++threadSeq;
      Array.prototype.forEach.call(listEl.querySelectorAll('.ib-row'), function (r) { r.classList.toggle('on', Number(r.getAttribute('data-id')) === id); });
      var narrow = window.matchMedia && window.matchMedia('(max-width: 980px)').matches;
      var target = threadEl;
      if (narrow) { if (!panel) { panel = ui.panel('Conversation'); } target = panel.body; }
      if (!refreshOnly) SB.mount(target, h('div', { class: 'skeleton' }));
      return SB.api.get('/api/inbox/threads/' + id).then(function (d) {
        if (dead || mine !== threadSeq) return;
        paintThread(d, target);
        return SB.api.post('/api/inbox/threads/' + id + '/read', { read: true }).then(function () { return loadList(); }, function () {});
      }, function (e) { if (!dead) SB.mount(target, h('div', { class: 'form-error', text: e.status === 404 ? 'This conversation no longer exists.' : SB.api.friendly(e) })); });
    }

    // ---------- shell ----------
    var syncBtn = h('button', { class: 'btn', type: 'button', id: 'ib-sync', tip: I.syncTip }, 'Check for replies');
    syncBtn.addEventListener('click', function () {
      syncBtn.disabled = true;
      SB.api.post('/api/inbox/sync', {}).then(function () { ui.toast('Checked your mailboxes'); return loadList(); }, function (e) { ui.toast(SB.api.friendly(e), true); }).then(function () { syncBtn.disabled = false; });
    });
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Inbox' }), h('p', { class: 'sub', text: 'Every reply from every account and campaign, in one place.' })), syncBtn));
    root.appendChild(h('div', { class: 'card ib' },
      h('div', { class: 'ib-left' }, h('div', { class: 'ib-filters' }, search, h('div', { class: 'ib-selects' }, campSel, sndSel), chipsEl), listEl, foot),
      h('div', { class: 'ib-right' }, threadEl)));
    SB.mount(threadEl, emptyThread()); fillSelects(); SB.mount(listEl, h('div', { class: 'skeleton' }));

    Promise.all([SB.api.get('/api/campaigns?pageSize=100'), SB.api.get('/api/senders')]).then(function (r) {
      if (dead) return; camps = (r[0].items || []).filter(function (c) { return !c.parent_id; }); sndrs = r[1].items || []; fillSelects();
    }, function () {});
    var stop = ui.poll(function () { if (!document.querySelector('#ib-reply') || !document.querySelector('#ib-reply').value) return loadList(); }, 15000);
    return { el: root, destroy: function () { dead = true; stop(); clearTimeout(searchTimer); if (panel) panel.close(); } };
  };
})();
