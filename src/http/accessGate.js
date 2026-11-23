'use strict';
// Remote / tunnel access gate (src/http/accessGate.js).
//
// When an access token is configured (SENDERBOLT_ACCESS_TOKEN, or a long SENDERBOLT_SETUP_TOKEN as fallback), SenderBolt accepts requests that
// arrive under ANY host name (a Cloudflare / ngrok / localtunnel address, a phone on the LAN, ...), but every such "remote" request must prove it
// knows the token first. Requests to the local addresses (localhost / 127.0.0.1 / the HOST:PORT you bound) are never gated.
//
// The proof is a long-lived cookie derived from the token with HMAC: it is NOT tied to an IP address, a device or a MAC address, so it keeps working
// when the phone switches between Wi-Fi and mobile data and can be created on any number of devices. Changing the token invalidates every cookie.
// Ways to present the token: ?token=... on a GET link (redirected away at once so it is not kept in the address bar), the entry form that the gate
// page shows, or the X-SB-Access-Token header for scripts. Public recipient routes (unsubscribe, open pixel) are not gated.
var tokens = require('../lib/tokens');
var cookies = require('../lib/cookies');
var AppError = require('../lib/errors').AppError;
var RateLimiter = require('../security/rateLimiter').RateLimiter;

var COOKIE = 'sb_access';
var COOKIE_DAYS = 30;
var OPEN_ASSETS = { '/css/tokens.css': 1, '/css/app.css': 1, '/favicon.svg': 1 };   // only what the gate page itself needs
var HOST_SYNTAX = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

function create(o) {
  var token = o.token || '';
  var gate = { enabled: !!token };
  if (!gate.enabled) return gate;
  var local = o.localHosts || [], extra = o.allowedHosts || [];
  var cookieValue = tokens.hmac(o.secret, 'senderbolt:access:v1:' + token);
  var limiter = o.limiter || new RateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

  gate.cookieName = COOKIE;
  gate.isLocal = function (host) { return local.indexOf(host) !== -1; };
  // A request is "remote" when its Host is not a local address, OR when it carries proxy/tunnel headers. The second rule matters because a tunnel
  // client can REWRITE the Host header to localhost (localtunnel --local-host ...): without it such traffic would look local and skip the token.
  // Opening the app directly in a browser on this computer never sends these headers.
  var FORWARD = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-original-host'];
  gate.isRemote = function (host, req) {
    if (!gate.isLocal(host)) return true;
    var hd = (req && req.headers) || {};
    for (var i = 0; i < FORWARD.length; i++) if (hd[FORWARD[i]] !== undefined) return true;
    return false;
  };
  // With the gate on, a tunnel's host name is accepted (the token, not the name, is what protects the app).
  gate.hostAllowed = function (host) { return gate.isLocal(host) || extra.indexOf(host) !== -1 || (host.length <= 255 && HOST_SYNTAX.test(host)); };
  gate.originAllowed = function (origin, host) {
    try { return new URL(origin).host.toLowerCase() === host; } catch (e) { return false; }
  };
  gate.cookie = function (secure) { return cookies.serialize(COOKIE, cookieValue, { secure: secure, maxAgeSec: COOKIE_DAYS * 86400, sameSite: 'Lax' }); };

  function tryToken(candidate, ip) {
    var r = limiter.consume(ip);
    if (!r.allowed) throw new AppError('rate_limited', 'Too many attempts, try again later', 429, { retryAfterMs: r.retryAfterMs });
    return tokens.safeEqual(candidate, token);
  }

  // -> { ok, setCookie, redirect }  (throws rate_limited when someone keeps guessing)
  gate.check = function (req, u, ip) {
    var have = cookies.parse(req.headers.cookie)[COOKIE];
    if (have && tokens.safeEqual(have, cookieValue)) return { ok: true };
    var hdr = req.headers['x-sb-access-token'];
    if (typeof hdr === 'string' && hdr.length && hdr.length <= 200) return { ok: tryToken(hdr, ip) };
    var q = u.searchParams.get('token');
    if (q && (req.method === 'GET' || req.method === 'HEAD') && q.length <= 200) {
      if (!tryToken(q, ip)) return { ok: false };
      u.searchParams.delete('token');
      var rest = u.searchParams.toString();
      return { ok: true, setCookie: true, redirect: u.pathname + (rest ? '?' + rest : '') };
    }
    return { ok: false };
  };
  gate.isOpenAsset = function (req, u) { return (req.method === 'GET' || req.method === 'HEAD') && OPEN_ASSETS[u.pathname] === 1; };

  gate.page = function (message) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>SenderBolt - access token</title><link rel="icon" href="/favicon.svg">' +
      '<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css"></head><body class="auth-body"><main class="auth-card card">' +
      '<h1>SenderBolt</h1><p class="muted">This address needs the access token. Enter it once; this device then stays allowed for ' + COOKIE_DAYS + ' days, on any network.</p>' +
      (message ? '<div class="form-error" role="alert">' + message + '</div>' : '') +
      '<form method="post" action="/__access" autocomplete="off"><div class="field"><label for="tk">Access token</label>' +
      '<input class="input" id="tk" name="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" required autofocus></div>' +
      '<button class="btn btn-primary" type="submit">Continue</button></form></main></body></html>';
  };

  // The form posts here. Bounded body, same-host Origin only.
  gate.entry = function (req, res, ip, secure, host) {
    return new Promise(function (resolve, reject) {
      var origin = req.headers.origin;
      if (origin && !gate.originAllowed(origin, host)) return reject(new AppError('csrf_origin', 'Origin not allowed', 403));
      var size = 0, chunks = [], failed = false;
      req.on('data', function (c) { if (failed) return; size += c.length; if (size > 2048) { failed = true; reject(new AppError('payload_too_large', 'Request body too large', 413)); } else chunks.push(c); });
      req.on('end', function () {
        if (failed) return;
        var cand = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('token') || '';
        var ok;
        try { ok = cand.length > 0 && cand.length <= 200 && tryToken(cand, ip); } catch (e) { return reject(e); }
        if (ok) {
          res.statusCode = 303; res.setHeader('Set-Cookie', gate.cookie(secure)); res.setHeader('Location', '/'); res.setHeader('Cache-Control', 'no-store'); res.end();
        } else {
          res.statusCode = 401; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
          res.end(gate.page('That token is not right.'));
        }
        resolve();
      });
      req.on('error', function () { if (!failed) reject(new AppError('bad_request', 'Request aborted', 400)); });
    });
  };

  // A browser page request gets the entry page; API calls get a clean JSON 401.
  gate.deny = function (req, res, u) {
    var wantsPage = (req.method === 'GET' || req.method === 'HEAD') && u.pathname.indexOf('/api/') !== 0 && /text\/html/.test(String(req.headers.accept || ''));
    if (!wantsPage) throw new AppError('access_token_required', 'This address needs the access token', 401);
    res.statusCode = 401; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : gate.page(''));
  };
  return gate;
}

module.exports = { create: create, COOKIE: COOKIE, COOKIE_DAYS: COOKIE_DAYS };
