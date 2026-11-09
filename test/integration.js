'use strict';
// Integration tests: database, migrations, sessions, CSRF, rate limiting, auth, senders.
// Uses Node's built-in node:sqlite so the same SQL runs here as in production.
var assert = require('assert');
var crypto = require('crypto');
var database = require('../src/db');
var migrate = require('../src/db/migrate').migrate;
var vault = require('../src/lib/vault');
var cookies = require('../src/lib/cookies');
var health = require('../src/lib/health');
var Sessions = require('../src/services/sessions').Sessions;
var Auth = require('../src/services/auth').Auth;
var sendersMod = require('../src/services/senders');
var RateLimiter = require('../src/security/rateLimiter').RateLimiter;
var csrfProtection = require('../src/security/csrf').csrfProtection;
var requireAuth = require('../src/middleware/auth').requireAuth;

var SECRET = crypto.randomBytes(32).toString('hex');
var STRONG = 'Tr0ub4dor&3-horse-staple';
var passed = 0, failed = 0, tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function group(name) { tests.push({ group: name }); }

function freshDb() {
  return database.open(':memory:').then(function (db) {   // driver auto-picked: sqlite3 if installed, else node:sqlite
    return migrate(db).then(function () { return db; });
  });
}
function expectReject(promise, code) {
  return promise.then(function () { throw new Error('expected rejection' + (code ? ' ' + code : '')); },
    function (e) { if (code) assert.strictEqual(e.code, code, 'got ' + e.code + ': ' + e.message); return e; });
}
function makeRes() {
  var r = { statusCode: 200, headers: {}, body: '', setHeader: function (k, v) { r.headers[k] = v; }, end: function (b) { r.body = b || ''; } };
  return r;
}
function mkUser(db, addr) {
  return db.run('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)', [addr, 'x', 1]).then(function (r) { return r.lastID; });
}
var GOOD = { label: 'Main', email: 'me@gmail.com', provider: 'gmail', password: 'abcd efgh ijkl mnop' };

group('migrations and schema');
test('applies once, is idempotent, detects tampering', function () {
  return database.open(':memory:').then(function (db) {
    return migrate(db).then(function (a) {
      assert.deepStrictEqual(a, ['001_init.sql', '002_campaign_settings.sql', '003_engine.sql', '004_projects.sql']);
      return migrate(db);
    }).then(function (b) {
      assert.deepStrictEqual(b, []);
      return db.run("UPDATE schema_migrations SET checksum = 'tampered'");
    }).then(function () { return migrate(db); }).then(function () { throw new Error('should reject'); }, function (e) {
      assert.ok(/modified after being applied/.test(e.message));
    });
  });
});
test('database constraints reject bad data (limit > 400, orphan FK)', function () {
  return freshDb().then(function (db) {
    return mkUser(db, 'a@x.com').then(function (uid) {
      var ins = "INSERT INTO senders (user_id,label,email,provider,username,password_enc,smtp_host,smtp_port,daily_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
      return expectReject(db.run(ins, [uid, 'l', 'e@x.com', 'smtp', 'u', 'p', 'h.com', 587, 401, 1, 1]))
        .then(function () { return db.run(ins, [uid, 'l', 'e@x.com', 'smtp', 'u', 'p', 'h.com', 587, 400, 1, 1]); })
        .then(function () { return expectReject(db.run('INSERT INTO sessions (user_id,token_hash,created_at,last_seen_at,expires_at) VALUES (999,?,1,1,2)', ['h'])); });
    });
  });
});
test('transaction rolls back on error', function () {
  return freshDb().then(function (db) {
    return expectReject(db.transaction(function (tx) {
      return tx.run('INSERT INTO users (email,password_hash,created_at) VALUES (?,?,?)', ['t@x.com', 'x', 1]).then(function () { throw new Error('boom'); });
    })).then(function () { return db.get('SELECT COUNT(*) AS c FROM users'); }).then(function (r) { assert.strictEqual(r.c, 0); });
  });
});

