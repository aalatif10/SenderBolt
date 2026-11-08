'use strict';
// In-memory sliding-window rate limiter with bounded memory.
// Fine for a single process; swap the store for Redis if this becomes multi-node SaaS.
var http = require('../lib/http');

function RateLimiter(opts) {
  this.windowMs = opts.windowMs;
  this.max = opts.max;
  this.maxKeys = opts.maxKeys || 10000;
  this.now = opts.now || Date.now;
  this.hits = new Map();
}

RateLimiter.prototype.consume = function (key) {
  var t = this.now(), cutoff = t - this.windowMs;
  var arr = (this.hits.get(key) || []).filter(function (x) { return x > cutoff; });
  if (arr.length >= this.max) {
    this.hits.delete(key); this.hits.set(key, arr);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, arr[0] + this.windowMs - t) };
  }
  arr.push(t);
  this.hits.delete(key); this.hits.set(key, arr);          // keeps Map in recency order
  while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
  return { allowed: true, remaining: this.max - arr.length, retryAfterMs: 0 };
};

RateLimiter.prototype.reset = function (key) { this.hits.delete(key); };

// Express-style middleware. keyFn(req) -> string (default: remote IP).
function middleware(limiter, keyFn) {
  return function (req, res, next) {
    var key = keyFn ? keyFn(req) : ((req.socket && req.socket.remoteAddress) || 'unknown');
    var r = limiter.consume(key);
    if (!r.allowed) {
      return http.sendJson(res, 429, { error: 'rate_limited', message: 'Too many requests' },
        { 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) });
    }
    next();
  };
}

module.exports = { RateLimiter: RateLimiter, middleware: middleware };
