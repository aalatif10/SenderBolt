'use strict';
// Public (no session) routes: /u/:token unsubscribe. GET only shows a confirmation page because mail
// scanners and link-preview bots prefetch GET links; the POST (button or RFC 8058 one-click) acts.
var reply = require('../http/router').reply;
var RateLimiter = require('../security/rateLimiter').RateLimiter;
var escapeHtml = require('../lib/html').escapeHtml;

var CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function page(status, title, inner) {
  var body = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + escapeHtml(title) + '</title><style>body{font:16px/1.5 system-ui,Segoe UI,Arial,sans-serif;background:#f5f6f8;color:#1c2330;margin:0;display:grid;place-items:center;min-height:100vh}' +
    'main{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:32px;max-width:420px;box-shadow:0 2px 12px rgba(0,0,0,.05)}h1{font-size:20px;margin:0 0 12px}' +
    'button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}p{margin:0 0 16px;color:#4b5565}</style></head><body><main>' + inner + '</main></body></html>';
  return reply(status, body, { raw: true, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP } });
}

module.exports = function register(router, d) {
  var U = d.unsubscribe;
  var limit = { by: 'ip', limiter: new RateLimiter({ windowMs: 60000, max: 30 }) };

  router.get('/u/:token', { external: true, limit: limit }, function (ctx) {
    return U.lookup(ctx.params.token).then(function (r) {
      if (!r.valid) return page(404, 'Link not valid', '<h1>This link is not valid</h1><p>It may have expired or been copied incorrectly.</p>');
      return page(200, 'Unsubscribe', '<h1>Unsubscribe?</h1><p>Stop all emails to ' + escapeHtml(r.email) + '.</p><form method="post"><button type="submit">Yes, unsubscribe me</button></form>');
    });
  });

  router.post('/u/:token', { external: true, limit: limit }, function (ctx) {
    return U.apply(ctx.params.token).then(function (r) {
      if (!r.valid) return page(404, 'Link not valid', '<h1>This link is not valid</h1><p>It may have expired or been copied incorrectly.</p>');
      return page(200, 'Unsubscribed', '<h1>You are unsubscribed</h1><p>You will not receive further emails from us.</p>');
    });
  });
};
