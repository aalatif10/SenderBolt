'use strict';
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
};
