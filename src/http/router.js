'use strict';
// HTTP layer on plain Node http (works on Node 12, fully testable, mountable
// inside Express later as app.use(dispatch)). Per request it enforces, in order:
//   security headers -> Host allowlist (DNS rebinding) -> global rate limit -> route match
//   -> X-SB-Client header + Origin/Sec-Fetch-Site checks (unsafe methods)
//   -> session auth -> CSRF token -> bounded JSON body -> per-route rate limit -> handler
var http = require('../lib/http');
var cookies = require('../lib/cookies');
var tokens = require('../lib/tokens');
var AppError = require('../lib/errors').AppError;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

var UNSAFE = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

function Reply(status, body, opts) {
  this.status = status;
  this.body = body;
  this.headers = (opts && opts.headers) || {};
  this.cookies = (opts && opts.cookies) || [];
  this.raw = !!(opts && opts.raw);
}
function reply(status, body, opts) { return new Reply(status, body, opts); }

function parseId(v) {
  if (!/^\d{1,15}$/.test(String(v))) throw new AppError('not_found', 'Not found', 404);
  var n = parseInt(v, 10);
  if (n < 1) throw new AppError('not_found', 'Not found', 404);
  return n;
}

function compile(pattern) {
  var names = [];
  var src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-zA-Z]+)/g, function (_, n) { names.push(n); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '/?$'), names: names };
}

function Router() { this.routes = []; }
['get', 'post', 'patch', 'put', 'delete'].forEach(function (m) {
  Router.prototype[m] = function (pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    var c = compile(pattern);
    this.routes.push({
      method: m.toUpperCase(), re: c.re, names: c.names, handler: handler,
      auth: opts.auth !== false, csrf: opts.csrf !== false, maxBody: opts.maxBody || 262144, limit: opts.limit || null
    });
    return this;
  };
});

