/* App shell: boot, auth flow, sidebar, hash router, status banners. */
(function () {
  'use strict';
  var h = SB.h, root = document.getElementById('app');
  var user = null, current = null, stopStatus = null, viewEl = null, bannerEl = null, badgeEl = null, navEl = null;
  var offlineBanner = null, modeBanner = null;

  var NAV = [
    { hash: '#/', key: '', icon: 'home', label: 'Home' },
    { hash: '#/leads', key: 'leads', icon: 'users', label: 'Leads' },
    { hash: '#/senders', key: 'senders', icon: 'send', label: 'Senders' },
    { hash: '#/inbox', key: 'inbox', icon: 'inbox', label: 'Inbox' },
    { hash: '#/settings', key: 'settings', icon: 'settings', label: 'Settings' }
  ];
  function destroyCurrent() { if (current && current.destroy) current.destroy(); current = null; }

  function showAuth(mode) {
    destroyCurrent(); if (stopStatus) { stopStatus(); stopStatus = null; }
    SB.api.setCsrf(null);
    SB.mount(root, SB.screens.auth(mode, function (u) { user = u; startShell(); }));
  }
  function showFatal(e) {
    SB.mount(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' }, h('div', { class: 'brand' }, h('span', { class: 'logo' }, SB.icon('bolt')), 'SenderBolt'),
      h('h1', { text: 'Cannot connect' }), h('p', { class: 'sub', text: SB.api.friendly(e) }),
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: boot } }, 'Try again'))));
  }

  function route() {
    destroyCurrent();
    var parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
    var key = parts[0] || '';
    var screen;
    if (key === '') screen = SB.screens.home();
    else if (key === 'project' && /^\d{1,15}$/.test(parts[1] || '')) screen = SB.screens.project({ id: parts[1] });
    else if (key === 'campaign' && parts[1] === 'new' && (!parts[2] || /^\d{1,15}$/.test(parts[2])) && parts.length < 4) screen = SB.screens.wizard({ projectId: parts[2] || null, userEmail: user.email });
    else if (key === 'campaign' && parts[1] === 'draft' && /^\d{1,15}$/.test(parts[2] || '') && parts.length < 4) screen = SB.screens.wizard({ draftId: parts[2], userEmail: user.email });
    else if (key === 'inbox' && parts.length < 2) screen = SB.screens.inbox();
    else if (key === 'senders') screen = SB.screens.senders();
    else if (key === 'leads' && (!parts[1] || parts[1] === 'suppression') && parts.length < 3) screen = SB.screens.leads({ tab: parts[1] === 'suppression' ? 'suppression' : 'lists' });
    else if (key === 'settings' && parts.length < 2) screen = SB.screens.settings({ userEmail: user.email });
    else screen = { el: h('div', { class: 'card empty' }, h('h2', { text: 'Page not found' }), h('a', { class: 'btn', href: '#/' }, 'Back to Home')), destroy: function () {} };
    current = screen; SB.mount(viewEl, screen.el);
    var navKey = (key === 'project' || key === 'campaign') ? '' : key;
    Array.prototype.forEach.call(navEl.querySelectorAll('a'), function (a) { a.classList.toggle('active', a.getAttribute('data-key') === navKey); });
    window.scrollTo(0, 0);
  }

  function banner(cls, icon, text) { return h('div', { class: 'banner ' + cls, role: 'status' }, SB.icon(icon), text); }
  function setBanner(which, node) {
    var old = which === 'offline' ? offlineBanner : modeBanner;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (which === 'offline') offlineBanner = node; else modeBanner = node;
    if (node) bannerEl.appendChild(node);
  }

  function refreshStatus() {
    return Promise.all([SB.api.get('/api/engine/status'), SB.api.get('/api/inbox?limit=1')]).then(function (r) {
      var mode = r[0].mode;
      setBanner('mode', mode === 'dry-run' ? banner('banner-test', 'info', SB.S.testMode) : mode === 'off' ? banner('banner-off', 'alert', SB.S.engineOff) : null);
      SB.clear(badgeEl);
      if (r[1].unread) { badgeEl.appendChild(h('span', { class: 'pill pill-active', text: String(r[1].unread) })); }
    }, function () {});
  }

  function logout() {
    SB.api.post('/api/auth/logout', {}, { noAuthRedirect: true }).catch(function () {}).then(function () { user = null; showAuth('login'); });
  }

  function startShell() {
    navEl = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(function (n) {
      var a = h('a', { href: n.hash, 'data-key': n.key }, SB.icon(n.icon), h('span', { text: n.label }));
      if (n.key === 'inbox') { badgeEl = h('span', { class: 'badge' }); a.appendChild(badgeEl); }
      return a;
    }));
    bannerEl = h('div'); viewEl = h('div');
    var side = h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, SB.icon('bolt')), 'SenderBolt'), navEl,
      h('div', { class: 'sidebar-foot' }, h('div', { class: 'who', tip: 'Signed in as ' + user.email, text: user.email }),
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: logout } }, SB.icon('logout'), 'Sign out')));
    SB.mount(root, h('div', { class: 'shell' }, side, h('main', { class: 'main' }, bannerEl, viewEl)));
    offlineBanner = null; modeBanner = null;
    if (!location.hash) location.hash = '#/';
    route();
    stopStatus = SB.ui.poll(refreshStatus, 15000);
  }

  function boot() {
    SB.mount(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'skeleton auth-card' })));
    SB.api.get('/api/auth/status', { noAuthRedirect: true }).then(function (s) {
      if (s.needsSetup) return showAuth('setup');
      return SB.api.get('/api/auth/me', { noAuthRedirect: true }).then(function (r) { SB.api.setCsrf(r.csrfToken); user = r.user; startShell(); },
        function (e) { if (e.status === 401) return showAuth('login'); throw e; });
    }).catch(showFatal);
  }

  SB.api.on({
    unauthorized: function () { if (user) { user = null; SB.ui.toast('Your session ended. Please sign in again.', true); showAuth('login'); } },
    offline: function () { if (bannerEl) setBanner('offline', banner('banner-offline', 'alert', 'Connection lost. Retrying automatically…')); },
    online: function () { setBanner('offline', null); }
  });
  window.addEventListener('hashchange', function () { if (user && viewEl) route(); });
  boot();
})();
