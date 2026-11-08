'use strict';
// Password hashing with Node's built-in scrypt: no native addons to compile
// (important on Windows 7). Format: scrypt$N$r$p$salt$hash
var crypto = require('crypto');

var N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;

function hash(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Password must be at least 10 characters');
  var salt = crypto.randomBytes(16);
  var dk = crypto.scryptSync(password, salt, KEYLEN, { N: N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
}

function verify(password, stored) {
  try {
    var parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    var n = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
    var salt = Buffer.from(parts[4], 'base64');
    var expected = Buffer.from(parts[5], 'base64');
    var dk = crypto.scryptSync(String(password), salt, expected.length, { N: n, r: r, p: p, maxmem: MAXMEM });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch (e) {
    return false;
  }
}

// Async variants: scrypt runs on the libuv thread pool so logins do not block the server.
function scryptAsync(pw, salt, len, opts) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(pw, salt, len, opts, function (err, key) { if (err) reject(err); else resolve(key); });
  });
}

function hashAsync(password) {
  if (typeof password !== 'string' || password.length < 10) return Promise.reject(new Error('Password must be at least 10 characters'));
  var salt = crypto.randomBytes(16);
  return scryptAsync(password, salt, KEYLEN, { N: N, r: R, p: P, maxmem: MAXMEM }).then(function (dk) {
    return ['scrypt', N, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
  });
}

function verifyAsync(password, stored) {
  try {
    var parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return Promise.resolve(false);
    var salt = Buffer.from(parts[4], 'base64');
    var expected = Buffer.from(parts[5], 'base64');
    return scryptAsync(String(password), salt, expected.length,
      { N: parseInt(parts[1], 10), r: parseInt(parts[2], 10), p: parseInt(parts[3], 10), maxmem: MAXMEM })
      .then(function (dk) { return dk.length === expected.length && crypto.timingSafeEqual(dk, expected); },
        function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}

module.exports = { hash: hash, verify: verify, hashAsync: hashAsync, verifyAsync: verifyAsync };
