'use strict';
// Remote / tunnel access: token gate, host + origin handling, long-lived device cookie (not tied to IP/device), rotation, public routes.
var assert = require('assert');
var http = require('http');
var crypto = require('crypto');
var h = require('./helpers');
var config = require('../src/config');
var createApp = require('../src/app').createApp;

var TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
var TUNNEL = 'quiet-fox-1234.trycloudflare.com';
var STRONG = 'Str0ng-Passw0rd-xyz!';

function boot(env) {
  var probe = http.createServer(), S = {};
  return new Promise(function (r) { probe.listen(0, '127.0.0.1', r); }).then(function () { S.port = probe.address().port; return new Promise(function (r) { probe.close(r); }); }).then(function () {
    var e = Object.assign({ SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: 's'.repeat(40), PORT: String(S.port), HOST: '127.0.0.1', SENDERBOLT_DB_FILE: ':memory:' }, env);
    var cfg = config.build(e), io = h.fakeIO(); cfg.mailer = io.mailer; cfg.mailbox = io.mailbox; S.cfg = cfg;
    return createApp(cfg);
  }).then(function (app) {
    S.app = app; S.local = '127.0.0.1:' + S.port; S.server = http.createServer(app.dispatch);
    return new Promise(function (r) { S.server.listen(S.port, '127.0.0.1', r); });
  }).then(function () { return S; });
}
function stop(S) { return new Promise(function (r) { S.server.close(r); }).then(function () { return S.app.close(); }); }
function req(S, method, p, o) {
  o = o || {};
  return new Promise(function (resolve, reject) {
    var headers = Object.assign({ Host: o.host || S.local }, o.headers || {}), payload = null;
    if (o.json) { payload = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; headers['X-SB-Client'] = '1'; }
    if (o.form) { payload = o.form; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    var r = http.request({ host: '127.0.0.1', port: S.port, method: method, path: p, headers: headers }, function (res) {
      var chunks = []; res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { var text = Buffer.concat(chunks).toString('utf8'), body = null; try { body = JSON.parse(text); } catch (e) { body = null; } resolve({ status: res.statusCode, headers: res.headers, text: text, body: body }); });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
function cookieOf(res, name) { var sc = res.headers['set-cookie'] || [], hit = sc.filter(function (c) { return c.indexOf(name + '=') === 0; })[0]; return hit ? hit.split(';')[0] : null; }
var HTML = { Accept: 'text/html' };

h.group('configuration');
h.test('the token comes from SENDERBOLT_ACCESS_TOKEN or a long SENDERBOLT_SETUP_TOKEN; short ones are refused or ignored', function () {
  var base = { SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: 's'.repeat(40) };
  assert.strictEqual(config.build(base).accessToken, '');
  assert.strictEqual(config.build(Object.assign({ SENDERBOLT_ACCESS_TOKEN: TOKEN }, base)).accessToken, TOKEN);
  var c = config.build(Object.assign({ SENDERBOLT_SETUP_TOKEN: TOKEN }, base)); assert.strictEqual(c.accessToken, TOKEN); assert.strictEqual(c.accessTokenSource, 'SENDERBOLT_SETUP_TOKEN');
  assert.strictEqual(config.build(Object.assign({ SENDERBOLT_SETUP_TOKEN: 'tok-123' }, base)).accessToken, '', 'a short setup token does not open the app to tunnels');
  assert.strictEqual(config.build(Object.assign({ SENDERBOLT_ACCESS_TOKEN: TOKEN, SENDERBOLT_SETUP_TOKEN: 'other-long-setup-token-1234' }, base)).accessTokenSource, 'SENDERBOLT_ACCESS_TOKEN');
  assert.throws(function () { config.build(Object.assign({ SENDERBOLT_ACCESS_TOKEN: 'short' }, base)); }, /at least 16/);
});

h.group('gate off (no token)');
h.test('without a token an unknown host is still rejected', function () {
  return boot({}).then(function (S) {
    return req(S, 'GET', '/api/auth/status', { host: TUNNEL }).then(function (r) { assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'bad_host'); assert.ok(/npm run token/.test(r.body.message), 'the message says how to fix it'); return stop(S); });
  });
});

h.group('gate on');
var S1, cookie;
h.test('boot', function () { return boot({ SENDERBOLT_ACCESS_TOKEN: TOKEN }).then(function (s) { S1 = s; }); });
h.test('local addresses are never gated', function () {
  return req(S1, 'GET', '/api/auth/status').then(function (r) { assert.strictEqual(r.status, 200); return req(S1, 'GET', '/', { headers: HTML }); }).then(function (r) { assert.strictEqual(r.status, 200); assert.ok(r.text.indexOf('<div id="app">') !== -1); });
});
h.test('a tunnel host without the token: pages get the entry page, API calls a clean 401, app files stay private, the gate page styles are open', function () {
  return req(S1, 'GET', '/', { host: TUNNEL, headers: HTML }).then(function (r) {
    assert.strictEqual(r.status, 401); assert.ok(r.text.indexOf('name="token"') !== -1); assert.ok(r.text.indexOf('<div id="app">') === -1);
    assert.ok(/default-src 'self'/.test(r.headers['content-security-policy']), 'the entry page has the strict CSP');
    return req(S1, 'GET', '/api/auth/status', { host: TUNNEL });
  }).then(function (r) { assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'access_token_required'); return req(S1, 'GET', '/js/app.js', { host: TUNNEL }); })
    .then(function (r) { assert.strictEqual(r.status, 401); return req(S1, 'GET', '/css/app.css', { host: TUNNEL }); })
    .then(function (r) { assert.strictEqual(r.status, 200); });
});
h.test('a wrong token link is refused and sets nothing; the right one redirects without the token and sets a long-lived Lax cookie', function () {
  return req(S1, 'GET', '/?token=nope-nope-nope-nope', { host: TUNNEL, headers: HTML }).then(function (r) {
    assert.strictEqual(r.status, 401); assert.ok(!r.headers['set-cookie']);
    return req(S1, 'GET', '/?x=1&token=' + TOKEN, { host: TUNNEL, headers: Object.assign({ 'X-Forwarded-Proto': 'https' }, HTML) });
  }).then(function (r) {
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/?x=1', 'the token is removed from the address');
    var sc = r.headers['set-cookie'][0]; cookie = sc.split(';')[0];
    assert.ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Max-Age=2592000/.test(sc) && /Secure/.test(sc), sc);
    assert.ok(sc.indexOf(TOKEN) === -1, 'the cookie does not contain the token itself');
  });
});
h.test('the cookie works from a different address and for APIs: not tied to an IP or a device', function () {
  return req(S1, 'GET', '/api/auth/status', { host: TUNNEL, headers: { Cookie: cookie, 'X-Forwarded-For': '203.0.113.77', 'User-Agent': 'Phone on mobile data' } }).then(function (r) {
    assert.strictEqual(r.status, 200); return req(S1, 'GET', '/', { host: 'another-name.ngrok-free.app', headers: { Cookie: cookie, Accept: 'text/html' } });
  }).then(function (r) { assert.strictEqual(r.status, 200); assert.ok(r.text.indexOf('<div id="app">') !== -1, 'any tunnel host name works with the cookie'); });
});
h.test('the entry form: wrong token 401, foreign Origin 403, right token 303 + cookie', function () {
  return req(S1, 'POST', '/__access', { host: TUNNEL, form: 'token=wrong-wrong-wrong-1' }).then(function (r) {
    assert.strictEqual(r.status, 401); assert.ok(/not right/.test(r.text)); assert.ok(!r.headers['set-cookie']);
    return req(S1, 'POST', '/__access', { host: TUNNEL, form: 'token=' + TOKEN, headers: { Origin: 'https://evil.example' } });
  }).then(function (r) {
    assert.strictEqual(r.status, 403);
    return req(S1, 'POST', '/__access', { host: TUNNEL, form: 'token=' + TOKEN, headers: { Origin: 'https://' + TUNNEL } });
  }).then(function (r) { assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.location, '/'); assert.ok(cookieOf(r, 'sb_access')); });
});
h.test('the X-SB-Access-Token header works for scripts', function () {
  return req(S1, 'GET', '/api/auth/status', { host: TUNNEL, headers: { 'X-SB-Access-Token': TOKEN } }).then(function (r) { assert.strictEqual(r.status, 200); return req(S1, 'GET', '/api/auth/status', { host: TUNNEL, headers: { 'X-SB-Access-Token': 'x'.repeat(30) } }); })
    .then(function (r) { assert.strictEqual(r.status, 401); });
});
h.test('sign-in through the tunnel: same-host Origin is accepted, a foreign one is not, the session persists, cookies get Secure behind https', function () {
  var hdr = { Cookie: cookie, Origin: 'https://' + TUNNEL, 'X-Forwarded-Proto': 'https' };
  return req(S1, 'POST', '/api/auth/setup', { host: TUNNEL, headers: Object.assign({}, hdr, { Origin: 'https://evil.example' }), json: { email: 'me@example.com', password: STRONG } }).then(function (r) {
    assert.strictEqual(r.status, 403); return req(S1, 'POST', '/api/auth/setup', { host: TUNNEL, headers: hdr, json: { email: 'me@example.com', password: STRONG } });
  }).then(function (r) {
    assert.strictEqual(r.status, 201); return req(S1, 'POST', '/api/auth/login', { host: TUNNEL, headers: hdr, json: { email: 'me@example.com', password: STRONG } });
  }).then(function (r) {
    assert.strictEqual(r.status, 200); var sc = r.headers['set-cookie'][0]; assert.ok(/^sb_sid=/.test(sc) && /Secure/.test(sc) && /HttpOnly/.test(sc), sc);
    assert.ok(/Strict-Transport-Security/i.test(Object.keys(r.headers).join(',')) || r.headers['strict-transport-security'], 'HSTS on the https tunnel');
    var both = cookie + '; ' + sc.split(';')[0];
    return req(S1, 'GET', '/api/auth/me', { host: TUNNEL, headers: { Cookie: both, 'X-Forwarded-For': '198.51.100.9' } });   // "new network"
  }).then(function (r) { assert.strictEqual(r.status, 200); assert.strictEqual(r.body.user.email, 'me@example.com'); });
});
h.test('the session cookie alone is not enough on a tunnel: the access token is required first', function () {
  return req(S1, 'POST', '/api/auth/login', { host: TUNNEL, headers: { Origin: 'https://' + TUNNEL }, json: { email: 'me@example.com', password: STRONG } }).then(function (r) { assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'access_token_required'); });
});
h.test('public recipient routes (unsubscribe link, open pixel) stay reachable on the tunnel address without the token', function () {
  return req(S1, 'GET', '/t/o/forged-token-forged-token').then(function () { return req(S1, 'GET', '/t/o/forged-token-forged-token', { host: TUNNEL }); }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.ok(/image\/gif/.test(r.headers['content-type']));
    return req(S1, 'GET', '/u/forged-token-forged-token', { host: TUNNEL });
  }).then(function (r) { assert.notStrictEqual(r.status, 401, 'the unsubscribe page is not behind the gate'); });
});
h.test('a *.loca.lt address works with the token; a tunnel that rewrites Host to localhost is still gated (forwarding headers)', function () {
  var LT = 'brave-lions-12.loca.lt';
  return req(S1, 'GET', '/api/auth/status', { host: LT }).then(function (r) { assert.strictEqual(r.status, 401); return req(S1, 'GET', '/api/auth/status', { host: LT, headers: { 'X-SB-Access-Token': TOKEN } }); })
    .then(function (r) { assert.strictEqual(r.status, 200); return req(S1, 'GET', '/api/auth/status', { headers: { 'X-Forwarded-For': '203.0.113.5' } }); })
    .then(function (r) { assert.strictEqual(r.status, 401, 'Host=localhost but proxied: needs the token'); return req(S1, 'GET', '/api/auth/status', { headers: { 'X-Forwarded-For': '203.0.113.5', Cookie: cookie } }); })
    .then(function (r) { assert.strictEqual(r.status, 200); });
});
h.test('localtunnel rewrites Host to "localhost": the browser Origin is the tunnel name, and sign-in still works (Sec-Fetch-Site same-origin), foreign sites do not', function () {
  var base = { Cookie: cookie, Origin: 'https://brave-lions-12.loca.lt', 'Sec-Fetch-Site': 'same-origin' };
  function login(h2) { return req(S1, 'POST', '/api/auth/login', { host: 'localhost', headers: h2, json: { email: 'me@example.com', password: STRONG } }); }
  return login(base).then(function (r) {
    assert.strictEqual(r.status, 200, r.text);
    return login(Object.assign({}, base, { 'Sec-Fetch-Site': 'cross-site' }));
  }).then(function (r) {
    assert.strictEqual(r.status, 403);
    var noHint = Object.assign({}, base); delete noHint['Sec-Fetch-Site'];
    return login(noHint);
  }).then(function (r) {
    assert.strictEqual(r.status, 403, 'an unexplained foreign Origin is refused');
    return login({ Origin: 'https://brave-lions-12.loca.lt', 'Sec-Fetch-Site': 'same-origin' });
  }).then(function (r) { assert.strictEqual(r.status, 401, 'no access cookie: still gated'); assert.strictEqual(r.body.error, 'access_token_required');
    return req(S1, 'POST', '/__access', { host: 'localhost', form: 'token=' + TOKEN, headers: { Origin: 'https://brave-lions-12.loca.lt', 'Sec-Fetch-Site': 'same-origin' } });
  }).then(function (r) { assert.strictEqual(r.status, 303, 'the token form also works behind a Host-rewriting tunnel'); });
});
h.test('guessing is rate limited', function () {
  var p = Promise.resolve(), last;
  for (var i = 0; i < 25; i++) p = p.then(function () { return req(S1, 'GET', '/?token=guess-guess-guess-guess', { host: 'guesser.example.net', headers: HTML }); }).then(function (r) { last = r; });
  return p.then(function () { assert.strictEqual(last.status, 429); });
});
h.test('shutdown', function () { return stop(S1); });

h.group('rotation');
h.test('a new token invalidates cookies made with the old one', function () {
  return boot({ SENDERBOLT_ACCESS_TOKEN: 'ffffffffffffffffffffffffffffffffffffffffffffffff' }).then(function (S) {
    return req(S, 'GET', '/api/auth/status', { host: TUNNEL, headers: { Cookie: cookie } }).then(function (r) { assert.strictEqual(r.status, 401); return stop(S); });
  });
});

h.run();
