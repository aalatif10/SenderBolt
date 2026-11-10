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
  var HEALTH_TIP = 'A 0-100 score based on recent bounces and send failures. 90+ is excellent, below 50 and SenderBolt pauses this account automatically to protect it.';

  function state(s) {
    if (s.status === 'disabled') return { key: 'draft', label: 'Disabled', tip: 'This account is switched off and will never be used.' };
    if (s.status === 'paused') return { key: 'paused', label: 'Paused', tip: s.last_error ? 'Paused automatically: ' + s.last_error : 'Nothing is sent from this account until you resume it.' };
    if (s.health_score < 50) return { key: 'error', label: 'Needs attention', tip: 'The health score is very low, so this account is not used until it recovers.' };
    if (s.warmup_enabled && s.limit_today < s.daily_limit) return { key: 'active', label: 'Warming up', tip: 'New accounts start with a small daily amount that grows each day. Today: up to ' + s.limit_today + ' emails.' };
    return { key: 'active', label: 'Active', tip: 'Ready to send.' };
  }
  function pill(st) { return h('span', { class: 'pill pill-' + st.key, tip: st.tip }, st.label); }

  function trackingChip(rt) {
    var map = {
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
      field('Emails per day', limit, 'New accounts should start low. The absolute maximum is ' + CAP + ' per day, which keeps a safe buffer under Gmail\'s own limit.', 'as-limit'));
    ui.modal({ title: 'Add a sender', body: body, actions: [
      { label: 'Cancel' },
      { label: 'Add and test connection', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        var lim = num(limit);
        if (!isFinite(lim) || lim < 1 || lim > CAP) { err.textContent = 'Emails per day must be between 1 and ' + CAP + '.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
        var payload = { label: email.value.trim(), email: email.value, provider: provider, password: pass.value, from_name: name.value, daily_limit: lim, warmup_enabled: true };
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
      h('p', { class: 'muted', text: sender.email }), testResult(result),
      ok ? null : h('p', { class: 'small muted', text: 'Check the App Password and that 2-Step Verification is on, then open the sender and test again.' })),
      actions: [{ label: 'Done', kind: 'primary' }] });
  }

  function runTest(s, btn, after) {
    btn.disabled = true; var old = btn.textContent; btn.textContent = 'Testing…';
    return SB.api.post('/api/senders/' + s.id + '/test', {}).then(function (r) { showTest(s, r); after(); }, function (e) { ui.toast(SB.api.friendly(e), true); })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ---- settings slide-over -----------------------------------------------------------------
  function settingsPanel(s, onDone) {
    var p = ui.panel(s.email), err = h('div', { class: 'form-error hidden', role: 'alert' });
    var name = h('input', { class: 'input', id: 'st-name', maxlength: 80, value: s.from_name || '' });
    var limit = h('input', { class: 'input', id: 'st-limit', type: 'number', min: 1, max: CAP, value: s.daily_limit });
    var warm = h('input', { type: 'checkbox', id: 'st-warm' }); warm.checked = !!s.warmup_enabled;
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

    var usage = h('div', { class: 'usage' },
      h('div', { class: 'usage-top' }, h('span', { text: 'Today' }), h('b', { text: fmt.num(s.sent_today) + ' of ' + fmt.num(s.limit_today) })), ui.progress(s.limit_today ? s.sent_today / s.limit_today * 100 : 0));

    var save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save changes');
    save.addEventListener('click', function () {
      err.classList.add('hidden');
      var lim = num(limit);
      if (!isFinite(lim) || lim < 1 || lim > CAP) { err.textContent = 'Emails per day must be between 1 and ' + CAP + '.'; err.classList.remove('hidden'); return; }
      var body = { from_name: name.value, daily_limit: lim, warmup_enabled: warm.checked, delay_mode: mode.value, signature_html: textToSig(sig.value), tracking_domain: track.value.trim() };
      if (mode.value === 'random') { body.delay_min_sec = num(dmin); body.delay_max_sec = num(dmax); } else body.delay_fixed_sec = num(dfix);
      if (newPass.value) body.password = newPass.value;
      save.disabled = true;
      SB.api.patch('/api/senders/' + s.id, body).then(function () { p.close(); ui.toast('Saved'); onDone(); }, function (e) { fieldErrors(err, e); save.disabled = false; });
    });

    var isPaused = s.status !== 'active';
    var toggle = h('button', { class: 'btn', type: 'button' }, SB.icon(isPaused ? 'play' : 'pause'), isPaused ? 'Resume sending' : 'Pause sending');
    toggle.addEventListener('click', function () {
      SB.api.post('/api/senders/' + s.id + '/status', { status: isPaused ? 'active' : 'paused' }).then(function () { p.close(); ui.toast(isPaused ? 'Resumed' : 'Paused'); onDone(); }, function (e) { ui.toast(SB.api.friendly(e), true); });
    });
    var del = h('button', { class: 'btn btn-danger', type: 'button' }, 'Remove sender');
    del.addEventListener('click', function () {
      ui.confirm({ title: 'Remove ' + s.email + '?', message: 'The account is disconnected and its saved password is deleted. Emails already sent are not affected.', confirmLabel: 'Remove', danger: true,
        onConfirm: function () { return SB.api.del('/api/senders/' + s.id).then(function () { p.close(); ui.toast('Sender removed'); onDone(); }); } });
    });

    p.body.appendChild(h('div', { class: 'panel-pad' }, err, usage,
      h('div', { class: 'actions pad-b' }, toggle),
      h('h3', { class: 'sub-h', text: 'Sending' }),
      field('Name shown to recipients', name, null, 'st-name'),
      field('Emails per day', limit, 'Maximum ' + CAP + '. Gmail allows about 500 per day, so ' + CAP + ' keeps a safe 100-email buffer and protects your account.', 'st-limit'),
      h('div', { class: 'field check' }, warm, h('label', { for: 'st-warm' }, 'Warm-up: start small and grow daily'),
        h('div', { class: 'hint', text: 'Recommended for new or rarely used accounts. The daily amount ramps up automatically until it reaches your limit.' })),
      field('Pause between emails', mode, 'Random pauses look like a human. Very short pauses can trigger spam filters.', 'st-mode'), randBox, fixBox,
      h('h3', { class: 'sub-h', text: 'Signature' }),
      field('Added to the end of every email', sig, 'Plain text. Line breaks are kept.', 'st-sig'),
      h('h3', { class: 'sub-h', text: 'Advanced' }),
      field('Tracking domain', track, 'Only needed if you use a custom domain for unsubscribe links.', 'st-track'),
      field('Replace App Password', newPass, 'Use this if Google revoked the old one.', 'st-pass'),
      h('div', { class: 'panel-foot' }, save, del)));
  }

  // ---- cards -------------------------------------------------------------------------------
  function card(s, rt, onDone) {
    var st = state(s), hi = healthInfo(s.health_score);
    var pct = s.limit_today ? s.sent_today / s.limit_today * 100 : 0;
    var testBtn = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Logs in to this account right now to check that sending and reply detection work.' }, 'Test connection');
    testBtn.addEventListener('click', function () { runTest(s, testBtn, onDone); });
    var setBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Settings');
    setBtn.addEventListener('click', function () { settingsPanel(s, onDone); });
    return h('div', { class: 'card sender-card' },
      h('div', { class: 'top' }, h('div', { class: 'who' }, h('h3', { text: s.from_name || s.email }), s.from_name ? h('div', { class: 'small muted', text: s.email }) : null), pill(st)),
      h('div', { class: 'usage' },
        h('div', { class: 'usage-top' }, h('span', { class: 'small muted', text: 'Sent today' }), h('b', { tip: 'Emails sent today out of what this account may send today' + (s.warmup_enabled && s.limit_today < s.daily_limit ? ' (warm-up is still growing it toward ' + s.daily_limit + ')' : '') + '. Your absolute maximum is ' + CAP + ' per day.', text: fmt.num(s.sent_today) + ' / ' + fmt.num(s.limit_today) })),
        ui.progress(pct)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip chip-' + hi.cls, tip: HEALTH_TIP }, 'Health: ' + hi.label + ' (' + s.health_score + ')'),
        trackingChip(rt)),
      h('div', { class: 'small muted', text: s.status === 'active' && s.next_send_at ? 'Next email ' + fmt.until(s.next_send_at) : (s.last_error ? 'Last problem: ' + s.last_error : ' ') }),
      h('div', { class: 'actions' }, testBtn, setBtn));
  }

  SB.screens.senders = function () {
    var root = h('div'), body = h('div', null, h('div', { class: 'skeleton' }));
    function openAdd() { addModal(load); }
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Senders' }), h('p', { class: 'sub', text: 'The email accounts SenderBolt sends from. Emails rotate evenly across active accounts.' })),
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
      senders.forEach(function (s) { sent += s.sent_today; if (s.status === 'active' && s.health_score >= 50) { active++; capToday += s.limit_today; } });
      var tiles = h('div', { class: 'grid-tiles' },
        ui.tile('Active senders', fmt.num(active), 'of ' + fmt.num(senders.length) + ' connected', 'Accounts that are switched on and healthy enough to send.'),
        ui.tile('Capacity today', fmt.num(capToday), 'emails across active senders', 'The most your active accounts can send today, including warm-up limits.'),
        ui.tile('Sent today', fmt.num(sent), capToday ? Math.max(0, capToday - sent) + ' still available' : null, 'Emails already sent today from all accounts.'));
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
