'use strict';
// Campaigns module: wizard data, Smart Split into sub-campaigns, lifecycle, dashboard data.
//
// Model: a MAIN campaign (parent_id NULL) owns the sequence + settings. When Smart Split is used
// it has SUB-campaigns (parent_id = main) that each hold a batch of leads and a copy of the
// sequence (so the sending engine only ever reads "my campaign's steps"). Without a split the
// main campaign holds the leads itself. The main campaign's status is derived from its parts.
//
// Safety: all queries scoped by user_id; lead selection excludes suppressed addresses; suppression
// is re-checked at start; sender ownership verified; templates validated; no sending happens here
// (the sending engine reads campaigns with status 'active').
var email = require('../lib/email');
var text = require('../lib/text');
var split = require('../lib/split');
var tpl = require('../lib/template');
var v = require('../lib/validate');
var AppError = require('../lib/errors').AppError;
var audit = require('./audit');
var nextSend = require('../lib/nextSend');
var nextEmail = require('./nextEmail');
var state = require('./campaignState');
var settingsLib = require('./settings');
var stepProgress = require('./stepProgress');

var MAX_LEADS = 50000, MAX_PARTS = 500, MAX_STEPS = 6, MAX_SENDERS = 20;
var DEFAULT_LEAD_STATUSES = ['valid', 'unverified', 'risky', 'catch_all'];
var LEAD_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'risky'];
// 'stopped' = stopped in this campaign only (manually, "not interested" reply or "stop campaign" phrase); it is finished work but never 'completed'.
var CL_STATUSES = ['pending', 'active', 'replied', 'completed', 'bounced', 'unsubscribed', 'paused', 'error', 'stopped'];
var DONE_STATUSES = ['replied', 'completed', 'bounced', 'unsubscribed', 'stopped'];
var FILTERS = { all: null, active: ['active'], paused: ['paused'], completed: ['completed'], draft: ['draft', 'preparing'], error: ['error'] };
var SAMPLE_LEAD = { first_name: 'Alex', last_name: 'Morgan', company: 'Acme Domains', email: 'alex@acme-domains.com', domain: 'acme-domains.com' };

var sanitize = require('../lib/sanitize');
function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }
function seq(items, fn) { return items.reduce(function (p, it, i) { return p.then(function () { return fn(it, i); }); }, Promise.resolve()); }

// ---------- validation ----------
function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw bad('steps', 'A sequence needs 1 to ' + MAX_STEPS + ' emails (the first email plus up to 5 follow-ups)');
  return steps.map(function (s, i) { return validateStep(s, i); });
}

// One step (index i = step_no). Also used by the live editor, which changes a single not-yet-sent step.
function validateStep(s, i) {
  if (!s || typeof s !== 'object') throw bad('steps', 'Step ' + (i + 1) + ' is invalid');
  var subject = typeof s.subject === 'string' ? s.subject.trim() : '';
  if (text.hasControl(subject) || subject.length > 200) throw bad('steps', 'Step ' + (i + 1) + ': subject must be one line, max 200 characters');
  if (i === 0 && !subject) throw bad('steps', 'The first email needs a subject');
  var body = typeof s.body_html === 'string' ? s.body_html : '';
  if (body.length > 50000) throw bad('steps', 'Step ' + (i + 1) + ': body is too long (max 50,000 characters)');
  body = sanitize.clean(body);
  if (sanitize.isBlank(body)) throw bad('steps', 'Step ' + (i + 1) + ': the email body is empty');
  if ((body.match(/<img\b/g) || []).length > 3) throw bad('steps', 'Step ' + (i + 1) + ': use at most 3 pictures per email (more can look like spam)');
  var delay = 0;
  if (i > 0) {
    delay = s.delay_days === undefined ? 3 : v.intIn(s.delay_days, 1, 60);
    if (delay === null) throw bad('steps', 'Step ' + (i + 1) + ': wait time must be 1 to 60 days');
  }
  return { step_no: i, delay_days: delay, subject: subject, body_html: body };
}

var MAX_START_DAYS = 90;
// Local calendar date (YYYY-MM-DD) of a UTC timestamp in a campaign's own time zone.
function localDate(ms, offsetMin) { return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10); }
// The moment the campaign may begin: the first sending hour of the chosen local date, expressed in UTC.
function startAtFor(dateStr, hour, offsetMin) {
  var p = dateStr.split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hour) - offsetMin * 60000;
}

function validateSettings(input, base, nowMs) {
  var o = Object.assign({ window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, weekdays_only: 1, stop_on_reply: 1, track_opens: 0, start_at: null, priority_mode: 'followups_first' }, base || {});
  var prevHour = o.window_start_hour, prevOff = o.utc_offset_min;
  var has = function (k) { return input && Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined; };
  if (has('window_start_hour')) { o.window_start_hour = v.intIn(input.window_start_hour, 0, 23); if (o.window_start_hour === null) throw bad('window_start_hour', 'Start hour must be 0-23'); }
  if (has('window_end_hour')) { o.window_end_hour = v.intIn(input.window_end_hour, 1, 24); if (o.window_end_hour === null) throw bad('window_end_hour', 'End hour must be 1-24'); }
  if (o.window_end_hour <= o.window_start_hour) throw bad('window_end_hour', 'End hour must be after the start hour');
  if (has('utc_offset_min')) { o.utc_offset_min = v.intIn(input.utc_offset_min, -720, 840); if (o.utc_offset_min === null) throw bad('utc_offset_min', 'Invalid time zone offset'); }
  ['weekdays_only', 'stop_on_reply', 'track_opens'].forEach(function (k) { if (has(k)) o[k] = input[k] ? 1 : 0; });
  if (has('active_days')) {
    var m = v.intIn(input.active_days, 1, 127); if (m === null) throw bad('active_days', 'Choose at least one day to send on');
    o.active_days = m; o.weekdays_only = (m & 65) === 0 ? 1 : 0;      // keep the old flag truthful for older readers
  } else if (has('weekdays_only')) o.active_days = null;
  // Scheduled start: "start_date" is a local calendar day (YYYY-MM-DD) in the campaign's time zone; null / '' means start right away.
  if (has('start_date')) {
    if (input.start_date === null || input.start_date === '') o.start_at = null;
    else {
      var d = String(input.start_date);
      var ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
      if (!ok) throw bad('start_date', 'Choose a valid start date');
      var now = nowMs === undefined ? Date.now() : nowMs;
      if (d < localDate(now, o.utc_offset_min)) throw bad('start_date', 'The start date cannot be in the past');
      if (d > localDate(now + MAX_START_DAYS * 86400000, o.utc_offset_min)) throw bad('start_date', 'The start date can be at most ' + MAX_START_DAYS + ' days ahead');
      o.start_at = startAtFor(d, o.window_start_hour, o.utc_offset_min);
    }
  } else if (o.start_at && (o.window_start_hour !== prevHour || o.utc_offset_min !== prevOff)) {
    // Hours or time zone changed but the date was not touched: keep the same local day.
    o.start_at = startAtFor(localDate(o.start_at, prevOff), o.window_start_hour, o.utc_offset_min);
  }
  return o;
}

function validateName(n) {
  var name = text.cleanText(n, 120);
  if (!name) throw bad('name', 'Campaign name is required (max 120 characters)');
  return name;
}

