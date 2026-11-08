'use strict';
// Token helpers. base64url is done by hand because Buffer 'base64url' needs Node 14.18+.
var crypto = require('crypto');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(bytes) { return b64url(crypto.randomBytes(bytes || 32)); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hmac(secret, msg) { return b64url(crypto.createHmac('sha256', secret).update(String(msg)).digest()); }
function safeEqual(a, b) {
  var x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { b64url: b64url, randomToken: randomToken, sha256hex: sha256hex, hmac: hmac, safeEqual: safeEqual };
