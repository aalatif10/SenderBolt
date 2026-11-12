/* API client: CSRF + client header, 30 s timeout, one retry for network blips on GET, friendly errors.
   The CSRF token lives only in memory (never localStorage); the session cookie is HttpOnly. */
(function () {
  'use strict';
  var csrf = null, onUnauthorized = null, onOnline = null, onOffline = null, offline = false;

  function ApiError(status, code, message, details, retryAfter) {
    this.name = 'ApiError'; this.status = status; this.code = code; this.message = message; this.details = details || null; this.retryAfter = retryAfter || 0;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function setOffline(v) { if (v !== offline) { offline = v; (v ? onOffline : onOnline) && (v ? onOffline : onOnline)(); } }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function once(method, path, body) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
    var headers = { Accept: 'application/json' };
    var opts = { method: method, credentials: 'same-origin', headers: headers, signal: ctl ? ctl.signal : undefined };
    if (method !== 'GET') {
      headers['X-SB-Client'] = '1';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (method !== 'DELETE') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    }
    return fetch(path, opts).then(function (res) {
      clearTimeout(timer); setOffline(false);
      return res.text().then(function (text) {
        var data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (res.ok) return data === null ? {} : data;
        var ra = parseInt(res.headers.get('Retry-After'), 10) || 0;
        throw new ApiError(res.status, (data && data.error) || 'error', (data && data.message) || 'Something went wrong.', data && data.details, ra);
      });
    }, function () {
      clearTimeout(timer);
      throw new ApiError(0, 'offline', 'Cannot reach the server.');
    });
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    function attempt(n) {
      return once(method, path, body).catch(function (e) {
        if (e.code === 'offline') {
          if (method === 'GET' && n < 1) return wait(800).then(function () { return attempt(n + 1); });
          setOffline(true);
        }
        if (e.status === 401 && !opts.noAuthRedirect && onUnauthorized) onUnauthorized();
        throw e;
      });
    }
    return attempt(0);
  }

  SB.api = {
    ApiError: ApiError,
    get: function (p, o) { return request('GET', p, null, o); },
    post: function (p, b, o) { return request('POST', p, b, o); },
    put: function (p, b, o) { return request('PUT', p, b, o); },
    patch: function (p, b, o) { return request('PATCH', p, b, o); },
    del: function (p, o) { return request('DELETE', p, null, o); },
    setCsrf: function (t) { csrf = t; },
    on: function (h) { onUnauthorized = h.unauthorized; onOnline = h.online; onOffline = h.offline; },
    friendly: function (e) {
      if (!e) return 'Something went wrong.';
      if (e.code === 'offline') return 'Cannot reach the server. Check that SenderBolt is still running.';
      if (e.status === 429) return 'Too many attempts. Please wait ' + (e.retryAfter ? Math.ceil(e.retryAfter / 60) + ' minute(s)' : 'a moment') + ' and try again.';
      return e.message || 'Something went wrong.';
    }
  };
})();
