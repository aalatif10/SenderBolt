'use strict';
// Sender routes: /api/senders/*. All handlers are user-scoped by the service layer.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;

module.exports = function register(router, d) {
  var s = d.senders;

  router.get('/api/senders', function (ctx) { return s.list(ctx.user.id).then(function (items) { return { items: items }; }); });

  router.post('/api/senders', function (ctx) {
    return s.create(ctx.user.id, ctx.body, ctx.ip).then(function (row) { return reply(201, { sender: row }); });
  });

  router.get('/api/senders/:id', function (ctx) {
    return s.get(ctx.user.id, parseId(ctx.params.id)).then(function (row) { return { sender: row }; });
  });

  router.patch('/api/senders/:id', function (ctx) {
    return s.update(ctx.user.id, parseId(ctx.params.id), ctx.body, ctx.ip).then(function (row) { return { sender: row }; });
  });

  router.post('/api/senders/:id/status', function (ctx) {
    return s.setStatus(ctx.user.id, parseId(ctx.params.id), ctx.body.status, ctx.ip).then(function (row) { return { sender: row }; });
  });

  router.delete('/api/senders/:id', function (ctx) {
    return s.remove(ctx.user.id, parseId(ctx.params.id), ctx.ip).then(function () { return { ok: true }; });
  });
};
