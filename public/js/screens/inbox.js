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
    var root = h('div'), state = { sentiment: '', unread: false, read: false, q: '', campaigns: [], senders: [], statuses: [], offset: 0, sel: null };
    var PAGE = 30, listEl = h('div', { class: 'ib-list', role: 'list' }), chipsEl = h('div', { class: 'ib-chips' }), threadEl = h('div', { class: 'ib-thread' });
    var foot = h('div', { class: 'ib-foot' }), dead = false, camps = [], sndrs = [], lastData = null, panel = null, searchTimer = null, listSeq = 0, threadSeq = 0;

    // ---------- filters ----------
    var search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name, company, subject…', 'aria-label': 'Search replies', maxlength: 100 });
    search.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { state.q = search.value.trim(); state.offset = 0; loadList(); }, 300); });
    function reset() { state.offset = 0; loadList(); }
    var campMs = SB.controls.multiSelect({ label: 'Campaigns', tip: 'Show replies from these campaigns only.', options: [], selected: [], emptyText: 'No campaigns yet.', onApply: function (v) { state.campaigns = v; reset(); } });
    var acctMs = SB.controls.multiSelect({ label: 'Email accounts', tip: 'Show replies received on these sending accounts only.', options: [], selected: [], emptyText: 'No sending accounts yet.', onApply: function (v) { state.senders = v; reset(); } });
    var teamMs = SB.controls.multiSelect({ label: 'Team members', tip: 'SenderBolt currently has one user, so every conversation is yours. Teammates will appear here when sharing is added.', options: [{ value: 'me', label: 'You', sub: 'Owner' }], selected: [], onApply: function () { reset(); } });
    var statusMs = SB.controls.multiSelect({ label: 'Status', tip: 'Filter by the reply tag (Interested, More info, Neutral), by outcome (Successful = conversations you marked Successful; Not successful = closed without a win because the person opted out, the address bounced or the campaign was stopped for them), or Stop campaign = people stopped in their campaign, by you or because they asked.',
      options: [{ value: 'successful', label: 'Successful' }, { value: 'not_successful', label: 'Not successful' }, { value: 'interested', label: I.sentiment.interested.label }, { value: 'more_info', label: I.sentiment.more_info.label },
        { value: 'stopped', label: I.stopBtn.label }, { value: 'neutral', label: I.sentiment.neutral.label }],
      selected: [], onApply: function (v) { state.statuses = v; reset(); } });
    function fillSelects() {
      campMs.setOptions(camps.map(function (c) { return { value: c.id, label: c.name }; }));
      acctMs.setOptions(sndrs.map(function (x) { return { value: x.id, label: x.email, sub: x.label && x.label !== x.email ? x.label : null }; }));
    }
    function paintChips(counts, unread) {
      SB.clear(chipsEl);
      function chip(label, on, count, tip, fn, cls) {
        return h('button', { type: 'button', class: 'chip ib-chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), tip: tip, 'aria-pressed': on ? 'true' : 'false', on: { click: fn } }, label, count !== null ? h('span', { class: 'ib-count', text: String(count) }) : null);
      }
      var all = ORDER.reduce(function (a, k) { return a + (counts[k] || 0); }, 0);
      chipsEl.appendChild(chip('All', !state.sentiment && !state.unread && !state.read, all, 'Every conversation with a reply.', function () { state.sentiment = ''; state.unread = false; state.read = false; state.offset = 0; loadList(); }));
      chipsEl.appendChild(chip('Unread', state.unread, unread, 'Conversations with a reply you have not opened.', function () { state.unread = !state.unread; state.read = false; state.offset = 0; loadList(); }));
      chipsEl.appendChild(chip('Read', state.read, Math.max(0, all - unread), 'Conversations where you have opened every reply.', function () { state.read = !state.read; state.unread = false; state.offset = 0; loadList(); }));
      ORDER.concat(['successful']).forEach(function (k) {
        if (k === 'successful') { chipsEl.appendChild(chip(I.successful.label, state.sentiment === 'successful', counts.successful || 0, I.successfulTab, function () { state.sentiment = state.sentiment === 'successful' ? '' : 'successful'; state.offset = 0; loadList(); }, 'chip-int')); return; }
        chipsEl.appendChild(chip(I.sentiment[k].label, state.sentiment === k, counts[k] || 0, I.sentiment[k].tip, function () { state.sentiment = state.sentiment === k ? '' : k; state.offset = 0; loadList(); }, 'chip-' + I.sentiment[k].cls));
      });
    }

    // ---------- list ----------
    function qs() {
      var p = ['limit=' + PAGE, 'offset=' + state.offset];
      if (state.sentiment) p.push('sentiment=' + encodeURIComponent(state.sentiment)); if (state.unread) p.push('unread=1'); if (state.read) p.push('read=1');
      if (state.campaigns.length) p.push('campaign_ids=' + state.campaigns.join(',')); if (state.senders.length) p.push('sender_ids=' + state.senders.join(','));
      if (state.statuses.length) p.push('status=' + state.statuses.join(','));
      if (state.q) p.push('q=' + encodeURIComponent(state.q));
      return p.join('&');
    }
    function row(it) {
      var on = state.sel === it.campaign_lead_id;
      var b = h('button', { type: 'button', role: 'listitem', class: 'ib-row' + (on ? ' on' : '') + (it.unread ? ' unread' : ''), 'data-id': it.campaign_lead_id, on: { click: function () { openThread(it.campaign_lead_id); } } },
        h('div', { class: 'ib-row-top' }, h('span', { class: 'ib-name', text: who(it) }), h('span', { class: 'ib-time faint small', tip: fmt.full(it.received_at), text: fmt.ago(it.received_at) })),
        h('div', { class: 'ib-subj', text: it.subject || '(no subject)' }),
        h('div', { class: 'ib-snip small muted', text: (it.snippet || '').replace(/\s+/g, ' ') }),
        h('div', { class: 'ib-row-bot' }, senti(it.sentiment), it.outcome === 'successful' ? h('span', { class: 'tag tag-int', tip: 'You marked this lead as Successful.' }, SB.icon('check'), 'Successful') : null, ui.optBadge(it.opt_out), it.unread ? h('span', { class: 'ib-dot', tip: it.unread + ' unread', 'aria-label': 'Unread' }) : null,
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
          var filtered = state.sentiment || state.unread || state.read || state.q || state.campaigns.length || state.senders.length || state.statuses.length;
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
    // Their reply laid out cleanly: what they wrote, then (muted, separated) their device signature, then the quoted history
    // folded away in a real blockquote. All text goes through textContent; paragraphs keep their spacing.
    function paragraphs(txt) {
      return String(txt || '').split(/\n{2,}/).map(function (para) { return h('p', { class: 'ib-p', text: para.replace(/\n/g, ' \n').replace(/ \n/g, '\n') }); });
    }
    function replyParts(v) {
      return h('div', { class: 'ib-msg-body parts' },
        h('div', { class: 'ib-main' }, paragraphs(v.body || '(empty reply)')),
        v.signature ? h('div', { class: 'ib-sig small faint', tip: I.sigTip }, v.signature) : null,
        v.quoted ? h('details', { class: 'ib-quote' }, h('summary', { class: 'small', text: I.showQuoted }),
          v.quotedHeader ? h('div', { class: 'small faint ib-qhead', text: v.quotedHeader }) : null, h('blockquote', null, paragraphs(v.quoted))) : null);
    }
    // "View original formatting": the server-sanitized page in a fully sandboxed frame (no scripts, no same-origin access).
    function formattedToggle(m) {
      var slot = h('div'), shown = false;
      var btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: I.formattedTip, on: { click: function () {
        shown = !shown; btn.textContent = shown ? I.hideFormatted : I.showFormatted;
        if (shown) SB.mount(slot, h('iframe', { class: 'ib-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: 'Original formatting of the reply', src: '/api/inbox/messages/' + m.id + '/html', loading: 'lazy' }));
        else SB.clear(slot);
      } } }, I.showFormatted);
      return h('div', { class: 'ib-formatted' }, btn, slot);
    }
    function bubble(m, lead) {
      var out = m.direction === 'out', label = msgLabel(m), when = m.sent_at || m.received_at || m.created_at;
      return h('div', { class: 'ib-msg ' + (out ? 'out' : 'in') + (m.kind !== 'email' && !out ? ' sys' : '') + (m.status === 'failed' ? ' failed' : '') },
        h('div', { class: 'ib-msg-head small' }, (out || lead.first_name) ? h('b', { text: out ? 'You' : lead.first_name }) : ui.email(lead.email, 'strong', 'b'), label ? h('span', { class: 'tag tag-sys', text: label }) : null, h('span', { class: 'faint', tip: fmt.full(when), text: fmt.ago(when) })),
        m.subject ? h('div', { class: 'ib-msg-subj small muted', text: m.subject }) : null,
        m.view ? replyParts(m.view) : h('div', { class: 'ib-msg-body', text: m.body_text || '' }),
        m.has_html ? formattedToggle(m) : null,
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
      // Stop campaign is a toggle chip: red while the person is stopped in this campaign (set automatically by a stop reply, or by you).
      var isStopped = c.status === 'stopped';
      function afterStop(msg) { ui.toast(msg); return Promise.all([openThread(c.id, true), loadList()]); }
      var stopBtn = (isStopped || ['pending', 'active', 'paused', 'error', 'replied', 'completed'].indexOf(c.status) !== -1) ? h('button', { type: 'button', class: 'chip ib-chip chip-not ib-stop' + (isStopped ? ' on' : ''), 'aria-pressed': isStopped ? 'true' : 'false', tip: isStopped ? I.stopBtn.tipOn : I.stopBtn.tip, on: { click: function () {
        if (isStopped) {
          SB.api.post('/api/campaigns/' + c.campaign_id + '/leads/bulk', { action: 'requeue', ids: [c.id] }).then(function () { return afterStop(I.stopBtn.undone); }, function (e) { ui.toast(SB.api.friendly(e), true); });
          return;
        }
        ui.confirm({ title: I.stopBtn.label, message: I.stopBtn.confirm, confirmLabel: I.stopBtn.label, danger: true, onConfirm: function () {
          return SB.api.post('/api/inbox/threads/' + c.id + '/stop', {}).then(function () { return afterStop(I.stopBtn.done); });
        } });
      } } }, SB.icon('ban'), I.stopBtn.label) : null;
      var tags = lastIn ? h('div', { class: 'ib-tags' }, h('span', { class: 'small muted' }, 'Tag: ', ui.info(I.sentimentTip)), ORDER.filter(function (k) { return k !== 'not_interested'; }).map(function (k) {
        return h('button', { type: 'button', class: 'chip ib-chip chip-' + I.sentiment[k].cls + (lastIn.sentiment === k ? ' on' : ''), tip: I.sentiment[k].tip, on: { click: function () {
          SB.api.post('/api/inbox/messages/' + lastIn.id + '/sentiment', { sentiment: k }).then(function () { return Promise.all([openThread(c.id, true), loadList()]); }, function (e) { ui.toast(SB.api.friendly(e), true); });
        } } }, I.sentiment[k].label);
      }).concat([h('span', { class: 'ib-tag-sep', 'aria-hidden': 'true' }), (function () {
        var won = c.outcome === 'successful';
        return h('button', { type: 'button', class: 'chip ib-chip chip-int' + (won ? ' on' : ''), 'aria-pressed': won ? 'true' : 'false', tip: I.successful.tip, on: { click: function () {
          SB.api.post('/api/inbox/threads/' + c.id + '/outcome', { outcome: won ? null : 'successful' }).then(function () { ui.toast(won ? 'Successful mark removed' : 'Marked as Successful'); return Promise.all([openThread(c.id, true), loadList()]); }, function (e) { ui.toast(SB.api.friendly(e), true); });
        } } }, SB.icon('check'), I.successful.label);
      })(), stopBtn])) : (stopBtn ? h('div', { class: 'ib-tags' }, stopBtn) : null);
      var node = h('div', { class: 'ib-thread-in' },
        h('div', { class: 'ib-thread-head' },
          h('div', null, h('h2', { text: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email }),
            h('div', { class: 'small muted', text: [lead.email, lead.company].filter(Boolean).join(' · ') }),
            h('div', { class: 'small faint', text: 'Campaign: ' + c.campaign_name + (c.sender ? ' · via ' + c.sender.email : '') })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', type: 'button', tip: 'Show this conversation as unread again.', on: { click: function () {
            SB.api.post('/api/inbox/threads/' + c.id + '/read', { read: false }).then(function () { ui.toast('Marked unread'); if (panel) { panel.close(); panel = null; } state.sel = null; SB.mount(threadEl, emptyThread()); loadList(); });
          } } }, 'Mark unread'))),
        c.opt_out ? h('div', { class: 'optbanner ob-' + c.opt_out }, ui.optBadge(c.opt_out, true), h('span', { class: 'small', text: I.optNote[c.opt_out] })) : null,
        c.suppressed && !c.opt_out ? h('div', { class: 'callout warn', text: I.blocked }) : null,
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
      h('div', { class: 'ib-left' }, h('div', { class: 'ib-filters' }, search, h('div', { class: 'ib-selects' }, acctMs.el, teamMs.el, campMs.el, statusMs.el), chipsEl), listEl, foot),
      h('div', { class: 'ib-right' }, threadEl)));
    SB.mount(threadEl, emptyThread()); fillSelects(); SB.mount(listEl, h('div', { class: 'skeleton' }));

    Promise.all([SB.api.get('/api/campaigns?pageSize=100'), SB.api.get('/api/senders')]).then(function (r) {
      if (dead) return; camps = (r[0].items || []).filter(function (c) { return !c.parent_id; }); sndrs = r[1].items || []; fillSelects();
    }, function () {});
    var stop = ui.poll(function () { if (!document.querySelector('#ib-reply') || !document.querySelector('#ib-reply').value) return loadList(); }, 15000);
    return { el: root, destroy: function () { SB.controls.close(); dead = true; stop(); clearTimeout(searchTimer); if (panel) panel.close(); } };
  };
})();
