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
    root.appendChild(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Settings' }), h('p', { class: 'sub', text: 'Your account, security and the signature added to your emails.' }))));
    var grid = h('div', { class: 'st-grid' }); root.appendChild(grid);

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
    grid.appendChild(h('div', { class: 'card st-wide' }, h('h2', null, 'Default email signature ', ui.info(T.sigTip)),
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

    loadSessions();
    return { el: root, destroy: function () { dead = true; } };
  };
})();
