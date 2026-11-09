'use strict';
// HTTP-level tests for the engine-era routes: inbox, sender test, engine status, public unsubscribe.
var assert = require('assert');
var http = require('http');
var crypto = require('crypto');
var h = require('./helpers');
var config = require('../src/config');
var createApp = require('../src/app').createApp;
var unsub = require('../src/lib/unsub');

var STRONG = 'Tr0ub4dor&3-horse-staple';
var S = {};

function request(method, path, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var headers = Object.assign({ Host: S.host }, opts.headers || {}), payload = null;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (opts.form) { payload = Buffer.from('List-Unsubscribe=One-Click'); headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = payload.length; }
    if (opts.auth !== false && S.cookie) headers.Cookie = S.cookie;
    if (method !== 'GET' && opts.client !== false && !opts.form) { headers['X-SB-Client'] = '1'; if (S.csrf) headers['X-CSRF-Token'] = S.csrf; }
    var req = http.request({ host: '127.0.0.1', port: S.port, method: method, path: path, headers: headers }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), body = text;
        try { body = JSON.parse(text); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: body, text: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

h.group('e2e (engine routes)');
h.test('boot in dry-run mode, create account, sign in', function () {
  var probe = http.createServer();
  return new Promise(function (resolve) { probe.listen(0, '127.0.0.1', resolve); }).then(function () {
    S.port = probe.address().port; return new Promise(function (r) { probe.close(r); });
  }).then(function () {
    var cfg = config.build({ SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      PORT: String(S.port), HOST: '127.0.0.1', SENDERBOLT_DB_FILE: ':memory:', SENDERBOLT_SETUP_TOKEN: 'tok-123', SENDERBOLT_SENDING: 'dry-run' });
    assert.strictEqual(cfg.sending, 'dry-run');
    return createApp(cfg);
  }).then(function (app) {
    S.app = app; S.host = '127.0.0.1:' + S.port;
    S.server = http.createServer(app.dispatch);
    return new Promise(function (r) { S.server.listen(S.port, '127.0.0.1', r); });
  }).then(function () { return request('POST', '/api/auth/setup', { json: { email: 'me@example.com', password: STRONG, setupToken: 'tok-123' } }); })
    .then(function () { return request('POST', '/api/auth/login', { json: { email: 'me@example.com', password: STRONG } }); })
    .then(function (r) { S.cookie = r.headers['set-cookie'][0].split(';')[0]; S.csrf = r.body.csrfToken; });
});
h.test('config rejects bad sending mode and bad public origin', function () {
  var base = { SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: crypto.randomBytes(32).toString('hex') };
  assert.throws(function () { config.build(Object.assign({ SENDERBOLT_SENDING: 'yes' }, base)); }, /SENDERBOLT_SENDING/);
  assert.throws(function () { config.build(Object.assign({ SENDERBOLT_PUBLIC_ORIGIN: 'ftp://x.com' }, base)); }, /http/);
  assert.strictEqual(config.build(base).sending, 'dry-run');
  assert.strictEqual(config.build(Object.assign({ SENDERBOLT_PUBLIC_ORIGIN: 'https://app.example.com/path/' }, base)).publicOrigin, 'https://app.example.com');
});
h.test('inbox and engine routes require a session', function () {
  var saved = S.cookie; S.cookie = null;
  var paths = ['/api/inbox', '/api/inbox/threads/1', '/api/engine/status'];
  return paths.reduce(function (p, path) { return p.then(function () { return request('GET', path); }).then(function (r) { assert.strictEqual(r.status, 401, path); }); }, Promise.resolve())
    .then(function () { return request('POST', '/api/inbox/sync', { json: {} }); }).then(function (r) { assert.strictEqual(r.status, 401); S.cookie = saved; });
});
h.test('sender test-connection (dry-run) succeeds, arms reply tracking; engine status reflects it', function () {
  return request('POST', '/api/senders', { json: { label: 'G1', email: 'g1@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' } }).then(function (r) {
    assert.strictEqual(r.status, 201); S.sid = r.body.sender.id;
    return request('GET', '/api/engine/status');
  }).then(function (r) {
    assert.strictEqual(r.body.mode, 'dry-run'); assert.strictEqual(r.body.senders[0].reply_tracking, 'pending');
    return request('POST', '/api/senders/' + S.sid + '/test', { json: {} });
  }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.smtp.ok, true); assert.strictEqual(r.body.imap.ok, true);
    assert.ok(JSON.stringify(r.body).indexOf('abcdefghijklmnop') === -1);
    return request('GET', '/api/engine/status');
  }).then(function (r) { assert.strictEqual(r.body.senders[0].reply_tracking, 'ok'); });
});
h.test('sender test on a foreign/unknown id is 404; inbox is empty; sync works', function () {
  return request('POST', '/api/senders/9999/test', { json: {} }).then(function (r) {
    assert.strictEqual(r.status, 404); return request('GET', '/api/inbox');
  }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.total, 0); assert.strictEqual(r.body.unread, 0);
    return request('GET', '/api/inbox?sentiment=bogus');
  }).then(function (r) { assert.strictEqual(r.status, 400); return request('POST', '/api/inbox/sync', { json: {} }); })
    .then(function (r) { assert.strictEqual(r.status, 200); assert.strictEqual(r.body.senders, 1); return request('GET', '/api/inbox/threads/abc'); })
    .then(function (r) { assert.strictEqual(r.status, 404); return request('POST', '/api/inbox/threads/1/reply', { json: { body: 'hi' } }); })
    .then(function (r) { assert.strictEqual(r.status, 404); });
});
h.test('public unsubscribe: no session/CSRF needed, GET is read-only, POST acts, forged token is 404, page has its own CSP', function () {
  var db = S.app.db;
  return db.run("INSERT INTO folders (user_id, name, created_at) VALUES (1, 'F', 1)").then(function (f) {
    return db.run("INSERT INTO leads (user_id, folder_id, email, domain, created_at) VALUES (1, ?, 'lead@co.com', 'co.com', 1)", [f.lastID]);
  }).then(function (l) {
    return db.run("INSERT INTO campaigns (user_id, name, status, created_at, updated_at) VALUES (1, 'C', 'active', 1, 1)").then(function (c) {
      return db.run("INSERT INTO campaign_leads (campaign_id, lead_id, status, next_send_at, position, current_step) VALUES (?, ?, 'active', 5, 0, 0)", [c.lastID, l.lastID]);
    });
  }).then(function (cl) {
    S.tok = unsub.make(S.app.engine.secret, cl.lastID);
    var saved = S.cookie; S.cookie = null;
    return request('GET', '/u/' + S.tok).then(function (r) {
      assert.strictEqual(r.status, 200); assert.ok(/Unsubscribe\?/.test(r.text) && /l\*\*\*@co\.com/.test(r.text)); assert.ok(/default-src 'none'/.test(r.headers['content-security-policy']));
      return db.get("SELECT status FROM campaign_leads WHERE id = ?", [cl.lastID]);
    }).then(function (row) {
      assert.strictEqual(row.status, 'active');
      return request('POST', '/u/' + S.tok, { form: true });
    }).then(function (r) {
      assert.strictEqual(r.status, 200); assert.ok(/unsubscribed/i.test(r.text));
      return Promise.all([db.get('SELECT status FROM campaign_leads WHERE id = ?', [cl.lastID]), db.get("SELECT reason FROM suppression WHERE email = 'lead@co.com'")]);
    }).then(function (x) {
      assert.strictEqual(x[0].status, 'unsubscribed'); assert.strictEqual(x[1].reason, 'unsubscribed');
      return request('POST', '/u/' + S.tok.slice(0, -3) + 'abc', { form: true });
    }).then(function (r) { assert.strictEqual(r.status, 404); return request('GET', '/u/not-a-token'); })
      .then(function (r) { assert.strictEqual(r.status, 404); S.cookie = saved; });
  });
});
h.test('shutdown', function () { return new Promise(function (r) { S.server.close(r); }).then(function () { return S.app.close(); }); });

h.run();
