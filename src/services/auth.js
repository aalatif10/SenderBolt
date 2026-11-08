'use strict';
// Authentication: first-user bootstrap, login with layered brute-force defence
// (per-IP and per-account rate limits + escalating account lockout), generic
// error messages (no user enumeration), constant-ish timing for unknown users.
var password = require('../lib/password');
var email = require('../lib/email');
var cookies = require('../lib/cookies');
var AppError = require('../lib/errors').AppError;
var audit = require('./audit');

var MAX_FAILS = 5;
var BASE_LOCK_MS = 15 * 60 * 1000;
var MAX_LOCK_MS = 24 * 60 * 60 * 1000;

var dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = password.hashAsync('dummy-password-for-timing-only');
  return dummyHashPromise;
}

function invalid() { return new AppError('invalid_credentials', 'Invalid email or password', 401); }

function Auth(db, sessions, opts) {
  opts = opts || {};
  this.db = db;
  this.sessions = sessions;
  this.allowRegistration = !!opts.allowRegistration;
  this.now = opts.now || Date.now;
  this.ipLimiter = opts.ipLimiter || null;
  this.emailLimiter = opts.emailLimiter || null;
}

Auth.validatePasswordPolicy = function (addr, pw) {
  var errors = [];
  if (typeof pw !== 'string' || pw.length < 12) errors.push('Password must be at least 12 characters');
  else {
    if (pw.length > 200) errors.push('Password is too long');
    if (/^(.)\1+$/.test(pw)) errors.push('Password cannot be a single repeated character');
    var local = String(addr || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && pw.toLowerCase().indexOf(local) !== -1) errors.push('Password must not contain your email name');
  }
  return errors;
};

Auth.prototype.needsSetup = function () {
  return this.db.get('SELECT COUNT(*) AS c FROM users').then(function (r) { return r.c === 0; });
};

Auth.prototype.createUser = function (rawEmail, pw, ip) {
  var self = this, addr = email.normalize(rawEmail);
  var syntax = email.checkSyntax(addr);
  if (!syntax.ok) return Promise.reject(new AppError('validation', 'Invalid email', 400, { email: 'Invalid email address' }));
  var problems = Auth.validatePasswordPolicy(addr, pw);
  if (problems.length) return Promise.reject(new AppError('validation', 'Weak password', 400, { password: problems.join('; ') }));
  return password.hashAsync(pw).then(function (hash) {
    return self.db.transaction(function (tx) {
      return tx.get('SELECT COUNT(*) AS c FROM users').then(function (r) {
        if (r.c > 0 && !self.allowRegistration) throw new AppError('registration_closed', 'Registration is closed', 403);
        return tx.get('SELECT id FROM users WHERE email = ?', [addr]).then(function (exists) {
          if (exists) throw new AppError('validation', 'Email already registered', 409, { email: 'Already registered' });
          return tx.run('INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?,?,?)',
            [addr, hash, r.c === 0 ? 'owner' : 'member', self.now()]);
        });
      }).then(function (ins) {
        return audit.log(tx, { userId: ins.lastID, action: 'user.create', entity: 'user', entityId: ins.lastID, ip: ip }, self.now)
          .then(function () { return { id: ins.lastID, email: addr }; });
      });
    });
  });
};

Auth.prototype.login = function (rawEmail, pw, ctx) {
  var self = this, ip = (ctx && ctx.ip) || 'unknown', ua = ctx && ctx.userAgent;
  var addr = email.normalize(rawEmail);
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 200 || addr.length > 254) return Promise.reject(invalid());

  var blocked = null;
  if (this.ipLimiter) { var a = this.ipLimiter.consume(ip); if (!a.allowed) blocked = a; }
  if (this.emailLimiter) { var b = this.emailLimiter.consume(addr); if (!b.allowed) blocked = blocked || b; }
  if (blocked) {
    return Promise.reject(new AppError('rate_limited', 'Too many attempts, try again later', 429, { retryAfterMs: blocked.retryAfterMs }));
  }

  return this.db.get('SELECT id, email, role, password_hash, failed_logins, locked_until FROM users WHERE email = ?', [addr])
    .then(function (user) {
      var hashP = user ? Promise.resolve(user.password_hash) : dummyHash();
      return hashP.then(function (hash) { return password.verifyAsync(pw, hash); }).then(function (ok) {
        var t = self.now();
        if (!user) return audit.log(self.db, { action: 'login.fail', ip: ip, meta: { reason: 'unknown_user' } }, self.now).then(function () { throw invalid(); });
        if (user.locked_until && user.locked_until > t) {
          return audit.log(self.db, { userId: user.id, action: 'login.locked', ip: ip }, self.now).then(function () { throw invalid(); });
        }
        if (!ok) {
          var fails = user.failed_logins + 1;
          var lockUntil = null;
          if (fails >= MAX_FAILS) lockUntil = t + Math.min(BASE_LOCK_MS * Math.pow(2, fails - MAX_FAILS), MAX_LOCK_MS);
          return self.db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [fails, lockUntil, user.id])
            .then(function () { return audit.log(self.db, { userId: user.id, action: 'login.fail', ip: ip, meta: { fails: fails, locked: !!lockUntil } }, self.now); })
            .then(function () { throw invalid(); });
        }
        // Success: reset counters and issue a brand-new session (prevents session fixation).
        return self.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [t, user.id])
          .then(function () { if (self.emailLimiter) self.emailLimiter.reset(addr); return self.sessions.create(user.id, ip, ua); })
          .then(function (s) {
            return audit.log(self.db, { userId: user.id, action: 'login.ok', ip: ip }, self.now).then(function () {
              return { token: s.token, csrfToken: s.csrfToken, maxAgeSec: s.maxAgeSec, user: { id: user.id, email: user.email, role: user.role } };
            });
          });
      });
    });
};

Auth.prototype.logout = function (token, userId, ip) {
  var self = this;
  return this.sessions.destroy(token).then(function () { return audit.log(self.db, { userId: userId, action: 'logout', ip: ip }, self.now); });
};

Auth.prototype.changePassword = function (userId, currentPw, newPw, currentToken, ip) {
  var self = this;
  return this.db.get('SELECT email, password_hash FROM users WHERE id = ?', [userId]).then(function (u) {
    if (!u) throw invalid();
    return password.verifyAsync(currentPw, u.password_hash).then(function (ok) {
      if (!ok) throw new AppError('invalid_credentials', 'Current password is incorrect', 401);
      var problems = Auth.validatePasswordPolicy(u.email, newPw);
      if (problems.length) throw new AppError('validation', 'Weak password', 400, { password: problems.join('; ') });
      return password.hashAsync(newPw);
    });
  }).then(function (hash) {
    return self.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  }).then(function () {
    return self.sessions.destroyAllForUser(userId, currentToken);
  }).then(function () {
    return audit.log(self.db, { userId: userId, action: 'password.change', ip: ip }, self.now);
  });
};

Auth.cookieOptions = function (secure) { return { secure: !!secure }; };
Auth.cookies = cookies;

module.exports = { Auth: Auth, MAX_FAILS: MAX_FAILS };
