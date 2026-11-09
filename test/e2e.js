'use strict';
// End-to-end test over a real HTTP server on an ephemeral port.
var assert = require('assert');
var http = require('http');
var crypto = require('crypto');
var h = require('./helpers');
var config = require('../src/config');
var createApp = require('../src/app').createApp;

var STRONG = 'Tr0ub4dor&3-horse-staple';
var state = {};

function request(method, path, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var headers = Object.assign({ Host: state.host }, opts.headers || {});
    var payload = null;
    if (opts.json !== undefined) { payload = Buffer.from(JSON.stringify(opts.json)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (opts.raw !== undefined) { payload = Buffer.from(opts.raw); headers['Content-Length'] = payload.length; if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'; }
    if (opts.auth !== false && state.cookie) headers.Cookie = state.cookie;
    if (method !== 'GET' && opts.client !== false) headers['X-SB-Client'] = '1';
    if (opts.csrf !== false && state.csrf && method !== 'GET' && !headers['X-CSRF-Token']) headers['X-CSRF-Token'] = state.csrf;
    var req = http.request({ host: '127.0.0.1', port: state.port, method: method, path: path, headers: headers }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), body = text;
        try { body = JSON.parse(text); } catch (e) { /* csv etc. */ }
        resolve({ status: res.statusCode, headers: res.headers, body: body, text: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

h.group('e2e: server, headers, auth flow');
h.test('boot server', function () {
  var cfg = config.build({
    SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    PORT: '0', HOST: '127.0.0.1', SENDERBOLT_DB_FILE: ':memory:'
  });
  // fake DNS so the test never touches the network
  cfg.resolver = { resolveMx: function (d) { return d === 'good.com' ? Promise.resolve([{ exchange: 'mx.good.com', priority: 1 }]) : Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })); }, resolveAddr: function () { return Promise.resolve([]); } };
  return createApp(cfg).then(function (app) {
    state.app = app;
    state.server = http.createServer(app.dispatch);
    return new Promise(function (resolve) {
      state.server.listen(0, '127.0.0.1', function () {
        state.port = state.server.address().port;
        // rebuild allowed hosts now that the port is known
        resolve();
      });
    });
  });
});
h.test('host allowlist: wrong Host header is rejected (DNS rebinding guard)', function () {
  // allowedHosts were built for port 0; patch via a fresh dispatcher is overkill, so check rejection first
  return request('GET', '/api/auth/status', { headers: { Host: 'evil.com' } }).then(function (r) {
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'bad_host');
  });
});
h.test('configure allowed hosts for the ephemeral port', function () {
  state.server.removeAllListeners('request');
  var cfg2 = state.app;
  // re-create dispatcher through the app with correct host list
  return state.app.close().then(function () {
    var cfg = config.build({
      SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      PORT: String(state.port), HOST: '127.0.0.1', SENDERBOLT_DB_FILE: ':memory:', SENDERBOLT_SETUP_TOKEN: 'setup-token-123'
    });
    cfg.resolver = { resolveMx: function (d) { return d === 'good.com' ? Promise.resolve([{ exchange: 'mx.good.com', priority: 1 }]) : Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })); }, resolveAddr: function () { return Promise.resolve([]); } };
    return createApp(cfg).then(function (app) {
      state.app = app; state.host = '127.0.0.1:' + state.port; state.origin = 'http://' + state.host;
      state.server.on('request', app.dispatch);
    });
  });
});
h.test('security headers present; unknown route 404; wrong method 405', function () {
  return request('GET', '/api/auth/status').then(function (r) {
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.needsSetup, true);
    assert.ok(/default-src 'self'/.test(r.headers['content-security-policy']));
    assert.ok(/frame-ancestors 'none'/.test(r.headers['content-security-policy']));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.ok(!r.headers['x-powered-by']);
    return request('GET', '/api/nope');
  }).then(function (r) { assert.strictEqual(r.status, 404); return request('PUT', '/api/auth/status', { json: {} }); })
    .then(function (r) { assert.strictEqual(r.status, 405); assert.ok(/GET/.test(r.headers.allow)); });
});
h.test('protected routes require a session', function () {
  return request('GET', '/api/senders').then(function (r) { assert.strictEqual(r.status, 401); return request('GET', '/api/folders'); })
    .then(function (r) { assert.strictEqual(r.status, 401); });
});
h.test('setup needs the setup token, then closes', function () {
  return request('POST', '/api/auth/setup', { json: { email: 'me@example.com', password: STRONG } }).then(function (r) {
    assert.strictEqual(r.status, 403);
    return request('POST', '/api/auth/setup', { json: { email: 'me@example.com', password: STRONG, setupToken: 'setup-token-123' } });
  }).then(function (r) {
    assert.strictEqual(r.status, 201);
    return request('POST', '/api/auth/setup', { json: { email: 'two@example.com', password: STRONG, setupToken: 'setup-token-123' } });
  }).then(function (r) { assert.strictEqual(r.status, 403); });
});
h.test('login: cookie flags, generic failure, CSRF token returned', function () {
  return request('POST', '/api/auth/login', { json: { email: 'me@example.com', password: 'wrong-password-123' } }).then(function (r) {
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'invalid_credentials');
    return request('POST', '/api/auth/login', { json: { email: 'me@example.com', password: STRONG } });
  }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.ok(r.body.csrfToken);
    var sc = r.headers['set-cookie'][0];
    assert.ok(/^sb_sid=/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc));
    state.cookie = sc.split(';')[0]; state.csrf = r.body.csrfToken;
    return request('GET', '/api/auth/me');
  }).then(function (r) { assert.strictEqual(r.body.user.email, 'me@example.com'); assert.strictEqual(r.body.csrfToken, state.csrf); });
});

