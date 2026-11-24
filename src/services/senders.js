'use strict';
// Senders module. Security properties:
//  - passwords encrypted with AES-256-GCM, bound to the sender row (AAD) and never returned by the API
//  - every query is scoped by user_id (no IDOR); foreign ids look identical to missing ids
//  - column names in UPDATE come from a fixed whitelist, never from user input
//  - hosts must be public hostnames (SSRF guard), ports restricted to mail ports
//  - daily limit hard-capped at 400 in validation AND by database triggers (migration 004)
//  - warm-up is optional per sender; the ramp rules live in lib/throttle.js (pure, unit-tested)
var email = require('../lib/email');
var vault = require('../lib/vault');
var throttle = require('../lib/throttle');
var net = require('../lib/net');
var AppError = require('../lib/errors').AppError;
var audit = require('./audit');
var health = require('../lib/health');
var nextSend = require('../lib/nextSend');
var settingsLib = require('./settings');

var SMTP_PORTS = [25, 465, 587, 2525];
var IMAP_PORTS = [143, 993];
var GMAIL = { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993 };

var COLUMNS = ['label', 'email', 'provider', 'username', 'smtp_host', 'smtp_port', 'smtp_secure', 'imap_host', 'imap_port',
  'from_name', 'daily_limit', 'delay_mode', 'delay_fixed_sec', 'delay_min_sec', 'delay_max_sec', 'warmup_enabled', 'warmup_pace',
  'signature_html', 'tracking_domain', 'reply_detection', 'protection_level', 'force_until'];

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
  if (has('warmup_pace')) {
    if (throttle.PACE_NAMES.indexOf(input.warmup_pace) === -1) errors.warmup_pace = 'Warm-up pace must be ' + throttle.PACE_NAMES.join(' or '); else v.warmup_pace = input.warmup_pace;
  }
  if (has('reply_detection')) v.reply_detection = input.reply_detection ? 1 : 0;
  if (has('protection_level')) {
    if (health.LEVEL_NAMES.indexOf(input.protection_level) === -1) errors.protection_level = 'Protection level must be ' + health.LEVEL_NAMES.join(', ');
    else v.protection_level = input.protection_level;
  }
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

// Adds read-only "today" figures so the UI never has to re-implement warm-up / cap rules.
// warmup_day / warmup_reaches_day are null when warm-up is switched off (the sender uses its full limit).
function withToday(row, nowMs) {
  var out = publicView(row);
  var dateStr = new Date(nowMs).toISOString().slice(0, 10);
  out.sent_today = row.sent_today_date === dateStr ? row.sent_today : 0;
  out.limit_today = throttle.limitToday(row, dateStr);
  out.remaining_today = capacityToday(row, dateStr, nowMs);
  out.warmup_day = row.warmup_enabled ? throttle.rampIndex(row, dateStr) + 1 : null;
  out.warmup_reaches_day = row.warmup_enabled ? throttle.warmupDaysToLimit(row.daily_limit, row.warmup_pace) : null;
  out.warmup_slowed = !!(row.warmup_enabled && row.warmup_penalty > 0);
  out.hard_cap = throttle.HARD_DAILY_CAP;
  out.health_floor = health.floorFor(row);                       // the score below which this sender is paused automatically
  out.force_active = health.isForced(row, nowMs);                // "Force continue" override currently on
  out.force_until = out.force_active ? row.force_until : null;
  // Health healing: the score is the 30-day result (base) plus earned points; both are shown so the owner can see why it moves.
  out.health_base = row.health_base === null || row.health_base === undefined ? row.health_score : row.health_base;
  out.health_heal = health.clampHeal(row.health_heal, out.health_base);
  out.heal_rules = { calm: health.HEAL.calm, clean_per: health.HEAL.cleanPer, clean_max: health.HEAL.cleanMax, reply: health.HEAL.reply, day_max: health.HEAL.dayMax };
  out.connection_error = row.connection_error || null;
  out.next_email_at = null;
  // Healing outlook: the soonest day the score can be full again if every day stays clean (best case, 4 points a day), and when the next day is credited.
  out.heal_next_at = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1);
  out.heal_full_in_days = row.health_score >= 100 ? 0 : Math.ceil((100 - row.health_score) / health.HEAL.dayMax);
  out.risk = riskOf(row, out, nowMs);
  return out;
}

