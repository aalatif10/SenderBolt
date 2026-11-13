'use strict';
// User settings (src/services/settings.js): the default email signature.
// The signature is HTML written in the rich-text editor; it is sanitized here when saved and again whenever it is used.
// A sender's own signature wins; this default is only used for senders without one (see withSignature).
var AppError = require('../lib/errors').AppError;
var sanitize = require('../lib/sanitize');
var audit = require('./audit');

var MAX_SIG = 10000;

function SettingsService(db, deps) { this.db = db; this.now = (deps && deps.now) || Date.now; }
var S = SettingsService.prototype;

S.get = function (userId) {
  return this.db.get('SELECT default_signature_html, updated_at FROM user_settings WHERE user_id = ?', [userId]).then(function (r) {
    return { settings: { default_signature_html: r ? r.default_signature_html : null, updated_at: r ? r.updated_at : null } };
  });
};

S.update = function (userId, input, ip) {
  var self = this, t = this.now();
  input = input || {};
  var sig = input.default_signature_html;
  if (sig !== null && typeof sig !== 'string') return Promise.reject(new AppError('validation', 'Signature must be text', 400, { default_signature_html: 'Invalid' }));
  var clean = sig === null ? null : sanitize.clean(sig.slice(0, 50000));
  if (clean !== null && sanitize.isBlank(clean)) clean = null;
  if (clean !== null && clean.length > MAX_SIG) return Promise.reject(new AppError('validation', 'Signature is too long (max ' + MAX_SIG + ' characters)', 400, { default_signature_html: 'Too long' }));
  return this.db.run('INSERT INTO user_settings (user_id, default_signature_html, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET default_signature_html = excluded.default_signature_html, updated_at = excluded.updated_at', [userId, clean, t])
    .then(function () { return audit.log(self.db, { userId: userId, action: 'settings.signature', ip: ip, meta: { set: clean !== null } }, self.now); })
    .then(function () { return self.get(userId); });
};

// Returns a copy of the sender row whose signature falls back to the user's default.
function withSignature(db, userId, sender) {
  if (sender.signature_html) return Promise.resolve(sender);
  return db.get('SELECT default_signature_html FROM user_settings WHERE user_id = ?', [userId]).then(function (r) {
    if (!r || !r.default_signature_html) return sender;
    return Object.assign({}, sender, { signature_html: r.default_signature_html });
  });
}

module.exports = { SettingsService: SettingsService, withSignature: withSignature };
