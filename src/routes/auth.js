'use strict';
var audit = require('../services/audit');
// Auth routes: /api/auth/*  (status, setup, login, logout, me, password)
var cookies = require('../lib/cookies');
var tokens = require('../lib/tokens');
var AppError = require('../lib/errors').AppError;
var reply = require('../http/router').reply;

function str(v, max) { return typeof v === 'string' && v.length <= max ? v : ''; }

module.exports = function register(router, d) {
  var cookieName = d.cookieName, secure = d.config.secureCookies;

  router.get('/api/auth/status', { auth: false }, function () {
    return d.auth.needsSetup().then(function (needsSetup) { return { needsSetup: needsSetup }; });
  });

  // One-time owner creation. Optional SENDERBOLT_SETUP_TOKEN stops a stranger from
  // claiming the instance first when it is deployed on a public address.
  router.post('/api/auth/setup', { auth: false }, function (ctx) {
    if (d.config.setupToken && !tokens.safeEqual(str(ctx.body.setupToken, 200), d.config.setupToken)) {
      return Promise.reject(new AppError('forbidden', 'Invalid setup token', 403));
    }
    return d.auth.createUser(str(ctx.body.email, 254), str(ctx.body.password, 200), ctx.ip).then(function (u) {
      return reply(201, { user: u });
    });
  });

  router.post('/api/auth/login', { auth: false }, function (ctx) {
    return d.auth.login(str(ctx.body.email, 254), str(ctx.body.password, 200), { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] })
      .then(function (r) {
        return reply(200, { user: r.user, csrfToken: r.csrfToken },
          { cookies: [cookies.serialize(cookieName, r.token, { secure: secure, maxAgeSec: r.maxAgeSec })] });
      });
  });

  router.post('/api/auth/logout', function (ctx) {
    return d.auth.logout(ctx.sessionToken, ctx.user.id, ctx.ip).then(function () {
      return reply(200, { ok: true }, { cookies: [cookies.clear(cookieName, { secure: secure })] });
    });
  });

  router.get('/api/auth/me', function (ctx) {
    return { user: ctx.user, csrfToken: ctx.session.csrfToken };
  });

  router.post('/api/auth/password', function (ctx) {
    return d.auth.changePassword(ctx.user.id, str(ctx.body.currentPassword, 200), str(ctx.body.newPassword, 200), ctx.sessionToken, ctx.ip)
      .then(function () { return { ok: true }; });
  });

  // Active sign-ins (this and other devices) and a way to end all the others.
  router.get('/api/auth/sessions', function (ctx) {
    return d.sessions.listForUser(ctx.user.id, ctx.sessionToken).then(function (items) { return { items: items }; });
  });
  router.post('/api/auth/sessions/revoke-others', function (ctx) {
    return d.sessions.destroyAllForUser(ctx.user.id, ctx.sessionToken).then(function (r) {
      return audit.log(d.db, { userId: ctx.user.id, action: 'sessions.revoke_others', ip: ctx.ip }, d.config.now).then(function () { return { ok: true, ended: r && r.changes ? r.changes : 0 }; });
    });
  });
  // Recent account activity (audit trail, secrets already redacted when written).
  router.get('/api/auth/activity', function (ctx) {
    return d.db.all('SELECT action, entity, entity_id, ip, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50', [ctx.user.id]).then(function (items) { return { items: items }; });
  });
};