// One plain verdict + the reasons behind it, so the owner never has to decode numbers. level: low | moderate | high | critical.
function riskOf(row, v, nowMs) {
  var floor = health.floorFor(row), forced = health.isForced(row, nowMs), factors = [], level = 0;
  function add(lvl, text) { factors.push(text); if (lvl > level) level = lvl; }
  if (row.health_score < floor && !forced) add(3, 'Health ' + row.health_score + ' is below this account\u2019s protection threshold (' + floor + ').');
  else if (row.health_score < 70) add(2, 'Health is ' + row.health_score + ': recent bounces are hurting this account.');
  else if (row.health_score < 90) add(1, 'Health is ' + row.health_score + ': a few recent bounces.');
  if (v.warmup_slowed) add(1, 'Warm-up growth is slowed because of recent bounces.');
  if (forced) add(2, 'Force continue is on: automatic health pauses are skipped until it expires.');
  if (row.connection_error) add(1, 'Connection problem: ' + row.connection_error);
  if (!row.warmup_enabled && row.daily_limit > 300) add(1, 'High daily limit (' + row.daily_limit + ') without warm-up.');
  if (row.status === 'paused') add(1, 'Paused: nothing is being sent.');
  return { level: ['low', 'moderate', 'high', 'critical'][level], factors: factors };
}

// When will each sender's next email REALLY go out? Computed by services/nextEmail.js, the same source the campaigns use.
// null = nothing waiting, or the sender cannot send right now (then next_email_block says why: paused | health | tracking).
function addNextEmail(db, userId, rows, nowMs) {
  var nextEmail = require('./nextEmail');       // loaded here: nextEmail itself needs capacityToday from this file
  rows.forEach(function (r) { r.next_email_at = null; r.next_email_block = null; });
  if (!rows.some(function (r) { return r.status === 'active'; })) return Promise.resolve(rows);
  return settingsLib.loadGuard(db, userId).then(function (guard) { return nextEmail.compute(db, userId, nowMs, { guard: guard }); }).then(function (res) {
    rows.forEach(function (r) {
      if (res.bySender[r.id] !== undefined) r.next_email_at = res.bySender[r.id];
      else if (res.senderBlock[r.id]) r.next_email_block = res.senderBlock[r.id];
    });
    return rows;
  });
}

Senders.prototype.list = function (userId) {
  var self = this;
  return this.db.all('SELECT * FROM senders WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId]).then(function (rows) {
    var t = self.now(); return addNextEmail(self.db, userId, rows.map(function (r) { return withToday(r, t); }), t);
  });
};

Senders.prototype.get = function (userId, id) {
  var self = this;
  return this._find(userId, id).then(function (r) { var t = self.now(); return addNextEmail(self.db, userId, [withToday(r, t)], t).then(function (a) { return a[0]; }); });
};

Senders.prototype.update = function (userId, id, input, ip) {
  var self = this, parsed;
  return this._find(userId, id).then(function (existing) {
    var merged = Object.assign({}, input);
    if (!merged.provider) merged.provider = existing.provider;
    parsed = validate(merged, false);
    var v = parsed.values, tnow = self.now();
    // "Force continue" is a switch in the API; stored as an expiry time so it can never stay on forever.
    if (Object.prototype.hasOwnProperty.call(input, 'force_continue')) v.force_until = input.force_continue ? tnow + health.FORCE_MS : null;
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
    // Forcing a sender that was paused (for example automatically because of its health) also resumes it.
    if (v.force_until && existing.status === 'paused') { sets.push("status = 'active'"); sets.push('last_error = NULL'); sets.push('next_send_at = NULL'); }
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
// dateStr is the UTC day (YYYY-MM-DD) as decided by the caller. nowMs is kept for callers' convenience.
function capacityToday(sender, dateStr, nowMs) {
  if (sender.status !== 'active' || health.isBelowFloor(sender, nowMs === undefined ? Date.now() : nowMs)) return 0;
  var sent = sender.sent_today_date === dateStr ? sender.sent_today : 0;
  return Math.max(0, throttle.limitToday(sender, dateStr) - sent);
}

module.exports = { Senders: Senders, capacityToday: capacityToday, validate: validate };