h.group('e2e: CSRF and request hardening');
h.test('POST without CSRF token / client header / with evil origin is blocked', function () {
  return request('POST', '/api/folders', { json: { name: 'X' }, csrf: false }).then(function (r) {
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'csrf_token');
    return request('POST', '/api/folders', { json: { name: 'X' }, client: false });
  }).then(function (r) { assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'csrf_header');
    return request('POST', '/api/folders', { json: { name: 'X' }, headers: { Origin: 'http://evil.com' } });
  }).then(function (r) { assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'csrf_origin');
    return request('POST', '/api/folders', { json: { name: 'X' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  }).then(function (r) { assert.strictEqual(r.status, 403);
    return request('POST', '/api/folders', { json: { name: 'X' }, headers: { 'X-CSRF-Token': 'forged' } });
  }).then(function (r) { assert.strictEqual(r.status, 403); return request('GET', '/api/folders'); })
    .then(function (r) { assert.strictEqual(r.body.items.length, 0); });         // nothing was created
});
h.test('malformed JSON, wrong content-type, arrays and oversized bodies are rejected', function () {
  return request('POST', '/api/folders', { raw: '{bad json' }).then(function (r) {
    assert.strictEqual(r.status, 400); return request('POST', '/api/folders', { raw: '[1,2]' });
  }).then(function (r) { assert.strictEqual(r.status, 400);
    return request('POST', '/api/folders', { raw: '{"name":"x"}', headers: { 'Content-Type': 'text/plain' } });
  }).then(function (r) { assert.strictEqual(r.status, 415);
    return request('POST', '/api/folders', { raw: JSON.stringify({ name: new Array(300000).join('a') }) });
  }).then(function (r) { assert.strictEqual(r.status, 413); });
});
h.test('bad path ids are 404, never reach the database', function () {
  return request('GET', '/api/senders/abc').then(function (r) { assert.strictEqual(r.status, 404); return request('GET', '/api/senders/0'); })
    .then(function (r) { assert.strictEqual(r.status, 404); return request('GET', "/api/senders/1;DROP%20TABLE%20senders"); })
    .then(function (r) { assert.strictEqual(r.status, 404); return request('GET', '/api/senders/%E0%A4%A'); })
    .then(function (r) { assert.strictEqual(r.status, 400); });
});

h.group('e2e: senders over HTTP');
h.test('create sender: 201, password never in any response, 400 cap enforced', function () {
  return request('POST', '/api/senders', { json: { label: 'Main', email: 'me@gmail.com', provider: 'gmail', password: 'abcd efgh ijkl mnop', daily_limit: 401 } }).then(function (r) {
    assert.strictEqual(r.status, 400); assert.ok(r.body.details.daily_limit);
    return request('POST', '/api/senders', { json: { label: 'Main', email: 'me@gmail.com', provider: 'gmail', password: 'abcd efgh ijkl mnop', daily_limit: 400 } });
  }).then(function (r) {
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.sender.daily_limit, 400);
    assert.ok(r.text.indexOf('abcdefghijklmnop') === -1 && r.text.indexOf('password_enc') === -1);
    state.senderId = r.body.sender.id;
    return request('GET', '/api/senders');
  }).then(function (r) { assert.ok(r.text.indexOf('abcdefghijklmnop') === -1 && r.text.indexOf('v1.') === -1); assert.strictEqual(r.body.items.length, 1); });
});
h.test('patch, status and delete sender', function () {
  return request('PATCH', '/api/senders/' + state.senderId, { json: { daily_limit: 120, from_name: 'Alex' } }).then(function (r) {
    assert.strictEqual(r.body.sender.daily_limit, 120);
    return request('PATCH', '/api/senders/' + state.senderId, { json: { daily_limit: 999 } });
  }).then(function (r) { assert.strictEqual(r.status, 400); return request('POST', '/api/senders/' + state.senderId + '/status', { json: { status: 'paused' } }); })
    .then(function (r) { assert.strictEqual(r.body.sender.status, 'paused'); return request('DELETE', '/api/senders/' + state.senderId); })
    .then(function (r) { assert.strictEqual(r.status, 200); return request('GET', '/api/senders/' + state.senderId); })
    .then(function (r) { assert.strictEqual(r.status, 404); });
});