function parseLeadSource(input) {
  var out = { statuses: DEFAULT_LEAD_STATUSES, excludeRole: !!input.exclude_role, skipInActive: input.skip_in_active !== false, excludeDuplicates: input.exclude_duplicates === true };
  if (input.lead_statuses !== undefined) {
    if (!Array.isArray(input.lead_statuses) || !input.lead_statuses.length || input.lead_statuses.some(function (s) { return LEAD_STATUSES.indexOf(s) === -1; })) throw bad('lead_statuses', 'Invalid lead status filter');
    out.statuses = input.lead_statuses;
  }
  if (input.folder_ids !== undefined && input.folder_ids !== null) {
    out.folderIds = v.idArray(input.folder_ids, 1, 50);                 // several lists at once (Hunter-style); duplicates by email are merged
    if (!out.folderIds) throw bad('folder_ids', 'Choose 1 to 50 lead lists');
  } else if (input.folder_id !== undefined && input.folder_id !== null) {
    out.folderId = v.intIn(input.folder_id, 1, 9007199254740991);
    if (out.folderId === null) throw bad('folder_id', 'Invalid folder');
  } else if (input.lead_ids !== undefined) {
    out.leadIds = v.idArray(input.lead_ids, 1, 5000);
    if (!out.leadIds) throw bad('lead_ids', 'Provide 1-5000 lead ids');
  } else throw bad('folder_id', 'Choose a folder (or specific leads) to send to');
  return out;
}

function parseSplit(input) {
  if (input === undefined || input === null) return null;
  var size = v.intIn(input.batch_size, 1, 1000000);
  if (size === null) throw bad('batch_size', 'Batch size must be a whole number of at least 1');
  var seed = input.seed === undefined || input.seed === null ? null : v.intIn(input.seed, 0, 4294967295);
  if (input.seed !== undefined && input.seed !== null && seed === null) throw bad('seed', 'Invalid seed');
  return { batchSize: size, seed: seed };
}

function CampaignsService(db, opts) {
  this.db = db;
  this.now = (opts && opts.now) || Date.now;
}
var C = CampaignsService.prototype;

// ---------- lead selection and split planning ----------
C._selectLeads = function (userId, src) {
  var self = this;
  var conds = ['l.user_id = ?', 'l.verify_status IN (' + v.placeholders(src.statuses.length) + ')',
    'NOT EXISTS (SELECT 1 FROM suppression s WHERE s.user_id = l.user_id AND s.email = l.email)'];
  var base = [userId].concat(src.statuses);
  if (src.excludeRole) conds.push('l.is_role = 0');
  if (src.skipInActive) {
    conds.push("NOT EXISTS (SELECT 1 FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = l.id AND c.status IN ('active','paused','preparing') AND cl.status IN ('pending','active','paused'))");
  }
  // "Remove" in the duplicate prompt: nobody who already sits in ANY campaign (running, paused, draft or finished) is added again.
  if (src.excludeDuplicates) conds.push('NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id)');
  var cols = 'SELECT l.id, l.email, l.domain FROM leads l WHERE ';
  var p;
  if (src.folderIds) {
    var fids = src.folderIds;
    p = this.db.all('SELECT id FROM folders WHERE user_id = ? AND id IN (' + v.placeholders(fids.length) + ')', [userId].concat(fids)).then(function (fs) {
      if (fs.length !== fids.length) throw new AppError('not_found', 'Folder not found', 404);
      return self.db.all(cols + conds.join(' AND ') + ' AND l.folder_id IN (' + v.placeholders(fids.length) + ') ORDER BY l.id LIMIT ' + (MAX_LEADS * 2 + 1), base.concat(fids));
    }).then(function (rows) {
      var seenMail = {};            // the same address in two lists must receive the sequence only once
      return rows.filter(function (r) { var k = String(r.email).toLowerCase(); if (seenMail[k]) return false; seenMail[k] = true; return true; });
    });
  } else if (src.folderId) {
    p = this.db.get('SELECT id FROM folders WHERE id = ? AND user_id = ?', [src.folderId, userId]).then(function (f) {
      if (!f) throw new AppError('not_found', 'Folder not found', 404);
      return self.db.all(cols + conds.join(' AND ') + ' AND l.folder_id = ? ORDER BY l.id LIMIT ' + (MAX_LEADS + 1), base.concat([src.folderId]));
    });
  } else {
    var seen = {}, rows = [];     // chunked IN (...) keeps us under SQLite's variable limit
    p = seq(v.chunk(src.leadIds, 500), function (ids) {
      return self.db.all(cols + conds.join(' AND ') + ' AND l.id IN (' + v.placeholders(ids.length) + ') ORDER BY l.id', base.concat(ids)).then(function (r) {
        r.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = true; rows.push(x); } });
      });
    }).then(function () { return rows; });
  }
  return p.then(function (rows) {
    if (rows.length > MAX_LEADS) throw bad('folder_id', 'Too many leads (max ' + MAX_LEADS + ' per campaign)');
    return rows;
  });
};

// Shared by preview and create so the same seed gives exactly the same result.
C._plan = function (userId, input, splitInput) {
  var src = parseLeadSource(input), sp = parseSplit(splitInput);
  return this._selectLeads(userId, src).then(function (leads) {
    if (!leads.length) throw bad('folder_id', 'No eligible leads found (invalid, suppressed, or already in an active campaign are skipped)');
    var seed = sp && sp.seed !== null ? sp.seed : (input.seed !== undefined && input.seed !== null ? v.intIn(input.seed, 0, 4294967295) : split.newSeed());
    if (seed === null) throw bad('seed', 'Invalid seed');
    var batches;
    if (sp && sp.batchSize < leads.length) {
      if (Math.ceil(leads.length / sp.batchSize) > MAX_PARTS) throw bad('batch_size', 'This would create more than ' + MAX_PARTS + ' sub-campaigns. Use a larger batch size.');
      batches = split.splitSpread(leads, sp.batchSize, seed);
    } else {
      batches = [split.domainAwareShuffle(leads, seed)];
    }
    return { leads: leads, batches: batches, seed: seed, isSplit: !!(sp && sp.batchSize < leads.length), batchSize: sp ? sp.batchSize : null };
  });
};

C.previewSplit = function (userId, input) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    return self._plan(userId, input, { batch_size: input.batch_size, seed: input.seed });
  }).then(function (plan) {
    return {
      total: plan.leads.length, batch_size: plan.batchSize, seed: plan.seed, is_split: plan.isSplit,
      sizes: plan.batches.map(function (b) { return b.length; }),
      same_company_in_one_batch: split.countConflicts(plan.batches)
    };
  });
};

// ---------- writes ----------
function insertSteps(tx, campaignId, steps) {
  return seq(steps, function (s) {
    return tx.run('INSERT INTO campaign_steps (campaign_id, step_no, delay_days, subject, body_html) VALUES (?,?,?,?,?)',
      [campaignId, s.step_no, s.delay_days, s.subject, s.body_html]);
  });
}
function linkSenders(tx, campaignId, senderIds) {
  return seq(senderIds, function (id) { return tx.run('INSERT INTO campaign_senders (campaign_id, sender_id) VALUES (?,?)', [campaignId, id]); });
}
function insertLeads(tx, campaignId, leads) {
  return seq(v.chunk(leads.map(function (l, i) { return { id: l.id, pos: i }; }), 300), function (rows) {
    var params = [];
    rows.forEach(function (r) { params.push(campaignId, r.id, r.pos); });
    return tx.run('INSERT INTO campaign_leads (campaign_id, lead_id, position) VALUES ' + rows.map(function () { return '(?,?,?)'; }).join(','), params);
  });
}
var CAMPAIGN_COLS = 'user_id, parent_id, project_id, name, status, split_seed, batch_size, window_start_hour, window_end_hour, utc_offset_min, weekdays_only, stop_on_reply, track_opens, start_at, priority_mode, created_at, updated_at';
function insertCampaign(tx, userId, parentId, projectId, name, status, seed, batchSize, s, t) {
  return tx.run('INSERT INTO campaigns (' + CAMPAIGN_COLS + ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, parentId, parentId ? null : projectId, name, status, seed, batchSize, s.window_start_hour, s.window_end_hour, s.utc_offset_min, s.weekdays_only, s.stop_on_reply, s.track_opens, s.start_at || null, s.priority_mode || 'followups_first', t, t]).then(function (r) { return r.lastID; });
}