group('rate limiter and CSRF');
test('rate limiter blocks, recovers, and bounds memory', function () {
  var t = 1000, rl = new RateLimiter({ windowMs: 1000, max: 3, maxKeys: 5, now: function () { return t; } });
  assert.ok(rl.consume('a').allowed && rl.consume('a').allowed && rl.consume('a').allowed);
  var blocked = rl.consume('a');
  assert.ok(!blocked.allowed && blocked.retryAfterMs > 0);
  t += 1001;
  assert.ok(rl.consume('a').allowed);
  for (var i = 0; i < 20; i++) rl.consume('k' + i);
  assert.ok(rl.hits.size <= 5);
});
test('csrf: safe methods pass; POST needs origin + token', function () {
  var mw = csrfProtection({ allowedOrigins: ['http://127.0.0.1:3000'] });
  function run(req) { var res = makeRes(), called = false; mw(req, res, function () { called = true; }); return { res: res, called: called }; }
  assert.ok(run({ method: 'GET', headers: {} }).called);
  var s = { csrfToken: 'tok123' };
  assert.ok(run({ method: 'POST', headers: { 'x-csrf-token': 'tok123' }, session: s }).called);
  assert.ok(run({ method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'x-csrf-token': 'tok123' }, session: s }).called);
  assert.strictEqual(run({ method: 'POST', headers: { origin: 'http://evil.com', 'x-csrf-token': 'tok123' }, session: s }).res.statusCode, 403);
  assert.strictEqual(run({ method: 'POST', headers: {}, session: s }).res.statusCode, 403);
  assert.strictEqual(run({ method: 'POST', headers: { 'x-csrf-token': 'wrong' }, session: s }).res.statusCode, 403);
  assert.strictEqual(run({ method: 'DELETE', headers: { 'x-csrf-token': 'tok123' } }).res.statusCode, 403);
});
test('cookie serializer blocks header injection', function () {
  assert.throws(function () { cookies.serialize('sid', 'a\r\nSet-Cookie: x=y'); });
  assert.throws(function () { cookies.serialize('sid', 'a; Domain=evil.com'); });
  var c = cookies.serialize('sb_sid', 'abc', { secure: true, maxAgeSec: 60 });
  assert.ok(/HttpOnly/.test(c) && /SameSite=Strict/.test(c) && /Secure/.test(c));
  assert.strictEqual(cookies.parse('a=1; sb_sid=tok; b=2').sb_sid, 'tok');
});

group('sessions');
test('session lifecycle: validate, idle expiry, absolute expiry, destroy', function () {
  return freshDb().then(function (db) {
    var clock = { t: 1700000000000 };
    var s = new Sessions(db, { secret: SECRET, idleMs: 1000 * 60, absoluteMs: 1000 * 60 * 10, now: function () { return clock.t; } });
    return mkUser(db, 'a@x.com').then(function (uid) {
      return s.create(uid, '1.2.3.4', 'UA').then(function (c) {
        assert.ok(c.token.length >= 40);
        return db.get('SELECT token_hash FROM sessions').then(function (row) {
          assert.notStrictEqual(row.token_hash, c.token);                // raw token never stored
          return s.validate(c.token);
        }).then(function (v) {
          assert.strictEqual(v.userId, uid);
          assert.ok(v.csrfToken);
          return s.validate('garbage');
        }).then(function (g) {
          assert.strictEqual(g, null);
          clock.t += 30000; return s.validate(c.token);
        }).then(function (v) { assert.ok(v); clock.t += 70000; return s.validate(c.token); })   // idle > 60s
          .then(function (v) { assert.strictEqual(v, null); return s.create(uid, 'ip', 'UA'); })
          .then(function (c2) {
            return s.destroy(c2.token).then(function () { return s.validate(c2.token); }).then(function (v) { assert.strictEqual(v, null); return s.create(uid); });
          }).then(function (c3) {
            clock.t += 1000 * 60 * 11;                                                     // beyond absolute lifetime
            return s.validate(c3.token).then(function (v) { assert.strictEqual(v, null); });
          });
      });
    });
  });
});
test('session cap per user and short secret rejected', function () {
  return freshDb().then(function (db) {
    assert.throws(function () { new Sessions(db, { secret: 'short' }); });
    var s = new Sessions(db, { secret: SECRET });
    return mkUser(db, 'a@x.com').then(function (uid) {
      var p = Promise.resolve();
      for (var i = 0; i < 14; i++) p = p.then(function () { return s.create(uid); });
      return p.then(function () { return db.get('SELECT COUNT(*) AS c FROM sessions'); }).then(function (r) { assert.strictEqual(r.c, 10); });
    });
  });
});

