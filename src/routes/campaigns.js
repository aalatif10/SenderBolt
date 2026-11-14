'use strict';
// Campaign routes: wizard (split preview, template preview), CRUD, lifecycle, dashboard list.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

module.exports = function register(router, d) {
  var testLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 600000, max: 10 }) };     // 10 test emails per 10 minutes
  var S = d.campaigns;
  var heavy = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 30 }) };
  var BODY = 700000;     // up to 6 steps x 50k chars of HTML

  router.get('/api/campaigns', function (ctx) { return S.list(ctx.user.id, ctx.query); });
  router.post('/api/campaigns', { maxBody: BODY, limit: heavy }, function (ctx) {
    return S.create(ctx.user.id, ctx.body, ctx.ip).then(function (c) { return reply(201, { campaign: c }); });
  });
  router.post('/api/campaigns/split-preview', { limit: heavy }, function (ctx) { return S.previewSplit(ctx.user.id, ctx.body); });
  router.post('/api/campaigns/variable-coverage', { maxBody: 200000, limit: heavy }, function (ctx) { return S.variableCoverage(ctx.user.id, ctx.body); });
  router.post('/api/campaigns/test-send', { maxBody: 200000, limit: testLimit }, function (ctx) { return d.testSend.send(ctx.user, ctx.body, ctx.ip); });
  router.post('/api/templates/preview', { maxBody: 200000 }, function (ctx) { return S.previewTemplate(ctx.user.id, ctx.body); });

  router.post('/api/campaigns/batch', function (ctx) { return S.batch(ctx.user.id, ctx.body, ctx.ip); });
  router.get('/api/campaigns/:id', function (ctx) { return S.get(ctx.user.id, parseId(ctx.params.id)).then(function (c) { return { campaign: c }; }); });
  router.patch('/api/campaigns/:id', { maxBody: BODY }, function (ctx) {
    return S.update(ctx.user.id, parseId(ctx.params.id), ctx.body, ctx.ip).then(function (c) { return { campaign: c }; });
  });
  router.delete('/api/campaigns/:id', function (ctx) { return S.remove(ctx.user.id, parseId(ctx.params.id), ctx.ip); });
  router.get('/api/campaigns/:id/leads', function (ctx) { return S.listLeads(ctx.user.id, parseId(ctx.params.id), ctx.query); });

  router.post('/api/campaigns/:id/start', function (ctx) { return S.start(ctx.user.id, parseId(ctx.params.id), ctx.ip).then(function (c) { return { campaign: c }; }); });
  router.post('/api/campaigns/:id/pause', function (ctx) { return S.pause(ctx.user.id, parseId(ctx.params.id), ctx.ip).then(function (c) { return { campaign: c }; }); });
  router.post('/api/campaigns/:id/resume', function (ctx) { return S.resume(ctx.user.id, parseId(ctx.params.id), ctx.ip).then(function (c) { return { campaign: c }; }); });
};