C._checkSenders = function (userId, ids) {
  return this.db.all('SELECT id, status FROM senders WHERE user_id = ? AND id IN (' + v.placeholders(ids.length) + ')', [userId].concat(ids)).then(function (rows) {
    if (rows.length !== ids.length) throw bad('sender_ids', 'One or more senders were not found');
    if (rows.some(function (r) { return r.status === 'disabled'; })) throw bad('sender_ids', 'A selected sender is disabled');
  });
};

C.create = function (userId, input, ip) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    var name = validateName(input.name), steps = validateSteps(input.steps), settings = validateSettings(input, null, self.now());
    var senderIds = v.idArray(input.sender_ids, 1, MAX_SENDERS);
    if (!senderIds) throw bad('sender_ids', 'Choose 1 to ' + MAX_SENDERS + ' sending accounts');
    var projectId = null;
    if (input.project_id !== undefined && input.project_id !== null) {
      projectId = v.intIn(input.project_id, 1, 9007199254740991);
      if (projectId === null) throw bad('project_id', 'Invalid project');
    }
    return self._checkSenders(userId, senderIds).then(function () {
      if (projectId === null) return null;
      return self.db.get('SELECT id, archived FROM projects WHERE id = ? AND user_id = ?', [projectId, userId]).then(function (p) {
        if (!p) throw bad('project_id', 'Project not found');
        if (p.archived) throw bad('project_id', 'This project is archived. Unarchive it first.');
      });
    }).then(function () {
      return self._plan(userId, input, input.split || null);
    }).then(function (plan) {
      var t = self.now();
      return self.db.transaction(function (tx) {
        var mainId;
        // No project given: the campaign gets a project of its own (keeps one-step creation for simple cases).
        var pj = projectId !== null ? Promise.resolve(projectId)
          : tx.run('INSERT INTO projects (user_id, name, created_at, updated_at) VALUES (?,?,?,?)', [userId, name, t, t]).then(function (r) { return r.lastID; });
        return pj.then(function (pid) { projectId = pid; return insertCampaign(tx, userId, null, projectId, name, 'draft', plan.seed, plan.batchSize, settings, t); }).then(function (id) {
          mainId = id;
          return null;
        }).then(function () { return insertSteps(tx, mainId, steps); }).then(function () { return linkSenders(tx, mainId, senderIds); }).then(function () {
          if (!plan.isSplit) return insertLeads(tx, mainId, plan.batches[0]);
          return seq(plan.batches, function (batch, i) {
            var partName = name + ' - Part ' + (i + 1) + '/' + plan.batches.length, pid;
            return insertCampaign(tx, userId, mainId, null, partName, 'draft', plan.seed, plan.batchSize, settings, t).then(function (id) {
              pid = id;
              return insertSteps(tx, pid, steps);
            }).then(function () { return linkSenders(tx, pid, senderIds); }).then(function () { return insertLeads(tx, pid, batch); });
          });
        }).then(function () {
          return audit.log(tx, { userId: userId, action: 'campaign.create', entity: 'campaign', entityId: mainId, ip: ip,
            meta: { name: name, project_id: projectId, leads: plan.leads.length, parts: plan.isSplit ? plan.batches.length : 0, steps: steps.length } }, self.now);
        }).then(function () { return mainId; });
      });
    });
  }).then(function (id) { return self.get(userId, id); });
};

// ---------- reads ----------
C._own = function (userId, id) {
  return this.db.get('SELECT * FROM campaigns WHERE id = ? AND user_id = ?', [id, userId]).then(function (c) {
    if (!c) throw new AppError('not_found', 'Campaign not found', 404);
    return c;
  });
};

function emptyStats() {
  var s = { total: 0, sent: 0, done: 0, progress_pct: 0, next_send_at: null, next_blocked: null };
  CL_STATUSES.forEach(function (k) { s[k] = 0; });
  return s;
}
function addStats(a, b) {
  CL_STATUSES.concat(['total', 'sent']).forEach(function (k) { a[k] += b[k]; });
  if (b.next_send_at !== null && (a.next_send_at === null || b.next_send_at < a.next_send_at)) a.next_send_at = b.next_send_at;
  if (b.next_blocked && !a.next_blocked) a.next_blocked = b.next_blocked;
  return a;
}
function finishStats(s) {
  if (s.next_send_at !== null) s.next_blocked = null;   // a usable time exists: not blocked
  s.done = DONE_STATUSES.reduce(function (n, k) { return n + s[k]; }, 0);
  s.progress_pct = s.total ? Math.round(s.done / s.total * 1000) / 10 : 0;
  return s;
}
var deriveStatus = state.deriveStatus;

// Per-campaign stats for the user. (Single-user scale; add pagination before SaaS scale.)
C._statsByCampaign = function (userId, onlyIds) {
  var self = this;
  return settingsLib.loadGuard(this.db, userId).then(function (guard) { return self._statsByCampaignG(userId, onlyIds, guard); });
};
C._statsByCampaignG = function (userId, onlyIds, guard) {
  var self = this, out = {};
  var filter = onlyIds ? ' AND cl.campaign_id IN (' + v.placeholders(onlyIds.length) + ')' : '';
  var params = onlyIds ? [userId].concat(onlyIds) : [userId];
  var sums = CL_STATUSES.map(function (k) { return "COALESCE(SUM(CASE WHEN cl.status = '" + k + "' THEN 1 ELSE 0 END), 0) AS " + k; }).join(', ');
  return this.db.all('SELECT cl.campaign_id AS cid, COUNT(*) AS total, ' + sums + ' ' +
    'FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ?' + filter + ' GROUP BY cl.campaign_id', params).then(function (rows) {
    var now = self.now();
    // The next-email time comes from the shared calculator (same numbers as the Senders screen): earliest valid time among the owner senders.
    return nextEmail.compute(self.db, userId, now, { guard: guard, campaignIds: onlyIds || null }).then(function (ne) { return { rows: rows, ne: ne }; });
  }).then(function (x) {
    var rows = x.rows, ne = x.ne;
    rows.forEach(function (r) {
      var s = emptyStats();
      CL_STATUSES.forEach(function (k) { s[k] = Number(r[k]); });
      s.total = Number(r.total); s.next_send_at = ne.byCampaign[r.cid] === undefined ? null : ne.byCampaign[r.cid];
      s.next_blocked = ne.campaignBlock[r.cid] || null;   // 'paused' | 'health' | 'tracking' when waiting people exist but no owner sender can send
      out[r.cid] = s;
    });
    return self.db.all("SELECT cl.campaign_id AS cid, COUNT(*) AS n FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND m.direction = 'out' AND m.status = 'sent'" + filter + ' GROUP BY cl.campaign_id', params);
  }).then(function (rows) {
    rows.forEach(function (r) { if (!out[r.cid]) out[r.cid] = emptyStats(); out[r.cid].sent = Number(r.n); });
    Object.keys(out).forEach(function (k) { finishStats(out[k]); });
    return out;
  });
};

function summarize(c, stats, senderIds) {
  return { id: c.id, parent_id: c.parent_id, project_id: c.project_id === undefined ? null : c.project_id, name: c.name, status: c.status, created_at: c.created_at, updated_at: c.updated_at,
    stats: stats || finishStats(emptyStats()), sender_ids: senderIds || [] };
}