group('auth');
function authSetup(opts) {
  return freshDb().then(function (db) {
    var clock = { t: 1700000000000 };
    var now = function () { return clock.t; };
    var sessions = new Sessions(db, { secret: SECRET, now: now });
    var auth = new Auth(db, sessions, Object.assign({ now: now }, opts || {}));
    return { db: db, clock: clock, sessions: sessions, auth: auth };
  });
}
test('bootstrap: first user is owner, registration then closes; policy enforced', function () {
  return authSetup().then(function (c) {
    return c.auth.needsSetup().then(function (n) {
      assert.strictEqual(n, true);
      return expectReject(c.auth.createUser('owner@example.com', 'short'), 'validation');
    }).then(function () { return expectReject(c.auth.createUser('owner@example.com', 'owner-example-123'), 'validation'); })
      .then(function () { return c.auth.createUser('Owner@Example.com', STRONG, '1.1.1.1'); })
      .then(function (u) { assert.strictEqual(u.email, 'owner@example.com'); return c.db.get('SELECT role, password_hash FROM users'); })
      .then(function (row) { assert.strictEqual(row.role, 'owner'); assert.ok(/^scrypt\$/.test(row.password_hash)); return c.auth.needsSetup(); })
      .then(function (n) { assert.strictEqual(n, false); return expectReject(c.auth.createUser('second@example.com', STRONG), 'registration_closed'); });
  });
});
test('login: success issues fresh session; failures are generic', function () {
  return authSetup().then(function (c) {
    return c.auth.createUser('me@example.com', STRONG).then(function () {
      return c.auth.login('ME@example.com', STRONG, { ip: '9.9.9.9', userAgent: 'UA' });
    }).then(function (r1) {
      assert.ok(r1.token && r1.csrfToken && r1.user.email === 'me@example.com');
      return c.auth.login('me@example.com', STRONG, { ip: '9.9.9.9' }).then(function (r2) { assert.notStrictEqual(r1.token, r2.token); });
    }).then(function () { return expectReject(c.auth.login('me@example.com', 'wrong-password-123', { ip: 'x' }), 'invalid_credentials'); })
      .then(function (e1) {
        return expectReject(c.auth.login('nobody@example.com', 'wrong-password-123', { ip: 'x' }), 'invalid_credentials').then(function (e2) {
          assert.strictEqual(e1.message, e2.message);                     // no user enumeration
        });
      });
  });
});
test('lockout after 5 failures, even the right password is refused until it expires', function () {
  return authSetup().then(function (c) {
    return c.auth.createUser('me@example.com', STRONG).then(function () {
      var p = Promise.resolve();
      for (var i = 0; i < 5; i++) p = p.then(function () { return expectReject(c.auth.login('me@example.com', 'bad-password-123', { ip: 'x' }), 'invalid_credentials'); });
      return p;
    }).then(function () { return expectReject(c.auth.login('me@example.com', STRONG, { ip: 'x' }), 'invalid_credentials'); })
      .then(function () { c.clock.t += 16 * 60 * 1000; return c.auth.login('me@example.com', STRONG, { ip: 'x' }); })
      .then(function (r) { assert.ok(r.token); return c.db.get('SELECT failed_logins, locked_until FROM users'); })
      .then(function (u) { assert.strictEqual(u.failed_logins, 0); assert.strictEqual(u.locked_until, null); });
  });
});
test('login rate limiting per IP returns 429 with retry info', function () {
  var clockT = 1700000000000;
  var ipLimiter = new RateLimiter({ windowMs: 60000, max: 3, now: function () { return clockT; } });
  return authSetup({ ipLimiter: ipLimiter }).then(function (c) {
    return c.auth.createUser('me@example.com', STRONG).then(function () {
      var p = Promise.resolve();
      for (var i = 0; i < 3; i++) p = p.then(function () { return expectReject(c.auth.login('me@example.com', 'bad-password-123', { ip: '5.5.5.5' }), 'invalid_credentials'); });
      return p;
    }).then(function () { return expectReject(c.auth.login('me@example.com', STRONG, { ip: '5.5.5.5' }), 'rate_limited'); })
      .then(function (e) { assert.strictEqual(e.status, 429); assert.ok(e.details.retryAfterMs > 0); });
  });
});
test('password change revokes other sessions but keeps the current one', function () {
  return authSetup().then(function (c) {
    return c.auth.createUser('me@example.com', STRONG).then(function (u) {
      return c.auth.login('me@example.com', STRONG, { ip: 'a' }).then(function (a) {
        return c.auth.login('me@example.com', STRONG, { ip: 'b' }).then(function (b) {
          return expectReject(c.auth.changePassword(u.id, 'nope-nope-nope-1', 'Another-Strong-Pass-9', b.token), 'invalid_credentials')
            .then(function () { return c.auth.changePassword(u.id, STRONG, 'Another-Strong-Pass-9', b.token, 'ip'); })
            .then(function () { return c.sessions.validate(a.token); })
            .then(function (va) { assert.strictEqual(va, null); return c.sessions.validate(b.token); })
            .then(function (vb) { assert.ok(vb); return c.auth.login('me@example.com', 'Another-Strong-Pass-9', { ip: 'c' }); })
            .then(function (r) { assert.ok(r.token); });
        });
      });
    });
  });
});
test('requireAuth middleware', function () {
  return authSetup().then(function (c) {
    return c.auth.createUser('me@example.com', STRONG).then(function () { return c.auth.login('me@example.com', STRONG, { ip: 'a' }); }).then(function (l) {
      var mw = requireAuth(c.sessions, 'sb_sid');
      var res1 = makeRes(), req1 = { headers: { cookie: 'x=1; sb_sid=' + l.token } };
      return new Promise(function (resolve) { mw(req1, res1, resolve); }).then(function () {
        assert.strictEqual(req1.user.email, 'me@example.com');
        var res2 = makeRes();
        mw({ headers: {} }, res2, function () { throw new Error('must not pass'); });
        assert.strictEqual(res2.statusCode, 401);
        var res3 = makeRes();
        return new Promise(function (resolve) {
          mw({ headers: { cookie: 'sb_sid=forged-token-value-forged-token-value' } }, res3, function () { throw new Error('must not pass'); });
          setTimeout(resolve, 50);
        }).then(function () { assert.strictEqual(res3.statusCode, 401); });
      });
    });
  });
});

