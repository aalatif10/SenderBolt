'use strict';
// Report routes (src/routes/reports.js)
//   GET /api/alerts                                         every error / warning for Home "Campaign health" (services/alerts.js)
//   GET /api/reports?days=30&campaign_id=&sender_id=&tz=120   everything the Reports page shows
//   GET /api/campaigns/:id/opens?limit=&offset=              who opened which email, how often, last time
var parseId = require('../http/router').parseId;

module.exports = function register(router, d) {
  router.get('/api/alerts', function (ctx) { return d.alerts.list(ctx.user.id); });   // Home "Campaign health": every problem, computed on the server
  router.get('/api/reports', function (ctx) { return d.reports.overview(ctx.user.id, ctx.query || {}); });
  router.get('/api/campaigns/:id/opens', function (ctx) { return d.reports.opens(ctx.user.id, parseId(ctx.params.id), ctx.query || {}); });
};