function securityHeaders(res, secure) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Powered-By', '');
  res.removeHeader && res.removeHeader('X-Powered-By');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req, o) {
  if (o.trustProxy) {
    var xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length < 200) {
      var first = xff.split(',')[0].trim();
      if (first && first.length <= 45) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readJson(req, limit) {
  return new Promise(function (resolve, reject) {
    var len = parseInt(req.headers['content-length'], 10);
    if (len > limit) return reject(new AppError('payload_too_large', 'Request body too large', 413));
    var size = 0, chunks = [], failed = false;
    req.on('data', function (c) {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; return reject(new AppError('payload_too_large', 'Request body too large', 413)); }
      chunks.push(c);
    });
    req.on('end', function () {
      if (failed) return;
      if (size === 0) return resolve({});
      var ct = String(req.headers['content-type'] || '').toLowerCase();
      if (ct.indexOf('application/json') !== 0) return reject(new AppError('unsupported_media_type', 'Content-Type must be application/json', 415));
      try {
        var parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch (e) { reject(new AppError('bad_json', 'Request body must be a JSON object', 400)); }
    });
    req.on('error', function () { if (!failed) reject(new AppError('bad_request', 'Request aborted', 400)); });
  });
}

function send(res, r) {
  if (r.cookies.length) res.setHeader('Set-Cookie', r.cookies);
  if (r.raw) {
    res.statusCode = r.status;
    Object.keys(r.headers).forEach(function (k) { res.setHeader(k, r.headers[k]); });
    res.setHeader('Cache-Control', 'no-store');
    res.end(r.body);
  } else {
    http.sendJson(res, r.status, r.body, r.headers);
  }
}

function createDispatcher(o) {
  var globalLimiter = o.globalLimiter || new RateLimiter({ windowMs: 60000, max: 600 });
  var cookieName = o.cookieName;

  function handle(req, res) {
    securityHeaders(res, o.secureCookies);
    var ip = clientIp(req, o);
    var host = String(req.headers.host || '').toLowerCase();
    if (o.allowedHosts.indexOf(host) === -1) throw new AppError('bad_host', 'Host not allowed', 400);
    var u;
    try { u = new URL(req.url, 'http://placeholder'); } catch (e) { throw new AppError('bad_request', 'Bad URL', 400); }
    var g = globalLimiter.consume(ip);
    if (!g.allowed) throw new AppError('rate_limited', 'Too many requests', 429, { retryAfterMs: g.retryAfterMs });

    var route = null, params = {}, pathMatched = false, allow = [];
    for (var i = 0; i < o.routes.length; i++) {
      var r = o.routes[i], m = r.re.exec(u.pathname);
      if (!m) continue;
      pathMatched = true; allow.push(r.method);
      if (r.method === req.method) {
        route = r;
        for (var k = 0; k < r.names.length; k++) {
          try { params[r.names[k]] = decodeURIComponent(m[k + 1]); } catch (e) { throw new AppError('bad_request', 'Bad URL', 400); }
        }
        break;
      }
    }
    if (!route) {
      if (pathMatched) { res.setHeader('Allow', allow.join(', ')); throw new AppError('method_not_allowed', 'Method not allowed', 405); }
      throw new AppError('not_found', 'Not found', 404);
    }

    var unsafe = !!UNSAFE[req.method];
    if (unsafe) {
      if (req.headers['x-sb-client'] !== '1') throw new AppError('csrf_header', 'Missing client header', 403);
      var origin = req.headers.origin;
      if (origin && o.allowedOrigins.indexOf(origin) === -1) throw new AppError('csrf_origin', 'Origin not allowed', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('csrf_origin', 'Cross-site request blocked', 403);
    }

    var ctx = { req: req, res: res, params: params, query: {}, body: {}, ip: ip, user: null, session: null, sessionToken: null };
    u.searchParams.forEach(function (v, key) { if (!Object.prototype.hasOwnProperty.call(ctx.query, key)) ctx.query[key] = v; });

    var p = Promise.resolve();
    if (route.auth) {
      p = p.then(function () {
        var token = cookies.parse(req.headers.cookie)[cookieName];
        if (!token) throw new AppError('unauthorized', 'Please sign in', 401);
        return o.sessions.validate(token).then(function (s) {
          if (!s) throw new AppError('unauthorized', 'Please sign in', 401);
          if (unsafe && route.csrf && !tokens.safeEqual(req.headers['x-csrf-token'], s.csrfToken)) {
            throw new AppError('csrf_token', 'Invalid CSRF token', 403);
          }
          ctx.sessionToken = token; ctx.session = s; ctx.user = { id: s.userId, email: s.email, role: s.role };
        });
      });
    }
    if (unsafe && req.method !== 'DELETE') {
      p = p.then(function () { return readJson(req, route.maxBody); }).then(function (b) { ctx.body = b; });
    }
    p = p.then(function () {
      if (route.limit) {
        var key = route.limit.by === 'user' && ctx.user ? 'u:' + ctx.user.id : 'ip:' + ip;
        var rl = route.limit.limiter.consume(key);
        if (!rl.allowed) throw new AppError('rate_limited', 'Too many requests, slow down', 429, { retryAfterMs: rl.retryAfterMs });
      }
      return route.handler(ctx);
    }).then(function (result) {
      send(res, result instanceof Reply ? result : reply(200, result === undefined ? { ok: true } : result));
    });
    return p;
  }

  return function dispatch(req, res) {
    var done;
    try { done = Promise.resolve(handle(req, res)); } catch (e) { done = Promise.reject(e); }
    done.catch(function (err) {
      if (!(err && err.name === 'AppError')) console.error('[error]', err && err.stack ? err.stack : err);
      if (res.headersSent) { try { res.end(); } catch (e) { /* ignore */ } return; }
      if (err && err.code === 'payload_too_large') res.setHeader('Connection', 'close');
      http.sendError(res, err);
    });
  };
}

module.exports = { Router: Router, createDispatcher: createDispatcher, reply: reply, parseId: parseId, Reply: Reply };
