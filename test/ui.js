'use strict';
// Web UI: static-file hardening, "no unsafe DOM API" source scan, CSP-compatibility.
var assert = require('assert');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var h = require('./helpers');
var config = require('../src/config');
var createApp = require('../src/app').createApp;

var PUB = path.join(__dirname, '..', 'public');
var S = {};

function get(p, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var req = http.request({ host: '127.0.0.1', port: S.port, method: opts.method || 'GET', path: p, headers: Object.assign({ Host: opts.host || S.host }, opts.headers || {}) }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject); req.end();
  });
}
function rawGet(rawPath) {   // send the path exactly as written (http.request would normalise nothing, but be explicit)
  return get(rawPath);
}
function walk(dir) {
  var out = [];
  fs.readdirSync(dir).forEach(function (f) { var p = path.join(dir, f); if (fs.statSync(p).isDirectory()) out = out.concat(walk(p)); else out.push(p); });
  return out;
}

h.group('web UI: static serving');
h.test('boot', function () {
  var probe = http.createServer();
  return new Promise(function (r) { probe.listen(0, '127.0.0.1', r); }).then(function () { S.port = probe.address().port; return new Promise(function (r) { probe.close(r); }); }).then(function () {
    var cfg = config.build({ SENDERBOLT_MASTER_KEY: crypto.randomBytes(32).toString('hex'), SENDERBOLT_SESSION_SECRET: crypto.randomBytes(32).toString('hex'), PORT: String(S.port), HOST: '127.0.0.1', SENDERBOLT_DB_FILE: ':memory:' });
    var io = h.fakeIO(); cfg.mailer = io.mailer; cfg.mailbox = io.mailbox;
    return createApp(cfg);
  }).then(function (app) { S.app = app; S.host = '127.0.0.1:' + S.port; S.server = http.createServer(app.dispatch); return new Promise(function (r) { S.server.listen(S.port, '127.0.0.1', r); }); });
});
h.test('serves the app shell, assets with correct types, strict security headers, no caching surprises', function () {
  return get('/').then(function (r) {
    assert.strictEqual(r.status, 200); assert.ok(/text\/html/.test(r.headers['content-type'])); assert.ok(r.text.indexOf('<div id="app">') !== -1);
    assert.ok(/script-src 'self'/.test(r.headers['content-security-policy']) && /frame-ancestors 'none'/.test(r.headers['content-security-policy']));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff'); assert.strictEqual(r.headers['x-frame-options'], 'DENY'); assert.strictEqual(r.headers['cache-control'], 'no-cache');
    return get('/css/app.css');
  }).then(function (r) { assert.ok(/text\/css/.test(r.headers['content-type'])); return get('/js/app.js'); })
    .then(function (r) { assert.ok(/javascript/.test(r.headers['content-type'])); return get('/favicon.svg'); })
    .then(function (r) { assert.ok(/svg/.test(r.headers['content-type'])); return get('/', { method: 'HEAD' }); })
    .then(function (r) { assert.strictEqual(r.status, 200); assert.strictEqual(r.text, ''); });
});
h.test('path traversal, dotfiles, backslashes, null bytes, odd extensions and directories all give 404', function () {
  var bad = ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/js/%2e%2e/%2e%2e/package.json', '/css/..%2f..%2fpackage.json', '/%2e%2e%2fpackage.json',
    '/.env', '/js/.hidden.js', '/..%5cpackage.json', '/js%5c..%5c..%5cpackage.json', '/index.html%00.js', '/js/', '/js', '/css', '/package.json', '/src/server.js', '/data/senderbolt.db', '/js/app.js.map', '/index.php', '/%E0%A4%A'];
  return bad.reduce(function (p, u) {
    return p.then(function () { return rawGet(u); }).then(function (r) { assert.ok(r.status === 404 || r.status === 400, u + ' -> ' + r.status); assert.ok(r.text.indexOf('"name": "senderbolt"') === -1 && r.text.indexOf('SENDERBOLT_MASTER_KEY') === -1, u + ' leaked content'); });
  }, Promise.resolve());
});
h.test('only GET/HEAD reach static files; unknown API paths stay JSON 404; wrong Host rejected', function () {
  return get('/', { method: 'POST' }).then(function (r) { assert.ok(r.status === 404 || r.status === 403 || r.status === 405, 'POST / -> ' + r.status); return get('/api/nope'); })
    .then(function (r) { assert.strictEqual(r.status, 404); assert.ok(/json/.test(r.headers['content-type'])); return get('/', { host: 'evil.com' }); })
    .then(function (r) { assert.strictEqual(r.status, 400); });
});
h.test('shutdown', function () { return new Promise(function (r) { S.server.close(r); }).then(function () { return S.app.close(); }); });

h.group('web UI: source safety');
h.test('no unsafe DOM/JS APIs in /public/js (innerHTML, eval, document.write, inline handlers, javascript: URLs)', function () {
  var banned = [/\binnerHTML\b(?!['"])/, /\bouterHTML\b(?!['"])/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*['"]/, /setInterval\s*\(\s*['"]/, /javascript:/i, /\blocalStorage\b/, /\bsessionStorage\b/, /\.srcdoc\b/];
  walk(path.join(PUB, 'js')).forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    banned.forEach(function (re) {
      if (path.basename(f) === 'dom.js' && /innerHTML|outerHTML|srcdoc/.test(re.source)) return;     // dom.js lists them only to DROP them
      assert.ok(!re.test(src), path.relative(PUB, f) + ' contains ' + re);
    });
  });
});
h.test('index.html: no inline scripts/styles/handlers, no external resources; every script/style is same-origin', function () {
  var html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>'); assert.ok(!/<style/i.test(html)); assert.ok(!/\sstyle\s*=/i.test(html)); assert.ok(!/\son[a-z]+\s*=/i.test(html));
  assert.ok(!/https?:\/\//i.test(html), 'external URL in index.html');
  var srcs = html.match(/(?:src|href)="[^"]+"/g) || [];
  srcs.forEach(function (s) { assert.ok(/="\/[^\/]/.test(s), 'not same-origin: ' + s); });
  walk(PUB).forEach(function (f) { if (/\.css$/.test(f)) assert.ok(!/@import|url\(\s*['"]?https?:/i.test(fs.readFileSync(f, 'utf8')), 'external CSS import in ' + f); });
});
h.test('every script referenced by index.html exists', function () {
  var html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), re = /(?:src|href)="(\/[^"]+)"/g, m;
  while ((m = re.exec(html))) assert.ok(fs.existsSync(path.join(PUB, m[1])), 'missing ' + m[1]);
});
h.test('UI never persists secrets: the CSRF token is kept in memory only', function () {
  var api = fs.readFileSync(path.join(PUB, 'js', 'api.js'), 'utf8');
  assert.ok(/var csrf = null/.test(api)); assert.ok(!/document\.cookie/.test(api));
});

h.run();
