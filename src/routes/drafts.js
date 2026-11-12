'use strict';
// Wizard draft routes (src/routes/drafts.js): /api/drafts/* -- autosave of the Campaign Builder.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

module.exports = function register(router, d) {
  var S = d.drafts;
  var limiter = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 120 }) };   // autosave every few seconds is fine
  var BODY = 700000;

  router.get('/api/drafts', function (ctx) { return S.list(ctx.user.id, ctx.query); });
  router.post('/api/drafts', { maxBody: BODY, limit: limiter }, function (ctx) { return S.create(ctx.user.id, ctx.body).then(function (r) { return reply(201, r); }); });
  router.get('/api/drafts/:id', function (ctx) { return S.get(ctx.user.id, parseId(ctx.params.id)); });
  router.put('/api/drafts/:id', { maxBody: BODY, limit: limiter }, function (ctx) { return S.save(ctx.user.id, parseId(ctx.params.id), ctx.body); });
  router.delete('/api/drafts/:id', function (ctx) { return S.remove(ctx.user.id, parseId(ctx.params.id)); });
};
