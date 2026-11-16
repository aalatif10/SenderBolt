/* public/js/screens/studio.js - Campaign Studio (#/campaign/:id[/tab]).
   Opening a campaign from the project table lands here. Tabs:
     Sequence  every email as a step; emails nobody has received yet are editable (subject, text, wait, pictures),
               emails already sent are frozen and shown read-only. Saves with PATCH /api/campaigns/:id/steps.
     Overview  numbers, the segmented step bar with exact counts, sentiment, batches.
     People    every person with status, step reached and an opt-out badge ("Stopped: replied stop campaign").
     Opens     who opened, how many times, first and last time (only when open tracking is on).
     Settings  schedule and senders as they were when the campaign was created (read-only after start). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui, M = SB.S.metric, T = SB.S.studio;
  SB.screens = SB.screens || {};

  var TABS = [['sequence', 'Sequence'], ['overview', 'Overview'], ['people', 'People'], ['opens', 'Opens'], ['settings', 'Settings']];
  var LEAD_STATUS = {
    pending: ['Waiting', 'draft', 'Added to the campaign. Nothing sent yet.'], active: ['In sequence', 'active', 'Receiving the sequence.'],
    replied: ['Replied', 'completed', 'Wrote back. The sequence stopped for this person.'], completed: ['Finished', 'completed', 'Got every email in the sequence.'],
    bounced: ['Bounced', 'error', 'The address does not exist or refused the email.'], unsubscribed: ['Opted out', 'paused', 'Asked to stop. Never emailed again.'],
    paused: ['Paused', 'paused', 'Held back with the campaign.'], error: ['Problem', 'error', 'Could not be emailed, for example a missing personalisation field.']
  };
  function name(m) { return [m.first_name, m.last_name].filter(Boolean).join(' '); }
  function stepLabel(i) { return i === 0 ? 'Email 1' : 'Follow-up ' + i; }

  SB.screens.studio = function (params) {
    var id = params.id, tab = TABS.some(function (t) { return t[0] === params.tab; }) ? params.tab : 'sequence', userEmail = params.userEmail;
    var root = h('div'), head = h('div'), tabsBox = h('div'), body = h('div', null, h('div', { class: 'skeleton' }));
    var camp = null, dead = false, stopPoll = null, lastFetch = 0;
    // Sequence editing state: dirty edits per step survive background refreshes.
    var edits = {}, activeStep = null, editors = {};
    root.appendChild(head); root.appendChild(tabsBox); root.appendChild(body);

    function isDirty() { return Object.keys(edits).length > 0; }
    function beforeUnload(e) { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);

    function paintHead() {
      var c = camp, back = c.project_id ? '#/project/' + c.project_id : '#/';
      SB.mount(head, h('div', null,
        h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', h('a', { href: back }, 'Project'), ' / ', c.name),
        h('div', { class: 'page-head' },
          h('div', null, h('div', { class: 'actions' }, h('h1', { text: c.name }), ui.statusPill(c.status)),
            h('p', { class: 'sub', text: fmt.num(c.stats.total) + ' people · ' + c.steps.length + ' email' + (c.steps.length === 1 ? '' : 's') + (c.is_split ? ' · ' + c.parts.length + ' batches' : '') + ' · next email ' + fmt.until(c.stats.next_send_at) })),
          h('div', { class: 'actions' },
            c.status === 'draft' ? h('a', { class: 'btn btn-sm', href: '#/campaign/edit/' + c.id, tip: 'Change the senders, schedule or the number of emails before you start.' }, SB.icon('edit'), 'Open builder') : null,
            ui.lifecycleButton({ status: c.status, name: c.name, people: c.stats.total }, function () { load(true); }, c.id, true)))));
      SB.mount(tabsBox, h('div', { class: 'segs tabs studio-tabs', role: 'tablist' }, TABS.map(function (t) {
        return h('a', { class: 'seg' + (t[0] === tab ? ' active' : ''), href: '#/campaign/' + id + '/' + t[0], role: 'tab', 'aria-selected': t[0] === tab ? 'true' : 'false' }, t[1]);
      })));
    }

    // ---------------- Sequence ----------------
    function stepView(s) { var e = edits[s.step_no]; return e ? Object.assign({}, s, e) : s; }
    function paintSequence() {
      var steps = camp.steps;
      if (activeStep === null || !steps.some(function (s) { return s.step_no === activeStep; })) {
        var firstOpen = steps.filter(function (s) { return !s.locked; })[0];
        activeStep = (firstOpen || steps[0]).step_no;
      }
      editors = {};
      var rail = h('div', { class: 'sd-rail' }, steps.map(function (s) {
        var v = stepView(s);
        return h('button', { type: 'button', class: 'sd-step' + (s.step_no === activeStep ? ' on' : '') + (s.locked ? ' locked' : ''), on: { click: function () { activeStep = s.step_no; paintSequence(); } } },
          h('div', { class: 'sd-step-top' }, h('b', { text: stepLabel(s.step_no) }),
            s.locked ? h('span', { class: 'chip chip-sm', tip: T.lockedTip }, SB.icon('lock'), T.locked) : h('span', { class: 'chip chip-sm chip-good', tip: T.editableTip }, edits[s.step_no] ? T.unsaved : T.editable)),
          h('div', { class: 'small muted sd-subj', text: v.subject || (s.step_no === 0 ? '(no subject)' : 'Re: previous subject') }),
          ui.stepBar([{ step: s.step_no, sent: s.sent, capacity: s.capacity }], { compact: true }),
          h('div', { class: 'small faint', text: fmt.num(s.sent) + ' sent of ' + fmt.num(s.capacity) }));
      }));
      var cur = steps.filter(function (s) { return s.step_no === activeStep; })[0];
      SB.mount(body, h('div', { class: 'sd-grid' }, rail, cur.locked ? lockedPane(cur) : editPane(cur)));
    }

    function lockedPane(s) {
      var bodyDiv = h('div', { class: 'wz-mail-body' }); bodyDiv.appendChild(SB.editor.render(s.body_html));
      return h('div', { class: 'card sd-pane' },
        h('div', { class: 'callout' }, SB.icon('lock'), ' ', T.lockedTip),
        h('div', { class: 'wz-mail-subject' }, h('span', { class: 'faint', text: 'Subject  ' }), s.subject || (s.step_no === 0 ? '(no subject)' : 'Re: previous subject')),
        s.step_no > 0 ? h('p', { class: 'small muted', text: 'Sent ' + s.delay_days + ' day' + (s.delay_days === 1 ? '' : 's') + ' after the previous email.' }) : null, bodyDiv);
    }

    function editPane(s) {
      var v = stepView(s), W = SB.S.wizard;
      var subj = h('input', { class: 'input', id: 'st-subj', maxlength: 200, value: v.subject || '', placeholder: s.step_no === 0 ? W.subjectPlaceholder : W.followSubjectPlaceholder });
      var days = h('input', { class: 'input wz-days', id: 'st-days', type: 'number', min: 1, max: 60, value: v.delay_days, 'aria-label': 'Days to wait' });
      var msg = h('div', { class: 'hint' }), previewBox = h('div', { class: 'wz-preview-body' }), err = h('div', { class: 'form-error hidden', role: 'alert' });
      var saveBtn = h('button', { class: 'btn btn-primary', type: 'button', tip: T.saveTip }, T.save);
      var status = h('span', { class: 'wz-save', role: 'status' });
      var ed = SB.editor.create({ value: v.body_html, placeholder: W.followBodyPlaceholder, label: stepLabel(s.step_no) + ' text', variables: [['First name', '{{first_name|there}}'], ['Last name', '{{last_name}}'], ['Company', '{{company|your company}}'], ['Domain', '{{domain}}']], onChange: touch });
      editors[s.step_no] = ed;
      var previewSeq = 0, previewTimer = null;

      function current() {
        var o = { subject: subj.value, body_html: ed.getHtml() };
        if (s.step_no > 0) o.delay_days = days.value === '' ? '' : Number(days.value);
        return o;
      }
      function changedFromSaved(o) { return o.subject !== s.subject || o.body_html !== s.body_html || (s.step_no > 0 && o.delay_days !== s.delay_days); }
      function touch() {
        var o = current();
        if (changedFromSaved(o)) edits[s.step_no] = o; else delete edits[s.step_no];
        status.textContent = isDirty() ? T.unsaved : ''; status.classList.toggle('dirty', isDirty());
        saveBtn.disabled = !isDirty();
        if (s.step_no > 0) {
          var n = Number(days.value), ok = days.value !== '' && Math.floor(n) === n && n >= 1 && n <= 60;
          msg.textContent = ok ? (n !== s.delay_days ? T.delayShift : '') : W.delayRange; msg.className = 'hint' + (ok ? '' : ' bad');
        }
        clearTimeout(previewTimer); previewTimer = setTimeout(preview, 450);
      }
      function preview() {
        if (dead) return; var mine = ++previewSeq, o = current();
        if (!o.body_html && !o.subject) { SB.mount(previewBox, h('p', { class: 'muted', text: W.previewEmpty })); return; }
        SB.api.post('/api/templates/preview', { subject: o.subject, body_html: o.body_html }).then(function (r) {
          if (mine !== previewSeq || dead) return;
          var b = h('div', { class: 'wz-mail-body' }); b.appendChild(SB.editor.render(r.body_html));
          SB.mount(previewBox, h('div', null, h('div', { class: 'wz-mail-subject' }, h('span', { class: 'faint', text: 'Subject  ' }), r.subject || (s.step_no ? 'Re: previous subject' : '(no subject)')), b));
        }, function () {});
      }
      subj.addEventListener('input', touch); days.addEventListener('input', touch);
      saveBtn.disabled = !isDirty();
      saveBtn.addEventListener('click', save);

      function testSend() {
        SB.api.get('/api/senders').then(function (r) {
          var active = (r.items || r.senders || []).filter(function (x) { return x.status === 'active'; });
          if (!active.length) { ui.toast(W.testNoSender, true); return; }
          var pick = h('select', { class: 'input', 'aria-label': 'Send from' }, active.map(function (x) { return h('option', { value: x.id }, x.label || x.email); }));
          var to = h('input', { class: 'input', type: 'email', maxlength: 254, value: userEmail || '', 'aria-label': 'Send test to' }), e2 = h('div', { class: 'form-error hidden', role: 'alert' });
          var o = current(), prev = '';
          var pv = camp.steps.filter(function (x) { return x.step_no === s.step_no - 1; })[0]; if (pv) prev = stepView(pv).subject || '';
          ui.modal({ title: 'Send me a test email', body: h('div', null, e2, h('p', { class: 'muted', text: W.testIntro }), h('div', { class: 'field' }, h('label', null, 'Send from'), pick), h('div', { class: 'field' }, h('label', null, 'Send to'), to)),
            actions: [{ label: 'Cancel' }, { label: 'Send test', kind: 'primary', onClick: function (close) {
              return SB.api.post('/api/campaigns/test-send', { sender_id: Number(pick.value), to: to.value.trim(), subject: o.subject, previous_subject: prev, body_html: o.body_html }).then(function (res) {
                close(); ui.toast('Test sent to ' + res.to + '. It can take a minute to arrive; check spam too.');
              }, function (er) { e2.textContent = SB.api.friendly(er); e2.classList.remove('hidden'); throw er; });
            } }] });
        }, function (e) { ui.toast(SB.api.friendly(e), true); });
      }

      preview();
      return h('div', { class: 'card sd-pane' },
        err,
        h('div', { class: 'callout' }, T.liveNote, camp.status === 'draft' ? ' ' + T.draftNote : ''),
        h('div', { class: 'field' }, h('label', { for: 'st-subj' }, 'Subject'), subj, h('div', { class: 'hint', text: s.step_no === 0 ? W.subjectHint : W.followSubjectHint })),
        s.step_no > 0 ? h('div', { class: 'wz-delay' }, h('label', { for: 'st-days' }, 'Wait'), days, h('span', { text: 'days after the previous email' }), ui.info(W.delayTip), msg) : null,
        h('div', { class: 'field' }, h('label', null, 'Email text'), ed.el, h('div', { class: 'hint', text: W.fieldsHelp })),
        h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h3', { text: 'Preview' }), ui.info(W.previewTip))), previewBox,
        h('div', { class: 'panel-foot' }, h('button', { class: 'btn', type: 'button', tip: W.testTip, on: { click: testSend } }, SB.icon('mail'), 'Send me a test'),
          h('div', { class: 'actions' }, status, saveBtn)));

      function save() {
        var patch = Object.keys(edits).map(function (k) { return Object.assign({ step_no: Number(k) }, edits[k]); });
        if (!patch.length) return;
        saveBtn.disabled = true; err.classList.add('hidden');
        SB.api.patch('/api/campaigns/' + id + '/steps', { steps: patch }).then(function (r) {
          edits = {}; camp = r.campaign; ui.toast('Saved. The next email that goes out uses your changes.'); paintHead(); paintSequence();
        }, function (e) {
          saveBtn.disabled = false; err.textContent = SB.api.friendly(e); err.classList.remove('hidden');
          if (e.status === 409) load(true);     // a step may have just been sent: refresh the locks
        });
      }
    }

    // ---------------- Overview ----------------
    function paintOverview() {
      SB.mount(body, h('div', { class: 'skeleton' }));
      SB.api.get('/api/campaigns/' + id + '/analytics').then(function (a) {
        if (dead || tab !== 'overview') return;
        var t = a.totals;
        SB.mount(body, h('div', null,
          h('div', { class: 'grid-tiles' },
            ui.tile('Emailed', fmt.num(t.emailed), null, M.emailed), ui.tile('Replied', fmt.num(t.replied), fmt.pct(t.reply_rate) + ' reply rate', M.replied),
            ui.tile('Bounced', fmt.num(t.bounced), fmt.pct(t.bounce_rate) + ' bounce rate', M.bounced, t.bounce_rate > 3),
            t.opens_tracked ? ui.tile('Opens', fmt.num(t.opens), fmt.pct(t.open_rate) + ' of emailed (approx.)', M.opens) : ui.tile('Opens', 'Not tracked', 'Use replies instead', M.opens),
            ui.tile('Opted out', fmt.num(camp.stats.unsubscribed), null, M.unsub)),
          h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Sequence progress' }), ui.info(SB.S.steps.segTip)), h('div', { class: 'section-title' }), ui.stepBar(camp.steps.map(function (s) { return { step: s.step_no, sent: s.sent, capacity: s.capacity }; }))),
          t.replied ? h('div', { class: 'card pad-t' }, h('h3', null, 'Reply sentiment'), h('div', { class: 'section-title' }), ui.sentimentBar(t.sentiment)) : null,
          a.batches.length ? h('div', null, h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h3', { text: 'Batches' }), ui.info('Large lists are split into smaller batches that send in parallel, so contacts at the same company are not emailed at the same moment.'))),
            h('div', { class: 'table-wrap card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Batch' }), h('th', { text: 'Status' }), h('th', { text: 'Sequence progress' }), h('th', { text: 'Replies' }))),
              h('tbody', null, a.batches.map(function (b) {
                var part = camp.parts.filter(function (p) { return p.id === b.id; })[0];
                return h('tr', null, h('td', { text: b.name.replace(/^.* - /, '') }), h('td', null, ui.statusPill(b.status)), h('td', { class: 'c-steps' }, ui.stepBar(b.step_progress || (part && part.step_progress), { compact: true })), h('td', { text: fmt.num(b.metrics.replied) }));
              }))))) : null));
      }, function (e) { SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    // ---------------- People ----------------
    var pst = { status: 'all', page: 1, size: 50 };
    function paintPeople() {
      var table = h('div', null, h('div', { class: 'skeleton' }));
      var chips = SB.lists.chips([['all', 'All'], ['active', 'In sequence'], ['replied', 'Replied'], ['unsubscribed', 'Opted out'], ['bounced', 'Bounced'], ['completed', 'Finished'], ['pending', 'Waiting']].map(function (c) {
        return { key: c[0], label: c[1], n: c[0] === 'all' ? camp.stats.total : (camp.stats[c[0]] || 0), tip: c[0] === 'unsubscribed' ? 'People who asked to stop, by replying "stop campaign" or with the unsubscribe link.' : undefined };
      }), pst.status, function (k) { pst.status = k; pst.page = 1; paintPeople(); });
      SB.mount(body, h('div', null, chips, h('div', { class: 'pad-t' }), table));
      SB.api.get('/api/campaigns/' + id + '/leads?status=' + encodeURIComponent(pst.status) + '&page=' + pst.page + '&pageSize=' + pst.size).then(function (r) {
        if (dead || tab !== 'people') return;
        if (!r.items.length) { SB.mount(table, h('div', { class: 'card empty' }, h('h2', { text: 'Nobody here' }), h('p', { text: 'No people match this filter.' }))); return; }
        var total = camp.steps.length, pages = Math.max(1, Math.ceil(r.total / r.pageSize));
        SB.mount(table, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table leads-table' },
          h('thead', null, h('tr', null, h('th', { text: 'Person' }), h('th', { text: 'Status' }), h('th', null, 'Progress ', ui.info('How many emails of the sequence this person has received.')), h('th', { text: 'Last email' }), camp.settings.track_opens ? h('th', null, 'Opened ', ui.info('How many times this person opened your emails, and when they last did. Counts are estimates.')) : null, h('th', { text: 'Reply' }), h('th', { text: 'Sender' }))),
          h('tbody', null, r.items.map(function (m) {
            var st = LEAD_STATUS[m.status] || LEAD_STATUS.pending;
            return h('tr', { class: m.opt_out ? 'row-optout ro-' + m.opt_out : '' },
              h('td', { class: 'c-email break' }, h('b', { text: name(m) || m.email }), name(m) ? h('div', { class: 'small faint', text: m.email + (m.company ? ' · ' + m.company : '') }) : (m.company ? h('div', { class: 'small faint', text: m.company }) : null)),
              h('td', null, m.opt_out ? ui.optBadge(m.opt_out) : h('span', { class: 'pill pill-' + st[1], tip: st[2] }, st[0])),
              h('td', { class: 'nowrap', text: Math.min(m.current_step, total) + ' of ' + total }),
              h('td', { class: 'nowrap', tip: fmt.full(m.last_sent_at), text: m.last_sent_at ? fmt.ago(m.last_sent_at) : '—' }),
              camp.settings.track_opens ? h('td', { class: 'nowrap', tip: m.last_opened_at ? 'Last opened ' + fmt.full(m.last_opened_at) : 'Not opened yet' }, m.opens ? h('span', null, h('b', { text: m.opens + '\u00d7' }), h('span', { class: 'small faint', text: ' ' + fmt.ago(m.last_opened_at) })) : h('span', { class: 'faint', text: '\u2014' })) : null,
              h('td', { class: 'nowrap', text: m.replied_at ? fmt.ago(m.replied_at) : '—' }),
              h('td', { class: 'small break', text: m.sender_email || '—' }));
          })))),
          h('div', { class: 'table-foot' }, h('span', { class: 'small muted', text: fmt.num(r.total) + ' people' }), pages > 1 ? h('div', { class: 'pager' },
            h('button', { class: 'btn btn-sm', type: 'button', disabled: pst.page <= 1, on: { click: function () { pst.page--; paintPeople(); } } }, 'Previous'), h('span', { class: 'pager-n small', text: 'Page ' + pst.page + ' of ' + pages }),
            h('button', { class: 'btn btn-sm', type: 'button', disabled: pst.page >= pages, on: { click: function () { pst.page++; paintPeople(); } } }, 'Next')) : null)));
      }, function (e) { SB.mount(table, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    // ---------------- Opens ----------------
    var ost = { offset: 0, limit: 100 };
    // Opens can only be counted when the server knows its public address; say so instead of silently showing zeros.
    function trackWarn() {
      if (!SB.status || SB.status.public_origin_set !== false) return null;
      return h('div', { class: 'banner banner-warn inline', role: 'status' }, SB.icon('alert'), SB.S.studio.trackingInactive);
    }
    function paintOpens() {
      SB.mount(body, h('div', { class: 'skeleton' }));
      SB.api.get('/api/campaigns/' + id + '/opens?limit=' + ost.limit + '&offset=' + ost.offset).then(function (o) {
        if (dead || tab !== 'opens') return;
        if (!o.tracking_enabled) { SB.mount(body, h('div', { class: 'card empty' }, h('h2', { text: 'Open tracking is off for this campaign' }), h('p', { text: T.opensOff }))); return; }
        SB.mount(body, h('div', null, trackWarn(),
          h('div', { class: 'grid-tiles' }, ui.tile('People who opened', fmt.num(o.opened_emails), fmt.pct(o.open_rate) + ' of emails sent', M.opens), ui.tile('Total opens', fmt.num(o.total_opens), null, 'Every time an email was opened, including re-opens.'), ui.tile('Emails sent', fmt.num(o.emails_sent))),
          o.rows.length ? h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table leads-table' },
            h('thead', null, h('tr', null, h('th', { text: 'Person' }), h('th', { text: 'Email' }), h('th', null, 'Opens ', ui.info('How many times this email was opened.')), h('th', { text: 'First opened' }), h('th', { text: 'Last opened' }))),
            h('tbody', null, o.rows.map(function (r) {
              return h('tr', null, h('td', { class: 'c-email break' }, h('b', { text: name(r) || r.email }), name(r) ? h('div', { class: 'small faint', text: r.email }) : null),
                h('td', { class: 'small' }, stepLabel(r.step || 0), h('div', { class: 'faint', text: r.subject || '' })), h('td', null, h('b', { text: String(r.opens) }), r.opens > 3 ? h('span', { class: 'chip chip-sm', tip: 'Opened several times. Often a sign of real interest, though forwarding and security scanners also cause repeat opens.' }, 'Repeat') : null),
                h('td', { class: 'nowrap', tip: fmt.full(r.first_opened_at), text: fmt.ago(r.first_opened_at) }), h('td', { class: 'nowrap', tip: fmt.full(r.last_opened_at), text: fmt.ago(r.last_opened_at || r.first_opened_at) }));
            })))),
            h('div', { class: 'table-foot' }, h('span', { class: 'small muted', text: 'Showing ' + (ost.offset + 1) + '–' + (ost.offset + o.rows.length) + ' of ' + fmt.num(o.opened_emails) }),
              h('div', { class: 'pager' }, h('button', { class: 'btn btn-sm', type: 'button', disabled: ost.offset <= 0, on: { click: function () { ost.offset = Math.max(0, ost.offset - ost.limit); paintOpens(); } } }, 'Previous'),
                h('button', { class: 'btn btn-sm', type: 'button', disabled: ost.offset + o.rows.length >= o.opened_emails, on: { click: function () { ost.offset += ost.limit; paintOpens(); } } }, 'Next'))))
            : h('div', { class: 'card empty' }, h('h2', { text: 'No opens yet' }), h('p', { text: 'When someone opens an email it appears here.' })),
          h('p', { class: 'hint pad-t', text: T.opensNote })));
      }, function (e) { SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    // ---------------- Settings (read-only) ----------------
    function paintSettings() {
      var s = camp.settings, pad = function (n) { return (n < 10 ? '0' : '') + n + ':00'; }, off = s.utc_offset_min, tz = 'UTC' + (off >= 0 ? '+' : '-') + Math.floor(Math.abs(off) / 60) + (Math.abs(off) % 60 ? ':' + (Math.abs(off) % 60) : '');
      function row(k, v) { return h('div', { class: 'wz-sum-row' }, h('div', { class: 'k', text: k }), h('div', { class: 'v' }, v)); }
      SB.mount(body, h('div', { class: 'card wz-narrow' },
        h('div', { class: 'callout' }, camp.status === 'draft' ? T.draftNote : 'Senders and schedule are fixed once a campaign has started, so results stay comparable. Start a new campaign to change them.'),
        row('Sending window', pad(s.window_start_hour) + ' to ' + pad(s.window_end_hour) + ' (' + tz + ')'), row('Weekends', s.weekdays_only ? 'Skipped' : 'Included'),
        row('Stop on reply', s.stop_on_reply ? 'Yes: nobody gets a follow-up after answering' : 'No'), row('Open tracking', s.track_opens ? 'On' : 'Off'),
        row('Senders', camp.senders.map(function (x) { return x.label || x.email; }).join(', ') || '—'), row('Created', fmt.full(camp.created_at))));
    }

    function paintTab() {
      paintHead();
      if (tab === 'sequence') paintSequence(); else if (tab === 'overview') paintOverview(); else if (tab === 'people') paintPeople();
      else if (tab === 'opens') paintOpens(); else paintSettings();
    }

    function load(force) {
      return SB.api.get('/api/campaigns/' + id).then(function (r) {
        if (dead) return;
        var first = !camp; camp = r.campaign; lastFetch = Date.now();
        // Background refreshes only repaint what cannot disturb typing: the header, and the tab when nothing is being edited.
        if (first || force) paintTab(); else { paintHead(); if (tab !== 'sequence' && tab !== 'opens') paintTab(); }
      }, function (e) {
        if (e.status === 404) { SB.mount(root, h('div', { class: 'card empty' }, h('h2', { text: 'Campaign not found' }), h('a', { class: 'btn', href: '#/' }, 'Back to Home'))); return; }
        if (!camp && e.code !== 'offline') SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }

    stopPoll = ui.poll(function () { return load(false); }, 10000);
    return {
      el: root,
      isDirty: isDirty, dirtyMessage: T.leave,
      destroy: function () { dead = true; if (stopPoll) stopPoll(); window.removeEventListener('beforeunload', beforeUnload); }
    };
  };
})();