C.list = function (userId, q) {
  var self = this;
  q = q || {};
  var filter = q.status || 'all';
  return Promise.resolve().then(function () {
    if (!Object.prototype.hasOwnProperty.call(FILTERS, filter)) throw bad('status', 'Invalid status filter');
    var senderFilter = null;
    if (q.sender_id !== undefined && q.sender_id !== '') { senderFilter = v.intIn(q.sender_id, 1, 9007199254740991); if (senderFilter === null) throw bad('sender_id', 'Invalid sender'); }
    var projectFilter = null;
    if (q.project_id !== undefined && q.project_id !== '') { projectFilter = v.intIn(q.project_id, 1, 9007199254740991); if (projectFilter === null) throw bad('project_id', 'Invalid project'); }
    var search = q.q ? String(q.q).trim().slice(0, 100) : '';
    return Promise.all([
      self.db.all('SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5000', [userId]),
      self._statsByCampaign(userId, null),
      self.db.all('SELECT cs.campaign_id AS cid, cs.sender_id AS sid FROM campaign_senders cs JOIN campaigns c ON c.id = cs.campaign_id WHERE c.user_id = ?', [userId]),
      stepProgress.load(self.db, userId, null),
      stepProgress.metaFor(self.db, userId)
    ]).then(function (res) {
      var all = res[0], stats = res[1], links = {}, prog = res[3], meta = res[4];
      res[2].forEach(function (l) { (links[l.cid] = links[l.cid] || []).push(l.sid); });
      var kids = {}, mains = [];
      all.forEach(function (c) { if (c.parent_id) (kids[c.parent_id] = kids[c.parent_id] || []).push(c); else mains.push(c); });
      var rows = mains.map(function (m) {
        var parts = (kids[m.id] || []).slice().sort(function (a, b) { return a.id - b.id; });
        var agg = emptyStats();
        (parts.length ? parts : [m]).forEach(function (c) { addStats(agg, stats[c.id] || emptyStats()); });
        finishStats(agg);
        var sids = links[m.id] || [];
        var row = summarize(m, agg, sids);
        row.status = deriveStatus(m.status, parts);
        row.is_split = parts.length > 0;
        row.step_progress = stepProgress.describe(meta[m.id], stepProgress.sum((parts.length ? parts : [m]).map(function (c) { return prog[c.id]; })));
        row.parts = parts.map(function (p) { var pr = summarize(p, stats[p.id], links[p.id]); pr.step_progress = stepProgress.describe(meta[p.id], prog[p.id]); return pr; });
        return row;
      });
      if (search) { var needle = search.toLowerCase(); rows = rows.filter(function (r) { return r.name.toLowerCase().indexOf(needle) !== -1; }); }
      if (senderFilter) rows = rows.filter(function (r) { return r.sender_ids.indexOf(senderFilter) !== -1; });
      if (projectFilter) rows = rows.filter(function (r) { return r.project_id === projectFilter; });
      var counts = { all: rows.length };
      Object.keys(FILTERS).forEach(function (k) {
        if (k !== 'all') counts[k] = rows.filter(function (r) { return FILTERS[k].indexOf(r.status) !== -1; }).length;
      });
      if (FILTERS[filter]) rows = rows.filter(function (r) { return FILTERS[filter].indexOf(r.status) !== -1; });
      var page = Math.max(1, parseInt(q.page, 10) || 1), size = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
      return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page: page, pageSize: size, counts: counts };
    });
  });
};

C.get = function (userId, id) {
  var self = this, camp;
  return this._own(userId, id).then(function (c) {
    camp = c;
    return Promise.all([
      self.db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [id, userId]),
      self.db.all('SELECT step_no, delay_days, subject, body_html FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [id]),
      self.db.all('SELECT s.id, s.label, s.email, s.status, s.health_score, s.daily_limit FROM campaign_senders cs JOIN senders s ON s.id = cs.sender_id WHERE cs.campaign_id = ? ORDER BY s.id', [id])
    ]);
  }).then(function (res) {
    var parts = res[0], ids = [camp.id].concat(parts.map(function (p) { return p.id; }));
    return Promise.all([self._statsByCampaign(userId, ids), stepProgress.load(self.db, userId, ids), stepProgress.lockedSteps(self.db, userId, parts.length ? parts.map(function (p) { return p.id; }) : [camp.id])]).then(function (rr) {
      var stats = rr[0], prog = rr[1], locked = rr[2];
      var agg = emptyStats();
      (parts.length ? parts : [camp]).forEach(function (c) { addStats(agg, stats[c.id] || emptyStats()); });
      finishStats(agg);
      var senders = res[2];
      var out = {
        id: camp.id, parent_id: camp.parent_id, project_id: camp.project_id === undefined ? null : camp.project_id, name: camp.name, status: deriveStatus(camp.status, parts),
        created_at: camp.created_at, updated_at: camp.updated_at, split_seed: camp.split_seed, batch_size: camp.batch_size,
        settings: { window_start_hour: camp.window_start_hour, window_end_hour: camp.window_end_hour, utc_offset_min: camp.utc_offset_min,
          weekdays_only: camp.weekdays_only, active_days: camp.active_days || (camp.weekdays_only ? 62 : 127), stop_on_reply: camp.stop_on_reply, track_opens: camp.track_opens,
          start_at: camp.start_at || null, start_date: camp.start_at ? localDate(camp.start_at, camp.utc_offset_min) : null },
        steps: stepProgress.describe(res[1], stepProgress.sum((parts.length ? parts : [camp]).map(function (c) { return prog[c.id]; }))).map(function (d, k) {
          return Object.assign({}, res[1][k], { sent: d.sent, capacity: d.capacity, pct: d.pct, locked: !!locked[res[1][k].step_no] });
        }),
        senders: senders, stats: agg, is_split: parts.length > 0,
        parts: parts.map(function (p) { var s = summarize(p, stats[p.id], null); delete s.sender_ids; return s; })
      };
      return out;
    });
  });
};

// People tab. Sorting is whitelisted (never user text in SQL). Hidden ("removed") rows are excluded here but still count in the
// campaign's analytics, so history is preserved. `risk=risky` narrows to addresses the verifier flagged risky / catch-all.
var PEOPLE_SORTS = { email: 'l.email', name: "COALESCE(l.last_name, '') || ' ' || COALESCE(l.first_name, '')", company: "COALESCE(l.company, '')", status: 'cl.status',
  step: 'cl.current_step', next_send: 'cl.next_send_at', last_sent: 'cl.last_sent_at', sender: 's.email', opens: 'opens', replied: 'replied_at' };
C.listLeads = function (userId, id, q) {
  var self = this;
  q = q || {};
  return this._own(userId, id).then(function () {
    return self.db.all('SELECT id FROM campaigns WHERE parent_id = ? AND user_id = ?', [id, userId]);
  }).then(function (kids) {
    var ids = kids.length ? kids.map(function (k) { return k.id; }) : [id];
    var base = 'cl.campaign_id IN (' + v.placeholders(ids.length) + ') AND cl.removed_at IS NULL', baseParams = ids.slice();
    var where = base, params = baseParams.slice();
    if (q.status && q.status !== 'all') {
      if (CL_STATUSES.indexOf(q.status) === -1) throw bad('status', 'Invalid status');
      where += ' AND cl.status = ?'; params.push(q.status);
    }
    if (q.risk === 'risky') where += " AND l.verify_status IN ('risky','catch_all')";
    else if (q.risk && q.risk !== 'all') throw bad('risk', 'Invalid filter');
    var page = Math.max(1, parseInt(q.page, 10) || 1), size = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 50));
    var order = 'cl.campaign_id, cl.position';
    if (q.sort) {
      if (!PEOPLE_SORTS[q.sort]) throw bad('sort', 'Invalid sort column');
      var dir = q.dir === 'desc' ? 'DESC' : 'ASC', col = PEOPLE_SORTS[q.sort];
      order = '(' + col + ' IS NULL) ' + (dir === 'ASC' ? 'ASC' : 'ASC') + ', ' + col + ' ' + dir + ', cl.id ' + dir;     // empty values always last
    }
    var join = 'FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN senders s ON s.id = cl.sender_id ';
    return Promise.all([
      self.db.get('SELECT COUNT(*) AS c FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE ' + where, params),
      self.db.all('SELECT cl.status AS st, COUNT(*) AS n FROM campaign_leads cl WHERE ' + base + ' GROUP BY cl.status', baseParams),
      self.db.get("SELECT COUNT(*) AS n FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE " + base + " AND l.verify_status IN ('risky','catch_all')", baseParams)
    ]).then(function (r) {
      var tot = r[0], counts = { all: 0, risky: Number(r[2].n) || 0 };
      r[1].forEach(function (x) { counts[x.st] = Number(x.n); counts.all += Number(x.n); });
      return self.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.current_step, cl.next_send_at, cl.last_sent_at, cl.status_note, (SELECT COALESCE(SUM(m.open_count), 0) FROM messages m WHERE m.campaign_lead_id = cl.id AND m.direction = \'out\') AS opens, (SELECT MAX(m.last_opened_at) FROM messages m WHERE m.campaign_lead_id = cl.id AND m.direction = \'out\') AS last_opened_at, l.email, l.first_name, l.last_name, l.company, l.verify_status, s.email AS sender_email, sp.reason AS suppression_reason, ' +
        '(SELECT MAX(r.received_at) FROM messages r WHERE r.campaign_lead_id = cl.id AND r.direction = \'in\' AND r.kind = \'email\') AS replied_at ' +
        join + 'LEFT JOIN suppression sp ON sp.user_id = ? AND sp.email = l.email WHERE ' + where +
        ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [userId].concat(params, [size, (page - 1) * size]))
        .then(function (items) {
          items.forEach(function (it) { it.opt_out = optOutKind(it); });
          return { items: items, total: tot.c, page: page, pageSize: size, counts: counts };
        });
    });
  });
};

