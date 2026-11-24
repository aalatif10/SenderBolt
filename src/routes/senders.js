'use strict';
// Sender routes: /api/senders/*. All handlers are user-scoped by the service layer.
var parseId = require('../http/router').parseId;
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

module.exports = function register(router, d) {
  var s = d.senders;

  router.get('/api/senders', function (ctx) { return s.list(ctx.user.id).then(function (items) { return { items: items }; }); });

  router.post('/api/senders', function (ctx) {
    return s.create(ctx.user.id, ctx.body, ctx.ip).then(function (row) { return reply(201, { sender: row }); });
  });

  // Backup / restore of all sending accounts (encrypted file, see services/senderBackup.js). Rate limited: each call runs scrypt.
  var backupLimit = { by: 'user', limiter: new RateLimiter({ windowMs: 600000, max: 12 }) };
  var BACKUP_BODY = 2000000;
  function str(x, n) { return typeof x === 'string' ? x.slice(0, n) : ''; }
  router.post('/api/senders/backup', { limit: backupLimit }, function (ctx) {
    return d.senderBackup.export(ctx.user.id, str(ctx.body.currentPassword, 200), str(ctx.body.passphrase, 200), ctx.ip);
  });
  router.post('/api/senders/restore/preview', { maxBody: BACKUP_BODY, limit: backupLimit }, function (ctx) {
    return d.senderBackup.preview(ctx.user.id, ctx.body.file, str(ctx.body.passphrase, 200));
  });
  router.post('/api/senders/restore', { maxBody: BACKUP_BODY, limit: backupLimit }, function (ctx) {
    return d.senderBackup.restore(ctx.user.id, ctx.body.file, str(ctx.body.passphrase, 200), ctx.body.emails, ctx.ip);
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
