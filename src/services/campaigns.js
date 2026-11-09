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
var state = require('./campaignState');

var MAX_LEADS = 50000, MAX_PARTS = 500, MAX_STEPS = 6, MAX_SENDERS = 20;
var DEFAULT_LEAD_STATUSES = ['valid', 'unverified', 'risky', 'catch_all'];
var LEAD_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'risky'];
var CL_STATUSES = ['pending', 'active', 'replied', 'completed', 'bounced', 'unsubscribed', 'paused', 'error'];
var DONE_STATUSES = ['replied', 'completed', 'bounced', 'unsubscribed'];
var FILTERS = { all: null, active: ['active'], paused: ['paused'], completed: ['completed'], draft: ['draft', 'preparing'], error: ['error'] };
var SAMPLE_LEAD = { first_name: 'Alex', last_name: 'Morgan', company: 'Acme Domains', email: 'alex@acme-domains.com', domain: 'acme-domains.com' };

function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }
function seq(items, fn) { return items.reduce(function (p, it, i) { return p.then(function () { return fn(it, i); }); }, Promise.resolve()); }

// ---------- validation ----------
function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw bad('steps', 'A sequence needs 1 to ' + MAX_STEPS + ' emails (the first email plus up to 5 follow-ups)');
  return steps.map(function (s, i) {
    if (!s || typeof s !== 'object') throw bad('steps', 'Step ' + (i + 1) + ' is invalid');
    var subject = typeof s.subject === 'string' ? s.subject.trim() : '';
    if (text.hasControl(subject) || subject.length > 200) throw bad('steps', 'Step ' + (i + 1) + ': subject must be one line, max 200 characters');
    if (i === 0 && !subject) throw bad('steps', 'The first email needs a subject');
    var body = typeof s.body_html === 'string' ? s.body_html : '';
    if (!body.trim() || body.length > 50000) throw bad('steps', 'Step ' + (i + 1) + ': body is required (max 50,000 characters)');
    var delay = 0;
    if (i > 0) {
      delay = s.delay_days === undefined ? 3 : v.intIn(s.delay_days, 1, 60);
      if (delay === null) throw bad('steps', 'Step ' + (i + 1) + ': wait time must be 1 to 60 days');
    }
    return { step_no: i, delay_days: delay, subject: subject, body_html: body };
  });
}

function validateSettings(input, base) {
  var o = Object.assign({ window_start_hour: 9, window_end_hour: 17, utc_offset_min: 0, weekdays_only: 1, stop_on_reply: 1, track_opens: 0 }, base || {});
  var has = function (k) { return input && Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined; };
  if (has('window_start_hour')) { o.window_start_hour = v.intIn(input.window_start_hour, 0, 23); if (o.window_start_hour === null) throw bad('window_start_hour', 'Start hour must be 0-23'); }
  if (has('window_end_hour')) { o.window_end_hour = v.intIn(input.window_end_hour, 1, 24); if (o.window_end_hour === null) throw bad('window_end_hour', 'End hour must be 1-24'); }
  if (o.window_end_hour <= o.window_start_hour) throw bad('window_end_hour', 'End hour must be after the start hour');
  if (has('utc_offset_min')) { o.utc_offset_min = v.intIn(input.utc_offset_min, -720, 840); if (o.utc_offset_min === null) throw bad('utc_offset_min', 'Invalid time zone offset'); }
  ['weekdays_only', 'stop_on_reply', 'track_opens'].forEach(function (k) { if (has(k)) o[k] = input[k] ? 1 : 0; });
  return o;
}

function validateName(n) {
  var name = text.cleanText(n, 120);
  if (!name) throw bad('name', 'Campaign name is required (max 120 characters)');
  return name;
}

