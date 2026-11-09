'use strict';
// Senders module. Security properties:
//  - passwords encrypted with AES-256-GCM, bound to the sender row (AAD) and never returned by the API
//  - every query is scoped by user_id (no IDOR); foreign ids look identical to missing ids
//  - column names in UPDATE come from a fixed whitelist, never from user input
//  - hosts must be public hostnames (SSRF guard), ports restricted to mail ports
//  - daily limit hard-capped at 400 in validation AND by database triggers (migration 004)
var email = require('../lib/email');
var vault = require('../lib/vault');
var throttle = require('../lib/throttle');
var net = require('../lib/net');
var AppError = require('../lib/errors').AppError;
var audit = require('./audit');
var health = require('../lib/health');

var SMTP_PORTS = [25, 465, 587, 2525];
var IMAP_PORTS = [143, 993];
var GMAIL = { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993 };

var COLUMNS = ['label', 'email', 'provider', 'username', 'smtp_host', 'smtp_port', 'smtp_secure', 'imap_host', 'imap_port',
  'from_name', 'daily_limit', 'delay_mode', 'delay_fixed_sec', 'delay_min_sec', 'delay_max_sec', 'warmup_enabled',
  'signature_html', 'tracking_domain'];

function hasControl(s) {
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 32 || c === 127 || c === 0x2028 || c === 0x2029) return true; }
  return false;
}

function intIn(v, lo, hi) {
  var n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : v;
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi ? n : null;
}

// Returns { values, password } or throws AppError('validation').
function validate(input, isCreate) {
  var errors = {}, v = {}, has = function (k) { return Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined; };
  input = input || {};

  if (isCreate || has('label')) {
    var label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 80 || hasControl(label)) errors.label = 'Label is required (max 80 chars)'; else v.label = label;
  }
  if (isCreate || has('email')) {
    var addr = email.normalize(input.email);
    if (!email.checkSyntax(addr).ok) errors.email = 'Invalid email address'; else v.email = addr;
  }
  var provider = has('provider') ? input.provider : (isCreate ? undefined : null);
  if (isCreate || has('provider')) {
    if (provider !== 'gmail' && provider !== 'smtp') errors.provider = 'Provider must be gmail or smtp'; else v.provider = provider;
  }
  if (has('username')) {
    var un = typeof input.username === 'string' ? input.username.trim() : '';
    if (!un || un.length > 254 || hasControl(un)) errors.username = 'Invalid username'; else v.username = un;
  }

  // Connection settings: Gmail fixes them; custom SMTP must supply them.
  var effProvider = v.provider || input.provider;
  var conn = ['smtp_host', 'smtp_port', 'smtp_secure', 'imap_host', 'imap_port'].some(has);
  if (effProvider === 'gmail') {
    if (isCreate || has('provider')) Object.keys(GMAIL).forEach(function (k) { v[k] = GMAIL[k]; });
  } else if (isCreate || conn) {
    if (!has('smtp_host') && isCreate) errors.smtp_host = 'SMTP host is required';
    if (has('smtp_host')) { var e1 = net.assertPublicHostname(input.smtp_host, 'SMTP host'); if (e1) errors.smtp_host = e1; else v.smtp_host = String(input.smtp_host).trim().toLowerCase(); }
    if (has('smtp_port') || isCreate) { var sp = intIn(input.smtp_port, 1, 65535); if (sp === null || SMTP_PORTS.indexOf(sp) === -1) errors.smtp_port = 'SMTP port must be one of ' + SMTP_PORTS.join(', '); else v.smtp_port = sp; }
    if (has('smtp_secure')) v.smtp_secure = input.smtp_secure ? 1 : 0; else if (isCreate) v.smtp_secure = v.smtp_port === 465 ? 1 : 0;
    if (has('imap_host') && input.imap_host) { var e2 = net.assertPublicHostname(input.imap_host, 'IMAP host'); if (e2) errors.imap_host = e2; else v.imap_host = String(input.imap_host).trim().toLowerCase(); }
    if (has('imap_port') && input.imap_port) { var ip = intIn(input.imap_port, 1, 65535); if (ip === null || IMAP_PORTS.indexOf(ip) === -1) errors.imap_port = 'IMAP port must be one of ' + IMAP_PORTS.join(', '); else v.imap_port = ip; }
  }

  if (has('from_name')) {
    var fn = input.from_name === null ? '' : String(input.from_name).trim();
    if (fn.length > 80 || hasControl(fn)) errors.from_name = 'Invalid from name'; else v.from_name = fn || null;
  }
  if (has('daily_limit')) {
    var dl = intIn(input.daily_limit, 1, throttle.HARD_DAILY_CAP);
    if (dl === null) errors.daily_limit = 'Daily limit must be a whole number from 1 to ' + throttle.HARD_DAILY_CAP; else v.daily_limit = dl;
  }
  if (has('delay_mode')) {
    if (input.delay_mode !== 'fixed' && input.delay_mode !== 'random') errors.delay_mode = 'Delay mode must be fixed or random'; else v.delay_mode = input.delay_mode;
  }
  ['delay_fixed_sec', 'delay_min_sec', 'delay_max_sec'].forEach(function (k) {
    if (has(k)) { var n = intIn(input[k], 1, 3600); if (n === null) errors[k] = 'Must be 1-3600 seconds'; else v[k] = n; }
  });
  if (v.delay_min_sec !== undefined && v.delay_max_sec !== undefined && v.delay_min_sec > v.delay_max_sec) errors.delay_min_sec = 'Min delay cannot exceed max delay';
  if (has('warmup_enabled')) v.warmup_enabled = input.warmup_enabled ? 1 : 0;
  if (has('signature_html')) {
    if (input.signature_html !== null && (typeof input.signature_html !== 'string' || input.signature_html.length > 10000)) errors.signature_html = 'Signature too long (max 10000 chars)';
    else v.signature_html = input.signature_html || null;   // sanitized again at send time
  }
  if (has('tracking_domain')) {
    if (input.tracking_domain) { var e3 = net.assertPublicHostname(input.tracking_domain, 'Tracking domain'); if (e3) errors.tracking_domain = e3; else v.tracking_domain = String(input.tracking_domain).trim().toLowerCase(); }
    else v.tracking_domain = null;
  }

  var pw;
  if (isCreate || has('password')) {
    pw = typeof input.password === 'string' ? input.password.replace(/\s+/g, '') : '';
    if (effProvider === 'gmail') {
      if (!/^[a-zA-Z0-9]{16}$/.test(pw)) errors.password = 'Gmail App Password must be 16 letters/digits (spaces are ignored)';
    } else if (!pw || pw.length > 256 || hasControl(pw)) errors.password = 'Password is required';
  }
  if (Object.keys(errors).length) throw new AppError('validation', 'Invalid sender settings', 400, errors);
  return { values: v, password: pw };
}

