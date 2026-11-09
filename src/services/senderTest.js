'use strict';
// "Test connection" for a sender: logs in to SMTP and (when configured) IMAP, and arms reply tracking.
// Errors are reduced to friendly, non-leaking messages (never the raw server text or the password).
var vault = require('../lib/vault');
var AppError = require('../lib/errors').AppError;
var sendErrors = require('../lib/sendErrors');
var friendlyError = require('../engine/inboxSync').friendlyError;

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { var e = new Error('timeout'); e.code = 'ETIMEDOUT'; reject(e); }, ms);
    if (t.unref) t.unref();
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function SenderTest(db, deps) {
  this.db = db; this.key = deps.key; this.mailer = deps.mailer; this.mailbox = deps.mailbox; this.inboxSync = deps.inboxSync;
  this.now = deps.now || Date.now;
}

SenderTest.prototype.run = function (userId, id) {
  var self = this, row, out = { smtp: { ok: false, message: '' }, imap: { ok: null, message: 'Not configured' } };
  return this.db.get('SELECT * FROM senders WHERE id = ? AND user_id = ?', [id, userId]).then(function (r) {
    if (!r) throw new AppError('not_found', 'Sender not found', 404);
    row = r;
    var pass;
    try { pass = vault.decrypt(r.password_enc, self.key, 'sender:' + r.id); }
    catch (e) { out.smtp.message = 'The saved password could not be decrypted. Re-enter the App Password.'; return out; }
    return withTimeout(self.mailer.verify({ host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure, user: r.username, pass: pass }), 30000).then(function () {
      out.smtp = { ok: true, message: 'SMTP login works' };
    }, function (e) { out.smtp = { ok: false, message: sendErrors.classify(e).message }; }).then(function () {
      if (!r.imap_host) return null;
      return withTimeout(self.mailbox.verify({ host: r.imap_host, port: r.imap_port || 993, user: r.username, pass: pass }), 30000).then(function () {
        out.imap = { ok: true, message: 'IMAP login works' };
      }, function (e) { out.imap = { ok: false, message: friendlyError(e) }; });
    });
  }).then(function () {
    if (out.imap.ok && (row.imap_last_uid === null || row.imap_last_uid === undefined) && self.inboxSync) {
      return self.inboxSync.syncSender(row).then(function (r) { if (r && r.error) out.imap = { ok: false, message: 'IMAP login works but arming reply tracking failed. Try again.' }; else out.imap.message = 'IMAP login works; reply tracking is on'; });
    }
    return null;
  }).then(function () { return out; });
};

module.exports = { SenderTest: SenderTest };
