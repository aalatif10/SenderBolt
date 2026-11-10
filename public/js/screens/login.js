/* Sign-in and first-time setup. Passwords are cleared from the form as soon as they are sent and are
   never stored by the page. Server errors are generic by design (no account enumeration). */
(function () {
  'use strict';
  var h = SB.h;
  SB.screens = SB.screens || {};

  SB.screens.auth = function (mode, done) {
    var setup = mode === 'setup';
    var email = h('input', { class: 'input', type: 'email', id: 'f-email', autocomplete: 'username', required: true, maxlength: 254 });
    var pw = h('input', { class: 'input', type: 'password', id: 'f-pw', autocomplete: setup ? 'new-password' : 'current-password', required: true, maxlength: 200 });
    var token = setup ? h('input', { class: 'input', type: 'password', id: 'f-token', autocomplete: 'off', maxlength: 200 }) : null;
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit' }, setup ? 'Create account' : 'Sign in');

    function showError(msg) { err.textContent = msg; err.classList.remove('hidden'); }
    function field(label, input, hint) { return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint', text: hint }) : null); }

    var form = h('form', { novalidate: true }, err,
      field('Email', email),
      field('Password', pw, setup ? 'At least 12 characters. A short sentence works well.' : null),
      setup ? field('Setup token', token, 'Find it in your .env file as SENDERBOLT_SETUP_TOKEN (leave empty if you did not set one).') : null,
      btn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.classList.add('hidden');
      var creds = { email: email.value.trim(), password: pw.value };
      if (!creds.email || !creds.password) return showError('Enter your email and password.');
      btn.disabled = true;
      var p = setup ? SB.api.post('/api/auth/setup', { email: creds.email, password: creds.password, setupToken: token.value.trim() }, { noAuthRedirect: true }) : Promise.resolve();
      p.then(function () { return SB.api.post('/api/auth/login', creds, { noAuthRedirect: true }); }).then(function (r) {
        pw.value = ''; SB.api.setCsrf(r.csrfToken); done(r.user);
      }, function (e) {
        pw.value = '';
        var extra = e.details && typeof e.details === 'object' ? Object.keys(e.details).map(function (k) { return [].concat(e.details[k]).join(' '); }).join(' ') : '';
        showError(SB.api.friendly(e) + (e.code === 'validation' && extra ? ' ' + extra : ''));
        btn.disabled = false; pw.focus();
      });
    });

    return h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, SB.icon('bolt')), 'SenderBolt'),
      h('h1', { text: setup ? 'Welcome! Create your account' : 'Sign in' }),
      h('p', { class: 'sub', text: setup ? 'This is a one-time step. Your account stays on your own computer.' : 'Welcome back.' }),
      form));
  };
})();