function publicView(r) {
  if (!r) return r;
  var out = {};
  Object.keys(r).forEach(function (k) { if (k !== 'password_enc') out[k] = r[k]; });
  out.has_password = true;
  return out;
}

function Senders(db, key, opts) {
  this.db = db;
  this.key = key;
  this.now = (opts && opts.now) || Date.now;
}

Senders.prototype._find = function (userId, id) {
  return this.db.get('SELECT * FROM senders WHERE id = ? AND user_id = ?', [id, userId]).then(function (row) {
    if (!row) throw new AppError('not_found', 'Sender not found', 404);
    return row;
  });
};

// Public methods always return promises (validation errors become rejections).
Senders.prototype.create = function (userId, input, ip) {
  var self = this;
  return Promise.resolve().then(function () { return self._create(userId, input, ip); });
};

Senders.prototype._create = function (userId, input, ip) {
  var self = this, parsed = validate(input, true), v = parsed.values, t = this.now();
  if (!v.username) v.username = v.email;
  v.delay_fixed_sec = v.delay_fixed_sec || 60; v.delay_min_sec = v.delay_min_sec || 45; v.delay_max_sec = v.delay_max_sec || 120;
  if (v.delay_min_sec > v.delay_max_sec) throw new AppError('validation', 'Invalid sender settings', 400, { delay_min_sec: 'Min delay cannot exceed max delay' });
  var cols = COLUMNS.filter(function (c) { return v[c] !== undefined; });
  return this.db.transaction(function (tx) {
    return tx.get('SELECT id FROM senders WHERE user_id = ? AND email = ?', [userId, v.email]).then(function (dup) {
      if (dup) throw new AppError('validation', 'Sender already exists', 409, { email: 'This sender email is already added' });
      // warmup_started_at stays NULL until the first email is really sent (the engine sets it).
      var sql = 'INSERT INTO senders (user_id, password_enc, created_at, updated_at, ' + cols.join(', ') + ') VALUES (?,?,?,?,' + cols.map(function () { return '?'; }).join(',') + ')';
      var params = [userId, 'pending', t, t].concat(cols.map(function (c) { return v[c]; }));
      return tx.run(sql, params);
    }).then(function (ins) {
      var enc = vault.encrypt(parsed.password, self.key, 'sender:' + ins.lastID);
      return tx.run('UPDATE senders SET password_enc = ? WHERE id = ?', [enc, ins.lastID]).then(function () {
        return audit.log(tx, { userId: userId, action: 'sender.create', entity: 'sender', entityId: ins.lastID, ip: ip, meta: { email: v.email, provider: v.provider } }, self.now)
          .then(function () { return ins.lastID; });
      });
    });
  }).then(function (id) { return self.get(userId, id); });
};