// Why a person stopped receiving mail, as the Studio shows it: 'stop_campaign' (they replied "stop campaign"),
// 'unsubscribe_link', 'bounce', or null. Derived from the lead status plus the note / suppression reason the engine wrote.
function optOutKind(it) {
  if (it.status === 'bounced') return 'bounce';
  if (it.status === 'stopped') return state.stopKind(it.status_note);
  if (it.status !== 'unsubscribed') return null;
  if (it.suppression_reason === 'replied_stop' || /stop campaign/i.test(it.status_note || '')) return 'stop_campaign';
  return 'unsubscribe_link';
}

// ---------- lifecycle ----------
function leavesOf(db, userId, camp) {
  return db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [camp.id, userId]).then(function (kids) { return kids.length ? kids : [camp]; });
}

var syncMain = state.syncMain;

C.start = function (userId, id, ip) {
  var self = this, camp, leaves, estimate = null;
  return this._own(userId, id).then(function (c) {
    camp = c; return leavesOf(self.db, userId, c);
  }).then(function (l) {
    leaves = l;
    if (leaves.some(function (x) { return x.status !== 'draft'; })) throw new AppError('conflict', 'Only draft campaigns can be started. Use resume for paused ones.', 409);
    return Promise.all(leaves.map(function (leaf) {
      return Promise.all([
        self.db.get('SELECT COUNT(*) AS c FROM campaign_steps WHERE campaign_id = ?', [leaf.id]),
        self.db.get("SELECT COUNT(*) AS c FROM campaign_leads WHERE campaign_id = ? AND status = 'pending'", [leaf.id]),
        self.db.all("SELECT s.id, s.status, s.health_score, s.daily_limit FROM campaign_senders cs JOIN senders s ON s.id = cs.sender_id WHERE cs.campaign_id = ? AND s.user_id = ? ORDER BY s.id", [leaf.id, userId])
      ]);
    }));
  }).then(function (checks) {
    checks.forEach(function (c) {
      if (!c[0].c) throw bad('steps', 'The campaign has no email steps');
      if (!c[1].c) throw bad('leads', 'The campaign has no leads to send to');
      if (!c[2].length) throw bad('sender_ids', 'The campaign has no sending accounts');
      var unusable = c[2].filter(function (s) { return s.status !== 'active'; });
      if (unusable.length) throw bad('sender_ids', 'A selected sender is paused or disabled. Activate it or choose another.');
    });
    var senders = {};
    checks.forEach(function (c) { c[2].forEach(function (s) { senders[s.id] = s.daily_limit; }); });
    var stepCount = checks[0][0].c, perDay = Object.keys(senders).reduce(function (n, k) { return n + senders[k]; }, 0);
    var t = self.now();
    return self.db.transaction(function (tx) {
      return seq(leaves, function (leaf, i) {
        var sids = checks[i][2].map(function (s) { return s.id; });
        var n = sids.length, cases = sids.map(function (s, k) { return 'WHEN ' + k + ' THEN ?'; }).join(' ');
        return tx.run("UPDATE campaign_leads SET status = 'unsubscribed', status_note = 'On the do-not-email list' WHERE campaign_id = ? AND status = 'pending' AND lead_id IN " +
          '(SELECT l.id FROM leads l JOIN suppression s ON s.user_id = l.user_id AND s.email = l.email WHERE l.user_id = ?)', [leaf.id, userId]).then(function () {
          return tx.run("UPDATE campaign_leads SET sender_id = CASE (position % " + n + ') ' + cases + " END, status = 'active', next_send_at = ? WHERE campaign_id = ? AND status = 'pending'",
            sids.concat([Math.max(t, leaf.start_at || 0), leaf.id]));      // a scheduled campaign waits for its start date
        }).then(function () { return tx.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [t, leaf.id]); })
          // Everybody on the list may have been blocked: such a part completes now instead of sitting "active" with nobody to email.
          .then(function () { return state.completeIfDone(tx, leaf.id, t); });
      }).then(function () { return camp.parent_id === null && leaves[0].id !== camp.id ? tx.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [t, camp.id]) : null; })
        .then(function () { return camp.parent_id ? syncMain(tx, camp.parent_id, t) : null; })
        .then(function () { return audit.log(tx, { userId: userId, action: 'campaign.start', entity: 'campaign', entityId: id, ip: ip, meta: { parts: leaves.length } }, self.now); })
        .then(function () {
          // Estimate from the leads that really became active (suppressed ones were just removed).
          var ids = leaves.map(function (l) { return l.id; });
          return tx.get("SELECT COUNT(*) AS n FROM campaign_leads WHERE status = 'active' AND campaign_id IN (" + v.placeholders(ids.length) + ')', ids).then(function (r) {
            var total = r.n * stepCount;
            estimate = { emails_total_max: total, daily_capacity: perDay, min_days: perDay ? Math.ceil(total / perDay) : null };
          });
        });
    });
  }).then(function () { return Promise.all([self.get(userId, id), startWarnings(self, userId, leaves)]); }).then(function (r) {
    r[0].estimate = estimate; r[0].warnings = r[1]; return r[0];
  });
};

// Non-blocking heads-up shown right after launch: things that will not stop the campaign but the user should know.
function startWarnings(self, userId, leaves) {
  var warnings = [], ids = leaves.map(function (l) { return l.id; });
  return self.db.all('SELECT DISTINCT s.id, s.email FROM campaign_senders cs JOIN senders s ON s.id = cs.sender_id WHERE cs.campaign_id IN (' + v.placeholders(ids.length) + ') AND s.user_id = ? AND s.imap_host IS NULL', ids.concat([userId])).then(function (rows) {
    if (rows.length) warnings.push({ code: 'no_reply_tracking', message: rows.length + ' sender(s) have no IMAP settings, so replies and bounces to them cannot be detected (' + rows.map(function (r) { return r.email; }).join(', ') + '). Leads may keep getting follow-ups after they reply.' });
    return self.db.all('SELECT DISTINCT s.id, s.email FROM campaign_senders cs JOIN senders s ON s.id = cs.sender_id WHERE cs.campaign_id IN (' + v.placeholders(ids.length) + ') AND s.user_id = ? AND s.reply_detection = 0 AND s.imap_host IS NOT NULL', ids.concat([userId])).then(function (off) {
      if (off.length) warnings.push({ code: 'reply_detection_off', message: 'Reply detection is switched off for ' + off.map(function (r) { return r.email; }).join(', ') + '. Replies still reach your Inbox, but follow-ups keep going to people who answer.' });
    }).then(function () {
    return seq(leaves, function (leaf) {
      return Promise.all([
        self.db.all('SELECT subject, body_html FROM campaign_steps WHERE campaign_id = ?', [leaf.id]),
        self.db.all("SELECT l.email, l.first_name, l.last_name, l.company, l.custom FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? AND cl.status = 'active' LIMIT 20000", [leaf.id])
      ]).then(function (r) {
        var bad = 0;
        r[1].forEach(function (lead) {
          var vars = tpl.leadVars(lead), missing = false;
          r[0].forEach(function (st) { if (tpl.render(st.subject || '', vars, { html: false }).missing.length || tpl.render(st.body_html || '', vars, { html: true }).missing.length) missing = true; });
          if (missing) bad++;
        });
        leaf.__missing = bad;
      });
    });
    });
  }).then(function () {
    var n = leaves.reduce(function (a, l) { return a + (l.__missing || 0); }, 0);
    if (n) warnings.push({ code: 'missing_variables', message: n + ' lead(s) lack a value for a {{variable}} used in your emails (and the variable has no fallback). They will be skipped and marked as errors instead of receiving a broken email.' });
    return warnings;
  });
}

