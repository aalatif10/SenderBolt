'use strict';
// requireAuth: resolves the session cookie, attaches req.user / req.session.
var cookies = require('../lib/cookies');
var http = require('../lib/http');

function requireAuth(sessions, cookieName) {
  return function (req, res, next) {
    var token = cookies.parse(req.headers && req.headers.cookie)[cookieName];
    function unauthorized() { http.sendJson(res, 401, { error: 'unauthorized', message: 'Please sign in' }); }
    if (!token) return unauthorized();
    sessions.validate(token).then(function (s) {
      if (!s) return unauthorized();
      req.sessionToken = token;
      req.session = s;
      req.user = { id: s.userId, email: s.email, role: s.role };
      next();
    }, next);
  };
}

module.exports = { requireAuth: requireAuth };
