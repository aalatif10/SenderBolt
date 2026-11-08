'use strict';
// CSRF defence in depth for state-changing requests:
//  1. SameSite=Strict session cookie (set in cookies.js)
//  2. Origin header must match an allowed origin when present
//  3. Per-session HMAC token required in X-CSRF-Token (or body._csrf)
var tokens = require('../lib/tokens');
var http = require('../lib/http');

var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };

function csrfProtection(opts) {
  var allowed = (opts && opts.allowedOrigins) || [];
  return function (req, res, next) {
    if (SAFE[req.method]) return next();
    var origin = req.headers && req.headers.origin;
    if (origin && allowed.indexOf(origin) === -1) {
      return http.sendJson(res, 403, { error: 'csrf_origin', message: 'Origin not allowed' });
    }
    var supplied = (req.headers && req.headers['x-csrf-token']) || (req.body && req.body._csrf);
    if (!req.session || !tokens.safeEqual(supplied, req.session.csrfToken)) {
      return http.sendJson(res, 403, { error: 'csrf_token', message: 'Invalid CSRF token' });
    }
    next();
  };
}

module.exports = { csrfProtection: csrfProtection };
