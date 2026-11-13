'use strict';
// Server-side sessions. The cookie holds a random 256-bit token; only its SHA-256
// is stored, so a database leak does not yield usable session cookies.
// Idle timeout + absolute lifetime + per-user session cap.
var tokens = require('../lib/tokens');

var MAX_SESSIONS_PER_USER = 10;

function Sessions(db, opts) {
  if (!opts || typeof opts.secret !== 'string' || opts.secret.length < 32) {
    throw new Error('Sessions: secret must be at least 32 characters');
  }
  this.db = db;
  this.secret = opts.secret;
  this.idleMs = opts.idleMs || 2 * 60 * 60 * 1000;
  this.absoluteMs = opts.absoluteMs || 12 * 60 * 60 * 1000;
  this.now = opts.now || Date.now;
}

Sessions.prototype.csrfFor = function (tokenHash) { return tokens.hmac(this.secret, 'csrf:' + tokenHash); };

Sessions.prototype.create = function (userId, ip, userAgent) {
  var self = this, t = this.now();
  var token = tokens.randomToken(32), hash = tokens.sha256hex(token);
  return this.db.run(
    'INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
    [userId, hash, t, t, t + this.absoluteMs, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 256) : null]
  ).then(function () {
    return self.db.run(
      'DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ' + MAX_SESSIONS_PER_USER + ')',
      [userId, userId]);
  }).then(function () {
    return { token: token, csrfToken: self.csrfFor(hash), maxAgeSec: Math.floor(self.absoluteMs / 1000) };
  });
};

// Resolves to { sessionId, userId, email, role, csrfToken } or null.
Sessions.prototype.validate = function (token) {
  var self = this;
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return Promise.resolve(null);
  var hash = tokens.sha256hex(token), t = this.now();
  return this.db.get(
    'SELECT s.id, s.user_id, s.last_seen_at, s.expires_at, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    [hash]
  ).then(function (row) {
    if (!row) return null;
    if (row.expires_at <= t || t - row.last_seen_at > self.idleMs) {
      return self.db.run('DELETE FROM sessions WHERE id = ?', [row.id]).then(function () { return null; });
    }
    var touch = t - row.last_seen_at > 60000
      ? self.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [t, row.id])
      : Promise.resolve();
    return touch.then(function () {
      return { sessionId: row.id, userId: row.user_id, email: row.email, role: row.role, csrfToken: self.csrfFor(hash) };
    });
  });
};

Sessions.prototype.destroy = function (token) {
  return this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokens.sha256hex(token)]);
};

// Log out everywhere (optionally keeping the current session), e.g. after a password change.
Sessions.prototype.destroyAllForUser = function (userId, exceptToken) {
  if (exceptToken) {
    return this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, tokens.sha256hex(exceptToken)]);
  }
  return this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
};

// The user's active sessions (never the token or its hash). `current` marks the one making the request.
Sessions.prototype.listForUser = function (userId, currentToken) {
  var cur = currentToken ? tokens.sha256hex(currentToken) : null, t = this.now();
  return this.db.all('SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', [userId, t]).then(function (rows) {
    return rows.map(function (r) { return { current: r.token_hash === cur, created_at: r.created_at, last_seen_at: r.last_seen_at, expires_at: r.expires_at, ip: r.ip, user_agent: r.user_agent ? String(r.user_agent).slice(0, 160) : null }; });
  });
};

Sessions.prototype.purgeExpired = function () {
  var t = this.now();
  return this.db.run('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at < ?', [t, t - this.idleMs]);
};

module.exports = { Sessions: Sessions };