h.group('e2e: leads over HTTP');
h.test('folder, import, stats, verify, export, delete', function () {
  var folderId;
  return request('POST', '/api/folders', { json: { name: 'Crypto domains' } }).then(function (r) {
    assert.strictEqual(r.status, 201); folderId = r.body.folder.id;
    return request('POST', '/api/folders/' + folderId + '/import', { json: { format: 'csv', data: 'email,company\nann@good.com,Acme\nbob@gone.com,=EVIL()\nbad@@x\n' } });
  }).then(function (r) {
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.result.imported, 2); assert.strictEqual(r.body.result.invalid, 1);
    return request('GET', '/api/folders/' + folderId + '/leads?pageSize=10&sort=email&dir=asc');
  }).then(function (r) {
    assert.strictEqual(r.body.total, 2);
    state.leadIds = r.body.items.map(function (l) { return l.id; });
    return request('POST', '/api/leads/verify', { json: { ids: state.leadIds } });
  }).then(function (r) {
    assert.strictEqual(r.body.valid, 1); assert.strictEqual(r.body.invalid, 1);
    return request('GET', '/api/folders/' + folderId + '/stats');
  }).then(function (r) {
    assert.strictEqual(r.body.stats.total, 2); assert.strictEqual(r.body.stats.valid_rate, 50);
    return request('GET', '/api/folders/' + folderId + '/export');
  }).then(function (r) {
    assert.ok(/text\/csv/.test(r.headers['content-type']) && /attachment/.test(r.headers['content-disposition']));
    assert.ok(r.text.indexOf("'=EVIL()") !== -1);
    return request('POST', '/api/leads/delete', { json: { ids: state.leadIds } });
  }).then(function (r) { assert.strictEqual(r.body.deleted, 2); });
});
h.test('verify endpoint is rate limited per user', function () {
  var p = Promise.resolve(), last;
  for (var i = 0; i < 14; i++) p = p.then(function () { return request('POST', '/api/leads/verify', { json: { ids: [999999] } }).then(function (r) { last = r; }); });
  return p.then(function () { assert.strictEqual(last.status, 429); assert.ok(last.headers['retry-after']); });
});

h.group('e2e: campaigns over HTTP');
h.test('wizard flow: preview split, create split campaign, start, list, pause, delete', function () {
  var folderId, senderId, campId, emails = [];
  for (var i = 0; i < 30; i++) emails.push('p' + i + '@c' + (i % 10) + '.com');         // 10 companies x 3 contacts
  return request('POST', '/api/senders', { json: { label: 'Camp', email: 'camp@gmail.com', provider: 'gmail', password: 'abcdefghijklmnop' } }).then(function (r) {
    senderId = r.body.sender.id; return request('POST', '/api/folders', { json: { name: 'Campaign leads' } });
  }).then(function (r) {
    folderId = r.body.folder.id; return request('POST', '/api/folders/' + folderId + '/import', { json: { format: 'paste', data: emails.join('\n') } });
  }).then(function (r) {
    assert.strictEqual(r.body.result.imported, 30);
    return request('POST', '/api/campaigns/split-preview', { json: { folder_id: folderId, batch_size: 10, seed: 7 } });
  }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.sizes, [10, 10, 10]); assert.strictEqual(r.body.same_company_in_one_batch, 0);
    return request('POST', '/api/templates/preview', { json: { subject: 'Hi {{nickname|there}} from {{company}}', body_html: '<p>{{first_name}}</p>' } });
  }).then(function (r) {
    assert.strictEqual(r.body.subject, 'Hi there from Acme Domains');
    var body = { name: 'HTTP campaign', folder_id: folderId, sender_ids: [senderId], split: { batch_size: 10, seed: 7 },
      steps: [{ subject: 'Hello', body_html: '<p>Hi</p>' }, { subject: '', body_html: '<p>Bump</p>', delay_days: 2 }] };
    return request('POST', '/api/campaigns', { json: body, csrf: false }).then(function (nr) {
      assert.strictEqual(nr.status, 403);                                                  // CSRF enforced on the new routes too
      return request('POST', '/api/campaigns', { json: body });
    });
  }).then(function (r) {
    assert.strictEqual(r.status, 201); campId = r.body.campaign.id; assert.strictEqual(r.body.campaign.parts.length, 3);
    return request('POST', '/api/campaigns/' + campId + '/start', { json: {} });
  }).then(function (r) {
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.campaign.status, 'active'); assert.strictEqual(r.body.campaign.estimate.emails_total_max, 60);
    return request('GET', '/api/campaigns?status=active&q=http');
  }).then(function (r) {
    assert.strictEqual(r.body.total, 1); assert.strictEqual(r.body.counts.active, 1); assert.strictEqual(r.body.items[0].stats.total, 30);
    return request('DELETE', '/api/campaigns/' + campId);
  }).then(function (r) {
    assert.strictEqual(r.status, 409);
    return request('POST', '/api/campaigns/' + campId + '/pause', { json: {} });
  }).then(function (r) { assert.strictEqual(r.body.campaign.status, 'paused'); return request('GET', '/api/campaigns/' + campId + '/leads?pageSize=5'); })
    .then(function (r) { assert.strictEqual(r.body.total, 30); assert.strictEqual(r.body.items.length, 5); return request('DELETE', '/api/campaigns/' + campId); })
    .then(function (r) { assert.strictEqual(r.status, 200); return request('GET', '/api/campaigns/' + campId); })
    .then(function (r) {
      assert.strictEqual(r.status, 404);
      return request('DELETE', '/api/folders/' + folderId);                               // tidy up so later tests see a clean account
    }).then(function () { return request('DELETE', '/api/senders/' + senderId); })
    .then(function (r) { assert.strictEqual(r.status, 200); });
});

