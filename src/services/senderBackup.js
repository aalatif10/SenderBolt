'use strict';
// Sending-accounts backup and restore (src/services/senderBackup.js).
//
// Backup: every sending account of the user with its full CONFIGURATION (address, SMTP/IMAP settings, limits, delays, warm-up,
// protection level, signature, tracking domain, status) AND its app password, in one file the user downloads. Because the file
// holds secrets it is never written in plain text: it is sealed with AES-256-GCM using a key derived (scrypt) from a backup
// passphrase the user chooses, and creating it needs the account login password again. Runtime state (today's counter, health
// history, connection errors, IMAP position) is deliberately not part of it: it is rebuilt by the system.
//
// Restore (smart merge): the file is opened with the passphrase, each account is matched to the existing ones by e-mail address
// (case-insensitive), and only the missing ones are created. Existing accounts are never touched or overwritten and never raise
// an error: they are reported as "already exists". The user can pick which new accounts to restore; one failing account never
// stops the others.
var crypto = require('crypto');
var AppError = require('../lib/errors').AppError;
var vault = require('../lib/vault');
var password = require('../lib/password');
var audit = require('./audit');

var FORMAT = 'senderbolt-sender-backup', VERSION = 1;
var AAD = Buffer.from(FORMAT + ':' + VERSION, 'utf8');
var KDF = { N: 16384, r: 8, p: 1 };
var MAX_ACCOUNTS = 500;
// Configuration fields saved per account. Hosts and ports are saved for every account; Gmail ignores them on restore.
var FIELDS = ['label', 'provider', 'username', 'smtp_host', 'smtp_port', 'smtp_secure', 'imap_host', 'imap_port', 'from_name', 'daily_limit',
  'delay_mode', 'delay_fixed_sec', 'delay_min_sec', 'delay_max_sec', 'warmup_enabled', 'warmup_pace', 'signature_html', 'tracking_domain',
  'reply_detection', 'protection_level'];

function SenderBackup(db, deps) { this.db = db; this.senders = deps.senders; this.key = deps.key; this.now = deps.now || Date.now; }
var B = SenderBackup.prototype;

function bad(msg, fields) { return new AppError('validation', msg, 400, fields); }

function checkPassphrase(p) {
  if (typeof p !== 'string' || p.length < 10 || p.length > 200) throw bad('The backup password must be 10 to 200 characters', { passphrase: 'Use at least 10 characters' });
  return p;
}

function deriveKey(passphrase, salt, params) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, function (e, key) { if (e) reject(e); else resolve(key); });
  });
}

function seal(obj, passphrase) {
  var salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  return deriveKey(passphrase, salt, KDF).then(function (key) {
    var c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD);
    var ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return { format: FORMAT, version: VERSION, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') };
  });
}

// Opens a file produced by seal(). Wrong password and damaged files give the same plain message.
function open(file, passphrase) {
  var fail = new AppError('validation', 'This backup could not be opened. Check the backup password and that the file is a SenderBolt backup.', 400, { file: 'Cannot open this file' });
  if (typeof file === 'string') { try { file = JSON.parse(file); } catch (e) { return Promise.reject(fail); } }
  if (!file || typeof file !== 'object' || file.format !== FORMAT || file.version !== VERSION || file.kdf !== 'scrypt') return Promise.reject(fail);
  var params = { N: file.N, r: file.r, p: file.p };
  // Cost parameters come from the (untrusted) file: only the exact values we write are accepted, so a crafted file cannot burn CPU or memory.
  if (params.N !== KDF.N || params.r !== KDF.r || params.p !== KDF.p) return Promise.reject(fail);
  try {
    var salt = Buffer.from(String(file.salt), 'base64'), iv = Buffer.from(String(file.iv), 'base64'), tag = Buffer.from(String(file.tag), 'base64'), data = Buffer.from(String(file.data), 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !data.length) return Promise.reject(fail);
    return deriveKey(String(passphrase || ''), salt, params).then(function (key) {
      var d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(AAD); d.setAuthTag(tag);
      var obj = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
      if (!obj || !Array.isArray(obj.accounts) || obj.accounts.length > MAX_ACCOUNTS) throw new Error('shape');
      return obj;
    }).catch(function () { throw fail; });
  } catch (e) { return Promise.reject(fail); }
}

function emailKey(a) { return String(a || '').trim().toLowerCase(); }