function changeState(self, userId, id, from, to, action, ip) {
  var camp;
  return self._own(userId, id).then(function (c) { camp = c; return leavesOf(self.db, userId, c); }).then(function (leaves) {
    var eligible = leaves.filter(function (l) { return l.status === from; });
    if (!eligible.length) throw new AppError('conflict', 'Nothing to ' + action + ': campaign is not ' + from, 409);
    var t = self.now();
    return self.db.transaction(function (tx) {
      return seq(eligible, function (l) { return tx.run('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', [to, t, l.id]); })
        // A paused campaign whose leads all finished (replied / bounced) meanwhile completes on resume instead of idling.
        .then(function () { return to === 'active' ? seq(eligible, function (l) { return state.completeIfDone(tx, l.id, t); }) : null; })
        .then(function () { return camp.parent_id === null && leaves[0].id !== camp.id ? syncMain(tx, camp.id, t) : (camp.parent_id ? syncMain(tx, camp.parent_id, t) : null); })
        .then(function () { return audit.log(tx, { userId: userId, action: 'campaign.' + action, entity: 'campaign', entityId: id, ip: ip }, self.now); });
    });
  }).then(function () { return self.get(userId, id); });
}
C.pause = function (userId, id, ip) { return changeState(this, userId, id, 'active', 'paused', 'pause', ip); };
C.resume = function (userId, id, ip) { return changeState(this, userId, id, 'paused', 'active', 'resume', ip); };

// Live editing of steps that have NOT gone out yet (Campaign Studio): subject, body and wait time of single steps.
// input.steps = [{ step_no, subject?, body_html?, delay_days? }]. A step is locked once any email of it was sent (or is being
// sent right now), because people already hold that text. The check runs inside the same transaction as the write, so an
// email that starts sending a moment later cannot slip past it. The engine re-reads steps every tick, so the change applies
// from the next tick on; an email already being composed keeps the old text (that is the one unavoidable race, and it is
// harmless: it is the text the recipient was meant to get a second ago).
// Changing the wait time moves the due time of people who are waiting for that step by the difference.
C.updateSteps = function (userId, id, input, ip) {
  var self = this, camp, leaves, patches;
  return Promise.resolve().then(function () { return self._own(userId, id); }).then(function (c) {
    camp = c;
    if (c.parent_id) throw bad('id', 'Edit the main campaign, not a single part');
    var list = input && input.steps;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_STEPS) throw bad('steps', 'Send the steps you changed');
    var seen = {};
    patches = list.map(function (p) {
      var n = p && v.intIn(p.step_no, 0, MAX_STEPS - 1);
      if (n === null || n === undefined) throw bad('steps', 'Invalid step number');
      if (seen[n]) throw bad('steps', 'A step was sent twice');
      seen[n] = true;
      return { n: n, p: p };
    });
    return self.db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [id, userId]);
  }).then(function (kids) {
    leaves = kids.length ? kids : [camp];
    if (leaves.some(function (l) { return l.status === 'completed'; }) || leaves.some(function (l) { return l.status === 'preparing'; })) {
      throw new AppError('conflict', 'A completed or still-preparing campaign cannot be edited', 409);
    }
    var all = [camp].concat(kids), t = self.now();
    return self.db.transaction(function (tx) {
      return stepProgress.lockedSteps(tx, userId, leaves.map(function (l) { return l.id; })).then(function (locked) {
        patches.forEach(function (x) { if (locked[x.n]) throw new AppError('conflict', 'Email ' + (x.n + 1) + ' has already been sent to some people and can no longer be edited', 409, { step: x.n }); });
        return tx.all('SELECT step_no, delay_days, subject, body_html FROM campaign_steps WHERE campaign_id = ?', [camp.id]);
      }).then(function (cur) {
        var byNo = {}; cur.forEach(function (r) { byNo[r.step_no] = r; });
        var merged = patches.map(function (x) {
          var old = byNo[x.n];
          if (!old) throw bad('steps', 'Step ' + (x.n + 1) + ' does not exist');
          var next = validateStep({ subject: x.p.subject !== undefined ? x.p.subject : old.subject, body_html: x.p.body_html !== undefined ? x.p.body_html : old.body_html,
            delay_days: x.p.delay_days !== undefined ? x.p.delay_days : old.delay_days }, x.n);
          return { n: x.n, next: next, deltaDays: next.delay_days - old.delay_days };
        });
        return merged.reduce(function (p, m) {
          return p.then(function () {
            return seq(all, function (c) {
              return tx.run('UPDATE campaign_steps SET subject = ?, body_html = ?, delay_days = ? WHERE campaign_id = ? AND step_no = ?', [m.next.subject, m.next.body_html, m.next.delay_days, c.id, m.n]);
            });
          }).then(function () {
            if (!m.deltaDays || m.n === 0) return null;
            // People who already got the previous email and now wait for this one.
            return seq(leaves, function (c) {
              return tx.run("UPDATE campaign_leads SET next_send_at = MAX(?, next_send_at + ?) WHERE campaign_id = ? AND current_step = ? AND status IN ('active','paused') AND next_send_at IS NOT NULL",
                [t, m.deltaDays * 86400000, c.id, m.n]);
            });
          });
        }, Promise.resolve()).then(function () {
          return tx.run('UPDATE campaigns SET updated_at = ? WHERE id = ?', [t, camp.id]);
        });
      });
    }).then(function () {
      return audit.log(self.db, { userId: userId, action: 'campaign.steps_edit', entity: 'campaign', entityId: id, ip: ip, meta: { steps: patches.map(function (x) { return x.n; }) } }, self.now);
    });
  }).then(function () { return self.get(userId, id); });
};

