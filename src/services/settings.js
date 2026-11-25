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

// System preferences: defaults the campaign wizard starts from. Whitelisted keys only, each range-checked.
var v = require('../lib/validate');
var PREF_DEFAULTS = { window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, weekdays_only: 1, stop_on_reply: 1, track_opens: 0, default_delay_days: 3, priority_mode: 'followups_first',
  // System guardrail: when on, NO campaign sends outside these hours/days, whatever its own window says.
  guard_enabled: 0, guard_start_hour: 8, guard_end_hour: 20, guard_utc_offset_min: 0, guard_weekdays_only: 0 };
var PRIORITY_MODES = ['followups_first', 'balanced', 'new_first'];
function cleanPrefs(input) {
  var o = Object.assign({}, PREF_DEFAULTS);
  function num(k, lo, hi) {
    if (input[k] === undefined) return;
    var n = v.intIn(input[k], lo, hi);
    if (n === null) throw new AppError('validation', 'Invalid value for ' + k.replace(/_/g, ' '), 400, { prefs: k });
    o[k] = n;
  }
  function flag(k) {
    if (input[k] === undefined) return;
    if (input[k] !== true && input[k] !== false && input[k] !== 0 && input[k] !== 1) throw new AppError('validation', 'Invalid value for ' + k.replace(/_/g, ' '), 400, { prefs: k });
    o[k] = input[k] ? 1 : 0;
  }
  num('window_start_hour', 0, 23); num('window_end_hour', 1, 24); num('utc_offset_min', -720, 840); num('default_delay_days', 1, 60);
  num('guard_start_hour', 0, 23); num('guard_end_hour', 1, 24); num('guard_utc_offset_min', -720, 840);
  flag('weekdays_only'); flag('stop_on_reply'); flag('track_opens'); flag('guard_enabled'); flag('guard_weekdays_only');
  if (input.priority_mode !== undefined) {
    if (PRIORITY_MODES.indexOf(input.priority_mode) === -1) throw new AppError('validation', 'Priority must be one of: ' + PRIORITY_MODES.join(', '), 400, { prefs: 'priority_mode' });
    o.priority_mode = input.priority_mode;
  }
  if (o.window_end_hour <= o.window_start_hour) throw new AppError('validation', 'The sending window must end after it starts', 400, { prefs: 'window_end_hour' });
  if (o.guard_end_hour <= o.guard_start_hour) throw new AppError('validation', 'The guardrail window must end after it starts', 400, { prefs: 'guard_end_hour' });
  return o;
}
// The guardrail as a window object (same shape as a campaign window), or null when it is switched off.
function guardOf(prefs) {
  if (!prefs || !prefs.guard_enabled) return null;
  return { window_start_hour: prefs.guard_start_hour, window_end_hour: prefs.guard_end_hour, utc_offset_min: prefs.guard_utc_offset_min, weekdays_only: prefs.guard_weekdays_only, active_days: 0 };
}
function loadGuard(db, userId) {
  return db.get('SELECT prefs FROM user_settings WHERE user_id = ?', [userId]).then(function (r) { return guardOf(readPrefs(r && r.prefs)); });
}
function readPrefs(raw) {
  var o = null;
  try { o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
  try { return cleanPrefs(o && typeof o === 'object' ? o : {}); } catch (e) { return Object.assign({}, PREF_DEFAULTS); }
}

var SEEN_KEY = /^[pcse]:[0-9]{1,12}:[a-z_]{1,20}$/;
function readSeen(raw) {
  var a = null;
  try { a = raw ? JSON.parse(raw) : null; } catch (e) { a = null; }
  return Array.isArray(a) ? a.filter(function (k) { return typeof k === 'string' && SEEN_KEY.test(k); }).slice(0, 200) : [];
}

// Home 'Campaign health': remember which alerts were reviewed. The client sends the keys it is showing; anything that is not
// shown any more is dropped, so a problem that comes back counts as new again.
S.setHealthSeen = function (userId, keys) { return this._setAlertList(userId, keys, 'health_seen'); };
// Same, for alerts the owner dismissed (hidden until the problem goes away and comes back).
S.setHealthDismissed = function (userId, keys) { return this._setAlertList(userId, keys, 'health_dismissed'); };
S._setAlertList = function (userId, keys, col) {
  var self = this, t = this.now();
  if (!Array.isArray(keys) || keys.length > 200 || !keys.every(function (k) { return typeof k === 'string' && SEEN_KEY.test(k); })) return Promise.reject(new AppError('validation', 'Invalid alert list', 400, { keys: 'Invalid' }));
  var uniq = keys.filter(function (k, i) { return keys.indexOf(k) === i; });
  return this.db.get('SELECT 1 AS x FROM user_settings WHERE user_id = ?', [userId]).then(function (ex) {
    if (!ex) return self.db.run('INSERT INTO user_settings (user_id, updated_at) VALUES (?,?)', [userId, t]);
  }).then(function () { return self.db.run('UPDATE user_settings SET ' + col + ' = ? WHERE user_id = ?', [JSON.stringify(uniq), userId]); })   // col is one of two fixed names, never user input
    .then(function () { var o = {}; o[col] = uniq; return o; });
};

S.get = function (userId) {
  return this.db.get('SELECT default_signature_html, prefs, health_seen, health_dismissed, updated_at FROM user_settings WHERE user_id = ?', [userId]).then(function (r) {
    return { settings: { default_signature_html: r ? r.default_signature_html : null, prefs: readPrefs(r && r.prefs), health_seen: readSeen(r && r.health_seen), health_dismissed: readSeen(r && r.health_dismissed), updated_at: r ? r.updated_at : null } };
  });
};

// Partial update: send default_signature_html and/or prefs; whatever is left out stays as it was.
S.update = function (userId, input, ip) {
  var self = this, t = this.now();
  input = input || {};
  var hasSig = Object.prototype.hasOwnProperty.call(input, 'default_signature_html'), clean = null, prefs = null;
  try {
    if (hasSig) {
      var sig = input.default_signature_html;
      if (sig !== null && typeof sig !== 'string') throw new AppError('validation', 'Signature must be text', 400, { default_signature_html: 'Invalid' });
      clean = sig === null ? null : sanitize.clean(sig.slice(0, 50000));
      if (clean !== null && sanitize.isBlank(clean)) clean = null;
      if (clean !== null && clean.length > MAX_SIG) throw new AppError('validation', 'Signature is too long (max ' + MAX_SIG + ' characters)', 400, { default_signature_html: 'Too long' });
    }
    if (input.prefs !== undefined) {
      if (!input.prefs || typeof input.prefs !== 'object' || Array.isArray(input.prefs)) throw new AppError('validation', 'Preferences are invalid', 400, { prefs: 'Invalid' });
      prefs = cleanPrefs(input.prefs);
    }
    if (!hasSig && prefs === null) throw new AppError('validation', 'Nothing to save', 400);
  } catch (e) { return Promise.reject(e); }
  return this.db.get('SELECT 1 AS x FROM user_settings WHERE user_id = ?', [userId]).then(function (ex) {
    if (!ex) return self.db.run('INSERT INTO user_settings (user_id, updated_at) VALUES (?,?)', [userId, t]);
  }).then(function () {
    var sets = ['updated_at = ?'], p = [t];
    if (hasSig) { sets.push('default_signature_html = ?'); p.push(clean); }
    if (prefs !== null) { sets.push('prefs = ?'); p.push(JSON.stringify(prefs)); }
    return self.db.run('UPDATE user_settings SET ' + sets.join(', ') + ' WHERE user_id = ?', p.concat([userId]));
  }).then(function () { return audit.log(self.db, { userId: userId, action: hasSig ? 'settings.signature' : 'settings.prefs', ip: ip, meta: hasSig ? { set: clean !== null } : {} }, self.now); })
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

module.exports = { SettingsService: SettingsService, withSignature: withSignature, readPrefs: readPrefs, guardOf: guardOf, loadGuard: loadGuard, PRIORITY_MODES: PRIORITY_MODES };