// Creates the backup file content. loginPassword = the user's current sign-in password (re-checked here).
B.export = function (userId, loginPassword, passphrase, ip) {
  var self = this;
  return Promise.resolve().then(function () {
    checkPassphrase(passphrase);
    return self.db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  }).then(function (u) {
    if (!u) throw new AppError('invalid_credentials', 'Current password is incorrect', 401);
    return password.verifyAsync(String(loginPassword || ''), u.password_hash);
  }).then(function (ok) {
    if (!ok) throw new AppError('invalid_credentials', 'Current password is incorrect', 401);
    return self.db.all('SELECT * FROM senders WHERE user_id = ? ORDER BY id', [userId]);
  }).then(function (rows) {
    if (!rows.length) throw new AppError('conflict', 'There are no sending accounts to back up yet.', 409);
    var accounts = rows.map(function (r) {
      var a = { email: r.email, status: r.status, password: vault.decrypt(r.password_enc, self.key, 'sender:' + r.id) };
      FIELDS.forEach(function (f) { a[f] = r[f]; });
      return a;
    });
    return seal({ app: 'SenderBolt', created_at: self.now(), accounts: accounts }, passphrase).then(function (file) {
      return audit.log(self.db, { userId: userId, action: 'sender.backup', ip: ip, meta: { accounts: accounts.length } }, self.now).then(function () { return { file: file, count: accounts.length }; });
    });
  });
};

// Lists what the backup holds and which accounts already exist. Secrets are never returned.
B.preview = function (userId, file, passphrase) {
  var self = this;
  return open(file, passphrase).then(function (obj) {
    return self.db.all('SELECT email FROM senders WHERE user_id = ?', [userId]).then(function (rows) {
      var have = {}; rows.forEach(function (r) { have[emailKey(r.email)] = true; });
      var seen = {}, accounts = [];
      obj.accounts.forEach(function (a) {
        var k = emailKey(a && a.email);
        if (!k || seen[k]) return;           // duplicates inside the file count once
        seen[k] = true;
        accounts.push({ email: String(a.email), label: String(a.label || a.email), provider: a.provider === 'gmail' ? 'gmail' : 'smtp', daily_limit: Number(a.daily_limit) || null, status: a.status, exists: !!have[k] });
      });
      var existing = accounts.filter(function (a) { return a.exists; }).length;
      return { accounts: accounts, existing: existing, new: accounts.length - existing, created_at: obj.created_at || null };
    });
  });
};

// Restores the selected accounts (emails = list of addresses; omitted = every new one). Existing accounts are skipped, never errors.
B.restore = function (userId, file, passphrase, emails, ip) {
  var self = this, out = { added: [], skipped_existing: [], failed: [], not_in_backup: [] };
  return open(file, passphrase).then(function (obj) {
    var pick = null;
    if (emails !== undefined && emails !== null) {
      if (!Array.isArray(emails) || emails.length > MAX_ACCOUNTS) throw bad('Invalid selection', { emails: 'Invalid selection' });
      pick = {}; emails.forEach(function (e) { pick[emailKey(e)] = true; });
    }
    var byKey = {}, order = [];
    obj.accounts.forEach(function (a) { var k = emailKey(a && a.email); if (k && !byKey[k]) { byKey[k] = a; order.push(k); } });
    if (pick) Object.keys(pick).forEach(function (k) { if (!byKey[k]) out.not_in_backup.push(k); });
    var todo = order.filter(function (k) { return !pick || pick[k]; });
    return todo.reduce(function (p, k) {
      return p.then(function () {
        var a = byKey[k];
        return self.db.get('SELECT id FROM senders WHERE user_id = ? AND email = ?', [userId, a.email]).then(function (ex) {
          if (ex) { out.skipped_existing.push(a.email); return null; }
          var input = { email: a.email, password: a.password };
          FIELDS.forEach(function (f) { if (a[f] !== undefined && a[f] !== null) input[f] = a[f]; });
          if (input.provider === 'gmail') { ['smtp_host', 'smtp_port', 'smtp_secure', 'imap_host', 'imap_port'].forEach(function (f) { delete input[f]; }); }
          return self.senders.create(userId, input, ip).then(function (row) {
            out.added.push(a.email);
            return a.status === 'paused' || a.status === 'disabled' ? self.senders.setStatus(userId, row.id, a.status, ip) : null;
          });
        }).catch(function (e) {
          // A duplicate that appeared meanwhile is "already exists", anything else is reported for that account only.
          if (e && e.status === 409) out.skipped_existing.push(a.email);
          else out.failed.push({ email: a.email, message: (e && e.details && Object.keys(e.details).map(function (f) { return e.details[f]; }).join('; ')) || (e && e.message) || 'Could not restore this account' });
        });
      });
    }, Promise.resolve());
  }).then(function () {
    return audit.log(self.db, { userId: userId, action: 'sender.restore', ip: ip, meta: { added: out.added.length, existing: out.skipped_existing.length, failed: out.failed.length } }, self.now);
  }).then(function () { return out; });
};

module.exports = { SenderBackup: SenderBackup, FORMAT: FORMAT };
