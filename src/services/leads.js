'use strict';
// Leads & Lists module: folders, import (CSV / paste), listing, stats, export,
// suppression list, and the ON-DEMAND verifier (syntax + DNS MX; no background jobs).
//
// Honest limits of verification: "valid" means the domain can receive mail. A mailbox
// check needs SMTP probing, which is deliberately not done (blocked ports, IP reputation).
// Everything is scoped by user_id; SQL is parameterized (placeholder lists are built
// from counts only, and sort columns come from a fixed whitelist).
var dns = require('dns');
var csv = require('../lib/csv');
var xlsx = require('../lib/xlsx');
var email = require('../lib/email');
var text = require('../lib/text');
var AppError = require('../lib/errors').AppError;
var audit = require('./audit');

var MAX_IMPORT_ROWS = 50000;
var MAX_IMPORT_CHARS = 12000000;
var MAX_VERIFY_BATCH = 500;
var MAX_DELETE_BATCH = 1000;
var MAX_EXPORT_ROWS = 100000;
var DNS_TIMEOUT_MS = 5000;
var STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'risky'];
var SORTS = { created_at: 'l.created_at', email: 'l.email', company: 'l.company', verify_status: 'l.verify_status', domain: 'l.domain', name: 'l.first_name', verified_at: 'l.verified_at' };

var DISPOSABLE = {};
['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'maildrop.cc', 'temp-mail.org', 'dispostable.com']
  .forEach(function (d) { DISPOSABLE[d] = true; });

var HEADERS = {
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'mail', 'email id'],
  first_name: ['first name', 'firstname', 'first', 'given name', 'fname'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name', 'lname'],
  company: ['company', 'company name', 'organization', 'organisation', 'business', 'domain name']
};

function normHeader(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/[_\s]+/g, ' '); }
function fieldFor(h) {
  var n = normHeader(h);
  for (var f in HEADERS) { if (HEADERS[f].indexOf(n) !== -1) return f; }
  return null;
}

