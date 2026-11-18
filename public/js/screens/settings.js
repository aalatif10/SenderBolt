/* public/js/screens/settings.js - Settings: account (password), active sign-ins, default email signature, recent activity.
   The default signature is written in the same rich-text editor as emails; the server sanitizes it again. It is used only for
   sender accounts that have no signature of their own. Wrong current password returns 401, so those calls opt out of the
   automatic "session ended" redirect. */
(function () {
  'use strict';
  var h = SB.h, ui = SB.ui, fmt = SB.fmt, T = SB.S.settings;
  SB.screens = SB.screens || {};
  var ACTIONS = { 'login.ok': 'Signed in', 'login.fail': 'Failed sign-in attempt', 'login.locked': 'Sign-in locked after failed attempts', 'user.create': 'Account created', 'sender.status': 'Sender paused or resumed', 'campaign.update': 'Campaign edited', 'folder.delete': 'List deleted', 'leads.delete': 'Leads deleted', 'leads.import': 'Leads imported', 'leads.verify': 'Emails checked', logout: 'Signed out', 'password.change': 'Password changed', 'sessions.revoke_others': 'Signed out other devices', 'settings.signature': 'Default signature changed',
    'sender.create': 'Sender account added', 'sender.update': 'Sender account changed', 'sender.delete': 'Sender account removed', 'campaign.create': 'Campaign created', 'campaign.start': 'Campaign started', 'campaign.pause': 'Campaign paused',
    'campaign.resume': 'Campaign resumed', 'campaign.delete': 'Campaign deleted', 'project.create': 'Project created', 'project.update': 'Project changed', 'project.delete': 'Project deleted', 'test_email.send': 'Test email sent', 'inbox.reply': 'Reply sent', 'inbox.sentiment': 'Reply tag changed' };

  function device(ua) {
    ua = String(ua || '');
    var br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var os = /Windows NT 6\.1/.test(ua) ? 'Windows 7' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
    return br + ' on ' + os;
  }
  function nice(a) { return ACTIONS[a] || a.replace(/[._]/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }

  SB.screens.settings = function (params) {
    var root = h('div'), dead = false, sigEditor = null;
    var TABS = [['security', 'Security'], ['accounts', 'Sending accounts'], ['signatures', 'Signatures'], ['preferences', 'System preferences']];
    var tab = TABS.some(function (t) { return t[0] === params.tab; }) ? params.tab : 'security';
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Settings' }), h('p', { class: 'sub', text: 'Your security, sending accounts, signatures and the defaults new campaigns start from.' }))));
    root.appendChild(h('div', { class: 'segs tabs settings-tabs', role: 'tablist' }, TABS.map(function (t) {
      return h('a', { class: 'seg' + (t[0] === tab ? ' active' : ''), href: '#/settings/' + t[0], role: 'tab', 'aria-selected': t[0] === tab ? 'true' : 'false' }, t[1]);
    })));
    var grid = h('div', { class: 'st-grid' }), gridSig = h('div', { class: 'st-grid' }), gridAcc = h('div', { class: 'st-grid' }), gridPref = h('div', { class: 'st-grid' });
    var panes = { security: grid, accounts: gridAcc, signatures: gridSig, preferences: gridPref };
    Object.keys(panes).forEach(function (k) { if (k !== tab) panes[k].classList.add('hidden'); root.appendChild(panes[k]); });

    // ---- account + password ----
    var cur = h('input', { class: 'input', id: 'st-cur', type: 'password', autocomplete: 'current-password', maxlength: 200 });
    var nw = h('input', { class: 'input', id: 'st-new', type: 'password', autocomplete: 'new-password', maxlength: 200 });
    var cf = h('input', { class: 'input', id: 'st-conf', type: 'password', autocomplete: 'new-password', maxlength: 200 });
    var pwErr = h('div', { class: 'form-error hidden', role: 'alert' }), pwOk = h('div', { class: 'callout hidden', role: 'status' });
    var pwBtn = h('button', { class: 'btn btn-primary', type: 'button', id: 'st-pw-save' }, 'Change password');
    pwBtn.addEventListener('click', function () {
      pwErr.classList.add('hidden'); pwOk.classList.add('hidden');
      if (!cur.value || !nw.value) { pwErr.textContent = 'Fill in your current and new password.'; pwErr.classList.remove('hidden'); return; }
      if (nw.value !== cf.value) { pwErr.textContent = 'The new passwords do not match.'; pwErr.classList.remove('hidden'); return; }
      pwBtn.disabled = true;
      SB.api.post('/api/auth/password', { currentPassword: cur.value, newPassword: nw.value }, { noAuthRedirect: true }).then(function () {
        cur.value = ''; nw.value = ''; cf.value = ''; pwOk.textContent = 'Password changed. Other devices were signed out.'; pwOk.classList.remove('hidden'); loadSessions();
      }, function (e) {
        pwErr.textContent = e.details && e.details.password ? 'Choose a stronger password: ' + e.details.password : e.status === 401 ? 'Your current password is not correct.' : SB.api.friendly(e); pwErr.classList.remove('hidden');
      }).then(function () { pwBtn.disabled = false; });
    });
    grid.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Account' }),
      h('div', { class: 'field' }, h('label', null, 'Signed in as ', ui.info(T.accountTip)), h('div', { class: 'st-email', id: 'st-email', text: params.userEmail })),
      h('h3', { class: 'pad-b', text: 'Change password' }), pwErr, pwOk,
      h('div', { class: 'field' }, h('label', { for: 'st-cur' }, 'Current password'), cur),
      h('div', { class: 'field' }, h('label', { for: 'st-new' }, 'New password'), nw, h('div', { class: 'hint', text: T.passwordHint })),
      h('div', { class: 'field' }, h('label', { for: 'st-conf' }, 'Repeat new password'), cf), pwBtn));

    // ---- sessions ----
    var sesBox = h('div');
    function loadSessions() {
      return SB.api.get('/api/auth/sessions').then(function (r) {
        if (dead) return;
        var others = r.items.filter(function (x) { return !x.current; }).length;
        SB.mount(sesBox, h('div', null,
          h('div', { class: 'st-list' }, r.items.map(function (s) {
            return h('div', { class: 'st-row' }, h('div', null, h('b', { text: device(s.user_agent) }), s.current ? h('span', { class: 'tag tag-int', text: 'This device' }) : null,
              h('div', { class: 'small faint', text: (s.ip || 'unknown address') + ' · active ' + fmt.ago(s.last_seen_at) + ' · signed in ' + fmt.full(s.created_at) })));
          })),
          h('div', { class: 'actions pad-t' }, h('button', { class: 'btn', type: 'button', id: 'st-revoke', disabled: others ? null : true, on: { click: function () {
            ui.confirm({ title: 'Sign out other devices?', message: 'Every other browser and device is signed out immediately. This one stays signed in.', confirmLabel: 'Sign them out', onConfirm: function () {
              return SB.api.post('/api/auth/sessions/revoke-others', {}).then(function () { ui.toast('Other devices were signed out'); return loadSessions(); });
            } });
          } } }, 'Sign out other devices'))));
      }, function (e) { if (!dead) SB.mount(sesBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    grid.appendChild(h('div', { class: 'card' }, h('h2', null, 'Where you are signed in'), h('p', { class: 'muted small', text: 'If you see a device you do not recognise, sign out other devices and change your password.' }), sesBox));

    // ---- signature ----
    var sigBox = h('div', null, h('div', { class: 'skeleton' }));
    var sigBtn = h('button', { class: 'btn btn-primary', type: 'button', id: 'st-sig-save' }, 'Save signature');
    SB.api.get('/api/settings').then(function (r) {
      if (dead) return;
      sigEditor = SB.editor.create({ value: r.settings.default_signature_html || '', placeholder: 'Best regards,\nYour name', label: 'Default signature' });
      sigBtn.addEventListener('click', function () {
        sigBtn.disabled = true;
        SB.api.put('/api/settings', { default_signature_html: sigEditor.isEmpty() ? null : sigEditor.getHtml() }).then(function (res) {
          sigEditor.setHtml(res.settings.default_signature_html || ''); ui.toast('Signature saved');
        }, function (e) { ui.toast(SB.api.friendly(e), true); }).then(function () { sigBtn.disabled = false; });
      });
      SB.mount(sigBox, h('div', null, sigEditor.el, h('div', { class: 'actions pad-t' }, sigBtn)));
    }, function (e) { if (!dead) SB.mount(sigBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    gridSig.appendChild(h('div', { class: 'card st-wide' }, h('h2', null, 'Default email signature ', ui.info(T.sigTip)),
      h('p', { class: 'muted small', text: 'Added to the end of every email sent from an account that has no signature of its own. An account\'s own signature (Senders > Settings) always wins.' }), sigBox));

    // ---- activity ----
    var actBox = h('div');
    SB.api.get('/api/auth/activity').then(function (r) {
      if (dead) return;
      SB.mount(actBox, r.items.length ? h('div', { class: 'st-list' }, r.items.slice(0, 20).map(function (a) {
        return h('div', { class: 'st-row' }, h('div', null, h('b', { text: nice(a.action) }), h('div', { class: 'small faint', text: fmt.full(a.created_at) + (a.ip ? ' · ' + a.ip : '') })));
      })) : h('p', { class: 'muted', text: 'Nothing yet.' }));
    }, function (e) { if (!dead) SB.mount(actBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    grid.appendChild(h('div', { class: 'card st-wide' }, h('h2', null, 'Recent activity ', ui.info('The last actions on your account, for your own security checks.')), actBox));

    // ---- sending accounts (summary; full management stays on the Senders page) ----
    var accBox = h('div', null, h('div', { class: 'skeleton' }));
    SB.api.get('/api/senders').then(function (r) {
      if (dead) return;
      SB.mount(accBox, r.items.length ? h('div', { class: 'st-list' }, r.items.map(function (x) {
        return h('div', { class: 'st-row' }, h('div', null, h('b', null, ui.email(x.label || x.email)), x.status !== 'active' ? h('span', { class: 'tag tag-sys', text: x.status === 'paused' ? 'Paused' : 'Disabled' }) : null,
          h('div', { class: 'small faint' }, ui.email(x.email), ' \u00b7 up to ' + fmt.num(x.daily_limit) + ' emails a day' + (x.health_score !== undefined && x.health_score !== null ? ' \u00b7 health ' + x.health_score + '/100' : ''))));
      })) : h('p', { class: 'muted', text: 'No sending accounts yet.' }));
    }, function (e) { if (!dead) SB.mount(accBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    gridAcc.appendChild(h('div', { class: 'card st-wide' }, h('div', { class: 'page-head' }, h('div', null, h('h2', { text: 'Sending accounts' }), h('p', { class: 'muted small', text: 'App passwords are stored encrypted and never shown again. Daily limits (max 400), delays, warm-up and tracking domain are set per account.' })),
      h('a', { class: 'btn btn-primary', href: '#/senders' }, SB.icon('send'), 'Manage accounts')), accBox));

    // ---- system preferences: defaults new campaigns start from ----
    var P = T.prefs, prefBox = h('div', null, h('div', { class: 'skeleton' }));
    SB.api.get('/api/settings').then(function (r) {
      if (dead) return;
      var v = r.settings.prefs;
      function num(id, val, min, max) { return h('input', { class: 'input', id: id, type: 'number', min: min, max: max, value: val }); }
      function chk(id, on) { var c = h('input', { type: 'checkbox', id: id }); c.checked = !!on; return c; }
      // Sending hours are stored as 0-24 but shown and picked as clock times: "9:00 AM", "5:00 PM".
      function hourSel(id, val, lo, hi) {
        var sel = h('select', { class: 'input', id: id });
        for (var x = lo; x <= hi; x++) sel.appendChild(h('option', { value: x }, fmt.hour12(x) + (x === 24 ? ' (midnight)' : '')));
        sel.value = String(val); return sel;
      }
      var from = hourSel('pf-from', v.window_start_hour, 0, 23), to = hourSel('pf-to', v.window_end_hour, 1, 24), off = h('select', { class: 'input', id: 'pf-tz' }), delay = num('pf-delay', v.default_delay_days, 1, 60);
      for (var m = -720; m <= 840; m += 30) { off.appendChild(h('option', { value: m }, 'UTC' + (m < 0 ? '-' : '+') + Math.floor(Math.abs(m) / 60) + (Math.abs(m) % 60 ? ':30' : ''))); }
      off.value = String(v.utc_offset_min);
      var wk = chk('pf-wk', v.weekdays_only), sr = chk('pf-sr', v.stop_on_reply), to2 = chk('pf-op', v.track_opens), err = h('div', { class: 'form-error hidden', role: 'alert' });
      var save = h('button', { class: 'btn btn-primary', type: 'button', id: 'pf-save' }, 'Save preferences');
      save.addEventListener('click', function () {
        err.classList.add('hidden'); save.disabled = true;
        SB.api.put('/api/settings', { prefs: { window_start_hour: Number(from.value), window_end_hour: Number(to.value), utc_offset_min: Number(off.value), weekdays_only: wk.checked, stop_on_reply: sr.checked, track_opens: to2.checked, default_delay_days: Number(delay.value) } })
          .then(function () { ui.toast('Preferences saved'); }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); }).then(function () { save.disabled = false; });
      });
      SB.mount(prefBox, h('div', null, err, h('p', { class: 'muted small', text: P.intro }),
        h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { for: 'pf-from' }, 'Send from'), from), h('div', { class: 'field' }, h('label', { for: 'pf-to' }, 'Send until'), to)),
        h('p', { class: 'hint', text: 'Emails go out only between these times in your time zone, for example 9:00 AM to 5:00 PM.' }),
        h('div', { class: 'field' }, h('label', { for: 'pf-tz' }, 'Time zone ', ui.info(P.tzTip)), off),
        h('div', { class: 'field' }, h('label', { for: 'pf-delay' }, 'Days to wait before a follow-up'), delay),
        h('div', { class: 'field check' }, wk, h('label', { for: 'pf-wk' }, 'Skip weekends'), h('div', { class: 'hint', text: SB.S.wizard.weekdaysHint })),
        h('div', { class: 'field check' }, sr, h('label', { for: 'pf-sr' }, 'Stop follow-ups after a reply'), h('div', { class: 'hint', text: SB.S.wizard.stopHint })),
        h('div', { class: 'field check' }, to2, h('label', { for: 'pf-op' }, 'Track opens'), h('div', { class: 'hint', text: SB.S.wizard.opensHint })), save));
    }, function (e) { if (!dead) SB.mount(prefBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    gridPref.appendChild(h('div', { class: 'card st-wide' }, h('h2', { text: 'Campaign defaults' }), prefBox));

    loadSessions();
    return { el: root, destroy: function () { dead = true; } };
  };
})();