C.update = function (userId, id, input, ip) {
  var self = this, camp, parts, steps = null, senderIds = null, settings = null, name = null, live = false;
  return Promise.resolve().then(function () { return self._own(userId, id); }).then(function (c) {
    camp = c;
    if (c.parent_id) throw bad('id', 'Edit the main campaign, not a single part');
    input = input || {};
    if (input.name !== undefined) name = validateName(input.name);
    if (input.steps !== undefined) steps = validateSteps(input.steps);
    if (input.sender_ids !== undefined) {
      senderIds = v.idArray(input.sender_ids, 1, MAX_SENDERS);
      if (!senderIds) throw bad('sender_ids', 'Choose 1 to ' + MAX_SENDERS + ' sending accounts');
    }
    var hasSettings = ['window_start_hour', 'window_end_hour', 'utc_offset_min', 'weekdays_only', 'active_days', 'stop_on_reply', 'track_opens', 'start_date'].some(function (k) { return input[k] !== undefined; });
    if (hasSettings) settings = validateSettings(input, c, self.now());
    return self.db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [id, userId]);
  }).then(function (kids) {
    parts = kids;
    var leaves = kids.length ? kids : [camp];
    live = leaves.some(function (l) { return l.status !== 'draft'; });
    if (live && input.start_date !== undefined) throw new AppError('conflict', 'The start date can only be changed before the campaign has started', 409);
    if (steps && live) throw new AppError('conflict', 'Use the sequence editor to change emails of a running campaign', 409);
    // Senders and schedule may change while the campaign runs (paused or active); not once it is finished.
    if ((senderIds || settings) && leaves.some(function (l) { return l.status === 'completed' || l.status === 'preparing'; })) {
      throw new AppError('conflict', 'A finished or still-preparing campaign cannot be changed', 409);
    }
    return senderIds ? self._checkSenders(userId, senderIds).then(function () {
      if (!live) return null;
      return self.db.get('SELECT COUNT(*) AS n FROM senders WHERE user_id = ? AND status != \'active\' AND id IN (' + v.placeholders(senderIds.length) + ')', [userId].concat(senderIds)).then(function (r) {
        if (r.n) throw bad('sender_ids', 'A running campaign can only use active sending accounts. Activate it first or pick another.');
      });
    }) : null;
  }).then(function () {
    var t = self.now(), all = [camp].concat(parts);
    return self.db.transaction(function (tx) {
      var p = Promise.resolve();
      if (name) {
        p = p.then(function () { return tx.run('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?', [name, t, id]); })
          .then(function () { return seq(parts, function (k, i) { return tx.run('UPDATE campaigns SET name = ? WHERE id = ?', [name + ' - Part ' + (i + 1) + '/' + parts.length, k.id]); }); });
      }
      if (settings) {
        p = p.then(function () {
          return seq(all, function (c) {
            return tx.run('UPDATE campaigns SET window_start_hour = ?, window_end_hour = ?, utc_offset_min = ?, weekdays_only = ?, active_days = ?, stop_on_reply = ?, track_opens = ?, start_at = ?, priority_mode = ?, updated_at = ? WHERE id = ?',
              [settings.window_start_hour, settings.window_end_hour, settings.utc_offset_min, settings.weekdays_only, settings.active_days || null, settings.stop_on_reply, settings.track_opens, settings.start_at || null, settings.priority_mode || 'followups_first', t, c.id]);
          });
        });
      }
      if (steps) {
        p = p.then(function () {
          return seq(all, function (c) { return tx.run('DELETE FROM campaign_steps WHERE campaign_id = ?', [c.id]).then(function () { return insertSteps(tx, c.id, steps); }); });
        });
      }
      if (senderIds) {
        p = p.then(function () {
          return seq(all, function (c) { return tx.run('DELETE FROM campaign_senders WHERE campaign_id = ?', [c.id]).then(function () { return linkSenders(tx, c.id, senderIds); }); });
        }).then(function () { return live ? rebalanceLeads(tx, parts.length ? parts : [camp], senderIds) : null; });
      }
      return p.then(function () { return audit.log(tx, { userId: userId, action: 'campaign.update', entity: 'campaign', entityId: id, ip: ip, meta: { name: name, steps: !!steps, senders: !!senderIds, settings: !!settings } }, self.now); });
    });
  }).then(function () { return self.get(userId, id); });
};

// After the senders of a running campaign changed: only people who have not been emailed yet are spread over the new set.
// Dedicated sender ownership: once a person got Email 1 their sender owns the whole thread (follow-ups and replies), even if that
// sender is no longer in the campaign's list. The only exception is an owner that no longer exists at all (sender_id IS NULL).
function rebalanceLeads(tx, leaves, senderIds) {
  var n = senderIds.length, cases = senderIds.map(function (s, k) { return 'WHEN ' + k + ' THEN ?'; }).join(' ');
  return seq(leaves, function (leaf) {
    return tx.run("UPDATE campaign_leads SET sender_id = CASE (position % " + n + ') ' + cases + " END WHERE campaign_id = ? AND status IN ('pending','active','paused') AND (current_step = 0 OR sender_id IS NULL)", [].concat(senderIds, [leaf.id]));
  });
}

C.remove = function (userId, id, ip) {
  var self = this;
  return this._own(userId, id).then(function (c) {
    if (c.parent_id) throw bad('id', 'Delete the main campaign to remove its parts');
    return leavesOf(self.db, userId, c);
  }).then(function (leaves) {
    if (leaves.some(function (l) { return l.status === 'active'; })) throw new AppError('conflict', 'Pause the campaign before deleting it', 409);
    return self.db.run('DELETE FROM campaigns WHERE id = ? AND user_id = ?', [id, userId]);
  }).then(function () { return audit.log(self.db, { userId: userId, action: 'campaign.delete', entity: 'campaign', entityId: id, ip: ip }, self.now); });
};

// Batch actions on MAIN campaigns: { action: 'delete' | 'move', ids[], project_id | new_project_name }.
// Partial success is normal (a running campaign cannot be deleted): returns { done: [ids], failed: [{id, message}] }.
var MAX_BATCH = 200;
C.batch = function (userId, input, ip) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    if (input.action !== 'delete' && input.action !== 'move') throw bad('action', 'Choose delete or move');
    var ids = v.idArray(input.ids, 1, MAX_BATCH);
    if (!ids) throw bad('ids', 'Select between 1 and ' + MAX_BATCH + ' campaigns');
    ids = ids.filter(function (x, i) { return ids.indexOf(x) === i; });
    var res = { action: input.action, done: [], failed: [] };
    function each(fn) {
      return seq(ids, function (id) {
        return fn(id).then(function () { res.done.push(id); }, function (e) {
          if (!(e instanceof AppError)) throw e;
          res.failed.push({ id: id, message: e.message });
        });
      }).then(function () { return res; });
    }
    if (input.action === 'delete') return each(function (id) { return self.remove(userId, id, ip); });
    var target;
    if (input.project_id !== undefined && input.project_id !== null) {
      var pid = v.intIn(input.project_id, 1, 9007199254740991);
      if (pid === null) throw bad('project_id', 'Invalid project');
      target = self.db.get('SELECT id, archived FROM projects WHERE id = ? AND user_id = ?', [pid, userId]).then(function (p) {
        if (!p) throw bad('project_id', 'Project not found');
        if (p.archived) throw bad('project_id', 'This project is archived. Unarchive it first.');
        return p.id;
      });
    } else if (input.new_project_name !== undefined) {
      var nm = validateName(input.new_project_name), t = self.now();
      target = self.db.run('INSERT INTO projects (user_id, name, created_at, updated_at) VALUES (?,?,?,?)', [userId, nm, t, t]).then(function (r) { return r.lastID; });
    } else throw bad('project_id', 'Choose where to move the campaigns');
    return target.then(function (projectId) {
      res.project_id = projectId;
      return each(function (id) {
        return self._own(userId, id).then(function (c) {
          if (c.parent_id) throw bad('id', 'Move the main campaign, not one of its parts');
          if (c.project_id === projectId) return null;
          return self.db.run('UPDATE campaigns SET project_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', [projectId, self.now(), id, userId])
            .then(function () { return audit.log(self.db, { userId: userId, action: 'campaign.move', entity: 'campaign', entityId: id, ip: ip, meta: { from: c.project_id, to: projectId } }, self.now); });
        });
      });
    });
  });
};

// Archive / restore a main campaign (hides it from the Campaigns table; results and history are kept). Not while it is sending.
C.setArchived = function (userId, id, archived, ip) {
  var self = this;
  return this._own(userId, id).then(function (c) {
    if (c.parent_id) throw bad('id', 'Archive the main campaign, not a single part');
    var guard = archived ? self.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE (id = ? OR parent_id = ?) AND user_id = ? AND status IN ('active','preparing')", [id, id, userId]).then(function (r) {
      if (r.n) throw new AppError('conflict', 'Pause this campaign before archiving it', 409);
    }) : Promise.resolve();
    return guard.then(function () { return self.db.run('UPDATE campaigns SET archived = ?, updated_at = ? WHERE id = ? AND user_id = ?', [archived ? 1 : 0, self.now(), id, userId]); })
      .then(function () { return audit.log(self.db, { userId: userId, action: archived ? 'campaign.archive' : 'campaign.restore', entity: 'campaign', entityId: id, ip: ip }, self.now); });
  }).then(function () { return self.get(userId, id); });
};

