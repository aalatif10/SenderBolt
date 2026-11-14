/* public/js/screens/wizard.js - Campaign Builder (4 steps): Emails -> Audience -> Sending -> Review.
   Content first: the sequence is written before anything else. The first email is always shown; follow-ups
   appear only when "Add follow-up" is pressed. Everything is autosaved as a draft (server: /api/drafts) so a
   closed tab, a crash or a sleeping laptop never loses work. Routes: #/campaign/new[/<projectId>], #/campaign/draft/<id>. */
(function () {
  'use strict';
  var h = SB.h, ui = SB.ui, fmt = SB.fmt, W = SB.S.wizard;
  SB.screens = SB.screens || {};

  var MAX_FOLLOWUPS = 5, MAX_DELAY = 60, PRESETS = [2, 3, 5, 7, 14, 30];
  var FIELDS = [['First name', '{{first_name|there}}'], ['Last name', '{{last_name}}'], ['Company', '{{company|your company}}'], ['Domain', '{{domain}}'], ['Email', '{{email}}'], ['Spintax {a|b}', '{Hi|Hello}']];
  var STEP_NAMES = ['Emails', 'Audience', 'Sending', 'Review'];
  var STATUSES = ['valid', 'unverified', 'risky', 'catch_all'];

  function blankState() {
    return { step: 0, name: '', steps: [{ subject: '', body_html: '', delay_days: null }], sender_ids: [], folder_id: null, exclude_role: false,
      lead_statuses: STATUSES.slice(), split: { enabled: false, batch_size: 26, seed: null },
      settings: { window_start_hour: 9, window_end_hour: 17, utc_offset_min: -new Date().getTimezoneOffset(), weekdays_only: true, stop_on_reply: true, track_opens: false } };
  }
  function merge(base, d) {            // draft data -> full state (draft fields may be null)
    var s = base; d = d || {};
    s.step = d.step || 0; s.name = d.name || '';
    if (d.steps && d.steps.length) s.steps = d.steps.map(function (x, i) { return { subject: x.subject || '', body_html: x.body_html || '', delay_days: i === 0 ? null : x.delay_days }; });
    s.sender_ids = d.sender_ids || []; s.folder_id = d.folder_id || null; s.exclude_role = !!d.exclude_role;
    if (d.lead_statuses && d.lead_statuses.length) s.lead_statuses = d.lead_statuses;
    if (d.split) { s.split.enabled = !!d.split.enabled; if (d.split.batch_size) s.split.batch_size = d.split.batch_size; s.split.seed = d.split.seed; }
    if (d.settings) Object.keys(s.settings).forEach(function (k) { if (d.settings[k] !== null && d.settings[k] !== undefined) s.settings[k] = d.settings[k]; });
    return s;
  }
  function labelFor(i) { return i === 0 ? 'First email' : 'Follow-up ' + i; }
  function hasContent(s) { return !!(s.name || s.steps.some(function (x) { return x.subject || x.body_html; }) || s.folder_id || s.sender_ids.length); }
  function el(tag, cls, text) { return h(tag, { class: cls, text: text }); }

  SB.screens.wizard = function (params) {
    var st = blankState(), draft = null /* { id, rev } */, root = h('div'), body = h('div'), stepsEl = h('div', { class: 'wz-steps' });
    var dead = false, dirty = false, saving = false, saveTimer = null, conflict = false, lastSaved = null, saveEl = h('span', { class: 'wz-save', role: 'status' });
    var editId = params.editId || null, userEmail = params.userEmail || '', folders = [], senders = [], projects = [], projectId = params.projectId || null, activeIdx = 0, editors = [], launching = false;
    var previewTimer = null, previewBox = null, coverageBox = null, splitBox = null, countBox = null, previewSeq = 0, audSeq = 0;

    // ---------- autosave ----------
    function paintSave() {
      var t = conflict ? W.conflict : saving ? W.saving : dirty ? W.unsaved : lastSaved ? W.saved + ' ' + new Date(lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      saveEl.textContent = t; saveEl.className = 'wz-save' + (conflict ? ' bad' : dirty ? ' dirty' : '');
    }
    function payload() { return { name: st.name, step: st.step, steps: st.steps, sender_ids: st.sender_ids, folder_id: st.folder_id, exclude_role: st.exclude_role, lead_statuses: st.lead_statuses, split: st.split, settings: st.settings }; }
    function saveNow() {
      clearTimeout(saveTimer);
      if (editId || saving || conflict || !dirty || !hasContent(st)) return Promise.resolve();
      saving = true; paintSave();
      var snapshot = JSON.stringify(payload()), p;
      if (!draft) p = SB.api.post('/api/drafts', { project_id: projectId ? Number(projectId) : null, data: payload() });
      else p = SB.api.put('/api/drafts/' + draft.id, { rev: draft.rev, data: payload() });
      return p.then(function (r) {
        draft = { id: r.draft.id, rev: r.draft.rev }; lastSaved = Date.now();
        if (JSON.stringify(payload()) === snapshot) dirty = false;
        if (!dead && /^#\/campaign\/new/.test(location.hash)) history.replaceState(null, '', '#/campaign/draft/' + draft.id);     // reload resumes this draft
      }, function (e) {
        if (e.status === 409 && e.code === 'conflict' && draft) conflict = true;
        else if (e.code !== 'offline') ui.toast(SB.api.friendly(e), true);
      }).then(function () { saving = false; paintSave(); if (dirty && !conflict && !dead) schedule(); });
    }
    function schedule() { if (editId) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200); }
    function touch() { dirty = true; paintSave(); schedule(); }
    function onBeforeUnload(e) { if (dirty && hasContent(st)) { e.preventDefault(); e.returnValue = ''; return ''; } }
    window.addEventListener('beforeunload', onBeforeUnload);

    // ---------- header / stepper ----------
    function paintSteps() {
      SB.clear(stepsEl);
      STEP_NAMES.forEach(function (n, i) {
        stepsEl.appendChild(h('button', { type: 'button', class: 'wz-step' + (i === st.step ? ' on' : '') + (i < st.step ? ' done' : ''), 'aria-current': i === st.step ? 'step' : null,
          on: { click: function () { go(i); } } }, h('span', { class: 'n' }, i < st.step ? SB.icon('check') : String(i + 1)), n));
      });
    }
    function go(i) { st.step = i; touch(); render(); window.scrollTo(0, 0); }
    function head() {
      var name = h('input', { class: 'input wz-name', id: 'wz-name', maxlength: 120, placeholder: W.namePlaceholder, value: st.name, 'aria-label': 'Campaign name' });
      name.addEventListener('input', function () { st.name = name.value; touch(); });
      return h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), editId ? ' / Edit campaign' : ' / New campaign'),
        h('div', { class: 'page-head' }, h('div', { class: 'wz-title' }, name, saveEl),
          editId ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-ghost', href: '#/project/' + projectId, id: 'wz-cancel-edit' }, 'Cancel')) : h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', tip: W.saveTip, on: { click: function () { saveNow().then(function () { if (!conflict && !dirty) ui.toast(W.draftSaved); }); } } }, 'Save draft'),
            h('button', { class: 'btn btn-ghost', type: 'button', tip: W.discardTip, on: { click: discard } }, 'Discard'))),
        conflict ? h('div', { class: 'form-error' }, W.conflictLong, ' ', h('button', { class: 'btn btn-sm', type: 'button', on: { click: function () { location.reload(); } } }, 'Reload latest')) : null,
        stepsEl);
    }
    function discard() {
      ui.confirm({ title: 'Discard this draft?', message: draft ? 'The draft is deleted permanently.' : 'Nothing has been saved yet, so nothing is kept.', confirmLabel: 'Discard', danger: true, onConfirm: function () {
        dirty = false; clearTimeout(saveTimer);
        return (draft ? SB.api.del('/api/drafts/' + draft.id) : Promise.resolve()).then(function () { draft = null; location.hash = projectId ? '#/project/' + projectId : '#/'; });
      } });
    }

    // ---------- send me a test email ----------
    function testDialog(i) {
      var active = senders.filter(function (x) { return x.status === 'active'; });
      if (!active.length) { ui.toast(W.testNoSender, true); return; }
      var s = st.steps[i], prev = i > 0 ? st.steps[i - 1].subject : '';
      var pick = h('select', { class: 'input', id: 'wz-test-sender', 'aria-label': 'Send from' }, active.map(function (x) { return h('option', { value: x.id }, (x.label || x.email) + (x.label && x.label !== x.email ? ' (' + x.email + ')' : '')); }));
      var pre = st.sender_ids.filter(function (id) { return active.some(function (x) { return x.id === id; }); })[0]; if (pre) pick.value = String(pre);
      var to = h('input', { class: 'input', id: 'wz-test-to', type: 'email', maxlength: 254, value: userEmail, 'aria-label': 'Send test to' });
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      ui.modal({ title: 'Send me a test email', body: h('div', null, err,
        h('p', { class: 'muted', text: W.testIntro }),
        h('div', { class: 'field' }, h('label', { for: 'wz-test-sender' }, 'Send from'), pick),
        h('div', { class: 'field' }, h('label', { for: 'wz-test-to' }, 'Send to'), to, h('div', { class: 'hint', text: W.testToHint }))),
        actions: [{ label: 'Cancel' }, { label: 'Send test', kind: 'primary', onClick: function (close) {
          err.classList.add('hidden');
          return SB.api.post('/api/campaigns/test-send', { sender_id: Number(pick.value), to: to.value.trim(), subject: s.subject, previous_subject: prev, body_html: s.body_html }).then(function (r) {
            close();
            ui.toast('Test sent to ' + r.to + '. It can take a minute to arrive; check spam too.');
            if (r.missing && r.missing.length) ui.toast('Fields without a value in the example data: ' + r.missing.join(', ') + '.', true);
          }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
        } }] });
    }

    // ---------- step 1: emails ----------
    function delayRow(i) {
      var s = st.steps[i], msg = h('div', { class: 'hint', role: 'status' });
      var inp = h('input', { class: 'input wz-days', id: 'wz-delay-' + i, type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 3, 'aria-label': 'Days to wait', value: s.delay_days === null ? '' : String(s.delay_days) });
      function paint() {
        var n = s.delay_days, total = 0, k;
        for (k = 1; k <= i; k++) total += st.steps[k].delay_days || 0;
        msg.className = 'hint'; msg.textContent = '';
        if (n === null) { msg.textContent = W.delayEmpty; msg.className = 'hint warn'; }
        else if (n < 1 || n > MAX_DELAY) { msg.textContent = W.delayRange; msg.className = 'hint bad'; }
        else msg.textContent = 'Sent ' + n + ' day' + (n === 1 ? '' : 's') + ' after the previous email (day ' + total + ' of the sequence). It is skipped if they reply.';
        Array.prototype.forEach.call(chips.childNodes, function (c) { c.classList.toggle('on', Number(c.getAttribute('data-n')) === n); });
      }
      inp.addEventListener('input', function () {
        var digits = inp.value.replace(/\D/g, '').slice(0, 3); if (digits !== inp.value) inp.value = digits;      // type any whole number
        s.delay_days = digits === '' ? null : parseInt(digits, 10); paint(); touch();
      });
      var chips = h('div', { class: 'wz-chips', 'aria-label': 'Common waits' }, PRESETS.map(function (n) {
        return h('button', { type: 'button', class: 'chip', 'data-n': n, on: { click: function () { s.delay_days = n; inp.value = String(n); paint(); touch(); } } }, n + 'd');
      }));
      paint();
      return h('div', { class: 'wz-delay' }, h('label', { for: 'wz-delay-' + i }, 'Wait'), inp, h('span', null, 'days, then send'), chips, ui.info(W.delayTip), msg);
    }
    function emailCard(i) {
      var s = st.steps[i];
      var subj = h('input', { class: 'input', id: 'wz-subj-' + i, maxlength: 200, value: s.subject, placeholder: i === 0 ? W.subjectPlaceholder : W.followSubjectPlaceholder, 'aria-label': labelFor(i) + ' subject' });
      subj.addEventListener('input', function () { s.subject = subj.value.replace(/[\r\n]+/g, ' '); touch(); queuePreview(); });
      subj.addEventListener('focus', function () { setActive(i); });
      var ed = SB.editor.create({ value: s.body_html, placeholder: i === 0 ? W.bodyPlaceholder : W.followBodyPlaceholder, label: labelFor(i) + ' text', variables: FIELDS,
        onChange: function (html) { s.body_html = html; touch(); queuePreview(); } });
      ed.area.addEventListener('focus', function () { setActive(i); });
      editors[i] = ed;
      var card = h('div', { class: 'card wz-email' + (i === activeIdx ? ' active' : ''), 'data-idx': i },
        h('div', { class: 'wz-email-head' }, h('h3', { text: labelFor(i) }),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-sm', type: 'button', id: 'wz-test-' + i, tip: W.testTip, on: { click: function () { testDialog(i); } } }, SB.icon('send'), 'Send test'),
            i > 0 ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', tip: 'Remove this follow-up', on: { click: function () { removeFollowUp(i); } } }, SB.icon('trash'), 'Remove') : null)),
        i > 0 ? delayRow(i) : null,
        h('div', { class: 'field' }, h('label', { for: 'wz-subj-' + i }, 'Subject'), subj,
          i > 0 ? h('div', { class: 'hint', text: W.followSubjectHint }) : h('div', { class: 'hint', text: W.subjectHint })),
        h('div', { class: 'field' }, h('label', { text: 'Message' }), ed.el));
      return card;
    }
    function setActive(i) {
      if (activeIdx === i) return; activeIdx = i;
      Array.prototype.forEach.call(body.querySelectorAll('.wz-email'), function (c) { c.classList.toggle('active', Number(c.getAttribute('data-idx')) === i); });
      queuePreview();
    }
    function removeFollowUp(i) {
      var s = st.steps[i], empty = !s.subject && !s.body_html;
      function doIt() { st.steps.splice(i, 1); activeIdx = Math.min(activeIdx, st.steps.length - 1); touch(); render(); }
      if (empty) doIt(); else ui.confirm({ title: 'Remove ' + labelFor(i).toLowerCase() + '?', message: 'Its subject and text are deleted. Later follow-ups move up.', confirmLabel: 'Remove', danger: true, onConfirm: function () { doIt(); } });
    }
    function queuePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(paintPreview, 450); }
    function paintPreview() {
      if (!previewBox || dead) return;
      var s = st.steps[activeIdx] || st.steps[0], mine = ++previewSeq;
      var prevSubject = activeIdx > 0 ? (st.steps[activeIdx - 1].subject || '') : '';
      var subject = s.subject || (activeIdx > 0 ? 'Re: ' + prevSubject.replace(/^(re:\s*)+/i, '') : '');
      if (!s.body_html && !subject) { SB.mount(previewBox, h('p', { class: 'muted', text: W.previewEmpty })); return; }
      SB.api.post('/api/templates/preview', { subject: s.subject ? s.subject : subject, body_html: s.body_html }).then(function (r) {
        if (mine !== previewSeq || dead) return;
        var rendered = SB.editor.render(r.body_html), bodyDiv = h('div', { class: 'wz-mail-body' });
        bodyDiv.appendChild(rendered);
        SB.mount(previewBox, h('div', null, h('div', { class: 'wz-mail-subject' }, h('span', { class: 'faint', text: 'Subject  ' }), r.subject || '(no subject)'), bodyDiv,
          r.variables.length ? h('div', { class: 'hint pad-t', text: 'Fields used: ' + r.variables.join(', ') + '. Filled with an example person here.' }) : null));
      }, function () {});
    }
    function stepEmails() {
      editors = [];
      var cards = st.steps.map(function (s, i) { return emailCard(i); });
      var add = st.steps.length - 1 < MAX_FOLLOWUPS
        ? h('button', { class: 'btn wz-add', type: 'button', id: 'wz-add-followup', tip: W.addTip, on: { click: function () {
          st.steps.push({ subject: '', body_html: '', delay_days: 3 }); activeIdx = st.steps.length - 1; touch(); render();
          var f = body.querySelector('#wz-subj-' + activeIdx); if (f) f.focus();
        } } }, SB.icon('plus'), 'Add follow-up')
        : h('p', { class: 'hint', text: 'That is the maximum: the first email plus ' + MAX_FOLLOWUPS + ' follow-ups.' });
      previewBox = h('div', { class: 'wz-preview-body' });
      var side = h('aside', { class: 'wz-side' }, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h3', { text: 'Preview' }), ui.info(W.previewTip)), previewBox,
        h('p', { class: 'small muted pad-t', text: 'Shows the email you are editing.' })));
      paintPreview();
      return h('div', { class: 'wz-grid' }, h('div', null, cards, add, h('p', { class: 'hint pad-t', text: W.fieldsHelp })), side);
    }

    // ---------- step 2: audience ----------
    function leadSource() {
      var o = { folder_id: st.folder_id, exclude_role: st.exclude_role, lead_statuses: st.lead_statuses };
      return o;
    }
    function refreshAudience() {
      if (!countBox || dead) return; var mine = ++audSeq;
      if (!st.folder_id || !st.lead_statuses.length) { SB.mount(countBox, h('p', { class: 'muted', text: st.folder_id ? 'Choose at least one address type.' : W.pickFolder })); SB.clear(coverageBox); return; }
      SB.mount(countBox, h('div', { class: 'skeleton' }));
      var src = leadSource();
      Promise.all([SB.api.post('/api/campaigns/split-preview', Object.assign({ batch_size: 1000000 }, src)), SB.api.post('/api/campaigns/variable-coverage', Object.assign({ steps: st.steps }, src))]).then(function (r) {
        if (mine !== audSeq || dead) return;
        SB.mount(countBox, h('div', { class: 'wz-count' }, h('b', { text: fmt.num(r[0].total) }), ' people will be emailed ', ui.info(W.eligibleTip)));
        var cov = r[1], vars = cov.variables.filter(function (v) { return v.missing > 0; });
        SB.mount(coverageBox, vars.length
          ? h('div', { class: 'callout warn' }, h('b', { text: fmt.num(cov.leads_affected) + ' of these people are missing information used in your emails.' }),
            h('ul', null, vars.map(function (v) { return h('li', { text: '{{' + v.name + '}} is empty for ' + fmt.num(v.missing) + ' ' + (v.missing === 1 ? 'person' : 'people') }); })),
            h('p', { class: 'small', text: W.coverageHelp }))
          : (cov.variables.length ? h('p', { class: 'hint ok', text: 'Every person has a value for every field you use.' }) : null));
      }, function (e) {
        if (mine !== audSeq || dead) return;
        SB.mount(countBox, h('div', { class: e.status === 400 ? 'callout warn' : 'form-error', text: e.status === 400 ? e.message : SB.api.friendly(e) })); SB.clear(coverageBox);
      });
    }
    function stepAudience() {
      if (editId) return h('div', { class: 'wz-narrow' }, h('div', { class: 'card' }, h('h2', { text: 'Audience' }), h('p', { class: 'muted', text: 'The people in a campaign are fixed once it is created, so the sequence you send stays consistent. To email different people, create a new campaign.' })));
      var sel = h('select', { class: 'input', id: 'wz-folder', 'aria-label': 'Lead folder' }, h('option', { value: '' }, 'Choose a folder…'),
        folders.map(function (f) { return h('option', { value: f.id }, f.name + ' (' + fmt.num(f.lead_count) + ')'); }));
      sel.value = st.folder_id ? String(st.folder_id) : '';
      sel.addEventListener('change', function () { st.folder_id = sel.value ? Number(sel.value) : null; st.split.seed = null; touch(); refreshAudience(); });
      var checks = STATUSES.map(function (k) {
        var cb = h('input', { type: 'checkbox', id: 'wz-st-' + k }); cb.checked = st.lead_statuses.indexOf(k) !== -1;
        cb.addEventListener('change', function () { st.lead_statuses = STATUSES.filter(function (x) { return x === k ? cb.checked : st.lead_statuses.indexOf(x) !== -1; }); touch(); refreshAudience(); });
        var info = SB.S.leads.status[k];
        return h('div', { class: 'field check' }, cb, h('label', { for: 'wz-st-' + k }, info.label), h('div', { class: 'hint', text: info.tip }));
      });
      var role = h('input', { type: 'checkbox', id: 'wz-role' }); role.checked = st.exclude_role;
      role.addEventListener('change', function () { st.exclude_role = role.checked; touch(); refreshAudience(); });
      countBox = h('div'); coverageBox = h('div');
      var node = h('div', { class: 'card wz-narrow' }, h('h2', { text: 'Who should receive this?' }),
        folders.length ? null : h('div', { class: 'callout warn' }, 'You have no lead folders yet. ', h('a', { href: '#/leads' }, 'Add leads first'), ' - your draft is saved and waiting.'),
        h('div', { class: 'field' }, h('label', { for: 'wz-folder' }, 'Lead folder'), sel, h('div', { class: 'hint', text: W.folderHint })),
        h('div', { class: 'field' }, h('label', { text: 'Include addresses that are' }), checks),
        h('div', { class: 'field check' }, role, h('label', { for: 'wz-role' }, 'Skip role addresses (info@, sales@, support@…)'), h('div', { class: 'hint', text: W.roleHint })),
        h('div', { class: 'wz-result' }, countBox, coverageBox),
        h('p', { class: 'hint', text: W.audienceAuto }));
      refreshAudience();
      return node;
    }

    // ---------- step 3: sending ----------
    function refreshSplit() {
      if (!splitBox || dead) return;
      if (!st.split.enabled) { SB.clear(splitBox); return; }
      if (!st.folder_id) { SB.mount(splitBox, h('p', { class: 'hint warn', text: W.pickFolder })); return; }
      var n = st.split.batch_size;
      if (!n || n < 1) { SB.mount(splitBox, h('p', { class: 'hint bad', text: 'Enter a whole number of 1 or more.' })); return; }
      var mine = ++audSeq;
      SB.api.post('/api/campaigns/split-preview', Object.assign({ batch_size: n, seed: st.split.seed }, leadSource())).then(function (r) {
        if (mine !== audSeq || dead) return;
        if (st.split.seed === null) st.split.seed = r.seed;
        var sizes = r.sizes, shown = sizes.length > 8 ? sizes.slice(0, 7).join(' / ') + ' / … / ' + sizes[sizes.length - 1] : sizes.join(' / ');
        SB.mount(splitBox, h('div', null, h('div', { class: 'wz-sizes' }, h('b', { text: sizes.length + ' batch' + (sizes.length === 1 ? '' : 'es') + ': ' }), shown),
          r.same_company_in_one_batch ? h('p', { class: 'hint warn', text: r.same_company_in_one_batch + ' company contact(s) still share a batch. Shuffle again or use a smaller batch size.' }) : h('p', { class: 'hint ok', text: 'People from the same company are spread across different batches.' })));
      }, function (e) { if (mine === audSeq) SB.mount(splitBox, h('div', { class: 'callout warn', text: e.message })); });
    }
    function stepSending() {
      var list = senders.length ? senders.map(function (s) {
        var cb = h('input', { type: 'checkbox', id: 'wz-sd-' + s.id }); cb.checked = st.sender_ids.indexOf(s.id) !== -1;
        var ok = s.status === 'active';
        cb.addEventListener('change', function () { st.sender_ids = senders.map(function (x) { return x.id; }).filter(function (id) { return id === s.id ? cb.checked : st.sender_ids.indexOf(id) !== -1; }); touch(); paintCap(); });
        return h('div', { class: 'field check' }, cb, h('label', { for: 'wz-sd-' + s.id }, (s.label || s.email) + ' ', s.label && s.label !== s.email ? h('span', { class: 'faint', text: s.email }) : null),
          h('div', { class: 'hint', text: ok ? 'Can send ' + fmt.num(s.limit_today) + ' per day right now' + (s.warmup_enabled ? ' (warming up)' : '') : 'Not active (' + (SB.S.status[s.status] ? SB.S.status[s.status].label : s.status) + ') - it will not send until fixed' }));
      }) : [h('div', { class: 'callout warn' }, 'No sender accounts yet. ', h('a', { href: '#/senders' }, 'Add a sender'), ' - your draft is saved and waiting.')];
      var capBox = h('p', { class: 'hint' });
      function paintCap() {
        var cap = 0; senders.forEach(function (s) { if (st.sender_ids.indexOf(s.id) !== -1 && s.status === 'active') cap += s.limit_today; });
        capBox.textContent = st.sender_ids.length ? 'Together they can send up to ' + fmt.num(cap) + ' emails per day.' : 'Choose at least one account.';
      }
      var ss = st.settings;
      function hourSel(id, val, from, to, onPick) {
        var s = h('select', { class: 'input', id: id }, (function () { var a = []; for (var x = from; x <= to; x++) a.push(h('option', { value: x }, (x % 24 < 10 ? '0' : '') + (x % 24) + ':00')); return a; })());
        s.value = String(val); s.addEventListener('change', function () { onPick(Number(s.value)); touch(); }); return s;
      }
      var tz = h('select', { class: 'input', id: 'wz-tz' }, (function () {
        var a = [], seen = {}; for (var m = -720; m <= 840; m += 30) a.push(m);
        if (a.indexOf(ss.utc_offset_min) === -1) a.push(ss.utc_offset_min);
        return a.sort(function (x, y) { return x - y; }).map(function (m) { var ab = Math.abs(m); return h('option', { value: m }, 'UTC' + (m < 0 ? '-' : '+') + (ab / 60 | 0) + (ab % 60 ? ':30' : '') + (m === -new Date().getTimezoneOffset() ? '  (this device)' : '')); });
      })());
      tz.value = String(ss.utc_offset_min); tz.addEventListener('change', function () { ss.utc_offset_min = Number(tz.value); touch(); });
      function toggle(id, key, label, hint) {
        var cb = h('input', { type: 'checkbox', id: id }); cb.checked = !!ss[key]; cb.addEventListener('change', function () { ss[key] = cb.checked; touch(); });
        return h('div', { class: 'field check' }, cb, h('label', { for: id }, label), h('div', { class: 'hint', text: hint }));
      }
      var split = st.split, batch = h('input', { class: 'input wz-days', id: 'wz-batch', type: 'text', inputmode: 'numeric', maxlength: 6, value: String(split.batch_size || ''), 'aria-label': 'Batch size' });
      batch.addEventListener('input', function () { var d = batch.value.replace(/\D/g, '').slice(0, 6); if (d !== batch.value) batch.value = d; split.batch_size = d ? parseInt(d, 10) : null; split.seed = null; touch(); refreshSplit(); });
      var useSplit = h('input', { type: 'checkbox', id: 'wz-split' }); useSplit.checked = split.enabled;
      var splitCtl = h('div', { class: 'wz-split-ctl' }, h('label', { for: 'wz-batch' }, 'People per batch'), batch,
        h('button', { class: 'btn btn-sm', type: 'button', id: 'wz-shuffle', tip: W.shuffleTip, on: { click: function () { split.seed = Math.floor(Math.random() * 4294967295); touch(); refreshSplit(); } } }, 'Shuffle'));
      function paintSplitCtl() { splitCtl.classList.toggle('hidden', !split.enabled); }
      useSplit.addEventListener('change', function () { split.enabled = useSplit.checked; touch(); paintSplitCtl(); refreshSplit(); });
      splitBox = h('div'); paintSplitCtl(); paintCap(); refreshSplit();
      return h('div', { class: 'wz-narrow' },
        h('div', { class: 'card' }, h('h2', { text: 'Send from' }), h('div', { class: 'field' }, list), capBox, h('p', { class: 'hint', text: W.sendersHint })),
        h('div', { class: 'card' }, h('h2', { text: 'When to send' }),
          h('div', { class: 'wz-row' }, h('div', { class: 'field' }, h('label', { for: 'wz-ws' }, 'From'), hourSel('wz-ws', ss.window_start_hour, 0, 23, function (x) { ss.window_start_hour = x; })),
            h('div', { class: 'field' }, h('label', { for: 'wz-we' }, 'Until'), hourSel('wz-we', ss.window_end_hour, 1, 24, function (x) { ss.window_end_hour = x; })),
            h('div', { class: 'field' }, h('label', { for: 'wz-tz' }, 'Time zone'), tz)),
          toggle('wz-wd', 'weekdays_only', 'Weekdays only', W.weekdaysHint), toggle('wz-sr', 'stop_on_reply', 'Stop the sequence when someone replies', W.stopHint), toggle('wz-to', 'track_opens', 'Track opens (approximate)', W.opensHint)),
        h('div', { class: 'card' }, h('h2', null, 'Smart Split ', ui.info(W.splitTip)),
          h('div', { class: 'field check' }, useSplit, h('label', { for: 'wz-split' }, 'Split into smaller batches'), h('div', { class: 'hint', text: W.splitHint })), splitCtl, splitBox));
    }

    // ---------- step 4: review ----------
    function problems() {
      var p = [];
      if (!st.name.trim()) p.push({ s: 3, t: 'Give the campaign a name (top of the page).' });
      st.steps.forEach(function (s, i) {
        var empty = !(s.body_html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (i === 0 && !s.subject.trim()) p.push({ s: 0, t: 'The first email needs a subject.' });
        if (empty) p.push({ s: 0, t: labelFor(i) + ' has no text.' });
        if (i > 0 && (s.delay_days === null || s.delay_days < 1 || s.delay_days > MAX_DELAY)) p.push({ s: 0, t: labelFor(i) + ': wait must be 1 to ' + MAX_DELAY + ' days.' });
      });
      if (!st.folder_id) p.push({ s: 1, t: 'Choose a lead folder.' });
      if (!st.lead_statuses.length) p.push({ s: 1, t: 'Choose at least one address type.' });
      if (!st.sender_ids.length) p.push({ s: 2, t: 'Choose at least one sender account.' });
      if (st.settings.window_end_hour <= st.settings.window_start_hour) p.push({ s: 2, t: 'The sending window must end after it starts.' });
      if (st.split.enabled && !st.split.batch_size) p.push({ s: 2, t: 'Enter a batch size.' });
      return editId ? p.filter(function (x) { return x.s !== 1; }) : p;
    }
    function stepReview() {
      var probs = problems(), out = h('div', { class: 'wz-narrow' });
      var folder = folders.filter(function (f) { return f.id === st.folder_id; })[0];
      var chosen = senders.filter(function (s) { return st.sender_ids.indexOf(s.id) !== -1; });
      var totalDays = 0; st.steps.forEach(function (s, i) { if (i) totalDays += s.delay_days || 0; });
      var projSel = h('select', { class: 'input', id: 'wz-project', 'aria-label': 'Project' }, projectId ? null : h('option', { value: '' }, 'New project named after this campaign'),
        projects.map(function (p) { return h('option', { value: p.id }, p.name); }));
      projSel.value = projectId ? String(projectId) : '';
      projSel.addEventListener('change', function () { projectId = projSel.value || null; });
      function row(k, v) { return h('div', { class: 'wz-sum-row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)); }
      out.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Review' }),
        probs.length ? h('div', { class: 'callout warn' }, h('b', { text: 'Fix these before launching:' }), h('ul', null, probs.map(function (p) { return h('li', null, p.t + ' ', h('a', { href: '#', on: { click: function (e) { e.preventDefault(); go(p.s); } } }, 'Go there')); }))) : h('p', { class: 'hint ok', text: 'Everything is filled in. Nothing is sent until you press Start.' }),
        row('Campaign', st.name || '-'), row('Emails', st.steps.length + ' (first email' + (st.steps.length > 1 ? ' + ' + (st.steps.length - 1) + ' follow-up' + (st.steps.length > 2 ? 's' : '') : '') + ')' + (totalDays ? ', over ' + totalDays + ' days' : '')),
        editId ? null : row('Audience', folder ? folder.name : '-'), row('Senders', chosen.length ? chosen.map(function (s) { return s.label || s.email; }).join(', ') : '-'),
        row('Window', pad(st.settings.window_start_hour) + ':00 to ' + pad(st.settings.window_end_hour % 24) + ':00, ' + (st.settings.weekdays_only ? 'weekdays' : 'every day')),
        editId ? null : row('Smart Split', st.split.enabled ? 'Batches of ' + st.split.batch_size : 'Off'),
        editId ? null : h('div', { class: 'field pad-t' }, h('label', { for: 'wz-project' }, 'Add to project'), projSel)));
      out.appendChild(h('div', { class: 'actions wz-final' },
        h('button', { class: 'btn', type: 'button', id: 'wz-test-review', tip: W.testTip, on: { click: function () { testDialog(0); } } }, SB.icon('send'), 'Send me a test'),
        editId ? h('button', { class: 'btn btn-primary', type: 'button', id: 'wz-save-edit', disabled: probs.length ? true : null, on: { click: function () { launch(false); } } }, 'Save changes') : null,
        editId ? null : h('button', { class: 'btn', type: 'button', id: 'wz-create', disabled: probs.length ? true : null, tip: W.createTip, on: { click: function () { launch(false); } } }, 'Create campaign'),
        editId ? null : h('button', { class: 'btn btn-primary', type: 'button', id: 'wz-start', disabled: probs.length ? true : null, tip: W.startTip, on: { click: function () { launch(true); } } }, SB.icon('play'), 'Create and start')));
      return out;
    }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function launch(start) {
      if (launching || problems().length) return; launching = true;
      var body = { name: st.name.trim(), steps: st.steps.map(function (s, i) { return { subject: s.subject, body_html: s.body_html, delay_days: i === 0 ? undefined : s.delay_days }; }), sender_ids: st.sender_ids,
        folder_id: st.folder_id, exclude_role: st.exclude_role, lead_statuses: st.lead_statuses, settings: st.settings };
      body.window_start_hour = st.settings.window_start_hour; body.window_end_hour = st.settings.window_end_hour; body.utc_offset_min = st.settings.utc_offset_min;
      body.weekdays_only = st.settings.weekdays_only; body.stop_on_reply = st.settings.stop_on_reply; body.track_opens = st.settings.track_opens;
      if (st.split.enabled) body.split = { batch_size: st.split.batch_size, seed: st.split.seed === null ? undefined : st.split.seed };
      if (editId) {
        delete body.folder_id; delete body.exclude_role; delete body.lead_statuses; delete body.split;
        SB.api.patch('/api/campaigns/' + editId, body).then(function () { dirty = false; ui.toast('Changes saved'); location.hash = '#/project/' + projectId; }, function (e) { launching = false; ui.toast(SB.api.friendly(e), true); });
        return;
      }
      if (projectId) body.project_id = Number(projectId);
      clearTimeout(saveTimer);
      SB.api.post('/api/campaigns', body).then(function (r) {
        var c = r.campaign, after = start ? SB.api.post('/api/campaigns/' + c.id + '/start').then(function (s) { (s.campaign.warnings || []).forEach(function (w) { ui.toast(w.message, true); }); }) : Promise.resolve();
        return after.then(function () {
          dirty = false; var del = draft ? SB.api.del('/api/drafts/' + draft.id).catch(function () {}) : Promise.resolve();
          return del.then(function () { ui.toast(start ? 'Campaign started' : 'Campaign created. Start it when you are ready.'); location.hash = '#/project/' + c.project_id; });
        });
      }).catch(function (e) {
        launching = false; ui.toast(SB.api.friendly(e), true);
        if (e.details) { var first = Object.keys(e.details)[0]; if (first === 'steps') go(0); else if (first === 'folder_id') go(1); else if (first === 'sender_ids') go(2); }
      });
    }

    // ---------- shell ----------
    function render() {
      paintSteps(); paintSave();
      var content = st.step === 0 ? stepEmails() : st.step === 1 ? stepAudience() : st.step === 2 ? stepSending() : stepReview();
      var nav = h('div', { class: 'wz-nav' },
        st.step > 0 ? h('button', { class: 'btn', type: 'button', on: { click: function () { go(st.step - 1); } } }, SB.icon('back'), 'Back') : h('span'),
        st.step < 3 ? h('button', { class: 'btn btn-primary', type: 'button', id: 'wz-next', on: { click: function () { go(st.step + 1); } } }, 'Next: ' + STEP_NAMES[st.step + 1], SB.icon('chevron')) : h('span'));
      SB.mount(body, h('div', null, content, nav));
      var headNode = head(); SB.clear(root); root.appendChild(headNode); root.appendChild(body);
    }

    // ---------- boot ----------
    function boot() {
      SB.mount(root, h('div', { class: 'skeleton' }));
      var reqs = [SB.api.get('/api/folders'), SB.api.get('/api/senders'), SB.api.get('/api/projects')];
      if (params.draftId) reqs.push(SB.api.get('/api/drafts/' + params.draftId));
      if (editId) reqs.push(SB.api.get('/api/campaigns/' + editId));
      Promise.all(reqs).then(function (r) {
        if (dead) return;
        folders = r[0].items; senders = r[1].items; projects = r[2].items.filter(function (p) { return !p.archived; });
        if (r[3] && !editId) { draft = { id: r[3].draft.id, rev: r[3].draft.rev }; st = merge(blankState(), r[3].draft.data); st.name = st.name || r[3].draft.name; if (r[3].draft.project_id) projectId = String(r[3].draft.project_id); lastSaved = r[3].draft.updated_at; }
        else if (editId && r[3]) {
          var cc = r[3].campaign;
          if (cc.status !== 'draft' || cc.parent_id) { SB.mount(root, h('div', { class: 'card empty' }, h('h2', { text: 'This campaign can no longer be edited' }), h('p', { text: 'Only campaigns that have not been started can be edited.' }), h('a', { class: 'btn', href: '#/' }, 'Back to Home'))); return; }
          st = blankState(); st.name = cc.name; projectId = String(cc.project_id);
          st.steps = cc.steps.map(function (x, i) { return { subject: x.subject || '', body_html: x.body_html || '', delay_days: i === 0 ? null : x.delay_days }; });
          st.sender_ids = cc.senders.map(function (x) { return x.id; });
          Object.keys(st.settings).forEach(function (k) { if (cc.settings[k] !== undefined && cc.settings[k] !== null) st.settings[k] = k === 'weekdays_only' || k === 'stop_on_reply' || k === 'track_opens' ? !!cc.settings[k] : cc.settings[k]; });
          dirty = false;
        }
        else if (!projectId && projects.length === 1) { /* keep "new project" as default */ }
        if (st.folder_id && !folders.some(function (f) { return f.id === st.folder_id; })) st.folder_id = null;
        st.sender_ids = st.sender_ids.filter(function (id) { return senders.some(function (s) { return s.id === id; }); });
        render();
      }, function (e) {
        if (dead) return;
        SB.mount(root, h('div', { class: 'card empty' }, h('h2', { text: e.status === 404 ? 'Draft not found' : 'Cannot open the builder' }), h('p', { text: e.status === 404 ? 'It may have been discarded or used already.' : SB.api.friendly(e) }), h('a', { class: 'btn', href: '#/' }, 'Back to Home')));
      });
    }
    boot();
    return { el: root, destroy: function () {
      dead = true; window.removeEventListener('beforeunload', onBeforeUnload); clearTimeout(previewTimer); clearTimeout(saveTimer);
      if (dirty && hasContent(st) && !conflict && !launching) saveNow();      // flush unsent edits when leaving the page
    } };
  };

  // Draft list used by Home
  SB.screens.draftList = function (drafts, reload) {
    return h('div', { class: 'project-grid' }, drafts.map(function (d) {
      return h('div', { class: 'card project-card' }, h('a', { class: 'top draft-link', href: '#/campaign/draft/' + d.id }, h('h3', { text: d.name || 'Untitled campaign' }), ui.statusPill('draft')),
        h('div', { class: 'small faint', text: d.steps_count + ' email' + (d.steps_count === 1 ? '' : 's') + ' · edited ' + fmt.ago(d.updated_at) }),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm btn-primary', href: '#/campaign/draft/' + d.id }, 'Continue'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': 'Delete draft', tip: 'Delete this draft', on: { click: function () {
            ui.confirm({ title: 'Delete draft?', message: 'This draft is removed permanently.', confirmLabel: 'Delete', danger: true, onConfirm: function () { return SB.api.del('/api/drafts/' + d.id).then(reload); } });
          } } }, SB.icon('trash'))));
    }));
  };
})();
