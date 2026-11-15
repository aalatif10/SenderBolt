'use strict';
// Picture routes (src/routes/images.js): the editor's image library.
//   GET    /api/images        list (no bytes)
//   POST   /api/images        { name, data(base64) }  -> { image, existing }
//   GET    /api/images/:id    the picture itself, for the editor's own page only (session required, same-origin)
//   DELETE /api/images/:id    refused while a campaign, draft or signature still uses it
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

module.exports = function register(router, d) {
  var I = d.images;
  var uploadLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 20 }) };

  router.get('/api/images', function (ctx) { return I.list(ctx.user.id); });
  router.post('/api/images', { maxBody: 460000, limit: uploadLimit }, function (ctx) {
    return I.upload(ctx.user.id, ctx.body, ctx.ip).then(function (r) { return reply(r.existing ? 200 : 201, r); });
  });
  router.get('/api/images/:id', function (ctx) {
    return I.read(ctx.user.id, parseId(ctx.params.id)).then(function (img) {
      // The id never changes meaning (ids are never reused), so the browser may keep it; "sandbox" + no-sniff stop the bytes from ever running as a page.
      return reply(200, img.data, { raw: true, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.data.length),
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=86400, immutable', 'Content-Disposition': 'inline' } });
    });
  });
  router.delete('/api/images/:id', function (ctx) { return I.remove(ctx.user.id, parseId(ctx.params.id), ctx.ip); });
};