// Turn CSV or pasted text into [{ email, first_name, last_name, company, custom, row }].
function parseInput(format, data) {
  if (typeof data !== 'string' || !data.trim()) throw new AppError('validation', 'No data provided', 400, { data: 'Paste emails or upload a CSV' });
  if (data.length > MAX_IMPORT_CHARS) throw new AppError('payload_too_large', 'Import is too large', 413);
  var out = [];
  if (format === 'paste') {
    var re = /[^\s,;<>"'()\[\]]+@[^\s,;<>"'()\[\]]+/g, m, n = 0;
    while ((m = re.exec(data)) !== null) { out.push({ email: m[0].replace(/[.:]+$/, ''), row: ++n }); if (out.length > MAX_IMPORT_ROWS) break; }
    return out;
  }
  if (format !== 'csv' && format !== 'xlsx') throw new AppError('validation', 'Format must be csv, xlsx or paste', 400, { format: 'Unsupported format' });
  var rows;
  if (format === 'xlsx') {
    if (!/^[A-Za-z0-9+\/=\r\n]+$/.test(data)) throw new AppError('validation', 'The Excel file was not uploaded correctly', 400, { data: 'Invalid upload' });
    try { rows = xlsx.readRows(Buffer.from(data, 'base64')); } catch (e) {
      if (e.code === 'xlsx') throw new AppError('validation', e.message, 400, { data: e.message });
      throw new AppError('validation', 'Could not read this Excel file. Save it as CSV and try again.', 400, { data: 'Unreadable file' });
    }
  } else {
    try { rows = csv.parse(data); } catch (e) { throw new AppError('validation', 'Could not read the CSV: ' + e.message, 400, { data: e.message }); }
  }
  if (!rows.length) throw new AppError('validation', 'The CSV is empty', 400, { data: 'Empty file' });
  var map = {}, hasHeader = false, first = rows[0];
  first.forEach(function (cell, i) {
    var f = fieldFor(cell);
    if (f && map[f] === undefined) { map[f] = i; hasHeader = true; }
  });
  var startRow = 1, customCols = [];
  if (hasHeader && map.email !== undefined) {
    first.forEach(function (cell, i) {
      if (fieldFor(cell)) return;
      var key = normHeader(cell).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      if (key && customCols.length < 20) customCols.push({ idx: i, key: key });
    });
  } else {
    var idx = -1;
    first.forEach(function (cell, i) { if (idx < 0 && String(cell).indexOf('@') > 0) idx = i; });
    if (idx < 0) throw new AppError('validation', 'No email column found. Add a header named "email".', 400, { data: 'No email column' });
    map = { email: idx }; startRow = 0; customCols = [];
  }
  for (var r = startRow; r < rows.length && out.length <= MAX_IMPORT_ROWS; r++) {
    var row = rows[r], rec = { row: r + 1, email: row[map.email] };
    if (map.first_name !== undefined) rec.first_name = row[map.first_name];
    if (map.last_name !== undefined) rec.last_name = row[map.last_name];
    if (map.company !== undefined) rec.company = row[map.company];
    if (customCols.length) {
      var custom = {}, any = false;
      customCols.forEach(function (c) { var v = text.cleanText(row[c.idx], 500); if (v) { custom[c.key] = v; any = true; } });
      if (any) rec.custom = custom;
    }
    out.push(rec);
  }
  return out;
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { var e = new Error('timeout'); e.code = 'ETIMEOUT'; reject(e); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function defaultResolver() {
  var p = dns.promises;
  return {
    resolveMx: function (d) { return withTimeout(p.resolveMx(d), DNS_TIMEOUT_MS); },
    resolveAddr: function (d) {
      return withTimeout(p.resolve4(d), DNS_TIMEOUT_MS).catch(function (e) {
        if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') return withTimeout(p.resolve6(d), DNS_TIMEOUT_MS);
        throw e;
      });
    }
  };
}

// Returns { status: 'valid'|'invalid'|'risky'|null, reason }. status null = transient DNS failure.
function classifyDomain(domain, resolver) {
  if (DISPOSABLE[domain]) return Promise.resolve({ status: 'risky', reason: 'disposable_domain' });
  return resolver.resolveMx(domain).then(function (recs) {
    if (!recs || !recs.length) return fallbackAddr(domain, resolver);
    if (recs.length === 1 && (recs[0].exchange === '' || recs[0].exchange === '.')) return { status: 'invalid', reason: 'null_mx_domain_accepts_no_mail' };
    return { status: 'valid', reason: 'mx_ok_domain_can_receive_mail' };
  }, function (err) {
    if (err && err.code === 'ENOTFOUND') return { status: 'invalid', reason: 'domain_not_found' };
    if (err && err.code === 'ENODATA') return fallbackAddr(domain, resolver);
    return { status: null, reason: 'dns_error_' + String((err && err.code) || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '') };
  });
}
function fallbackAddr(domain, resolver) {
  return resolver.resolveAddr(domain).then(function (a) {
    return a && a.length ? { status: 'risky', reason: 'no_mx_falls_back_to_a_record' } : { status: 'invalid', reason: 'no_mx_records' };
  }, function (err) {
    if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND')) return { status: 'invalid', reason: 'no_mx_records' };
    return { status: null, reason: 'dns_error_' + String((err && err.code) || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '') };
  });
}

function idList(ids, max) {
  if (!Array.isArray(ids) || !ids.length) throw new AppError('validation', 'No leads selected', 400, { ids: 'Select at least one lead' });
  if (ids.length > max) throw new AppError('validation', 'Too many leads selected (max ' + max + ')', 400, { ids: 'Max ' + max });
  var seen = {}, out = [];
  ids.forEach(function (x) {
    if (typeof x !== 'number' || Math.floor(x) !== x || x < 1 || x > 9007199254740991) throw new AppError('validation', 'Invalid lead id', 400, { ids: 'Invalid id' });
    if (!seen[x]) { seen[x] = true; out.push(x); }
  });
  return out;
}
function placeholders(n) { var a = []; for (var i = 0; i < n; i++) a.push('?'); return a.join(','); }

function Leads(db, opts) {
  this.db = db;
  this.now = (opts && opts.now) || Date.now;
  this.resolver = (opts && opts.resolver) || defaultResolver();
}

// ----- folders -----
Leads.prototype._folder = function (userId, folderId) {
  return this.db.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]).then(function (f) {
    if (!f) throw new AppError('not_found', 'Folder not found', 404);
    return f;
  });
};

function folderName(v) {
  var n = text.cleanText(v, 80);
  if (!n) throw new AppError('validation', 'Folder name is required (max 80 chars)', 400, { name: 'Folder name is required' });
  return n;
}

Leads.prototype.createFolder = function (userId, name) {
  var self = this, n;
  try { n = folderName(name); } catch (e) { return Promise.reject(e); }
  return this.db.get('SELECT id FROM folders WHERE user_id = ? AND name = ? COLLATE NOCASE', [userId, n]).then(function (dup) {
    if (dup) throw new AppError('validation', 'A folder with this name already exists', 409, { name: 'Already exists' });
    return self.db.run('INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)', [userId, n, self.now()]);
  }).then(function (r) { return { id: r.lastID, name: n, lead_count: 0, valid_count: 0 }; });
};

Leads.prototype.listFolders = function (userId) {
  return this.db.all(
    'SELECT f.id, f.name, f.created_at, COUNT(l.id) AS lead_count, ' +
    "COALESCE(SUM(CASE WHEN l.verify_status = 'valid' THEN 1 ELSE 0 END), 0) AS valid_count " +
    'FROM folders f LEFT JOIN leads l ON l.folder_id = f.id WHERE f.user_id = ? GROUP BY f.id ORDER BY f.name COLLATE NOCASE', [userId]);
};

Leads.prototype.renameFolder = function (userId, folderId, name) {
  var self = this, n;
  try { n = folderName(name); } catch (e) { return Promise.reject(e); }
  return this._folder(userId, folderId).then(function () {
    return self.db.get('SELECT id FROM folders WHERE user_id = ? AND name = ? COLLATE NOCASE AND id <> ?', [userId, n, folderId]);
  }).then(function (dup) {
    if (dup) throw new AppError('validation', 'A folder with this name already exists', 409, { name: 'Already exists' });
    return self.db.run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', [n, folderId, userId]);
  }).then(function () { return { id: folderId, name: n }; });
};

// Leads that are still waiting in a running / paused / preparing campaign. Deleting them would
// silently shrink that campaign (campaign_leads rows cascade away), so deletes are refused instead.
var IN_CAMPAIGN_SQL = "SELECT COUNT(DISTINCT cl.lead_id) AS c FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id " +
  "WHERE c.user_id = ? AND c.status IN ('active','paused','preparing') AND cl.status IN ('pending','active','paused') AND ";
function assertNotInCampaign(count) {
  if (count > 0) throw new AppError('conflict', count + (count === 1 ? ' lead is' : ' leads are') + ' still in a running or paused campaign. Finish or delete that campaign first.', 409);
}

Leads.prototype.deleteFolder = function (userId, folderId, ip) {
  var self = this, removed = 0;
  return this._folder(userId, folderId).then(function () {
    return self.db.get(IN_CAMPAIGN_SQL + 'cl.lead_id IN (SELECT id FROM leads WHERE folder_id = ? AND user_id = ?)', [userId, folderId, userId]);
  }).then(function (busy) {
    assertNotInCampaign(busy.c);
    return self.db.get('SELECT COUNT(*) AS c FROM leads WHERE folder_id = ? AND user_id = ?', [folderId, userId]);
  }).then(function (r) {
    removed = r.c;
    return self.db.run('DELETE FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
  }).then(function () {
    return audit.log(self.db, { userId: userId, action: 'folder.delete', entity: 'folder', entityId: folderId, ip: ip, meta: { leads_removed: removed } }, self.now);
  }).then(function () { return { removed_leads: removed }; });
};

// ----- import -----
Leads.prototype.importLeads = function (userId, folderId, format, data, ip) {
  var self = this, records;
  return this._folder(userId, folderId).then(function () {
    records = parseInput(format, data);
    if (records.length > MAX_IMPORT_ROWS) throw new AppError('validation', 'Too many rows (max ' + MAX_IMPORT_ROWS + ' per import)', 400, { data: 'Too many rows' });
    return self.db.all('SELECT email FROM suppression WHERE user_id = ?', [userId]);
  }).then(function (sup) {
    var suppressed = {};
    sup.forEach(function (s) { suppressed[email.normalize(s.email)] = true; });
    var res = { total: records.length, imported: 0, duplicates: 0, invalid: 0, suppressed: 0, errors: [] };
    var seen = {}, t = self.now();
    function note(rec, reason) { if (res.errors.length < 100) res.errors.push({ row: rec.row, email: String(rec.email == null ? '' : rec.email).slice(0, 120), reason: reason }); }
    return self.db.transaction(function (tx) {
      var i = 0;
      function next() {
        if (i >= records.length) return Promise.resolve();
        var rec = records[i++], addr = email.normalize(rec.email), chk = email.checkSyntax(addr);
        if (!chk.ok) { res.invalid++; note(rec, chk.reason); return next(); }
        if (seen[addr]) { res.duplicates++; return next(); }
        seen[addr] = true;
        if (suppressed[addr]) { res.suppressed++; note(rec, 'suppressed'); return next(); }
        var custom = rec.custom ? JSON.stringify(rec.custom) : null;
        return tx.run(
          'INSERT OR IGNORE INTO leads (user_id, folder_id, email, domain, first_name, last_name, company, custom, is_role, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [userId, folderId, addr, email.domainOf(addr), text.cleanText(rec.first_name, 100), text.cleanText(rec.last_name, 100),
            text.cleanText(rec.company, 150), custom, email.isRoleAddress(addr) ? 1 : 0, t]
        ).then(function (r) { if (r.changes) res.imported++; else res.duplicates++; return next(); });
      }
      return next();
    }).then(function () {
      return audit.log(self.db, { userId: userId, action: 'leads.import', entity: 'folder', entityId: folderId, ip: ip,
        meta: { format: format, total: res.total, imported: res.imported, invalid: res.invalid } }, self.now);
    }).then(function () { return res; });
  });
};

// ----- listing / stats / export / delete -----
function leadFilter(userId, folderId, o) {
  var where = ['l.user_id = ?'], params = [userId];
  if (folderId) { where.push('l.folder_id = ?'); params.push(folderId); }
  if (o.status && o.status !== 'all') {
    if (STATUSES.indexOf(o.status) === -1) throw new AppError('validation', 'Invalid status filter', 400, { status: 'Invalid status' });
    where.push('l.verify_status = ?'); params.push(o.status);
  }
  if (o.search) {
    var like = '%' + String(o.search).slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(l.email LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\' OR l.first_name LIKE ? ESCAPE '\\' OR l.last_name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  // Smart filters (all optional, combinable)
  if (o.role === 'only') where.push('l.is_role = 1'); else if (o.role === 'exclude') where.push('l.is_role = 0');
  else if (o.role && o.role !== 'all') throw new AppError('validation', 'Invalid mailbox filter', 400, { role: 'Invalid filter' });
  if (o.missing) {
    var miss = { name: "(COALESCE(l.first_name,'') = '')", company: "(COALESCE(l.company,'') = '')", any: "(COALESCE(l.first_name,'') = '' OR COALESCE(l.company,'') = '')" }[o.missing];
    if (!miss) throw new AppError('validation', 'Invalid missing-field filter', 400, { missing: 'Invalid filter' });
    where.push(miss);
  }
  if (o.domain) {
    var dom = String(o.domain).trim().toLowerCase().slice(0, 100).replace(/^@/, '');
    if (!/^[a-z0-9.\-]+$/.test(dom)) throw new AppError('validation', 'Invalid domain', 400, { domain: 'Use letters, numbers, dots and dashes' });
    where.push("l.domain LIKE ? ESCAPE '\\'"); params.push('%' + dom.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (o.in_campaign === '1' || o.in_campaign === '0') {
    where.push((o.in_campaign === '1' ? '' : 'NOT ') + 'EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id)');
  } else if (o.in_campaign && o.in_campaign !== 'all') throw new AppError('validation', 'Invalid campaign filter', 400, { in_campaign: 'Invalid filter' });
  return { sql: where.join(' AND '), params: params };
}

Leads.prototype.listLeads = function (userId, folderId, o) {
  var self = this;
  o = o || {};
  return this._folder(userId, folderId).then(function () {
    var f = leadFilter(userId, folderId, o);
    var page = Math.max(1, parseInt(o.page, 10) || 1);
    var size = Math.min(200, Math.max(1, parseInt(o.pageSize, 10) || 50));
    var sortCol = SORTS[o.sort] || SORTS.created_at, dir = o.dir === 'asc' ? 'ASC' : 'DESC';
    return self.db.get('SELECT COUNT(*) AS c FROM leads l WHERE ' + f.sql, f.params).then(function (tot) {
      return self.db.all(
        'SELECT l.id, l.folder_id, l.email, l.domain, l.first_name, l.last_name, l.company, l.is_role, l.verify_status, l.verify_error, l.verified_at, l.created_at ' +
        'FROM leads l WHERE ' + f.sql + ' ORDER BY ' + sortCol + ' ' + dir + ', l.id ' + dir + ' LIMIT ? OFFSET ?',
        f.params.concat([size, (page - 1) * size])
      ).then(function (items) { return { items: items, total: tot.c, page: page, pageSize: size }; });
    });
  });
};

// Ids of every lead matching a filter (for "verify all unverified"). Capped at MAX_IMPORT_ROWS.
Leads.prototype.leadIds = function (userId, folderId, o) {
  var self = this;
  o = o || {};
  return this._folder(userId, folderId).then(function () {
    var f = leadFilter(userId, folderId, o);
    return self.db.all('SELECT l.id FROM leads l WHERE ' + f.sql + ' ORDER BY l.id LIMIT ' + (MAX_IMPORT_ROWS + 1), f.params);
  }).then(function (rows) {
    var truncated = rows.length > MAX_IMPORT_ROWS;
    return { ids: rows.slice(0, MAX_IMPORT_ROWS).map(function (r) { return r.id; }), truncated: truncated };
  });
};

Leads.prototype.stats = function (userId, folderId) {
  var self = this;
  return (folderId ? this._folder(userId, folderId) : Promise.resolve()).then(function () {
    var sql = 'SELECT COUNT(*) AS total, ' + STATUSES.map(function (s) { return "COALESCE(SUM(CASE WHEN verify_status = '" + s + "' THEN 1 ELSE 0 END), 0) AS " + s; }).join(', ') +
      ' FROM leads WHERE user_id = ?' + (folderId ? ' AND folder_id = ?' : '');
    return self.db.get(sql, folderId ? [userId, folderId] : [userId]);
  }).then(function (r) {
    var verified = r.total - r.unverified;
    r.valid_rate = verified > 0 ? Math.round(r.valid / verified * 1000) / 10 : null;
    return r;
  });
};

Leads.prototype.deleteLeads = function (userId, ids, ip) {
  var self = this, list;
  try { list = idList(ids, MAX_DELETE_BATCH); } catch (e) { return Promise.reject(e); }
  return this.db.get(IN_CAMPAIGN_SQL + 'cl.lead_id IN (' + placeholders(list.length) + ')', [userId].concat(list)).then(function (busy) {
    assertNotInCampaign(busy.c);
    return self.db.run('DELETE FROM leads WHERE user_id = ? AND id IN (' + placeholders(list.length) + ')', [userId].concat(list));
  }).then(function (r) {
    return audit.log(self.db, { userId: userId, action: 'leads.delete', ip: ip, meta: { requested: list.length, deleted: r.changes } }, self.now)
      .then(function () { return { deleted: r.changes }; });
  });
};

// Move leads to another folder (leads already in that folder with the same email stay where they are).
Leads.prototype.moveLeads = function (userId, ids, folderId, ip) {
  var self = this, list, fid = Number(folderId);
  try { list = idList(ids, MAX_DELETE_BATCH); } catch (e) { return Promise.reject(e); }
  if (!isFinite(fid) || fid < 1 || Math.floor(fid) !== fid) return Promise.reject(new AppError('validation', 'Choose a folder', 400, { folder_id: 'Choose a folder' }));
  return this._folder(userId, fid).then(function () {
    return self.db.run('UPDATE OR IGNORE leads SET folder_id = ? WHERE user_id = ? AND id IN (' + placeholders(list.length) + ')', [fid, userId].concat(list));
  }).then(function (r) {
    return audit.log(self.db, { userId: userId, action: 'leads.move', ip: ip, meta: { requested: list.length, moved: r.changes, folder_id: fid } }, self.now)
      .then(function () { return { moved: r.changes, skipped: list.length - r.changes }; });
  });
};

Leads.prototype.exportCsv = function (userId, folderId) {
  var self = this;
  return this._folder(userId, folderId).then(function () {
    return self.db.all('SELECT email, first_name, last_name, company, verify_status, verify_error FROM leads WHERE user_id = ? AND folder_id = ? ORDER BY id LIMIT ' + MAX_EXPORT_ROWS, [userId, folderId]);
  }).then(function (rows) {
    var out = [['email', 'first_name', 'last_name', 'company', 'status', 'verify_note']];
    rows.forEach(function (r) { out.push([r.email, r.first_name, r.last_name, r.company, r.verify_status, r.verify_error]); });
    return csv.stringify(out);   // formula-injection neutralized per cell
  });
};

// ----- verification (manual only) -----
Leads.prototype.verifyLeads = function (userId, ids, ip) {
  var self = this, list;
  try { list = idList(ids, MAX_VERIFY_BATCH); } catch (e) { return Promise.reject(e); }
  var cache = {};
  return this.db.all('SELECT id, email, domain FROM leads WHERE user_id = ? AND id IN (' + placeholders(list.length) + ')', [userId].concat(list)).then(function (leads) {
    var results = new Array(leads.length), cursor = 0;
    function check(lead) {
      var syn = email.checkSyntax(lead.email);
      if (!syn.ok) return Promise.resolve({ status: 'invalid', reason: 'bad_syntax_' + syn.reason });
      if (!cache[lead.domain]) cache[lead.domain] = classifyDomain(lead.domain, self.resolver);
      return cache[lead.domain];
    }
    function worker() {
      if (cursor >= leads.length) return Promise.resolve();
      var i = cursor++, lead = leads[i];
      return check(lead).then(function (r) { results[i] = { id: lead.id, email: lead.email, status: r.status, reason: r.reason }; return worker(); });
    }
    var workers = [];
    for (var w = 0; w < Math.min(8, leads.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }).then(function (results) {
    var t = self.now();
    return self.db.transaction(function (tx) {
      return results.reduce(function (p, r) {
        return p.then(function () {
          if (r.status) return tx.run('UPDATE leads SET verify_status = ?, verify_error = ?, verified_at = ? WHERE id = ? AND user_id = ?', [r.status, r.reason, t, r.id, userId]);
          return tx.run('UPDATE leads SET verify_error = ? WHERE id = ? AND user_id = ?', [r.reason, r.id, userId]);   // transient: status unchanged
        });
      }, Promise.resolve());
    }).then(function () {
      var sum = { checked: results.length, valid: 0, invalid: 0, risky: 0, retry_later: 0, results: results };
      results.forEach(function (r) { if (r.status === 'valid') sum.valid++; else if (r.status === 'invalid') sum.invalid++; else if (r.status === 'risky') sum.risky++; else sum.retry_later++; });
      return audit.log(self.db, { userId: userId, action: 'leads.verify', ip: ip, meta: { checked: sum.checked, valid: sum.valid, invalid: sum.invalid } }, self.now).then(function () { return sum; });
    });
  });
};

// ----- suppression list -----
Leads.prototype.addSuppression = function (userId, emails, reason) {
  var self = this;
  if (!Array.isArray(emails) || !emails.length || emails.length > 5000) return Promise.reject(new AppError('validation', 'Provide 1-5000 emails', 400, { emails: 'Provide 1-5000 emails' }));
  var why = reason || 'manual';
  if (['unsubscribed', 'bounced', 'complaint', 'manual', 'replied_stop'].indexOf(why) === -1) return Promise.reject(new AppError('validation', 'Invalid reason', 400, { reason: 'Invalid reason' }));
  return this.db.transaction(function (tx) {
    var added = 0, invalid = 0, t = self.now();
    return emails.reduce(function (p, raw) {
      return p.then(function () {
        var addr = email.normalize(raw);
        if (typeof raw !== 'string' || !email.checkSyntax(addr).ok) { invalid++; return; }
        return tx.run('INSERT OR IGNORE INTO suppression (user_id, email, reason, created_at) VALUES (?,?,?,?)', [userId, addr, why, t]).then(function (r) { added += r.changes; });
      });
    }, Promise.resolve()).then(function () { return { added: added, invalid: invalid }; });
  });
};

Leads.prototype.listSuppression = function (userId, page, pageSize) {
  var p = Math.max(1, parseInt(page, 10) || 1), s = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50)), self = this;
  return this.db.get('SELECT COUNT(*) AS c FROM suppression WHERE user_id = ?', [userId]).then(function (t) {
    return self.db.all('SELECT email, reason, created_at FROM suppression WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [userId, s, (p - 1) * s])
      .then(function (items) { return { items: items, total: t.c, page: p, pageSize: s }; });
  });
};

Leads.prototype.removeSuppression = function (userId, addr) {
  return this.db.run('DELETE FROM suppression WHERE user_id = ? AND email = ?', [userId, email.normalize(addr)]).then(function (r) { return { removed: r.changes }; });
};

module.exports = { Leads: Leads, parseInput: parseInput, classifyDomain: classifyDomain };
