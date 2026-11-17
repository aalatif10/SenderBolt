/* public/js/screens/studio.js - Campaign Studio (#/campaign/:id[/tab]).
   Opening a campaign from the project table lands here. Tabs:
     Sequence  every email as a step; emails nobody has received yet are editable (subject, text, wait, pictures),
               emails already sent are frozen and shown read-only. Saves with PATCH /api/campaigns/:id/steps.
     Overview  stat strip (sent / scheduled / opened / replied / successful), sequence overview bar, Metrics breakdown table
               (whole sequence + every email: scheduled, sent, delivered, opened, replied, successful, bounced, unsubscribed).
     People    every person with status and opt-out badge; tick people for Pause / Resume / Re-queue / Remove; click a person to
               open the drawer with the full message history, step progression and inline editing of their merge fields.
     Opens     who opened, how many times, first and last time (only when open tracking is on).
     Settings  sending window, active days, senders, stop-on-reply and tracking: editable also while the campaign runs. */
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
    var camp = null, dead = false, stopPoll = null, lastFetch = 0, drawerClose = null;
    // Sequence editing state: dirty edits per step survive background refreshes.
    var edits = {}, activeStep = null, editors = {}, adding = false;
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
        return h('button', { type: 'button', class: 'sd-step' + (s.step_no === activeStep && !adding ? ' on' : '') + (s.locked ? ' locked' : ''), on: { click: function () { activeStep = s.step_no; adding = false; paintSequence(); } } },
          h('div', { class: 'sd-step-top' }, h('b', { text: stepLabel(s.step_no) }),
            s.locked ? h('span', { class: 'chip chip-sm', tip: T.lockedTip }, SB.icon('lock'), T.locked) : h('span', { class: 'chip chip-sm chip-good', tip: T.editableTip }, edits[s.step_no] ? T.unsaved : T.editable)),
          h('div', { class: 'small muted sd-subj', text: v.subject || (s.step_no === 0 ? '(no subject)' : 'Re: previous subject') }),
          ui.stepBar([{ step: s.step_no, sent: s.sent, capacity: s.capacity }], { compact: true }),
          h('div', { class: 'small faint', text: fmt.num(s.sent) + ' sent of ' + fmt.num(s.capacity) }));
      }));
      var cur = steps.filter(function (s) { return s.step_no === activeStep; })[0];
      var canAdd = camp.status !== 'draft' && camp.status !== 'completed' && camp.status !== 'preparing' && steps.length < 6;
      if (canAdd) rail.appendChild(h('button', { type: 'button', class: 'sd-step sd-add' + (adding ? ' on' : ''), tip: T.addTip, on: { click: function () { adding = true; paintSequence(); } } }, SB.icon('plus'), h('b', { text: 'Add follow-up' }), h('div', { class: 'small muted', text: 'Follow-up ' + steps.length + ' · reaches everyone still in the sequence' })));
      SB.mount(body, h('div', { class: 'sd-grid' }, rail, adding && canAdd ? addPane() : (cur.locked ? lockedPane(cur) : editPane(cur))));
    }

    // New follow-up appended to a running campaign: people who already finished the sequence do not get it; everyone else does.
    function addPane() {
      var W = SB.S.wizard, n = camp.steps.length, err = h('div', { class: 'form-error hidden', role: 'alert' });
      var subj = h('input', { class: 'input', maxlength: 200, placeholder: W.followSubjectPlaceholder, 'aria-label': 'Subject' });
      var days = h('input', { class: 'input wz-days', type: 'number', min: 1, max: 60, value: 3, 'aria-label': 'Days to wait' });
      var ed = SB.editor.create({ value: '', placeholder: W.followBodyPlaceholder, label: 'Follow-up ' + n + ' text', variables: [['First name', '{{first_name|there}}'], ['Last name', '{{last_name}}'], ['Company', '{{company|your company}}'], ['Domain', '{{domain}}']], onChange: function () {} });
      var add = h('button', { class: 'btn btn-primary', type: 'button' }, SB.icon('plus'), 'Add follow-up ' + n);
      add.addEventListener('click', function () {
        var d = Number(days.value);
        if (!(Math.floor(d) === d && d >= 1 && d <= 60)) { err.textContent = W.delayRange; err.classList.remove('hidden'); return; }
        add.disabled = true; err.classList.add('hidden');
        SB.api.post('/api/campaigns/' + id + '/steps', { steps: [{ subject: subj.value, body_html: ed.getHtml(), delay_days: d }] }).then(function (r) {
          camp = r.campaign; adding = false; activeStep = n; ui.toast('Follow-up ' + n + ' added. People still in the sequence will get it after their current wait.'); paintHead(); paintSequence();
        }, function (e) { add.disabled = false; err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); });
      });
      return h('div', { class: 'card sd-pane' }, err, h('div', { class: 'callout' }, T.addNote),
        h('div', { class: 'field' }, h('label', null, 'Subject'), subj, h('div', { class: 'hint', text: W.followSubjectHint })),
        h('div', { class: 'wz-delay' }, h('label', null, 'Wait'), days, h('span', { text: 'days after the previous email' }), ui.info(W.delayTip)),
        h('div', { class: 'field' }, h('label', null, 'Email text'), ed.el, h('div', { class: 'hint', text: W.fieldsHelp })),
        h('div', { class: 'panel-foot' }, h('button', { class: 'btn', type: 'button', on: { click: function () { adding = false; paintSequence(); } } }, 'Cancel'), add));
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
    function pctOf(n, den) { return den ? Math.round(n / den * 1000) / 10 : 0; }
    function pc(n, den, tracked) { if (tracked === false) return '—'; return fmt.pct(pctOf(n, den)) + ' (' + fmt.num(n) + ')'; }
    function paintOverview() {
      SB.mount(body, h('div', { class: 'skeleton' }));
      Promise.all([SB.api.get('/api/campaigns/' + id + '/analytics'), SB.api.get('/api/campaigns/' + id + '/metrics')]).then(function (res) {
        if (dead || tab !== 'overview') return;
        var a = res[0], m = res[1], seqRow = m.rows[0], t = a.totals, tr = m.track_opens, total = seqRow.sent + seqRow.scheduled;
        function cell(label, value, note, tip) { return h('div', { class: 'ov-cell' }, h('div', { class: 'ov-label' }, label, tip ? ui.info(tip) : null), h('div', { class: 'ov-value', text: value }), note ? h('div', { class: 'ov-note small muted', text: note }) : null); }
        var sentFill = h('span', { class: 'sent' }), schedFill = h('span', { class: 'sched' });
        sentFill.style.width = pctOf(seqRow.sent, total) + '%'; schedFill.style.width = pctOf(seqRow.scheduled, total) + '%';
        var strip = h('div', { class: 'card ov-strip' },
          h('div', { class: 'ov-progress' }, h('div', { class: 'ov-bar', role: 'img', 'aria-label': 'Sent versus scheduled emails' }, sentFill, schedFill),
            h('div', { class: 'ov-legend' }, h('span', { tip: 'Emails that already went out, counting every email of the sequence.' }, h('i', { class: 'sent' }), h('b', { text: 'Sent ' }), fmt.num(seqRow.sent) + ' (' + fmt.pct(pctOf(seqRow.sent, total)) + ')'),
              h('span', { tip: 'Emails still to go out: first emails and follow-ups for people who are still in the sequence.' }, h('i', { class: 'sched' }), h('b', { text: 'Scheduled ' }), fmt.num(seqRow.scheduled) + ' (' + fmt.pct(pctOf(seqRow.scheduled, total)) + ')'))),
          h('div', { class: 'ov-cells' },
            cell('Opened', tr ? fmt.num(seqRow.opened) : '—', tr ? fmt.pct(pctOf(seqRow.opened, seqRow.delivered)) + ' of delivered' : 'Tracking is off', M.opens),
            cell('Clicked', '—', 'Not tracked', 'SenderBolt does not rewrite your links, which keeps emails out of spam folders. Replies are the signal to watch.'),
            cell('Replied', fmt.num(seqRow.replied), fmt.pct(pctOf(seqRow.replied, seqRow.delivered)) + ' of delivered', M.replied),
            cell('Successful', fmt.num(seqRow.successful), fmt.pct(pctOf(seqRow.successful, seqRow.delivered)) + ' of delivered', 'Replies tagged "Interested" in your Inbox.')));
        var cols = [['Scheduled', 'scheduled', 'Emails still to go out for this step.'], ['Sent', 'sent', 'Emails of this step that went out.'], ['Delivered', 'delivered', 'Sent minus bounced.'],
          ['Opened', 'opened', M.opens], ['Replied', 'replied', 'People who wrote back, counted under the email they answered.'], ['Successful', 'successful', 'Replies tagged "Interested".'],
          ['Bounced', 'bounced', M.bounced], ['Unsubscribed', 'unsubscribed', 'People who asked to stop (unsubscribe link or replying "stop campaign"), under the last email they got.']];
        function val(r, k) {
          if (k === 'scheduled' || k === 'sent' || k === 'delivered') return fmt.num(r[k]);
          if (k === 'opened') return pc(r.opened, r.delivered, tr);
          if (k === 'bounced') return pc(r.bounced, r.sent);
          return pc(r[k], r.delivered);
        }
        var breakdown = h('div', null,
          h('div', { class: 'section-title' }, h('div', { class: 'actions' }, h('h3', { text: 'Metrics breakdown' }), ui.info('One row for the whole sequence and one for every email. The Sequence row counts each person once, so it is not the sum of the rows below it.'))),
          h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table metrics-table' },
            h('thead', null, h('tr', null, h('th'), cols.map(function (c) { return h('th', { class: 'num' }, c[0], ' ', ui.info(c[2])); }))),
            h('tbody', null, m.rows.map(function (r, i) {
              return h('tr', { class: i === 0 ? 'mt-seq' : '' }, h('td', null, h('b', { text: i === 0 ? 'Sequence' : (i + '. ' + r.label) }), i && r.subject ? h('div', { class: 'small faint', text: r.subject }) : null),
                cols.map(function (c) { return h('td', { class: 'num' + (c[1] === 'bounced' && r.bounced ? ' bad' : '') }, val(r, c[1])); }));
            }))))));
        SB.mount(body, h('div', null, trackWarn(), strip,
          h('div', { class: 'card pad-t' }, h('div', { class: 'actions' }, h('h3', { text: 'Sequence overview' }), ui.info(SB.S.steps.segTip + ' Hover to see every step.')), h('div', { class: 'section-title' }), ui.stepBar(camp.steps.map(function (s) { return { step: s.step_no, sent: s.sent, capacity: s.capacity }; }))),
          breakdown,
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
    var pst = { status: 'all', page: 1, size: 50, sel: {} };
    function selIds() { return Object.keys(pst.sel).map(Number); }
    function bulk(action, label) {
      var idsNow = selIds(); if (!idsNow.length) return;
      function run() {
        return SB.api.post('/api/campaigns/' + id + '/leads/bulk', { action: action, ids: idsNow }).then(function (r) {
          var msg = fmt.num(r.done.length) + ' ' + label + (r.skipped.length ? '. ' + r.skipped.length + ' skipped: ' + r.skipped[0].message : '');
          ui.toast(msg, r.done.length === 0 && r.skipped.length > 0); pst.sel = {}; return load(true);
        }, function (e) { ui.toast(SB.api.friendly(e), true); });
      }
      if (action === 'remove') {
        ui.confirm({ title: 'Remove ' + idsNow.length + ' ' + (idsNow.length === 1 ? 'person' : 'people') + '?', message: T.removeNote, confirmLabel: 'Remove', danger: true, onConfirm: run });
      } else run();
    }
    function paintPeople() {
      var table = h('div', null, h('div', { class: 'skeleton' })), barBox = h('div');
      var chips = SB.lists.chips([['all', 'All'], ['active', 'In sequence'], ['paused', 'Paused'], ['replied', 'Replied'], ['unsubscribed', 'Opted out'], ['bounced', 'Bounced'], ['error', 'Problem'], ['completed', 'Finished'], ['pending', 'Waiting']].map(function (c) {
        return { key: c[0], label: c[1], n: c[0] === 'all' ? camp.stats.total : (camp.stats[c[0]] || 0), tip: c[0] === 'unsubscribed' ? 'People who asked to stop, by replying "stop campaign" or with the unsubscribe link.' : undefined };
      }).filter(function (c) { return c.key === 'all' || c.n > 0 || c.key === pst.status; }), pst.status, function (k) { pst.status = k; pst.page = 1; pst.sel = {}; paintPeople(); });
      SB.mount(body, h('div', null, chips, barBox, h('div', { class: 'pad-t' }), table));
      function paintBar() {
        var n = selIds().length;
        SB.mount(barBox, h('div', null, SB.lists.selectionBar(n, 'person', [
          { label: 'Pause', icon: 'pause', tip: 'Hold these people back. They get nothing more until you resume them.', onClick: function () { bulk('pause', 'paused'); } },
          { label: 'Resume', icon: 'play', tip: 'Let paused people continue where they stopped.', onClick: function () { bulk('resume', 'resumed'); } },
          { label: 'Re-queue', icon: 'undo', tip: T.requeueTip, onClick: function () { bulk('requeue', 'put back in the queue'); } },
          { label: 'Remove', icon: 'trash', kind: 'danger', tip: T.removeTip, onClick: function () { bulk('remove', 'removed'); } }], function () { pst.sel = {}; paintPeople(); })));
      }
      paintBar();
      SB.api.get('/api/campaigns/' + id + '/leads?status=' + encodeURIComponent(pst.status) + '&page=' + pst.page + '&pageSize=' + pst.size).then(function (r) {
        if (dead || tab !== 'people') return;
        if (!r.items.length) { SB.mount(table, h('div', { class: 'card empty' }, h('h2', { text: 'Nobody here' }), h('p', { text: 'No people match this filter.' }))); return; }
        var total = camp.steps.length, pages = Math.max(1, Math.ceil(r.total / r.pageSize));
        var all = h('input', { type: 'checkbox', 'aria-label': 'Select everyone on this page' });
        all.checked = r.items.every(function (m) { return pst.sel[m.id]; });
        all.addEventListener('change', function () { r.items.forEach(function (m) { if (all.checked) pst.sel[m.id] = true; else delete pst.sel[m.id]; }); paintPeople(); });
        SB.mount(table, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table leads-table' },
          h('thead', null, h('tr', null, h('th', { class: 'c-check' }, all), h('th', { text: 'Person' }), h('th', { text: 'Status' }), h('th', null, 'Progress ', ui.info('How many emails of the sequence this person has received.')), h('th', { text: 'Last email' }), camp.settings.track_opens ? h('th', null, 'Opened ', ui.info('How many times this person opened your emails, and when they last did. Counts are estimates.')) : null, h('th', { text: 'Reply' }), h('th', { text: 'Sender' }))),
          h('tbody', null, r.items.map(function (m) {
            var st = LEAD_STATUS[m.status] || LEAD_STATUS.pending;
            var cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + m.email }); cb.checked = !!pst.sel[m.id];
            cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
            cb.addEventListener('change', function () { if (cb.checked) pst.sel[m.id] = true; else delete pst.sel[m.id]; tr.classList.toggle('sel', cb.checked); paintBar(); });
            var tr = h('tr', { class: 'row-link' + (m.opt_out ? ' row-optout ro-' + m.opt_out : '') + (pst.sel[m.id] ? ' sel' : ''), tabindex: 0, on: { click: function () { openDrawer(m.id); }, keydown: function (ev) { if (ev.key === 'Enter') openDrawer(m.id); } } },
              h('td', { class: 'c-check' }, cb),
              h('td', { class: 'c-email break' }, h('b', { text: name(m) || m.email }), name(m) ? h('div', { class: 'small faint', text: m.email + (m.company ? ' · ' + m.company : '') }) : (m.company ? h('div', { class: 'small faint', text: m.company }) : null)),
              h('td', null, m.opt_out ? ui.optBadge(m.opt_out) : h('span', { class: 'pill pill-' + st[1], tip: st[2] }, st[0]), m.status_note && !m.opt_out ? h('div', { class: 'small faint', text: m.status_note }) : null),
              h('td', { class: 'nowrap', text: Math.min(m.current_step, total) + ' of ' + total }),
              h('td', { class: 'nowrap', tip: fmt.full(m.last_sent_at), text: m.last_sent_at ? fmt.ago(m.last_sent_at) : '—' }),
              camp.settings.track_opens ? h('td', { class: 'nowrap', tip: m.last_opened_at ? 'Last opened ' + fmt.full(m.last_opened_at) : 'Not opened yet' }, m.opens ? h('span', null, h('b', { text: m.opens + '×' }), h('span', { class: 'small faint', text: ' ' + fmt.ago(m.last_opened_at) })) : h('span', { class: 'faint', text: '—' })) : null,
              h('td', { class: 'nowrap', text: m.replied_at ? fmt.ago(m.replied_at) : '—' }),
              h('td', { class: 'small break', text: m.sender_email || '—' }));
            return tr;
          })))),
          h('div', { class: 'table-foot' }, h('span', { class: 'small muted', text: fmt.num(r.total) + ' people · click a person for their full history' }), pages > 1 ? h('div', { class: 'pager' },
            h('button', { class: 'btn btn-sm', type: 'button', disabled: pst.page <= 1, on: { click: function () { pst.page--; paintPeople(); } } }, 'Previous'), h('span', { class: 'pager-n small', text: 'Page ' + pst.page + ' of ' + pages }),
            h('button', { class: 'btn btn-sm', type: 'button', disabled: pst.page >= pages, on: { click: function () { pst.page++; paintPeople(); } } }, 'Next')) : null)));
      }, function (e) { SB.mount(table, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    // Side drawer: who this is, their merge fields (editable), step progression and every message sent or received.
    function openDrawer(clId) {
      var pnl = ui.panel('Person'), box = pnl.body; drawerClose = pnl.close;
      pnl.body.parentNode.classList.add('panel-wide');
      SB.mount(box, h('div', { class: 'skeleton' }));
      function paint(hi) {
        var l = hi.lead, st = LEAD_STATUS[l.status] || LEAD_STATUS.pending;
        var opt = l.status === 'bounced' ? 'bounce' : (l.status === 'unsubscribed' ? (/stop campaign/i.test(l.status_note || '') ? 'stop_campaign' : null) : null);
        var f = { first_name: h('input', { class: 'input', maxlength: 200, value: l.first_name || '', 'aria-label': 'First name' }), last_name: h('input', { class: 'input', maxlength: 200, value: l.last_name || '', 'aria-label': 'Last name' }),
          company: h('input', { class: 'input', maxlength: 200, value: l.company || '', 'aria-label': 'Company' }) };
        var customRows = h('div', { class: 'cf-rows' }), err = h('div', { class: 'form-error hidden', role: 'alert' });
        function addRow(k, val) {
          var key = h('input', { class: 'input', maxlength: 40, value: k || '', placeholder: 'field_name', 'aria-label': 'Field name' }), v = h('input', { class: 'input', maxlength: 500, value: val || '', placeholder: 'Value', 'aria-label': 'Field value' });
          var row = h('div', { class: 'cf-row' }, key, v, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Remove field', on: { click: function () { customRows.removeChild(row); } } }, SB.icon('x')));
          row.__get = function () { return [key.value.trim(), v.value]; }; customRows.appendChild(row);
        }
        Object.keys(l.custom || {}).forEach(function (k) { addRow(k, l.custom[k]); });
        var save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', tip: T.leadSaveTip }, 'Save changes');
        save.addEventListener('click', function () {
          var custom = {}; Array.prototype.forEach.call(customRows.children, function (r) { var kv = r.__get(); if (kv[0]) custom[kv[0]] = kv[1]; });
          save.disabled = true; err.classList.add('hidden');
          SB.api.patch('/api/campaigns/' + id + '/leads/' + clId, { first_name: f.first_name.value, last_name: f.last_name.value, company: f.company.value, custom: custom }).then(function (r) {
            ui.toast('Saved. The next email to this person uses the new values.'); paint(r);
            if (tab === 'people') paintPeople();
          }, function (e) { save.disabled = false; err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); });
        });
        var requeue = l.can_requeue ? h('button', { class: 'btn btn-sm', type: 'button', tip: T.requeueTip, on: { click: function () {
          SB.api.post('/api/campaigns/' + id + '/leads/bulk', { action: 'requeue', ids: [clId] }).then(function (r) {
            ui.toast(r.done.length ? 'Back in the queue. The next email goes out in the next sending window.' : (r.skipped[0] ? r.skipped[0].message : 'Nothing changed'), !r.done.length);
            return Promise.all([SB.api.get('/api/campaigns/' + id + '/leads/' + clId + '/history').then(paint), load(true)]);
          }, function (e) { ui.toast(SB.api.friendly(e), true); });
        } } }, SB.icon('undo'), 'Re-queue this person') : null;
        function when(ms) { return ms ? fmt.full(ms) : ''; }
        var prog = h('div', { class: 'sd-prog' }, hi.steps.map(function (x) {
          var ic = x.state === 'sent' ? 'check' : (x.state === 'scheduled' ? 'clock' : 'hourglass');
          var tx = x.state === 'sent' ? 'Sent ' + when(x.sent_at) : (x.state === 'scheduled' ? 'Scheduled ' + when(x.scheduled_at) : 'Not sent');
          return h('div', { class: 'sd-prog-row sp-' + x.state }, SB.icon(ic), h('span', { class: 'sp-lbl', text: stepLabel(x.step_no) }), h('span', { class: 'small muted', text: tx }), x.opens ? h('span', { class: 'chip chip-sm', tip: 'Opened ' + x.opens + ' time' + (x.opens === 1 ? '' : 's') }, SB.icon('eye'), x.opens + '×') : null);
        }));
        var thread = hi.messages.length ? h('div', { class: 'thread' }, hi.messages.map(function (m) {
          var out = m.direction === 'out', bodyEl = h('div', { class: 'wz-mail-body' });
          if (out && m.body_html) bodyEl.appendChild(SB.editor.render(m.body_html)); else bodyEl.appendChild(h('div', { class: 'msg-text', text: m.body_text || '' }));
          return h('div', { class: 'msg ' + (out ? 'msg-out' : 'msg-in') },
            h('div', { class: 'msg-head' }, h('b', { text: out ? (m.step_no === 0 ? 'Initial email' : (m.step_no !== null ? 'Follow-up ' + m.step_no : 'Your reply')) : (m.kind === 'bounce' ? 'Bounce notice' : 'Their reply') }),
              h('span', { class: 'small faint', tip: fmt.full(m.at), text: fmt.ago(m.at) }), m.error ? h('span', { class: 'chip chip-sm chip-bad', text: 'Not sent' }) : null),
            h('div', { class: 'msg-subj small', text: m.subject || '(no subject)' }), bodyEl, m.error ? h('div', { class: 'small bad', text: m.error }) : null);
        })) : h('p', { class: 'muted', text: 'No email has been sent to this person yet.' });
        SB.mount(box, h('div', { class: 'drawer' },
          h('div', { class: 'drawer-head' }, h('div', null, h('h3', { text: name(l) || l.email }), h('div', { class: 'small muted break', text: l.email + (l.sender_email ? ' · sending from ' + l.sender_email : '') })),
            opt ? ui.optBadge(opt, true) : h('span', { class: 'pill pill-' + st[1], tip: st[2] }, st[0])),
          l.status_note ? h('p', { class: 'small muted', text: l.status_note }) : null,
          requeue || l.requeue_blocked ? h('div', { class: 'callout' }, requeue, l.requeue_blocked ? h('span', { class: 'small', text: l.requeue_blocked }) : null) : null,
          h('h4', { class: 'drawer-h', text: 'Details' }), err,
          h('div', { class: 'cf-grid' }, h('label', null, 'First name', f.first_name), h('label', null, 'Last name', f.last_name), h('label', null, 'Company', f.company)),
          h('div', { class: 'cf-title small muted' }, 'Custom fields ', ui.info(T.customTip)), customRows,
          h('div', { class: 'actions pad-t' }, h('button', { class: 'btn btn-sm', type: 'button', on: { click: function () { addRow('', ''); } } }, SB.icon('plus'), 'Add field'), save),
          h('h4', { class: 'drawer-h', text: 'Progress' }), prog,
          h('h4', { class: 'drawer-h', text: 'Messages' }), thread));
      }
      SB.api.get('/api/campaigns/' + id + '/leads/' + clId + '/history').then(paint, function (e) { SB.mount(box, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
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

    // ---------------- Settings (editable, also while running) ----------------
    var DAYS = [['Mon', 2], ['Tue', 4], ['Wed', 8], ['Thu', 16], ['Fri', 32], ['Sat', 64], ['Sun', 1]];
    function tzLabel(off) { var a = Math.abs(off); return 'UTC' + (off >= 0 ? '+' : '-') + (Math.floor(a / 60) < 10 ? '0' : '') + Math.floor(a / 60) + ':' + (a % 60 ? '30' : '00'); }
    function paintSettings() {
      var s = camp.settings, locked = camp.status === 'completed' || camp.status === 'preparing', pad = function (n) { return (n < 10 ? '0' : '') + n + ':00'; };
      SB.mount(body, h('div', { class: 'skeleton' }));
      SB.api.get('/api/senders').then(function (r) {
        if (dead || tab !== 'settings') return;
        var all = r.items || r.senders || [], chosen = {}; camp.senders.forEach(function (x) { chosen[x.id] = true; });
        var days = s.active_days, err = h('div', { class: 'form-error hidden', role: 'alert' });
        var start = h('select', { class: 'input', 'aria-label': 'Start hour' }), end = h('select', { class: 'input', 'aria-label': 'End hour' }), tz = h('select', { class: 'input', 'aria-label': 'Time zone' });
        for (var i = 0; i <= 23; i++) start.appendChild(h('option', { value: i }, pad(i)));
        for (var j = 1; j <= 24; j++) end.appendChild(h('option', { value: j }, pad(j === 24 ? 0 : j) + (j === 24 ? ' (midnight)' : '')));
        var offs = []; for (var o = -720; o <= 840; o += 30) offs.push(o); if (offs.indexOf(s.utc_offset_min) === -1) offs.push(s.utc_offset_min);
        offs.sort(function (x, y) { return x - y; }).forEach(function (o) { tz.appendChild(h('option', { value: o }, tzLabel(o))); });
        start.value = s.window_start_hour; end.value = s.window_end_hour; tz.value = s.utc_offset_min;
        var dayBtns = DAYS.map(function (d) {
          var b = h('button', { type: 'button', class: 'chip day-chip' + ((days & d[1]) ? ' on' : ''), 'aria-pressed': (days & d[1]) ? 'true' : 'false', tip: d[0] === 'Sat' || d[0] === 'Sun' ? 'Weekend sending usually gets fewer opens.' : undefined }, d[0]);
          b.addEventListener('click', function () { days ^= d[1]; if (!days) days = d[1]; paintDays(); });
          return b;
        });
        function paintDays() { dayBtns.forEach(function (b, k) { var on = !!(days & DAYS[k][1]); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
        function sw(label, hint, val) { var cb = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label }); cb.checked = !!val; return { cb: cb, row: h('div', { class: 'set-row' }, h('div', { class: 'set-txt' }, h('label', { text: label }), h('div', { class: 'hint', text: hint })), cb) }; }
        var stop = sw('Stop when someone replies', 'Nobody gets a follow-up after answering you.', s.stop_on_reply), track = sw('Track opens', 'Adds a tiny invisible image to emails that go out from now on. Counts are estimates.', s.track_opens);
        var sendRows = all.map(function (x) {
          var cb = h('input', { type: 'checkbox', 'aria-label': (x.label || x.email) }); cb.checked = !!chosen[x.id]; cb.disabled = x.status !== 'active' && !chosen[x.id];
          cb.addEventListener('change', function () { if (cb.checked) chosen[x.id] = true; else delete chosen[x.id]; });
          return h('label', { class: 'sender-opt' + (cb.disabled ? ' dim' : '') }, cb, h('div', null, h('b', { text: x.label || x.email }), h('div', { class: 'small muted', text: x.email + ' · ' + fmt.num(x.sent_today) + ' of ' + fmt.num(x.limit_today) + ' sent today' + (x.status !== 'active' ? ' · ' + x.status : '') })));
        });
        var save = h('button', { class: 'btn btn-primary', type: 'button', disabled: locked }, 'Save settings');
        save.addEventListener('click', function () {
          var sids = Object.keys(chosen).map(Number);
          if (!sids.length) { err.textContent = 'Choose at least one sending account.'; err.classList.remove('hidden'); return; }
          save.disabled = true; err.classList.add('hidden');
          SB.api.patch('/api/campaigns/' + id, { window_start_hour: Number(start.value), window_end_hour: Number(end.value), utc_offset_min: Number(tz.value), active_days: days, stop_on_reply: stop.cb.checked ? 1 : 0, track_opens: track.cb.checked ? 1 : 0, sender_ids: sids }).then(function (r) {
            camp = r.campaign; ui.toast('Saved. Changes apply from the next email.'); paintHead(); paintSettings();
          }, function (e) { save.disabled = false; err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); });
        });
        function section(title, desc, kids) { return h('div', { class: 'card set-sec' }, h('div', { class: 'set-sec-h' }, h('h3', { text: title }), h('p', { class: 'muted small', text: desc })), h('div', { class: 'set-sec-b' }, kids)); }
        SB.mount(body, h('div', { class: 'wz-narrow' }, err,
          h('div', { class: 'callout' }, locked ? 'This campaign has finished, so its settings are fixed.' : T.settingsNote),
          section('Sending accounts', 'Add or remove accounts while the campaign runs. People who have not been emailed yet are spread over the new set; people mid-sequence keep their account so follow-ups stay in one thread.', h('div', { class: 'sender-opts' }, sendRows)),
          section('Sending window', 'Emails only go out between these hours, in this time zone.', h('div', { class: 'win-row' }, h('label', null, 'From', start), h('label', null, 'Until', end), h('label', null, 'Time zone', tz))),
          section('Active days', 'Choose the days emails may go out, weekends included.', h('div', { class: 'chips' }, dayBtns, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: function () { days = 62; paintDays(); } } }, 'Weekdays'), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: function () { days = 127; paintDays(); } } }, 'Every day'))),
          section('Behaviour', 'How the campaign treats replies and tracking.', [stop.row, track.row]),
          section('Gaps between emails', 'The wait before each follow-up is set per email in the Sequence tab (only for emails nobody has received). The pause between two emails from one account is set per account.',
            h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm', href: '#/campaign/' + id + '/sequence' }, 'Edit waits in Sequence'), h('a', { class: 'btn btn-sm', href: '#/senders' }, 'Sending accounts'))),
          h('div', { class: 'panel-foot' }, h('span', { class: 'small faint', text: 'Created ' + fmt.full(camp.created_at) }), save)));
        if (locked) Array.prototype.forEach.call(body.querySelectorAll('input,select,button.day-chip'), function (el) { el.disabled = true; });
      }, function (e) { SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
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
      destroy: function () { dead = true; if (drawerClose) { try { drawerClose(); } catch (e) {} } if (stopPoll) stopPoll(); window.removeEventListener('beforeunload', beforeUnload); }
    };
  };
})();
