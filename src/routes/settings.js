'use strict';
// Settings routes (src/routes/settings.js): GET/PUT /api/settings (default signature).
module.exports = function register(router, d) {
  router.get('/api/settings', function (ctx) { return d.settings.get(ctx.user.id); });
  router.put('/api/settings', { maxBody: 100000 }, function (ctx) { return d.settings.update(ctx.user.id, ctx.body, ctx.ip); });
};