function parseLeadSource(input) {
  var out = { statuses: DEFAULT_LEAD_STATUSES, excludeRole: !!input.exclude_role, skipInActive: input.skip_in_active !== false };
  if (input.lead_statuses !== undefined) {
    if (!Array.isArray(input.lead_statuses) || !input.lead_statuses.length || input.lead_statuses.some(function (s) { return LEAD_STATUSES.indexOf(s) === -1; })) throw bad('lead_statuses', 'Invalid lead status filter');
    out.statuses = input.lead_statuses;
  }
  if (input.folder_id !== undefined && input.folder_id !== null) {
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
  var cols = 'SELECT l.id, l.email, l.domain FROM leads l WHERE ';
  var p;
  if (src.folderId) {
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
var CAMPAIGN_COLS = 'user_id, parent_id, name, status, split_seed, batch_size, window_start_hour, window_end_hour, utc_offset_min, weekdays_only, stop_on_reply, track_opens, created_at, updated_at';
function insertCampaign(tx, userId, parentId, name, status, seed, batchSize, s, t) {
  return tx.run('INSERT INTO campaigns (' + CAMPAIGN_COLS + ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, parentId, name, status, seed, batchSize, s.window_start_hour, s.window_end_hour, s.utc_offset_min, s.weekdays_only, s.stop_on_reply, s.track_opens, t, t]).then(function (r) { return r.lastID; });
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
    var name = validateName(input.name), steps = validateSteps(input.steps), settings = validateSettings(input, null);
    var senderIds = v.idArray(input.sender_ids, 1, MAX_SENDERS);
    if (!senderIds) throw bad('sender_ids', 'Choose 1 to ' + MAX_SENDERS + ' sending accounts');
    return self._checkSenders(userId, senderIds).then(function () {
      return self._plan(userId, input, input.split || null);
    }).then(function (plan) {
      var t = self.now();
      return self.db.transaction(function (tx) {
        var mainId;
        return insertCampaign(tx, userId, null, name, 'draft', plan.seed, plan.batchSize, settings, t).then(function (id) {
          mainId = id;
          return insertSteps(tx, mainId, steps);
        }).then(function () { return linkSenders(tx, mainId, senderIds); }).then(function () {
          if (!plan.isSplit) return insertLeads(tx, mainId, plan.batches[0]);
          return seq(plan.batches, function (batch, i) {
            var partName = name + ' - Part ' + (i + 1) + '/' + plan.batches.length, pid;
            return insertCampaign(tx, userId, mainId, partName, 'draft', plan.seed, plan.batchSize, settings, t).then(function (id) {
              pid = id;
              return insertSteps(tx, pid, steps);
            }).then(function () { return linkSenders(tx, pid, senderIds); }).then(function () { return insertLeads(tx, pid, batch); });
          });
        }).then(function () {
          return audit.log(tx, { userId: userId, action: 'campaign.create', entity: 'campaign', entityId: mainId, ip: ip,
            meta: { name: name, leads: plan.leads.length, parts: plan.isSplit ? plan.batches.length : 0, steps: steps.length } }, self.now);
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
  var s = { total: 0, sent: 0, done: 0, progress_pct: 0, next_send_at: null };
  CL_STATUSES.forEach(function (k) { s[k] = 0; });
  return s;
}
function addStats(a, b) {
  CL_STATUSES.concat(['total', 'sent']).forEach(function (k) { a[k] += b[k]; });
  if (b.next_send_at !== null && (a.next_send_at === null || b.next_send_at < a.next_send_at)) a.next_send_at = b.next_send_at;
  return a;
}
function finishStats(s) {
  s.done = DONE_STATUSES.reduce(function (n, k) { return n + s[k]; }, 0);
  s.progress_pct = s.total ? Math.round(s.done / s.total * 1000) / 10 : 0;
  return s;
}
var deriveStatus = state.deriveStatus;

// Per-campaign stats for the user. (Single-user scale; add pagination before SaaS scale.)
C._statsByCampaign = function (userId, onlyIds) {
  var self = this, out = {};
  var filter = onlyIds ? ' AND cl.campaign_id IN (' + v.placeholders(onlyIds.length) + ')' : '';
  var params = onlyIds ? [userId].concat(onlyIds) : [userId];
  var sums = CL_STATUSES.map(function (k) { return "COALESCE(SUM(CASE WHEN cl.status = '" + k + "' THEN 1 ELSE 0 END), 0) AS " + k; }).join(', ');
  return this.db.all('SELECT cl.campaign_id AS cid, COUNT(*) AS total, ' + sums + ', MIN(CASE WHEN cl.status = \'active\' AND c.status = \'active\' THEN cl.next_send_at END) AS next_send_at ' +
    'FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ?' + filter + ' GROUP BY cl.campaign_id', params).then(function (rows) {
    rows.forEach(function (r) {
      var s = emptyStats();
      CL_STATUSES.forEach(function (k) { s[k] = Number(r[k]); });
      s.total = Number(r.total); s.next_send_at = r.next_send_at === null ? null : Number(r.next_send_at);
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
  return { id: c.id, parent_id: c.parent_id, name: c.name, status: c.status, created_at: c.created_at, updated_at: c.updated_at,
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
    var search = q.q ? String(q.q).trim().slice(0, 100) : '';
    return Promise.all([
      self.db.all('SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5000', [userId]),
      self._statsByCampaign(userId, null),
      self.db.all('SELECT cs.campaign_id AS cid, cs.sender_id AS sid FROM campaign_senders cs JOIN campaigns c ON c.id = cs.campaign_id WHERE c.user_id = ?', [userId])
    ]).then(function (res) {
      var all = res[0], stats = res[1], links = {};
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
        row.parts = parts.map(function (p) { return summarize(p, stats[p.id], links[p.id]); });
        return row;
      });
      if (search) { var needle = search.toLowerCase(); rows = rows.filter(function (r) { return r.name.toLowerCase().indexOf(needle) !== -1; }); }
      if (senderFilter) rows = rows.filter(function (r) { return r.sender_ids.indexOf(senderFilter) !== -1; });
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
    return self._statsByCampaign(userId, ids).then(function (stats) {
      var agg = emptyStats();
      (parts.length ? parts : [camp]).forEach(function (c) { addStats(agg, stats[c.id] || emptyStats()); });
      finishStats(agg);
      var senders = res[2];
      var out = {
        id: camp.id, parent_id: camp.parent_id, name: camp.name, status: deriveStatus(camp.status, parts),
        created_at: camp.created_at, updated_at: camp.updated_at, split_seed: camp.split_seed, batch_size: camp.batch_size,
        settings: { window_start_hour: camp.window_start_hour, window_end_hour: camp.window_end_hour, utc_offset_min: camp.utc_offset_min,
          weekdays_only: camp.weekdays_only, stop_on_reply: camp.stop_on_reply, track_opens: camp.track_opens },
        steps: res[1], senders: senders, stats: agg, is_split: parts.length > 0,
        parts: parts.map(function (p) { var s = summarize(p, stats[p.id], null); delete s.sender_ids; return s; })
      };
      return out;
    });
  });
};

C.listLeads = function (userId, id, q) {
  var self = this;
  q = q || {};
  return this._own(userId, id).then(function () {
    return self.db.all('SELECT id FROM campaigns WHERE parent_id = ? AND user_id = ?', [id, userId]);
  }).then(function (kids) {
    var ids = kids.length ? kids.map(function (k) { return k.id; }) : [id];
    var where = 'cl.campaign_id IN (' + v.placeholders(ids.length) + ')', params = ids.slice();
    if (q.status && q.status !== 'all') {
      if (CL_STATUSES.indexOf(q.status) === -1) throw bad('status', 'Invalid status');
      where += ' AND cl.status = ?'; params.push(q.status);
    }
    var page = Math.max(1, parseInt(q.page, 10) || 1), size = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 50));
    return self.db.get('SELECT COUNT(*) AS c FROM campaign_leads cl WHERE ' + where, params).then(function (tot) {
      return self.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.current_step, cl.next_send_at, cl.last_sent_at, l.email, l.first_name, l.last_name, l.company, s.email AS sender_email ' +
        'FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN senders s ON s.id = cl.sender_id WHERE ' + where +
        ' ORDER BY cl.campaign_id, cl.position LIMIT ? OFFSET ?', params.concat([size, (page - 1) * size]))
        .then(function (items) { return { items: items, total: tot.c, page: page, pageSize: size }; });
    });
  });
};

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
        return tx.run("UPDATE campaign_leads SET status = 'unsubscribed' WHERE campaign_id = ? AND status = 'pending' AND lead_id IN " +
          '(SELECT l.id FROM leads l JOIN suppression s ON s.user_id = l.user_id AND s.email = l.email WHERE l.user_id = ?)', [leaf.id, userId]).then(function () {
          return tx.run("UPDATE campaign_leads SET sender_id = CASE (position % " + n + ') ' + cases + " END, status = 'active', next_send_at = ? WHERE campaign_id = ? AND status = 'pending'",
            sids.concat([t, leaf.id]));
        }).then(function () { return tx.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [t, leaf.id]); });
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

C.update = function (userId, id, input, ip) {
  var self = this, camp, parts, steps = null, senderIds = null, settings = null, name = null;
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
    var hasSettings = ['window_start_hour', 'window_end_hour', 'utc_offset_min', 'weekdays_only', 'stop_on_reply', 'track_opens'].some(function (k) { return input[k] !== undefined; });
    if (hasSettings) settings = validateSettings(input, c);
    return self.db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [id, userId]);
  }).then(function (kids) {
    parts = kids;
    var leaves = kids.length ? kids : [camp];
    if ((steps || senderIds || settings) && leaves.some(function (l) { return l.status !== 'draft'; })) {
      throw new AppError('conflict', 'Sequence, senders and settings can only be changed while the campaign is a draft', 409);
    }
    return senderIds ? self._checkSenders(userId, senderIds) : null;
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
            return tx.run('UPDATE campaigns SET window_start_hour = ?, window_end_hour = ?, utc_offset_min = ?, weekdays_only = ?, stop_on_reply = ?, track_opens = ?, updated_at = ? WHERE id = ?',
              [settings.window_start_hour, settings.window_end_hour, settings.utc_offset_min, settings.weekdays_only, settings.stop_on_reply, settings.track_opens, t, c.id]);
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
        });
      }
      return p.then(function () { return audit.log(tx, { userId: userId, action: 'campaign.update', entity: 'campaign', entityId: id, ip: ip, meta: { name: name, steps: !!steps, senders: !!senderIds, settings: !!settings } }, self.now); });
    });
  }).then(function () { return self.get(userId, id); });
};

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
    var b = tpl.render(input.body_html || '', ctx.vars, { html: true, rnd: rnd });
    var used = tpl.findVariables(String(input.subject || '') + ' ' + String(input.body_html || ''));
    return { subject: s.text, body_html: b.text, variables: used, missing: s.missing.concat(b.missing.filter(function (m) { return s.missing.indexOf(m) === -1; })), sample: ctx.sample };
  });
};

module.exports = { CampaignsService: CampaignsService, validateSteps: validateSteps, deriveStatus: deriveStatus };
