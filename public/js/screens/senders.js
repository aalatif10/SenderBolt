/* Senders: connect Gmail (or other SMTP) accounts, test the connection, manage daily limits (hard cap 400). */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui;
  SB.screens = SB.screens || {};
  var CAP = 400, DEFAULT_LIMIT = 100;

  // ---- plain-language helpers -------------------------------------------------------------
  function healthInfo(score) {
    if (score >= 90) return { label: 'Excellent', cls: 'good' };
    if (score >= 70) return { label: 'Good', cls: 'good' };
    if (score >= 50) return { label: 'Needs care', cls: 'warn' };
    return { label: 'At risk', cls: 'bad' };
  }
  var HEALTH_TIP = 'A 0-100 score based on recent bounces and send failures. 90+ is excellent. When it falls below this account\u2019s protection threshold (see Protection level in its settings), SenderBolt stops using the account automatically to protect it.';
  var LEVELS = {
    low: { label: 'Low', below: 30, tip: 'Pauses only when the account is clearly in trouble (health below 30, or 8 failed sends in a row). For accounts you can afford to push.' },
    medium: { label: 'Medium', below: 50, tip: 'The balanced default: pauses below health 50, or after 5 failed sends in a row.' },
    high: { label: 'High', below: 70, tip: 'Strictest: pauses early, below health 70 or after 3 failed sends in a row. Best for your most valuable accounts.' }
  };
  function isForced(s) { return !!s.force_active; }
  // An account counts as active when it is switched on and either healthy enough OR running under Force continue.
  function isActiveNow(s) { return s.status === 'active' && (isForced(s) || s.health_score >= (s.health_floor || 50)); }
  // Real time of the next email from this account (computed on the server from schedule, sending hours, days and timezone).
  function nextLine(s) {
    if (s.status === 'active') {
      if (s.connection_error) return 'Connection problem. Retrying automatically.';
      if (s.next_email_at) return 'Next email ' + fmt.until(s.next_email_at);
      if (s.next_email_block && SB.S.nextBlock[s.next_email_block]) return SB.S.nextBlock[s.next_email_block];
      if (s.last_error) return 'Last problem: ' + s.last_error;
      return 'No emails scheduled';
    }
    return s.last_error ? 'Last problem: ' + s.last_error : ' ';
  }
  var RISK = { low: ['good', 'Low risk'], moderate: ['warn', 'Moderate risk'], high: ['bad', 'High risk'], critical: ['bad', 'Critical risk'] };

  function state(s) {
    if (s.status === 'disabled') return { key: 'draft', label: 'Disabled', tip: 'This account is switched off and will never be used.' };
    if (s.status === 'paused') return { key: 'halted', label: 'Paused', tip: s.last_error ? 'Paused automatically: ' + s.last_error : 'Nothing is sent from this account until you resume it.' };
    if (s.health_score < (s.health_floor || 50) && !isForced(s)) return { key: 'error', label: 'Needs attention', tip: 'The health score (' + s.health_score + ') is below this account\u2019s protection threshold (' + (s.health_floor || 50) + '), so it is not used until it recovers. You can override this with Force continue in its settings.' };
    if (s.warmup_enabled && s.limit_today < s.daily_limit) return { key: 'active', label: s.warmup_slowed ? 'Warming up (slowed)' : 'Warming up', tip: 'Warm-up day ' + s.warmup_day + ' of about ' + s.warmup_reaches_day + '. Today: up to ' + s.limit_today + ' emails, growing each day the account is really used.' + (s.warmup_slowed ? ' Growth is slowed because of recent bounces.' : '') };
    if (isForced(s)) return { key: 'active', label: 'Active (forced)', tip: 'Force continue is on until ' + fmt.dateTime(s.force_until) + ': automatic health pauses are skipped for this account.' };
    return { key: 'active', label: 'Active', tip: 'Ready to send.' };
  }
  // Does this account need the owner? Returns a list of plain-language problems (empty = all good).
  function problems(s, rt) {
    var out = [];
    if (s.status === 'paused') out.push({ code: 'paused', text: s.last_error ? 'Paused: ' + s.last_error : 'Paused: nothing is sent from this account until you resume it.' });
    // One item per ROOT CAUSE: an old "Auto-paused: health score fell…" note describes the same issue as a low health score, and a failing inbox is one issue however many places report it.
    var lowHealth = s.status === 'active' && s.health_score < (s.health_floor || 50) && !isForced(s), healthNote = /health score/i.test(s.last_error || '');
    if (lowHealth) out.push({ code: 'health', text: 'Health score ' + s.health_score + ' is below the protection threshold (' + (s.health_floor || 50) + ').' + (healthNote ? ' It was paused automatically for too many bounces.' : '') });
    if (s.status === 'active' && s.connection_error) out.push({ code: 'connection', text: 'Connection problem: ' + s.connection_error + ' The account keeps its place and SenderBolt retries automatically. Check the App Password in Settings, or run Test connection.' });
    else if (s.status === 'active' && s.last_error && !(lowHealth && healthNote)) out.push({ code: 'error', text: 'Last problem: ' + s.last_error });
    if (s.status === 'active' && rt === 'error' && !s.connection_error) out.push({ code: 'imap', text: 'The inbox cannot be read, so replies and bounces are not being detected.' });
    return out;
  }
  function pill(st) { return h('span', { class: 'pill pill-' + st.key, tip: st.tip }, st.label); }

  function trackingChip(rt) {
    var map = {
      off: ['warn', 'Replies detection off', 'Reply detection is switched off for this account: replies still reach your Inbox, but follow-ups keep going to people who answer. Turn it on in the account settings.'],
      ok: ['good', 'Replies detected', 'SenderBolt can see replies sent to this account, so it stops following up when someone answers.'],
      pending: ['warn', 'Checking replies…', 'Waiting for the first successful check of this inbox. Run "Test connection" if this stays for more than a few minutes.'],
      error: ['bad', 'Replies not detected', 'SenderBolt cannot read this inbox, so follow-ups will not run for it. Run "Test connection" to see why.'],
      not_configured: ['warn', 'Replies not set up', 'No inbox (IMAP) settings. Without them SenderBolt cannot tell when someone replies.']
    };
    var m = map[rt] || map.pending;
    return h('span', { class: 'chip chip-' + m[0], tip: m[2] }, m[1]);
  }

  function testResult(r) {
    function row(name, x) {
      return h('div', { class: 'test-row ' + (x.ok ? 'ok' : 'fail') }, SB.icon(x.ok ? 'check' : 'alert'),
        h('div', null, h('b', { text: name }), h('div', { class: 'small', text: x.message || (x.ok ? 'Working' : 'Failed') })));
    }
    return h('div', { class: 'test-box' },
      row('Sending (SMTP)', r.smtp || { ok: false, message: 'Not tested' }),
      row('Reading replies (IMAP)', r.imap || { ok: false, message: 'Not tested' }));
  }

  function sigToText(html) {
    if (!html) return '';
    return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  function textToSig(t) {
    t = String(t || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return null;
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>');
  }

  function field(label, input, hint, id) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint', text: hint }) : null);
  }
  function fieldErrors(box, e) {
    var msg = SB.api.friendly(e);
    if (e && e.details && typeof e.details === 'object') { var parts = Object.keys(e.details).map(function (k) { return e.details[k]; }); if (parts.length) msg = parts.join(' · '); }
    box.textContent = msg; box.classList.remove('hidden');
  }
  function num(inp, lo, hi) { var n = parseInt(inp.value, 10); return isFinite(n) ? n : NaN; }

  // ---- warm-up controls (shared) --------------------------------------------------------------
  var WARM_ON = 'The daily amount starts small and grows, but only on days the account is really used. Idle days do not count, and growth slows by itself if emails start bouncing. Recommended for new or rarely used accounts.';
  var WARM_OFF = 'Full speed: the account sends up to your daily limit from the very first day. Only choose this for accounts that already send a similar volume regularly.';
  var PACE_HINT = { standard: 'Standard: starts at 5 a day and reaches the maximum in about 3 weeks.', gentle: 'Gentle: starts at 3 a day and takes about 5 weeks. Best for brand-new Gmail accounts.' };
  function warmControls(s, idp) {   // s = existing sender or null (new)
    var box = h('input', { type: 'checkbox', id: idp + '-warm' }); box.checked = s ? !!s.warmup_enabled : true;
    var pace = h('select', { class: 'input', id: idp + '-pace' }, h('option', { value: 'standard' }, 'Standard (about 3 weeks)'), h('option', { value: 'gentle' }, 'Gentle (about 5 weeks)'));
    pace.value = (s && s.warmup_pace) || 'standard';
    var hint = h('div', { class: 'hint' }), paceHint = h('div', { class: 'hint' });
    var paceField = h('div', { class: 'field' }, h('label', { for: idp + '-pace' }, 'Warm-up speed'), pace, paceHint);
    function sync() {
      hint.textContent = box.checked ? WARM_ON : WARM_OFF; paceHint.textContent = PACE_HINT[pace.value];
      paceField.classList.toggle('hidden', !box.checked);
    }
    box.addEventListener('change', sync); pace.addEventListener('change', sync); sync();
    var status = null;
    if (s && s.warmup_enabled) {
      status = h('div', { class: 'callout' }, h('b', { text: 'Warm-up day ' + s.warmup_day + ' of about ' + s.warmup_reaches_day + '. ' }),
        'Today this account may send up to ' + fmt.num(s.limit_today) + ' emails' + (s.limit_today < s.daily_limit ? ', rising toward ' + fmt.num(s.daily_limit) + '.' : '.') +
        (s.warmup_slowed ? ' Growth is currently slowed because of recent bounces: clean your lists and it recovers within a week.' : ''));
    }
    return { box: box, pace: pace, node: h('div', null, status,
      h('div', { class: 'field check' }, box, h('label', { for: idp + '-warm' }, 'Warm-up: start small and grow daily'), hint), paceField),
      values: function () { return { warmup_enabled: box.checked, warmup_pace: pace.value }; } };
  }

  // ---- add sender -------------------------------------------------------------------------
  function addModal(onDone) {
    var provider = 'gmail';
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var email = h('input', { class: 'input', id: 'as-email', type: 'email', autocomplete: 'off', placeholder: 'you@gmail.com', maxlength: 254 });
    var pass = h('input', { class: 'input', id: 'as-pass', type: 'password', autocomplete: 'new-password', placeholder: 'xxxx xxxx xxxx xxxx', maxlength: 64 });
    var name = h('input', { class: 'input', id: 'as-name', maxlength: 80, placeholder: 'e.g. Alex Morgan' });
    var limit = h('input', { class: 'input', id: 'as-limit', type: 'number', min: 1, max: CAP, value: DEFAULT_LIMIT });
    var host = h('input', { class: 'input', id: 'as-host', placeholder: 'smtp.example.com', maxlength: 253 });
    var port = h('input', { class: 'input', id: 'as-port', type: 'number', value: 465 });
    var imapHost = h('input', { class: 'input', id: 'as-ihost', placeholder: 'imap.example.com', maxlength: 253 });
    var warm = warmControls(null, 'as');
    var smtpBox = h('div', { class: 'hidden' },
      field('SMTP server', host, 'The outgoing mail server, from your email provider.', 'as-host'),
      field('SMTP port', port, '465 (secure) or 587 are the most common.', 'as-port'),
      field('IMAP server (to detect replies)', imapHost, 'Optional but recommended. IMAP port 993 is used.', 'as-ihost'));
    var tabGmail = h('button', { class: 'seg active', type: 'button' }, 'Gmail'), tabSmtp = h('button', { class: 'seg', type: 'button' }, 'Other email provider');
    var help = h('div', { class: 'callout' },
      h('b', { text: 'How to get a Google App Password' }),
      h('ol', null,
        h('li', null, 'Turn on 2-Step Verification in your Google account (Security page).'),
        h('li', null, 'Open Security → App passwords and create one named "SenderBolt".'),
        h('li', null, 'Copy the 16-character code and paste it above. Your normal Gmail password will not work.')),
      h('div', { class: 'small', text: 'The code is encrypted on this computer and is never shown again.' }));
    function setProvider(p) {
      provider = p; tabGmail.classList.toggle('active', p === 'gmail'); tabSmtp.classList.toggle('active', p === 'smtp');
      smtpBox.classList.toggle('hidden', p === 'gmail'); help.classList.toggle('hidden', p !== 'gmail');
      port.value = 465;
    }
    tabGmail.addEventListener('click', function () { setProvider('gmail'); });
    tabSmtp.addEventListener('click', function () { setProvider('smtp'); });
    var body = h('div', null, err, h('div', { class: 'segs' }, tabGmail, tabSmtp),
      field('Email address', email, null, 'as-email'),
      field('App Password (or password)', pass, null, 'as-pass'), help, smtpBox,
      field('Name shown to recipients', name, 'People see this as the sender name. Use a real person\'s name for best results.', 'as-name'),
      field('Emails per day', limit, 'The most this account will ever send in a day. The absolute maximum is ' + CAP + ', which keeps a safe buffer under Gmail\'s own limit.', 'as-limit'), warm.node);
    ui.modal({ title: 'Add a sender', body: body, actions: [
      { label: 'Cancel' },
      { label: 'Add and test connection', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        var lim = num(limit);
        if (!isFinite(lim) || lim < 1 || lim > CAP) { err.textContent = 'Emails per day must be between 1 and ' + CAP + '.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
        var payload = { label: email.value.trim(), email: email.value, provider: provider, password: pass.value, from_name: name.value, daily_limit: lim };
        Object.assign(payload, warm.values());
        if (provider === 'smtp') {
          payload.smtp_host = host.value; payload.smtp_port = parseInt(port.value, 10) || 465;
          if (imapHost.value.trim()) { payload.imap_host = imapHost.value; payload.imap_port = 993; }
        }
        return SB.api.post('/api/senders', payload).then(function (r) {
          close(); ui.toast('Sender added. Testing the connection…');
          return SB.api.post('/api/senders/' + r.sender.id + '/test', {}).then(function (t) { onDone(); showTest(r.sender, t); }, function () { onDone(); });
        }, function (e) { fieldErrors(err, e); throw e; });
      } }
    ] });
  }

  function showTest(sender, result) {
    var ok = result.smtp && result.smtp.ok;
    ui.modal({ title: ok ? 'Connection works' : 'Connection problem', body: h('div', null,
      h('p', { class: 'muted' }, ui.email(sender.email)), testResult(result),
      ok ? null : h('p', { class: 'small muted', text: 'Check the App Password and that 2-Step Verification is on, then open the sender and test again.' })),
      actions: [{ label: 'Done', kind: 'primary' }] });
  }

  // "Test connection" on an account card runs and reports INSIDE the button (no pop-up): Testing… -> "SMTP ✓ · IMAP ✓" (or ✕ on what failed).
  // The result is remembered for a few seconds per account because the list repaints itself after a test.
  var cardTests = {}, RESULT_MS = 12000;
  function paintCardTest(s, btn, note, onDone) {
    var t = cardTests[s.id];
    btn.onclick = function () {
      if (btn.disabled) return;
      cardTests[s.id] = { running: true }; paintCardTest(s, btn, note, onDone);
      SB.api.post('/api/senders/' + s.id + '/test', {}).then(function (r) { cardTests[s.id] = { result: r, at: Date.now() }; }, function (e) {
        cardTests[s.id] = { result: { smtp: { ok: false, message: SB.api.friendly(e) }, imap: { ok: false, message: 'Not tested' } }, at: Date.now() };
      }).then(function () { if (btn.isConnected) paintCardTest(s, btn, note, onDone); onDone(); });
    };
    btn.classList.remove('is-ok', 'is-fail'); btn.removeAttribute('aria-busy'); note.classList.add('hidden');
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    if (t && t.running) {
      btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' })); btn.appendChild(document.createTextNode('Testing\u2026')); return;
    }
    btn.disabled = false;
    if (t && t.result && Date.now() - t.at < RESULT_MS) {
      var r = t.result, sOk = !!(r.smtp && r.smtp.ok), iOk = !!(r.imap && r.imap.ok);
      btn.classList.add(sOk && iOk ? 'is-ok' : 'is-fail');
      btn.appendChild(document.createTextNode('SMTP ' + (sOk ? '\u2713' : '\u2715') + ' \u00b7 IMAP ' + (iOk ? '\u2713' : '\u2715')));
      btn.setAttribute('data-tip', 'Sending (SMTP): ' + ((r.smtp && r.smtp.message) || (sOk ? 'works' : 'failed')) + '. Reading replies (IMAP): ' + ((r.imap && r.imap.message) || (iOk ? 'works' : 'failed')) + '. Click to test again.');
      if (!(sOk && iOk)) { note.textContent = !sOk ? ((r.smtp && r.smtp.message) || 'Sending failed.') : ((r.imap && r.imap.message) || 'Reading replies failed.'); note.classList.remove('hidden'); }
      setTimeout(function () { if (btn.isConnected && cardTests[s.id] === t) paintCardTest(s, btn, note, onDone); }, Math.max(200, RESULT_MS - (Date.now() - t.at)));
      return;
    }
    btn.appendChild(document.createTextNode('Test connection'));
    btn.setAttribute('data-tip', 'Logs in to this account right now to check that sending and reply detection work.');
  }

  // ---- settings slide-over -----------------------------------------------------------------
  function settingsPanel(s, onDone, rt) {
    var p = ui.panel(s.email), err = h('div', { class: 'form-error hidden', role: 'alert' });
    var ph = p.body.parentNode && p.body.parentNode.querySelector('.panel-head h2');
    if (ph) { while (ph.firstChild) ph.removeChild(ph.firstChild); ph.appendChild(ui.email(s.email)); }
    var name = h('input', { class: 'input', id: 'st-name', maxlength: 80, value: s.from_name || '' });
    var limit = h('input', { class: 'input', id: 'st-limit', type: 'number', min: 1, max: CAP, value: s.daily_limit });
    var warm = warmControls(s, 'st');
    var mode = h('select', { class: 'input', id: 'st-mode' }, h('option', { value: 'random' }, 'Random (looks more natural)'), h('option', { value: 'fixed' }, 'Fixed'));
    mode.value = s.delay_mode;
    var dmin = h('input', { class: 'input', id: 'st-dmin', type: 'number', min: 1, max: 3600, value: s.delay_min_sec });
    var dmax = h('input', { class: 'input', id: 'st-dmax', type: 'number', min: 1, max: 3600, value: s.delay_max_sec });
    var dfix = h('input', { class: 'input', id: 'st-dfix', type: 'number', min: 1, max: 3600, value: s.delay_fixed_sec });
    var randBox = h('div', { class: 'two' }, field('Shortest wait (seconds)', dmin, null, 'st-dmin'), field('Longest wait (seconds)', dmax, null, 'st-dmax'));
    var fixBox = h('div', null, field('Wait between emails (seconds)', dfix, null, 'st-dfix'));
    function syncMode() { randBox.classList.toggle('hidden', mode.value !== 'random'); fixBox.classList.toggle('hidden', mode.value !== 'fixed'); }
    mode.addEventListener('change', syncMode); syncMode();
    var sig = h('textarea', { class: 'input', id: 'st-sig', rows: 4, maxlength: 2000, placeholder: 'Best regards,\nAlex Morgan' }); sig.value = sigToText(s.signature_html);
    var track = h('input', { class: 'input', id: 'st-track', maxlength: 253, placeholder: 'Optional', value: s.tracking_domain || '' });
    var newPass = h('input', { class: 'input', id: 'st-pass', type: 'password', autocomplete: 'new-password', placeholder: 'Leave empty to keep the current one', maxlength: 64 });

    // ---- replies + protection (v1.8) ----
    var replyOn = h('input', { type: 'checkbox', id: 'st-reply', class: 'switch', role: 'switch' }); replyOn.checked = s.reply_detection !== 0;
    var level = s.protection_level || 'medium';
    var levelBtns = {};
    var levelBox = h('div', { class: 'seg-level', role: 'radiogroup', 'aria-label': 'Protection level' }, ['low', 'medium', 'high'].map(function (k) {
      var b = h('button', { class: 'level-opt' + (k === level ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': k === level ? 'true' : 'false', tip: LEVELS[k].tip }, h('b', { text: LEVELS[k].label }), h('span', { class: 'small', text: 'pause below ' + LEVELS[k].below }));
      b.addEventListener('click', function () { level = k; Object.keys(levelBtns).forEach(function (x) { levelBtns[x].classList.toggle('on', x === k); levelBtns[x].setAttribute('aria-checked', x === k ? 'true' : 'false'); }); });
      levelBtns[k] = b; return b;
    }));
    var forceBtn = h('button', { class: 'btn btn-sm', type: 'button' });
    var forceTxt = h('div', { class: 'small' });
    var forceBox = h('div', { class: 'force-box' });
    function paintForce(on, until) {
      forceBox.classList.toggle('on', on);
      forceTxt.textContent = on ? 'Force continue is ON until ' + fmt.dateTime(until) + '. Automatic health and failure pauses are skipped for this account. Wrong passwords and provider limits still stop it.' :
        'Use this for a large or experimental campaign when the automatic safety pause would interrupt it. It lasts 72 hours, then protection applies again. Use with care: a damaged account can be blocked by Google.';
      forceBtn.textContent = on ? 'Turn off Force continue' : (s.status === 'paused' ? 'Force start' : 'Force continue');
      forceBtn.onclick = function () {
        function go() {
          forceBtn.disabled = true;
          return SB.api.patch('/api/senders/' + s.id, { force_continue: !on }).then(function (r) { ui.toast(!on ? 'Force continue is on for 72 hours' : 'Force continue turned off'); onDone(); p.close(); settingsPanel(r.sender, onDone, rt); },
            function (e) { ui.toast(SB.api.friendly(e), true); forceBtn.disabled = false; });
        }
        if (on) return go();
        ui.confirm({ title: (s.status === 'paused' ? 'Force start' : 'Force continue') + ' ' + s.email + '?', message: 'Automatic pauses for low health or repeated failures will be skipped for 72 hours. Only do this if you accept the risk to this account\u2019s reputation.', confirmLabel: s.status === 'paused' ? 'Force start' : 'Force continue', danger: true, onConfirm: go });
      };
    }
    forceBox.appendChild(h('div', { class: 'small muted' }, forceTxt)); forceBox.appendChild(h('div', null, forceBtn));
    paintForce(!!s.force_active, s.force_until);

    var save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save changes');
    save.addEventListener('click', function () {
      err.classList.add('hidden');
      var lim = num(limit);
      if (!isFinite(lim) || lim < 1 || lim > CAP) { err.textContent = 'Emails per day must be between 1 and ' + CAP + '.'; err.classList.remove('hidden'); return; }
      if (mode.value === 'random' && num(dmin) > num(dmax)) { err.textContent = 'The shortest wait cannot be longer than the longest wait.'; err.classList.remove('hidden'); return; }
      if (!s.has_password && !newPass.value) { err.textContent = 'Add an App Password so this account can send.'; err.classList.remove('hidden'); return; }
      var body = { reply_detection: replyOn.checked, protection_level: level, from_name: name.value, daily_limit: lim, warmup_enabled: warm.box.checked, warmup_pace: warm.pace.value, delay_mode: mode.value, signature_html: textToSig(sig.value), tracking_domain: track.value.trim() };
      if (mode.value === 'random') { body.delay_min_sec = num(dmin); body.delay_max_sec = num(dmax); } else body.delay_fixed_sec = num(dfix);
      if (newPass.value) body.password = newPass.value;
      save.disabled = true;
      SB.api.patch('/api/senders/' + s.id, body).then(function () { p.close(); ui.toast('Saved'); onDone(); }, function (e) { fieldErrors(err, e); save.disabled = false; });
    });

    // Pause / Resume keeps the drawer open: the sender is reloaded and the summary, risk and Force button are repainted in place (unsaved edits stay).
    var toggle = h('button', { class: 'btn', type: 'button' });
    function paintToggle() {
      var paused = s.status !== 'active';
      while (toggle.firstChild) toggle.removeChild(toggle.firstChild);
      toggle.appendChild(SB.icon(paused ? 'play' : 'pause')); toggle.appendChild(document.createTextNode(paused ? 'Resume sending' : 'Pause sending'));
    }
    paintToggle();
    toggle.addEventListener('click', function () {
      if (toggle.disabled) return;
      var wasPaused = s.status !== 'active'; toggle.disabled = true;
      SB.api.post('/api/senders/' + s.id + '/status', { status: wasPaused ? 'active' : 'paused' }).then(function () {
        ui.toast(wasPaused ? 'Resumed' : 'Paused'); onDone();
        return reloadSender();
      }, function (e) { ui.toast(SB.api.friendly(e), true); }).then(function () { toggle.disabled = false; });
    });
    var del = h('button', { class: 'btn btn-danger', type: 'button' }, 'Remove sender');
    del.addEventListener('click', function () {
      ui.confirm({ title: 'Remove ' + s.email + '?', message: 'The account is disconnected and its saved password is deleted. Emails already sent are not affected.', confirmLabel: 'Remove', danger: true,
        onConfirm: function () { return SB.api.del('/api/senders/' + s.id).then(function () { p.close(); ui.toast('Sender removed'); onDone(); }); } });
    });

    var testBtn = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Logs in to this account right now to check that sending and reply detection work.' }, 'Test connection');
    var testOut = h('div', { class: 'sd-test', role: 'status', 'aria-live': 'polite' });
    testBtn.addEventListener('click', function () {
      if (testBtn.disabled) return;
      testBtn.disabled = true; testBtn.setAttribute('aria-busy', 'true');
      while (testBtn.firstChild) testBtn.removeChild(testBtn.firstChild);
      testBtn.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' })); testBtn.appendChild(document.createTextNode('Testing\u2026'));
      while (testOut.firstChild) testOut.removeChild(testOut.firstChild);
      testOut.appendChild(h('div', { class: 'small muted', text: 'Logging in to the mail servers\u2026' }));
      SB.api.post('/api/senders/' + s.id + '/test', {}).then(function (r) {
        while (testOut.firstChild) testOut.removeChild(testOut.firstChild);
        var ok = !!(r.smtp && r.smtp.ok), allOk = ok && !!(r.imap && r.imap.ok);
        testOut.appendChild(h('div', { class: 'sd-test-head ' + (allOk ? 'ok' : 'fail') }, SB.icon(allOk ? 'check' : 'alert'), h('b', { text: allOk ? 'Connection works' : ok ? 'Sending works, replies do not' : 'Connection problem' }), h('span', { class: 'small muted', text: 'just now' })));
        testOut.appendChild(testResult(r));
        if (!ok) testOut.appendChild(h('p', { class: 'small muted', text: 'Check the App Password and that 2-Step Verification is on, then test again.' }));
        onDone(); return reloadSender();
      }, function (e) {
        while (testOut.firstChild) testOut.removeChild(testOut.firstChild);
        testOut.appendChild(h('div', { class: 'sd-test-head fail' }, SB.icon('alert'), h('b', { text: 'The test could not run' })));
        testOut.appendChild(h('p', { class: 'small', text: SB.api.friendly(e) }));
      }).then(function () {
        testBtn.disabled = false; testBtn.removeAttribute('aria-busy');
        while (testBtn.firstChild) testBtn.removeChild(testBtn.firstChild); testBtn.appendChild(document.createTextNode('Test connection'));
      });
    });
    var conn = s.connection_error ? h('div', { class: 'callout warn' }, SB.icon('alert'), ' ', 'Connection problem: ' + s.connection_error + ' The account stays active and SenderBolt retries automatically; nothing is paused for this.') : null;
    var where = [s.provider === 'gmail' ? 'Gmail' : 'Custom SMTP', s.smtp_host ? 'SMTP ' + s.smtp_host + (s.smtp_port ? ':' + s.smtp_port : '') : null, s.imap_host ? 'IMAP ' + s.imap_host : null].filter(Boolean).join(' · ');

    // Accordion card: header = title + one-line summary of the current state + an issue dot; the body opens on click.
    // Every card starts closed each time the drawer opens, except a card with a problem or warning, which opens by itself.
    var cards = [], openCards = {};   // cards always start closed; only the ones with a problem or warning open by themselves
    function card(key, title, kids) {
      var dot = h('span', { class: 'sd-dot hidden', 'aria-hidden': 'true' }), sum = h('span', { class: 'sd-card-sum small muted' });
      var head = h('button', { class: 'sd-card-h', type: 'button', 'aria-expanded': 'false' }, h('span', { class: 'sd-card-t' }, h('b', { text: title }), dot), sum, SB.icon('chevron'));
      var bodyEl = h('div', { class: 'sd-card-b hidden' }, kids), el = h('section', { class: 'sd-card card' }, head, bodyEl);
      var c = { key: key, el: el, issue: null };
      c.open = function (on) { head.setAttribute('aria-expanded', on ? 'true' : 'false'); bodyEl.classList.toggle('hidden', !on); el.classList.toggle('is-open', !!on); openCards[key] = !!on; };
      head.addEventListener('click', function () { c.open(bodyEl.classList.contains('hidden')); });
      c.set = function (text, issue) {   // issue: null | { level: 'bad' | 'warn', msg }
        c.issue = issue; sum.textContent = issue ? issue.msg : text; sum.className = 'sd-card-sum small ' + (issue ? 'sd-sum-' + issue.level : 'muted');
        dot.className = 'sd-dot' + (issue ? ' ' + issue.level : ' hidden'); dot.setAttribute('title', issue ? issue.msg : '');
        head.setAttribute('aria-label', title + '. ' + (issue ? (issue.level === 'bad' ? 'Needs attention: ' : 'Warning: ') : '') + (issue ? issue.msg : text));
      };
      cards.push(c); return c;
    }
    // Risk: one plain verdict and the reasons behind it.
    var rk, rm, riskBox = h('div');
    function paintRisk() {
      rk = s.risk || { level: 'low', factors: [] }; rm = RISK[rk.level] || RISK.low;
      riskBox.className = 'risk-box risk-' + rk.level;
      while (riskBox.firstChild) riskBox.removeChild(riskBox.firstChild);
      riskBox.appendChild(h('div', { class: 'risk-head' }, h('span', { class: 'chip chip-' + rm[0], tip: 'A plain summary of how likely this account is to run into trouble, based on its health, warm-up, protection and connection state.' }, rm[1]),
        h('span', { class: 'small muted', text: 'Health ' + s.health_score + ' \u00b7 pauses below ' + (s.health_floor || 50) })));
      riskBox.appendChild(rk.factors.length ? h('ul', { class: 'risk-list' }, rk.factors.map(function (f) { return h('li', { text: f }); })) : h('div', { class: 'small muted', text: 'No warning signs. Keep lists clean and this account stays in good shape.' }));
    }
    paintRisk();
    // Health Healing: how the score recovers, step by step.
    var r = s.heal_rules || {}, base = s.health_base, heal = s.health_heal || 0;
    var healBar = ui.progress(s.health_score);
    var healBox = h('div', { class: 'heal-box' },
      h('div', { class: 'usage-top' }, h('span', { text: 'Health score', tip: HEALTH_TIP }), h('b', { text: s.health_score + ' / 100' })), healBar,
      h('div', { class: 'heal-split small muted' }, h('span', { tip: 'The score from the last 30 days of sending (bounces and failures).', text: 'From sending history: ' + base }), h('span', { tip: 'Points earned back by calm days, clean sending and replies. A new serious problem resets them.', text: 'Healed: +' + heal })),
      h('div', { class: 'small muted', text: s.health_score >= 100 ? 'Fully healed.' : 'If every day stays clean it can be back at 100 in about ' + s.heal_full_in_days + ' day' + (s.heal_full_in_days === 1 ? '' : 's') + '. Next healing day is credited ' + fmt.until(s.heal_next_at) + '.' }),
      h('ul', { class: 'risk-list' },
        h('li', { text: '+' + r.calm + ' for each calm day with no serious problem' }),
        h('li', { text: '+1 for every ' + r.clean_per + ' clean emails sent' }),
        h('li', { text: '+' + r.reply + ' when a real reply arrives' }),
        h('li', { text: 'At most +' + r.day_max + ' a day, never above 100. A serious problem pauses healing that day.' })));

    var summary = h('div', { class: 'sd-summary card' });
    function paintSummary() {
      var hi = healthInfo(s.health_score), st = state(s), pct = s.limit_today ? Math.min(100, s.sent_today / s.limit_today * 100) : 0;
      var connChip = s.connection_error ? h('span', { class: 'chip chip-bad', tip: 'Problem: ' + s.connection_error }, 'Connection problem') : trackingChip(rt || 'pending');
      paintToggle();
      while (summary.firstChild) summary.removeChild(summary.firstChild);
      summary.appendChild(h('div', { class: 'sd-sum-top' }, h('div', { class: 'sd-sum-state' }, pill(st), h('div', { class: 'small muted', text: nextLine(s) })), toggle));
      summary.appendChild(h('div', { class: 'sd-stats' },
        h('div', { tip: 'Emails sent today out of what this account may send today (warm-up limits included).' }, h('span', { class: 'small muted', text: 'Sent today' }), h('b', { text: fmt.num(s.sent_today) + ' / ' + fmt.num(s.limit_today) }), ui.progress(pct)),
        h('div', { tip: HEALTH_TIP }, h('span', { class: 'small muted', text: 'Health' }), h('b', { text: s.health_score + ' / 100' }), h('span', { class: 'chip chip-' + hi.cls, text: hi.label })),
        h('div', { tip: 'Whether SenderBolt can reach this account\u2019s mailbox: replies and bounces are read from it.' }, h('span', { class: 'small muted', text: 'Connection' }), connChip)));
    }
    paintSummary();
    // Fetch the account again after Pause/Resume or a connection test and repaint what depends on it. Form fields are left untouched.
    function reloadSender() {
      return SB.api.get('/api/senders/' + s.id).then(function (r) {
        Object.keys(r.sender).forEach(function (k) { s[k] = r.sender[k]; });
        paintSummary(); paintRisk(); paintForce(!!s.force_active, s.force_until); refresh();
      }, function () { /* the list behind refreshes on its own; keep what is shown */ });
    }

    var cConn = card('conn', 'Connection & reply tracking', h('div', null,
      h('div', { class: 'sd-where small muted', tip: 'The servers SenderBolt uses for this account. Gmail accounts use Google’s servers automatically.' }, where),
      h('div', { class: 'set-row' }, h('div', { class: 'set-txt' }, h('label', { for: 'st-reply', text: 'Replies detected' }, ' ', ui.info('SenderBolt reads this account’s inbox to notice replies. Each reply stops follow-ups for THAT person only; everyone else in the campaign keeps going.')),
        h('div', { class: 'hint', text: 'Stop follow-ups for a person who replies. Turn off to keep following up regardless (replies still reach your Inbox). "Stop campaign" requests and bounces are always respected.' })), replyOn),
      field('Replace App Password', newPass, 'Use this if Google revoked the old one. The current one is never shown.', 'st-pass'),
      field('Tracking domain (optional)', track, 'Only needed if you use a custom domain for tracking and unsubscribe links.', 'st-track'),
      h('div', { class: 'actions' }, testBtn), testOut));
    var cLimits = card('limits', 'Limits, pace & warm-up', h('div', null,
      field('Emails per day', limit, 'Maximum ' + CAP + '. Gmail allows about 500 per day, so ' + CAP + ' keeps a safe 100-email buffer and protects your account.', 'st-limit'), warm.node,
      h('div', { class: 'sd-sub' }, h('b', { text: 'Sending pace' }), h('span', { class: 'small muted', text: 'The pause between two emails from this account.' })),
      field('Pause between emails', mode, 'Random pauses look like a human. Very short pauses can trigger spam filters.', 'st-mode'), randBox, fixBox));
    var cProt = card('prot', 'Protection & health healing', h('div', null, riskBox,
      field('Protection level', levelBox, 'How early SenderBolt pauses this account to protect its reputation. Based on the account’s health score and failed sends.', 'st-level'),
      forceBox,
      h('div', { class: 'sd-sub' }, h('b', { text: 'Health healing' }), h('span', { class: 'small muted', text: 'A damaged score recovers gradually: calm days, clean sending and replies earn points back.' })), healBox));
    var cId = card('id', 'Identity & signature', h('div', null,
      field('Name shown to recipients', name, 'People see this as the sender name. Use a real person’s name for best results.', 'st-name'),
      field('Added to the end of every email', sig, 'Plain text. Line breaks are kept.', 'st-sig')));

    // One line per card, kept live while the owner edits, plus the issue dot (problems found in ANY control of the card).
    function refresh() {
      var lim = num(limit), badLim = !isFinite(lim) || lim < 1 || lim > CAP, badWait = mode.value === 'random' && num(dmin) > num(dmax), noPw = !s.has_password && !newPass.value;
      var connIssue = noPw ? { level: 'bad', msg: 'No App Password yet: this account cannot send.' } : s.connection_error ? { level: 'bad', msg: 'Connection problem: ' + s.connection_error } :
        rt === 'error' ? { level: 'bad', msg: 'Replies cannot be read from this inbox. Run Test connection.' } : (rt === 'pending' || rt === 'not_configured') ? { level: 'warn', msg: rt === 'pending' ? 'Waiting for the first successful inbox check.' : 'No inbox (IMAP) settings: replies cannot be detected.' } : null;
      cConn.set(where + ' · replies ' + (replyOn.checked ? 'on' : 'off') + (track.value.trim() ? ' · tracking domain set' : ''), connIssue);
      var pace = mode.value === 'random' ? num(dmin) + '–' + num(dmax) + ' s' : num(dfix) + ' s';
      cLimits.set((isFinite(lim) ? fmt.num(lim) : '?') + '/day · ' + (warm.box.checked ? (s.limit_today < s.daily_limit ? 'warm-up day ' + s.warmup_day : 'warm-up on') : 'no warm-up') + ' · pause ' + pace,
        badLim ? { level: 'bad', msg: 'Emails per day must be between 1 and ' + CAP + '.' } : badWait ? { level: 'bad', msg: 'The shortest wait is longer than the longest wait.' } : s.warmup_slowed ? { level: 'warn', msg: 'Warm-up is slowed because of recent problems.' } : null);
      var floor = s.health_floor || 50, protIssue = s.health_score < floor && !s.force_active ? { level: 'bad', msg: 'Health ' + s.health_score + ' is below the pause line (' + floor + ').' } :
        rk.level === 'high' ? { level: 'bad', msg: 'High risk: ' + (rk.factors[0] || 'see the reasons inside.') } : rk.level === 'moderate' ? { level: 'warn', msg: 'Moderate risk: ' + (rk.factors[0] || 'see the reasons inside.') } :
        s.force_active ? { level: 'warn', msg: 'Force continue is on: automatic pauses are skipped.' } : null;
      cProt.set(LEVELS[level].label + ' protection · ' + rm[1].toLowerCase() + ' · health ' + s.health_score + '/100', protIssue);
      cId.set((name.value.trim() || 'No name set') + ' · ' + (sig.value.trim() ? 'signature set' : 'no signature'), null);
    }
    [limit, dmin, dmax, dfix, mode, name, sig, track, newPass, replyOn, warm.box, warm.pace].forEach(function (el) { el.addEventListener('input', refresh); el.addEventListener('change', refresh); });
    Object.keys(levelBtns).forEach(function (k) { levelBtns[k].addEventListener('click', refresh); });
    refresh();
    cards.forEach(function (c) { c.open(!!c.issue); });
    var allBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Open or close every section at once.' }, 'Expand all');
    allBtn.addEventListener('click', function () { var every = cards.every(function (c) { return c.el.classList.contains('is-open'); }); cards.forEach(function (c) { c.open(!every); }); allBtn.textContent = every ? 'Expand all' : 'Collapse all'; });
    var save2 = h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { save.click(); } } }, 'Save changes');
    // a failed check on Save opens the card that holds the problem
    var shown = err.classList; new MutationObserver(function () { if (!shown.contains('hidden')) cards.forEach(function (c) { if (c.issue && c.issue.level === 'bad') c.open(true); }); }).observe(err, { attributes: true, attributeFilter: ['class'] });

    p.body.appendChild(h('div', { class: 'panel-pad sd-wrap' }, summary, err, conn,
      h('div', { class: 'sd-cards-h' }, h('span', { class: 'small muted', text: 'Settings' }), allBtn),
      cConn.el, cLimits.el, cProt.el, cId.el,
      h('div', { class: 'sd-foot' }, save2, del)));
  }

  // ---- quick actions (one click, right on the card) -------------------------------------------------
  function setStatus(s, status, msg, onDone) {
    return SB.api.post('/api/senders/' + s.id + '/status', { status: status }).then(function () { ui.toast(msg); onDone(); }, function (e) { ui.toast(SB.api.friendly(e), true); });
  }
  // "Needs attention" opens a short list of what is wrong, each with a one-click way to deal with it.
  function attentionDialog(s, rt, onDone) {
    var list = problems(s, rt), body = h('div', null, h('p', { class: 'muted' }, ui.email(s.email)));
    var close;
    list.forEach(function (x) { body.appendChild(h('div', { class: 'callout warn' }, SB.icon('alert'), ' ', x.text)); });
    var acts = h('div', { class: 'actions pad-t' });
    function act(label, fn, kind) { var b = h('button', { class: 'btn btn-sm' + (kind ? ' ' + kind : ''), type: 'button' }, label); b.addEventListener('click', function () { b.disabled = true; Promise.resolve(fn()).then(function () { b.disabled = false; }); }); acts.appendChild(b); }
    var codes = list.map(function (x) { return x.code; });
    if (s.status === 'paused') act('Resume sending', function () { return setStatus(s, 'active', 'Resumed', onDone).then(function () { close(); }); }, 'btn-primary');
    if (codes.indexOf('health') !== -1 || (s.status === 'paused' && s.health_score < (s.health_floor || 50))) act(s.status === 'paused' ? 'Force start' : 'Force continue', function () {
      return SB.api.patch('/api/senders/' + s.id, { force_continue: true }).then(function () { ui.toast('Force continue is on for 72 hours'); onDone(); close(); }, function (e) { ui.toast(SB.api.friendly(e), true); });
    });
    act('Test connection', function () { close(); return SB.api.post('/api/senders/' + s.id + '/test', {}).then(function (r) { showTest(s, r); onDone(); }, function (e) { ui.toast(SB.api.friendly(e), true); }); });
    act('Open settings', function () { close(); settingsPanel(s, onDone, rt); });
    body.appendChild(acts);
    close = ui.modal({ title: 'This account needs attention', body: body, actions: [{ label: 'Close' }] });
  }

  // ---- cards -------------------------------------------------------------------------------
  function card(s, rt, onDone) {
    var st = state(s), hi = healthInfo(s.health_score), probs = problems(s, rt);
    var pct = s.limit_today ? s.sent_today / s.limit_today * 100 : 0;
    var testBtn = h('button', { class: 'btn btn-sm btn-test', type: 'button', tip: 'Logs in to this account right now to check that sending and reply detection work.' }), testNote = h('div', { class: 'small sd-test-note hidden', role: 'status', 'aria-live': 'polite' });
    paintCardTest(s, testBtn, testNote, onDone);
    var setBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Settings');
    setBtn.addEventListener('click', function () { settingsPanel(s, onDone, rt); });
    // Pause / Resume in one click (no dialog: both are instantly reversible and change nothing about the people in campaigns).
    var quick = [];
    if (s.status === 'active') {
      var pb = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Stop sending from this account right now. Resume any time; nobody is lost.' }, SB.icon('pause'), 'Pause');
      pb.addEventListener('click', function () { pb.disabled = true; setStatus(s, 'paused', 'Paused ' + s.email, onDone).then(function () { pb.disabled = false; }); });
      quick.push(pb);
    } else if (s.status === 'paused') {
      var rb = h('button', { class: 'btn btn-sm btn-primary', type: 'button', tip: 'Start sending from this account again.' }, SB.icon('play'), 'Resume');
      rb.addEventListener('click', function () { rb.disabled = true; setStatus(s, 'active', 'Resumed ' + s.email, onDone).then(function () { rb.disabled = false; }); });
      quick.push(rb);
    }
    if (probs.length) {
      var ab = h('button', { class: 'btn btn-sm btn-attn', type: 'button', tip: 'See what is wrong with this account and fix it in one click.' }, SB.icon('alert'), 'Needs attention (' + probs.length + ')');
      ab.addEventListener('click', function () { attentionDialog(s, rt, onDone); });
      quick.push(ab);
    }
    return h('div', { class: 'card sender-card' },
      h('div', { class: 'top' }, h('div', { class: 'who' }, h('h3', null, ui.email(s.from_name || s.email)), s.from_name ? h('div', { class: 'small muted' }, ui.email(s.email)) : null), pill(st)),
      h('div', { class: 'usage' },
        h('div', { class: 'usage-top' }, h('span', { class: 'small muted', text: 'Sent today' }), h('b', { tip: 'Emails sent today out of what this account may send today' + (s.warmup_enabled && s.limit_today < s.daily_limit ? ' (warm-up is still growing it toward ' + s.daily_limit + ')' : '') + '. Your absolute maximum is ' + CAP + ' per day.', text: fmt.num(s.sent_today) + ' / ' + fmt.num(s.limit_today) })),
        ui.progress(pct)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip chip-' + hi.cls, tip: HEALTH_TIP }, 'Health: ' + hi.label + ' (' + s.health_score + ')'),
        h('span', { class: 'chip', tip: (LEVELS[s.protection_level] || LEVELS.medium).tip }, 'Protection: ' + (LEVELS[s.protection_level] || LEVELS.medium).label),
        trackingChip(rt)),
      h('div', { class: 'small muted card-next', title: nextLine(s) }, nextLine(s)),
      quick.length ? h('div', { class: 'sender-quick' }, h('div', { class: 'actions' }, quick)) : null,
      h('div', { class: 'actions' }, testBtn, setBtn), testNote);
  }

  SB.screens.senders = function () {
    var root = h('div'), body = h('div', null, h('div', { class: 'skeleton' }));
    function openAdd() { addModal(load); }
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Sending accounts' }), h('p', { class: 'sub', text: 'The email accounts SenderBolt sends from. Emails rotate evenly across active accounts.' })),
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: openAdd } }, SB.icon('plus'), 'Add sender')));
    root.appendChild(body);

    function render(r) {
      var senders = r[0].items, tracking = {};
      r[1].senders.forEach(function (x) { tracking[x.id] = x; });
      if (!senders.length) {
        SB.mount(body, h('div', { class: 'card empty' }, h('h2', { text: 'Connect your first Gmail account' }),
          h('p', { text: 'SenderBolt sends from your own accounts using a Google App Password. It takes about two minutes.' }),
          h('button', { class: 'btn btn-primary', type: 'button', on: { click: openAdd } }, SB.icon('plus'), 'Add sender')));
        return;
      }
      var active = 0, capToday = 0, sent = 0;
      senders.forEach(function (s) { sent += s.sent_today; if (isActiveNow(s)) { active++; capToday += s.limit_today; } });
      var avail = Math.max(0, capToday - sent), pct = capToday ? Math.min(100, Math.round(sent / capToday * 100)) : 0, fill = h('div', { class: 'usage-fill' });
      fill.style.width = pct + '%';
      var tiles = h('div', { class: 'card usage-card' }, h('div', { class: 'glance-h' }, h('span', { text: 'Sending limits' }), ui.info('How much your active accounts can still send today, including warm-up limits. It resets every day at midnight UTC.')),
        h('div', { class: 'muted small', text: 'Today\u2019s usage' }), h('div', { class: 'usage-bar', role: 'img', 'aria-label': pct + ' percent of today\u2019s capacity used' }, fill),
        h('div', { class: 'usage-legend' },
          h('div', { tip: 'Emails already sent today from all accounts.' }, h('span', { class: 'dot dot-sent' }), 'Sent', h('b', { text: fmt.num(sent) })),
          h('div', { tip: 'The most your active accounts can send today.' }, h('span', { class: 'dot dot-cap' }), 'Capacity', h('b', { text: fmt.num(capToday) })),
          h('div', { tip: 'Emails still allowed today before the limits are reached.' }, h('span', { class: 'dot dot-avail' }), 'Available', h('b', { text: fmt.num(avail) })),
          h('div', { tip: 'Accounts switched on and allowed to send: healthy ones, plus any running under Force continue.' }, h('span', { class: 'dot dot-acc' }), 'Active accounts', h('b', { text: fmt.num(active) + ' / ' + fmt.num(senders.length) }))));
      var cards = h('div', { class: 'sender-grid' }, senders.map(function (s) { var t = tracking[s.id]; return card(s, t ? t.reply_tracking : 'pending', load); }));
      var hint = h('div', { class: 'callout' }, h('b', { text: 'How limits work. ' }),
        'Every account has its own daily limit, never above ' + CAP + '. Campaigns share the work evenly between their accounts, so more accounts means more emails per day and less risk for each one.');
      SB.mount(body, h('div', null, tiles, h('div', { class: 'section-title' }, h('h2', { text: 'Your accounts' })), cards, hint));
    }
    function load() {
      return Promise.all([SB.api.get('/api/senders'), SB.api.get('/api/engine/status')]).then(render, function (e) {
        if (e.code !== 'offline') SB.mount(body, h('div', { class: 'form-error', text: SB.api.friendly(e) }));
      });
    }
    // Do not rebuild the page under an open dialog: skip refresh while an overlay is showing.
    var stop = ui.poll(function () { if (document.querySelector('.overlay')) return; return load(); }, 10000);
    return { el: root, destroy: stop };
  };
})();
