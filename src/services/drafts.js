'use strict';
// Wizard drafts (src/services/drafts.js): autosaved snapshots of the Campaign Builder.
// A draft is loose by design (the user may be half-way through), so nothing here is required to be complete;
// but every field that IS present is whitelisted, type-checked, length-capped and email HTML is sanitised,
// so a draft can never carry anything the final campaign validation would not accept later.
// Conflict protection: save(id, input.rev) fails with 'conflict' when the stored rev is newer (second tab).
var AppError = require('../lib/errors').AppError;
var v = require('../lib/validate');
var sanitize = require('../lib/sanitize');

var MAX_DRAFTS = 50, MAX_STEPS = 6, MAX_DATA = 600000;
var LEAD_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'risky'];

function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }
function str(x, max) { return typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : ''; }
function numOrNull(x, lo, hi) { var n = typeof x === 'number' ? x : (typeof x === 'string' && /^\d{1,9}$/.test(x.trim()) ? parseInt(x, 10) : NaN); return isFinite(n) && n % 1 === 0 && n >= lo && n <= hi ? n : null; }
function ids(a, max) { return Array.isArray(a) ? a.map(function (x) { return numOrNull(x, 1, 9007199254740991); }).filter(function (x) { return x !== null; }).slice(0, max) : []; }

// Whitelist + normalise the wizard state.
function normalise(d) {
  d = d && typeof d === 'object' ? d : {};
  var out = { step: numOrNull(d.step, 0, 3) || 0, name: str(d.name, 100).trim() };
  out.steps = (Array.isArray(d.steps) ? d.steps : []).slice(0, MAX_STEPS).map(function (s) {
    s = s && typeof s === 'object' ? s : {};
    // delay is kept as typed (integer days) so a half-typed value is not lost; the real 1..60 check runs on launch
    return { subject: str(s.subject, 200).replace(/[\r\n]+/g, ' '), body_html: sanitize.clean(str(s.body_html, 50000)), delay_days: numOrNull(s.delay_days, 0, 9999) };
  });
  out.sender_ids = ids(d.sender_ids, 20);
  out.folder_id = numOrNull(d.folder_id, 1, 9007199254740991);
  out.exclude_role = !!d.exclude_role;
  out.lead_statuses = (Array.isArray(d.lead_statuses) ? d.lead_statuses : []).filter(function (s, i, a) { return LEAD_STATUSES.indexOf(s) !== -1 && a.indexOf(s) === i; });
  var sp = d.split && typeof d.split === 'object' ? d.split : {};
  out.split = { enabled: !!sp.enabled, batch_size: numOrNull(sp.batch_size, 1, 1000000), seed: numOrNull(sp.seed, 0, 4294967295) };
  var st = d.settings && typeof d.settings === 'object' ? d.settings : {};
  out.settings = {
    window_start_hour: numOrNull(st.window_start_hour, 0, 23), window_end_hour: numOrNull(st.window_end_hour, 1, 24),
    utc_offset_min: typeof st.utc_offset_min === 'number' && st.utc_offset_min % 1 === 0 && st.utc_offset_min >= -720 && st.utc_offset_min <= 840 ? st.utc_offset_min : null,
    weekdays_only: st.weekdays_only === undefined ? true : !!st.weekdays_only,
    stop_on_reply: st.stop_on_reply === undefined ? true : !!st.stop_on_reply,
    track_opens: !!st.track_opens
  };
  return out;
}

function DraftsService(db, opts) { this.db = db; this.now = (opts && opts.now) || Date.now; }
var D = DraftsService.prototype;

function view(r, withData) {
  var data = {}; try { data = JSON.parse(r.data); } catch (e) { data = {}; }
  var o = { id: r.id, project_id: r.project_id, name: r.name, rev: r.rev, created_at: r.created_at, updated_at: r.updated_at,
    steps_count: (data.steps || []).length, step: data.step || 0 };
  if (withData) o.data = data;
  return o;
}