h.group('e2e: isolation, password change, logout');
h.test('a second user cannot see or touch the first user\'s data', function () {
  var owner = { cookie: state.cookie, csrf: state.csrf }, folderId;
  return request('POST', '/api/folders', { json: { name: 'Private' } }).then(function (r) {
    folderId = r.body.folder.id;
    // add a second user directly in the DB (registration is closed by design) and log in
    return require('../src/lib/password').hashAsync('Second-Strong-Pass-1').then(function (hash) {
      return state.app.db.run('INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?,?,?)', ['two@example.com', hash, 'member', Date.now()]);
    });
  }).then(function () {
    state.cookie = null; state.csrf = null;
    return request('POST', '/api/auth/login', { json: { email: 'two@example.com', password: 'Second-Strong-Pass-1' } });
  }).then(function (r) {
    state.cookie = r.headers['set-cookie'][0].split(';')[0]; state.csrf = r.body.csrfToken;
    return request('GET', '/api/folders/' + folderId + '/leads');
  }).then(function (r) { assert.strictEqual(r.status, 404); return request('DELETE', '/api/folders/' + folderId); })
    .then(function (r) { assert.strictEqual(r.status, 404); return request('GET', '/api/folders'); })
    .then(function (r) {
      assert.strictEqual(r.body.items.length, 0);
      state.cookie = owner.cookie; state.csrf = owner.csrf;
      return request('GET', '/api/folders');
    }).then(function (r) {
      assert.strictEqual(r.body.items.length, 2);            // "Crypto domains" (earlier test) + "Private"
      assert.ok(r.body.items.some(function (f) { return f.name === 'Private'; }));
    });
});
h.test('password change keeps current session, logout kills it', function () {
  return request('POST', '/api/auth/password', { json: { currentPassword: STRONG, newPassword: 'Brand-New-Strong-Pass-7' } }).then(function (r) {
    assert.strictEqual(r.status, 200); return request('GET', '/api/auth/me');
  }).then(function (r) { assert.strictEqual(r.status, 200); return request('POST', '/api/auth/logout', { json: {} }); })
    .then(function (r) {
      assert.strictEqual(r.status, 200); assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0]));
      return request('GET', '/api/auth/me');
    }).then(function (r) { assert.strictEqual(r.status, 401); });
});
h.test('login brute force is throttled (429 with Retry-After)', function () {
  state.cookie = null; state.csrf = null;
  var p = Promise.resolve(), last;
  for (var i = 0; i < 12; i++) p = p.then(function () { return request('POST', '/api/auth/login', { json: { email: 'me@example.com', password: 'guess-guess-guess-' + i } }).then(function (r) { last = r; }); });
  return p.then(function () { assert.strictEqual(last.status, 429); assert.ok(last.headers['retry-after']); });
});
h.test('shutdown', function () {
  return new Promise(function (resolve) { state.server.close(resolve); }).then(function () { return state.app.close(); });
});

h.run();