group('senders');
function sendersSetup() {
  return freshDb().then(function (db) {
    var key = vault.loadKey(crypto.randomBytes(32).toString('hex'));
    var svc = new sendersMod.Senders(db, key);
    return mkUser(db, 'a@x.com').then(function (a) { return mkUser(db, 'b@x.com').then(function (b) { return { db: db, key: key, svc: svc, a: a, b: b }; }); });
  });
}
test('create encrypts the password and never returns it', function () {
  return sendersSetup().then(function (c) {
    return c.svc.create(c.a, GOOD, '1.1.1.1').then(function (s) {
      assert.strictEqual(s.provider, 'gmail');
      assert.strictEqual(s.smtp_host, 'smtp.gmail.com');
      assert.strictEqual(s.daily_limit, 50);
      assert.ok(s.has_password && s.password_enc === undefined && s.password === undefined);
      return c.db.get('SELECT password_enc FROM senders').then(function (raw) {
        assert.ok(/^v1\./.test(raw.password_enc) && raw.password_enc.indexOf('abcdefghijklmnop') === -1);
        return c.svc.getCredentials(c.a, s.id);
      }).then(function (cred) { assert.strictEqual(cred.pass, 'abcdefghijklmnop'); assert.strictEqual(cred.host, 'smtp.gmail.com'); });
    });
  });
});
test('ciphertext is bound to its row (swapping rows breaks decryption)', function () {
  return sendersSetup().then(function (c) {
    return c.svc.create(c.a, GOOD).then(function (s1) {
      return c.svc.create(c.a, Object.assign({}, GOOD, { email: 'two@gmail.com', password: 'zzzzyyyyxxxxwwww' })).then(function (s2) {
        return c.db.run('UPDATE senders SET password_enc = (SELECT password_enc FROM senders WHERE id = ?) WHERE id = ?', [s1.id, s2.id])
          .then(function () { return c.svc.getCredentials(c.a, s2.id).then(function () { throw new Error('should fail'); }, function () {}); });
      });
    });
  });
});
test('daily limit hard cap 400 (validation), invalid values rejected', function () {
  return sendersSetup().then(function (c) {
    return expectReject(c.svc.create(c.a, Object.assign({}, GOOD, { daily_limit: 401 })), 'validation').then(function (e) {
      assert.ok(e.details.daily_limit);
      return expectReject(c.svc.create(c.a, Object.assign({}, GOOD, { daily_limit: -1 })), 'validation');
    }).then(function () { return expectReject(c.svc.create(c.a, Object.assign({}, GOOD, { daily_limit: '1e3' })), 'validation'); })
      .then(function () { return c.svc.create(c.a, Object.assign({}, GOOD, { daily_limit: 400 })); })
      .then(function (s) { assert.strictEqual(s.daily_limit, 400); return expectReject(c.svc.update(c.a, s.id, { daily_limit: 9999 }), 'validation'); })
      .then(function () { return c.svc.list(c.a); }).then(function (l) { assert.strictEqual(l[0].daily_limit, 400); });
  });
});
test('input validation: gmail password, hosts (SSRF), ports, delays, header injection', function () {
  return sendersSetup().then(function (c) {
    var smtp = { label: 'S', email: 'x@acme.com', provider: 'smtp', password: 'pw', smtp_host: 'mail.acme.com', smtp_port: 587 };
    function bad(patch, field) { return expectReject(c.svc.create(c.a, Object.assign({}, smtp, patch)), 'validation').then(function (e) { assert.ok(e.details[field], field + ' expected, got ' + JSON.stringify(e.details)); }); }
    return expectReject(c.svc.create(c.a, Object.assign({}, GOOD, { password: 'short' })), 'validation')
      .then(function () { return bad({ smtp_host: 'localhost' }, 'smtp_host'); })
      .then(function () { return bad({ smtp_host: '192.168.1.5' }, 'smtp_host'); })
      .then(function () { return bad({ smtp_host: '127.0.0.1' }, 'smtp_host'); })
      .then(function () { return bad({ smtp_host: 'db.internal' }, 'smtp_host'); })
      .then(function () { return bad({ smtp_host: 'mail.acme.com/../x' }, 'smtp_host'); })
      .then(function () { return bad({ smtp_port: 22 }, 'smtp_port'); })
      .then(function () { return bad({ delay_min_sec: 90, delay_max_sec: 30 }, 'delay_min_sec'); })
      .then(function () { return bad({ from_name: 'Bob\r\nBcc: evil@x.com' }, 'from_name'); })
      .then(function () { return bad({ email: 'x@acme.com\r\nBcc: y@z.com' }, 'email'); })
      .then(function () { return bad({ tracking_domain: 'http://evil.com' }, 'tracking_domain'); })
      .then(function () { return c.svc.create(c.a, smtp); })
      .then(function (s) { assert.strictEqual(s.smtp_port, 587); assert.strictEqual(s.smtp_secure, 0); });
  });
});
test('cross-user access is impossible (IDOR)', function () {
  return sendersSetup().then(function (c) {
    return c.svc.create(c.a, GOOD).then(function (s) {
      return expectReject(c.svc.get(c.b, s.id), 'not_found')
        .then(function () { return expectReject(c.svc.update(c.b, s.id, { label: 'hacked' }), 'not_found'); })
        .then(function () { return expectReject(c.svc.setStatus(c.b, s.id, 'paused'), 'not_found'); })
        .then(function () { return expectReject(c.svc.remove(c.b, s.id), 'not_found'); })
        .then(function () { return expectReject(c.svc.getCredentials(c.b, s.id), 'not_found'); })
        .then(function () { return c.svc.list(c.b); })
        .then(function (l) { assert.strictEqual(l.length, 0); return c.svc.get(c.a, s.id); })
        .then(function (still) { assert.strictEqual(still.label, 'Main'); });
    });
  });
});
test('SQL injection payloads are stored as plain text, never executed', function () {
  return sendersSetup().then(function (c) {
    var evil = "x'); DROP TABLE senders;--";
    return c.svc.create(c.a, Object.assign({}, GOOD, { label: evil, from_name: "' OR 1=1 --" })).then(function (s) {
      assert.strictEqual(s.label, evil);
      return c.svc.update(c.a, s.id, { label: '1; DELETE FROM users' });
    }).then(function () { return c.db.get('SELECT COUNT(*) AS c FROM users'); })
      .then(function (r) { assert.strictEqual(r.c, 2); return c.svc.list(c.a); })
      .then(function (l) { assert.strictEqual(l.length, 1); });
  });
});
test('update re-encrypts password; duplicates rejected; status; delete guarded by active campaigns', function () {
  return sendersSetup().then(function (c) {
    return c.svc.create(c.a, GOOD).then(function (s) {
      return expectReject(c.svc.create(c.a, GOOD), 'validation')
        .then(function () { return c.svc.update(c.a, s.id, { password: 'qqqqwwwweeeerrrr', daily_limit: 120, delay_mode: 'fixed', delay_fixed_sec: 30 }); })
        .then(function (u) { assert.strictEqual(u.daily_limit, 120); assert.strictEqual(u.delay_mode, 'fixed'); return c.svc.getCredentials(c.a, s.id); })
        .then(function (cred) { assert.strictEqual(cred.pass, 'qqqqwwwweeeerrrr'); return c.svc.setStatus(c.a, s.id, 'paused'); })
        .then(function (p) { assert.strictEqual(p.status, 'paused'); return expectReject(c.svc.setStatus(c.a, s.id, 'hax'), 'validation'); })
        .then(function () {
          return c.db.run("INSERT INTO campaigns (user_id,name,status,created_at,updated_at) VALUES (?,?,?,1,1)", [c.a, 'C', 'active']);
        }).then(function (camp) { return c.db.run('INSERT INTO campaign_senders (campaign_id,sender_id) VALUES (?,?)', [camp.lastID, s.id]).then(function () { return camp.lastID; }); })
        .then(function (campId) {
          return expectReject(c.svc.remove(c.a, s.id), 'conflict').then(function () { return c.db.run("UPDATE campaigns SET status='completed' WHERE id=?", [campId]); });
        }).then(function () { return c.svc.remove(c.a, s.id); })
        .then(function () { return c.svc.list(c.a); }).then(function (l) { assert.strictEqual(l.length, 0); });
    });
  });
});
test('audit log never contains secrets', function () {
  return sendersSetup().then(function (c) {
    return c.svc.create(c.a, GOOD).then(function (s) { return c.svc.update(c.a, s.id, { password: 'qqqqwwwweeeerrrr' }); })
      .then(function () { return c.db.all('SELECT action, meta FROM audit_log'); })
      .then(function (rows) {
        assert.ok(rows.length >= 2);
        var all = JSON.stringify(rows);
        assert.ok(all.indexOf('abcdefghijklmnop') === -1 && all.indexOf('qqqqwwwweeeerrrr') === -1);
      });
  });
});
test('capacityToday: limits, warm-up, health and status', function () {
  var day = 86400000, now = 10 * day;
  var base = { status: 'active', health_score: 100, daily_limit: 100, warmup_enabled: 0, warmup_started_at: now, sent_today: 30, sent_today_date: '2026-11-08' };
  var cap = sendersMod.capacityToday;
  assert.strictEqual(cap(base, '2026-11-08', now), 70);
  assert.strictEqual(cap(base, '2026-11-09', now), 100);                                         // new day resets
  assert.strictEqual(cap(Object.assign({}, base, { sent_today: 500 }), '2026-11-08', now), 0);
  assert.strictEqual(cap(Object.assign({}, base, { status: 'paused' }), '2026-11-08', now), 0);
  assert.strictEqual(cap(Object.assign({}, base, { health_score: 49 }), '2026-11-08', now), 0);
  assert.strictEqual(cap(Object.assign({}, base, { warmup_enabled: 1, sent_today: 0 }), '2026-11-08', now), 5);   // day 0 of warm-up
  assert.ok(cap(Object.assign({}, base, { warmup_enabled: 1, sent_today: 0, warmup_started_at: now - 30 * day }), '2026-11-08', now) === 100);
});
test('health score', function () {
  assert.strictEqual(health.computeHealth({ sent: 10, hardBounces: 5 }), 100);                 // too little data
  assert.strictEqual(health.computeHealth({ sent: 100, hardBounces: 2 }), 88);
  assert.strictEqual(health.computeHealth({ sent: 100, hardBounces: 10 }), 40);
  assert.strictEqual(health.computeHealth({ sent: 100, complaints: 1 }), 50);
  assert.strictEqual(health.computeHealth({ sent: 100, hardBounces: 50 }), 0);
});

(function run() {
  var chain = Promise.resolve();
  tests.forEach(function (t) {
    chain = chain.then(function () {
      if (t.group) { console.log(t.group); return; }
      return Promise.resolve().then(t.fn).then(function () { passed++; console.log('  ok   ' + t.name); },
        function (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); });
    });
  });
  chain.then(function () { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); });
})();