D._own = function (userId, id) {
  if (id === null || id === undefined) return Promise.reject(new AppError('not_found', 'Draft not found', 404));
  return this.db.get('SELECT * FROM wizard_drafts WHERE id = ? AND user_id = ?', [id, userId]).then(function (r) {
    if (!r) throw new AppError('not_found', 'Draft not found', 404);
    return r;
  });
};

D.list = function (userId, q) {
  var projectId = q && q.project_id !== undefined ? numOrNull(q.project_id, 1, 9007199254740991) : null;
  var sql = 'SELECT * FROM wizard_drafts WHERE user_id = ?' + (projectId ? ' AND project_id = ?' : '') + ' ORDER BY updated_at DESC, id DESC LIMIT 100';
  return this.db.all(sql, projectId ? [userId, projectId] : [userId]).then(function (rows) { return { drafts: rows.map(function (r) { return view(r, false); }) }; });
};

D.get = function (userId, id) { return this._own(userId, id).then(function (r) { return { draft: view(r, true) }; }); };

function checkProject(self, userId, pid) {
  if (pid === null) return Promise.resolve(null);
  return self.db.get('SELECT id FROM projects WHERE id = ? AND user_id = ?', [pid, userId]).then(function (p) {
    if (!p) throw new AppError('not_found', 'Project not found', 404);
    return pid;
  });
}

D.create = function (userId, input) {
  var self = this;
  input = input || {};
  var data = normalise(input.data), json = JSON.stringify(data);
  if (json.length > MAX_DATA) return Promise.reject(bad('data', 'Draft is too large'));
  var pid = input.project_id === undefined || input.project_id === null ? null : numOrNull(input.project_id, 1, 9007199254740991);
  if (input.project_id !== undefined && input.project_id !== null && pid === null) return Promise.reject(bad('project_id', 'Invalid project'));
  var t = this.now();
  return checkProject(this, userId, pid).then(function () {
    return self.db.get('SELECT COUNT(*) AS n FROM wizard_drafts WHERE user_id = ?', [userId]);
  }).then(function (c) {
    if (c.n >= MAX_DRAFTS) throw new AppError('conflict', 'You have ' + MAX_DRAFTS + ' drafts. Delete some old ones first.', 409);
    return self.db.run('INSERT INTO wizard_drafts (user_id, project_id, name, data, rev, created_at, updated_at) VALUES (?,?,?,?,1,?,?)', [userId, pid, data.name, json, t, t]);
  }).then(function (r) { return self.get(userId, r.lastID); });
};

// input: { data, rev } -- rev is the revision the client last saw; a newer stored one means another tab saved.
D.save = function (userId, id, input) {
  var self = this;
  input = input || {};
  var data = normalise(input.data), json = JSON.stringify(data);
  if (json.length > MAX_DATA) return Promise.reject(bad('data', 'Draft is too large'));
  var rev = numOrNull(input.rev, 1, 1000000000);
  if (rev === null) return Promise.reject(bad('rev', 'rev is required'));
  return this._own(userId, id).then(function (r) {
    if (r.rev !== rev) throw new AppError('conflict', 'This draft was changed in another tab or window. Reload it to see the latest version.', 409, { rev: r.rev });
    return self.db.run('UPDATE wizard_drafts SET name = ?, data = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND user_id = ? AND rev = ?', [data.name, json, self.now(), id, userId, rev]);
  }).then(function (res) {
    if (!res.changes) throw new AppError('conflict', 'This draft was changed in another tab or window. Reload it to see the latest version.', 409);
    return self.get(userId, id);
  });
};

D.remove = function (userId, id) {
  var self = this;
  return this._own(userId, id).then(function () { return self.db.run('DELETE FROM wizard_drafts WHERE id = ? AND user_id = ?', [id, userId]); }).then(function () { return { ok: true }; });
};

module.exports = { DraftsService: DraftsService, normalise: normalise, MAX_DRAFTS: MAX_DRAFTS };
