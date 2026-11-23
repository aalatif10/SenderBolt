'use strict';
// Inbox routes: /api/inbox/*, plus engine status and sender connection test.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;
var AppError = require('../lib/errors').AppError;

module.exports = function register(router, d) {
  var I = d.inbox;
  var replyLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 20 }) };
  var syncLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 6 }) };
  var testLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 60000, max: 10 }) };

  router.get('/api/inbox', function (ctx) { return I.list(ctx.user.id, ctx.query); });
  router.get('/api/inbox/threads/:id', function (ctx) { return I.thread(ctx.user.id, parseId(ctx.params.id)); });
  router.get('/api/inbox/messages/:id/html', function (ctx) {
    return I.replyHtml(ctx.user.id, parseId(ctx.params.id)).then(function (page) {
      // Own, stricter policy: nothing loads or runs (no script, image, font, frame or form); "sandbox" makes it a unique origin; only our own app may frame it.
      return reply(200, page, { raw: true, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'",
        'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'private, no-store' } });
    });
  });
  router.post('/api/inbox/threads/:id/read', function (ctx) { return I.markRead(ctx.user.id, parseId(ctx.params.id), ctx.body.read !== false); });
  router.post('/api/inbox/threads/:id/reply', { limit: replyLimit, maxBody: 60000 }, function (ctx) {
    return I.reply(ctx.user.id, parseId(ctx.params.id), ctx.body, ctx.ip).then(function (r) { return reply(201, r); });
  });
  router.post('/api/inbox/threads/:id/outcome', function (ctx) { return I.setOutcome(ctx.user.id, parseId(ctx.params.id), ctx.body.outcome === undefined ? null : ctx.body.outcome, ctx.ip); });
  router.post('/api/inbox/threads/:id/stop', function (ctx) { return I.stopLead(ctx.user.id, parseId(ctx.params.id), ctx.ip); });
  router.post('/api/inbox/messages/:id/sentiment', function (ctx) { return I.setSentiment(ctx.user.id, parseId(ctx.params.id), ctx.body.sentiment, ctx.ip); });

  router.post('/api/inbox/sync', { limit: syncLimit }, function (ctx) {
    if (!d.inboxSync) throw new AppError('unavailable', 'Reply checking is not available', 503);
    return d.inboxSync.syncAll(ctx.user.id);
  });

  router.get('/api/engine/status', function (ctx) { return d.engineStatus(ctx.user.id); });

  router.post('/api/senders/:id/test', { limit: testLimit }, function (ctx) { return d.senderTest.run(ctx.user.id, parseId(ctx.params.id)); });
};
