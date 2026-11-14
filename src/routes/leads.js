'use strict';
// Leads routes: folders, import, listing, stats, export, delete, verify, suppression.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

module.exports = function register(router, d) {
  var L = d.leads;
  var verifyLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 12 }) };
  var importLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 20 }) };
  var BIG = 13000000;   // body cap for imports (data itself capped at 12M chars)

  router.get('/api/folders', function (ctx) { return L.listFolders(ctx.user.id).then(function (items) { return { items: items }; }); });
  router.post('/api/folders', function (ctx) { return L.createFolder(ctx.user.id, ctx.body.name).then(function (f) { return reply(201, { folder: f }); }); });
  router.patch('/api/folders/:id', function (ctx) { return L.renameFolder(ctx.user.id, parseId(ctx.params.id), ctx.body.name).then(function (f) { return { folder: f }; }); });
  router.delete('/api/folders/:id', function (ctx) { return L.deleteFolder(ctx.user.id, parseId(ctx.params.id), ctx.ip); });

  router.get('/api/folders/:id/stats', function (ctx) { return L.stats(ctx.user.id, parseId(ctx.params.id)).then(function (s) { return { stats: s }; }); });
  router.get('/api/folders/:id/leads', function (ctx) { return L.listLeads(ctx.user.id, parseId(ctx.params.id), ctx.query); });
  router.get('/api/folders/:id/lead-ids', function (ctx) { return L.leadIds(ctx.user.id, parseId(ctx.params.id), ctx.query); });
  router.post('/api/folders/:id/import', { maxBody: BIG, limit: importLimit }, function (ctx) {
    return L.importLeads(ctx.user.id, parseId(ctx.params.id), ctx.body.format, ctx.body.data, ctx.ip).then(function (r) { return reply(201, { result: r }); });
  });
  router.get('/api/folders/:id/export', function (ctx) {
    return L.exportCsv(ctx.user.id, parseId(ctx.params.id)).then(function (csvText) {
      return reply(200, csvText, { raw: true, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' } });
    });
  });

  router.get('/api/stats', function (ctx) { return L.stats(ctx.user.id, null).then(function (s) { return { stats: s }; }); });
  router.post('/api/leads/delete', function (ctx) { return L.deleteLeads(ctx.user.id, ctx.body.ids, ctx.ip); });
  router.post('/api/leads/move', function (ctx) { return L.moveLeads(ctx.user.id, ctx.body.ids, ctx.body.folder_id, ctx.ip); });
  router.post('/api/leads/verify', { limit: verifyLimit }, function (ctx) { return L.verifyLeads(ctx.user.id, ctx.body.ids, ctx.ip); });

  router.get('/api/suppression', function (ctx) { return L.listSuppression(ctx.user.id, ctx.query.page, ctx.query.pageSize); });
  router.post('/api/suppression', function (ctx) { return L.addSuppression(ctx.user.id, ctx.body.emails, ctx.body.reason).then(function (r) { return reply(201, r); }); });
  router.post('/api/suppression/remove', function (ctx) { return L.removeSuppression(ctx.user.id, ctx.body.email); });
};
