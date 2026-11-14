'use strict';
// Project routes: /api/projects/*. Campaign analytics drill-down lives under the project it belongs to.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;

module.exports = function register(router, d) {
  var P = d.projects;
  router.get('/api/projects', function (ctx) { return P.list(ctx.user.id, ctx.query); });
  router.post('/api/projects', function (ctx) { return P.create(ctx.user.id, ctx.body, ctx.ip).then(function (p) { return reply(201, { project: p }); }); });
  router.get('/api/projects/:id', function (ctx) { return P.get(ctx.user.id, parseId(ctx.params.id)).then(function (p) { return { project: p }; }); });
  router.patch('/api/projects/:id', function (ctx) { return P.update(ctx.user.id, parseId(ctx.params.id), ctx.body, ctx.ip).then(function (p) { return { project: p }; }); });
  router.delete('/api/projects/:id', function (ctx) { return P.remove(ctx.user.id, parseId(ctx.params.id), ctx.ip); });
  router.post('/api/projects/batch', function (ctx) { return P.batch(ctx.user.id, ctx.body, ctx.ip); });
  router.get('/api/campaigns/:id/analytics', function (ctx) { return P.campaignAnalytics(ctx.user.id, parseId(ctx.params.id)); });
};