// Duplicate a campaign as a new DRAFT in the same project: same emails, sending days/hours, accounts and people, nothing sent yet.
// A split campaign is copied as one unsplit draft (split again in the wizard if needed). Blocked addresses are not copied.
C.duplicate = function (userId, id, ip) {
  var self = this, t = this.now(), newId;
  return this._own(userId, id).then(function (c) {
    if (c.parent_id) throw bad('id', 'Duplicate the main campaign, not a single part');
    return Promise.all([
      self.db.all('SELECT step_no, delay_days, subject, body_html FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [id]),
      self.db.all('SELECT sender_id FROM campaign_senders WHERE campaign_id = ?', [id]),
      self.db.all('SELECT id FROM campaigns WHERE parent_id = ? AND user_id = ?', [id, userId])
    ]).then(function (r) {
      var leafIds = r[2].length ? r[2].map(function (x) { return x.id; }) : [id];
      return self.db.all('SELECT DISTINCT cl.lead_id AS lead_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id IN (' + v.placeholders(leafIds.length) + ') ' +
        'AND NOT EXISTS (SELECT 1 FROM suppression sp WHERE sp.user_id = l.user_id AND sp.email = l.email) ORDER BY cl.lead_id', leafIds).then(function (leads) {
        var name = (c.name.replace(/ - Part \d+\/\d+$/, '') + ' (copy)').slice(0, 100);
        return self.db.transaction(function (tx) {
          return tx.run('INSERT INTO campaigns (user_id, parent_id, project_id, name, status, window_start_hour, window_end_hour, utc_offset_min, weekdays_only, active_days, stop_on_reply, track_opens, priority_mode, created_at, updated_at) ' +
            "SELECT user_id, NULL, project_id, ?, 'draft', window_start_hour, window_end_hour, utc_offset_min, weekdays_only, active_days, stop_on_reply, track_opens, priority_mode, ?, ? FROM campaigns WHERE id = ? AND user_id = ?",
            [name, t, t, id, userId]).then(function (ins) {
            newId = ins.lastID;
            return insertSteps(tx, newId, r[0]);
          }).then(function () { return linkSenders(tx, newId, r[1].map(function (x) { return x.sender_id; })); })
            .then(function () { return insertLeads(tx, newId, leads.map(function (x) { return { id: x.lead_id }; })); })
            .then(function () { return audit.log(tx, { userId: userId, action: 'campaign.duplicate', entity: 'campaign', entityId: newId, ip: ip, meta: { from: id, leads: leads.length } }, self.now); });
        });
      });
    });
  }).then(function () { return self.get(userId, newId); });
};

// Wizard check: how many of the chosen leads lack a value for each {{variable}} that has no fallback.
// input: lead source (folder_id | lead_ids, same filters as create) + steps [{subject, body_html}].
// Who in the chosen audience is already in another campaign? Used by the wizard to ask [Remove] / [Continue anyway].
C.duplicates = function (userId, input) {
  var self = this;
  return Promise.resolve().then(function () {
    input = Object.assign({}, input || {}, { skip_in_active: false, exclude_duplicates: false });
    var src = parseLeadSource(input);
    return self._selectLeads(userId, src);
  }).then(function (rows) {
    var found = {}, order = [], total = rows.length;
    return seq(v.chunk(rows.map(function (r) { return r.id; }), 400), function (part) {
      return self.db.all('SELECT cl.lead_id, l.email, COALESCE(p.name, c.name) AS campaign FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id LEFT JOIN campaigns p ON p.id = c.parent_id ' +
        'JOIN leads l ON l.id = cl.lead_id WHERE c.user_id = ? AND cl.lead_id IN (' + v.placeholders(part.length) + ') ORDER BY cl.id', [userId].concat(part)).then(function (hits) {
        hits.forEach(function (x) {
          if (!found[x.lead_id]) { found[x.lead_id] = { email: x.email, campaigns: [] }; order.push(x.lead_id); }
          if (found[x.lead_id].campaigns.indexOf(x.campaign) === -1) found[x.lead_id].campaigns.push(x.campaign);
        });
      });
    }).then(function () {
      return { total: total, duplicates: order.length, samples: order.slice(0, 8).map(function (k) { return { email: found[k].email, campaigns: found[k].campaigns.slice(0, 3) }; }) };
    });
  });
};

C.variableCoverage = function (userId, input) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    var src = parseLeadSource(input);
    if (!Array.isArray(input.steps) || input.steps.length > MAX_STEPS) throw bad('steps', 'Invalid steps');
    var texts = input.steps.map(function (s) { s = s || {}; return { subject: String(s.subject || '').slice(0, 200), body: sanitize.clean(String(s.body_html || '').slice(0, 50000)) }; });
    return self._selectLeads(userId, src).then(function (rows) {
      var vars = {};
      texts.forEach(function (t) { tpl.findVariables(t.subject + ' ' + t.body).forEach(function (n) { vars[n] = 0; }); });
      var names = Object.keys(vars), res = { total: rows.length, variables: [], leads_affected: 0 };
      if (!names.length || !rows.length) return res;
      var affected = 0;
      return seq(v.chunk(rows.map(function (r) { return r.id; }), 500), function (chunk) {
        return self.db.all('SELECT email, domain, first_name, last_name, company, custom FROM leads WHERE user_id = ? AND id IN (' + v.placeholders(chunk.length) + ')', [userId].concat(chunk)).then(function (leads) {
          leads.forEach(function (l) {
            var vv = tpl.leadVars(l), hit = false, miss = {};
            texts.forEach(function (t) {
              tpl.render(t.subject, vv, { html: false }).missing.concat(tpl.render(t.body, vv, { html: true }).missing).forEach(function (n) { miss[n] = true; });
            });
            Object.keys(miss).forEach(function (n) { if (vars[n] !== undefined) vars[n]++; hit = true; });
            if (hit) affected++;
          });
        });
      }).then(function () {
        res.variables = names.map(function (n) { return { name: n, missing: vars[n] }; });
        res.leads_affected = affected;
        return res;
      });
    });
  });
};

// Render the first email (or any step) for a sample or real lead so the wizard can show a preview.
C.previewTemplate = function (userId, input) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    var subject = typeof input.subject === 'string' ? input.subject : '', body = typeof input.body_html === 'string' ? input.body_html : '';
    if (subject.length > 200 || body.length > 50000) throw bad('body_html', 'Template is too long');
    if (input.lead_id !== undefined && input.lead_id !== null) {
      var lid = v.intIn(input.lead_id, 1, 9007199254740991);
      if (lid === null) throw bad('lead_id', 'Invalid lead');
      return self.db.get('SELECT email, domain, first_name, last_name, company, custom FROM leads WHERE id = ? AND user_id = ?', [lid, userId]).then(function (l) {
        if (!l) throw new AppError('not_found', 'Lead not found', 404);
        return { vars: tpl.leadVars(l), sample: false };
      });
    }
    return { vars: tpl.leadVars(SAMPLE_LEAD), sample: true };
  }).then(function (ctx) {
    var rnd = require('../lib/split').mulberry32(7);
    var s = tpl.render(input.subject || '', ctx.vars, { html: false, rnd: rnd });
    var cleanBody = sanitize.clean(input.body_html || '');
    var b = tpl.render(cleanBody, ctx.vars, { html: true, rnd: rnd });
    var used = tpl.findVariables(String(input.subject || '') + ' ' + cleanBody);
    return { subject: s.text, body_html: b.text, variables: used, missing: s.missing.concat(b.missing.filter(function (m) { return s.missing.indexOf(m) === -1; })), sample: ctx.sample };
  });
};

require('./campaignLive').install(C, { bad: bad, seq: seq, validateStep: validateStep, MAX_STEPS: MAX_STEPS, CL_STATUSES: CL_STATUSES, leavesOf: leavesOf });

module.exports = { CampaignsService: CampaignsService, validateSteps: validateSteps, deriveStatus: deriveStatus };