Senders.prototype.list = function (userId) {
  return this.db.all('SELECT * FROM senders WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId]).then(function (rows) { return rows.map(publicView); });
};

Senders.prototype.get = function (userId, id) {
  return this._find(userId, id).then(publicView);
};

Senders.prototype.update = function (userId, id, input, ip) {
  var self = this, parsed;
  return this._find(userId, id).then(function (existing) {
    var merged = Object.assign({}, input);
    if (!merged.provider) merged.provider = existing.provider;
    parsed = validate(merged, false);
    var v = parsed.values;
    if (!input.provider) { delete v.provider; }
    var cols = COLUMNS.filter(function (c) { return v[c] !== undefined; });
    var minD = v.delay_min_sec !== undefined ? v.delay_min_sec : existing.delay_min_sec;
    var maxD = v.delay_max_sec !== undefined ? v.delay_max_sec : existing.delay_max_sec;
    if (minD > maxD) throw new AppError('validation', 'Invalid sender settings', 400, { delay_min_sec: 'Min delay cannot exceed max delay' });
    var sets = cols.map(function (c) { return c + ' = ?'; });
    var params = cols.map(function (c) { return v[c]; });
    if (parsed.password) { sets.push('password_enc = ?'); params.push(vault.encrypt(parsed.password, self.key, 'sender:' + id)); }
    if (!sets.length) return null;
    sets.push('updated_at = ?'); params.push(self.now());
    params.push(id, userId);
    return self.db.run('UPDATE senders SET ' + sets.join(', ') + ' WHERE id = ? AND user_id = ?', params).then(function () {
      var meta = Object.assign({}, v); if (parsed.password) meta.password = true;
      return audit.log(self.db, { userId: userId, action: 'sender.update', entity: 'sender', entityId: id, ip: ip, meta: meta }, self.now);
    });
  }).then(function () { return self.get(userId, id); });
};

Senders.prototype.setStatus = function (userId, id, status, ip) {
  var self = this;
  if (['active', 'paused', 'disabled'].indexOf(status) === -1) return Promise.reject(new AppError('validation', 'Invalid status', 400, { status: 'Invalid status' }));
  return this._find(userId, id).then(function () {
    return self.db.run('UPDATE senders SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?', [status, self.now(), id, userId]);
  }).then(function () { return audit.log(self.db, { userId: userId, action: 'sender.status', entity: 'sender', entityId: id, ip: ip, meta: { status: status } }, self.now); })
    .then(function () { return self.get(userId, id); });
};

Senders.prototype.remove = function (userId, id, ip) {
  var self = this;
  return this._find(userId, id).then(function () {
    // Paused / error campaigns still have unsent leads tied to this sender: deleting it would strand them.
    return self.db.get("SELECT COUNT(*) AS c FROM campaign_senders cs JOIN campaigns c ON c.id = cs.campaign_id WHERE cs.sender_id = ? AND c.status IN ('active','paused','preparing','error')", [id]);
  }).then(function (r) {
    if (r.c > 0) throw new AppError('conflict', 'This sender is used by a running or paused campaign. Finish or delete that campaign first.', 409);
    return self.db.run('DELETE FROM campaign_senders WHERE sender_id = ?', [id]);
  }).then(function () {
    return self.db.run('DELETE FROM senders WHERE id = ? AND user_id = ?', [id, userId]);
  }).then(function () { return audit.log(self.db, { userId: userId, action: 'sender.delete', entity: 'sender', entityId: id, ip: ip }, self.now); });
};

// Internal only (the sending engine). Never expose this over HTTP.
Senders.prototype.getCredentials = function (userId, id) {
  var key = this.key;
  return this._find(userId, id).then(function (r) {
    return { host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure, user: r.username, pass: vault.decrypt(r.password_enc, key, 'sender:' + r.id) };
  });
};

// Pure: how many more emails this sender may send today.
// dateStr is the sender's local day (YYYY-MM-DD) as decided by the caller.
function capacityToday(sender, dateStr, nowMs) {
  if (sender.status !== 'active' || sender.health_score < health.AUTO_PAUSE_BELOW) return 0;
  var sent = sender.sent_today_date === dateStr ? sender.sent_today : 0;
  var limit = sender.daily_limit;
  if (sender.warmup_enabled) {
    var started = sender.warmup_started_at === null || sender.warmup_started_at === undefined ? nowMs : sender.warmup_started_at;
    var days = Math.max(0, Math.floor((nowMs - started) / 86400000));
    limit = throttle.warmupLimit(days, sender.daily_limit);
  }
  return Math.max(0, limit - sent);
}

module.exports = { Senders: Senders, capacityToday: capacityToday, validate: validate };
