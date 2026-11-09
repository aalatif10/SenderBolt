'use strict';
// Projects: the top-level container the UI is organised around.
//   Project  ->  Campaigns (variants: own sequence, leads, senders, settings)  ->  Batches (Smart Split parts)
// Analytics roll up the same way: batch -> campaign -> project, so the project view is the sum of its
// campaigns and any campaign can be drilled into. Every query is scoped by user_id (foreign ids -> 404).
//
// Metric definitions (shown as tooltips in the UI):
//   emailed   leads that received at least one email (or whose address was rejected while sending)
//   replied   leads that wrote back (real replies only; out-of-office and bounces excluded)
//   bounced   leads whose address bounced / was rejected          unsubscribed  leads that opted out
//   rates     are percentages of `emailed`
//   opens     NOT tracked yet (opens: null, opens_tracked: false); the UI must say so, never show 0
var AppError = require('../lib/errors').AppError;
var v = require('../lib/validate');
var state = require('./campaignState');
var audit = require('./audit');

var SENTIMENTS = ['interested', 'more_info', 'not_interested', 'neutral'];

function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }
function hasControl(s) { for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; }
function cleanName(n) {
  var s = typeof n === 'string' ? n.trim() : '';
  if (!s || s.length > 100 || hasControl(s)) throw bad('name', 'Name is required (max 100 characters)');
  return s;
}
function cleanDesc(d) {
  if (d === undefined || d === null || d === '') return null;
  var s = typeof d === 'string' ? d.trim() : '';
  if (s.length > 500 || (s && hasControl(s.replace(/[\r\n\t]/g, '')))) throw bad('description', 'Description is too long (max 500 characters)');
  return s || null;
}
function pct(n, d) { return d ? Math.round(n / d * 1000) / 10 : 0; }

function emptyMetrics() { return { emailed: 0, replied: 0, interested: 0, more_info: 0, not_interested: 0, neutral: 0 }; }
function addMetrics(a, b) { Object.keys(a).forEach(function (k) { a[k] += b[k] || 0; }); return a; }

function ProjectsService(db, deps) {
  this.db = db;
  this.campaigns = deps.campaigns;      // reuse lead-status stats
  this.now = deps.now || Date.now;
}
var P = ProjectsService.prototype;

P._own = function (userId, id) {
  return this.db.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', [id, userId]).then(function (p) {
    if (!p) throw new AppError('not_found', 'Project not found', 404);
    return p;
  });
};

// Per-leaf-campaign reply/sentiment counts (leaf = a campaign that owns leads: a batch, or an unsplit campaign).
P._metrics = function (userId) {
  var out = {}, db = this.db;
  return db.all('SELECT cl.campaign_id AS cid, COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND (cl.status = \'bounced\' OR EXISTS ' +
    "(SELECT 1 FROM messages m WHERE m.campaign_lead_id = cl.id AND m.direction = 'out' AND m.status = 'sent' AND m.step_no IS NOT NULL)) GROUP BY cl.campaign_id", [userId]).then(function (rows) {
    rows.forEach(function (r) { out[r.cid] = emptyMetrics(); out[r.cid].emailed = r.n; });
    return db.all("SELECT cl.campaign_id AS cid, m.sentiment AS s, COUNT(*) AS n FROM (SELECT campaign_lead_id, MAX(id) AS mid FROM messages WHERE user_id = ? AND direction = 'in' AND kind = 'email' AND campaign_lead_id IS NOT NULL GROUP BY campaign_lead_id) x " +
      'JOIN messages m ON m.id = x.mid JOIN campaign_leads cl ON cl.id = x.campaign_lead_id GROUP BY cl.campaign_id, m.sentiment', [userId]);
  }).then(function (rows) {
    rows.forEach(function (r) {
      var m = out[r.cid] || (out[r.cid] = emptyMetrics());
      m.replied += r.n;
      m[SENTIMENTS.indexOf(r.s) !== -1 ? r.s : 'neutral'] += r.n;
    });
    return out;
  });
};

// Everything needed to describe the user's projects, loaded once (single-user scale; paginate before SaaS).
P._load = function (userId) {
  var self = this;
  return Promise.all([
    this.db.all('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId]),
    this.db.all('SELECT id, parent_id, project_id, name, status, created_at, updated_at FROM campaigns WHERE user_id = ? ORDER BY id', [userId]),
    this.campaigns._statsByCampaign(userId, null),
    this._metrics(userId)
  ]).then(function (r) {
    var kids = {}, mains = {};
    r[1].forEach(function (c) {
      if (c.parent_id) (kids[c.parent_id] = kids[c.parent_id] || []).push(c);
      else (mains[c.project_id] = mains[c.project_id] || []).push(c);
    });
    return { projects: r[0], mains: mains, kids: kids, stats: r[2], metrics: r[3], self: self };
  });
};

function leafIds(main, kids) { return (kids[main.id] && kids[main.id].length) ? kids[main.id] : [main]; }

function describeCampaign(main, L) {
  var leaves = leafIds(main, L.kids), s = null, m = emptyMetrics();
  leaves.forEach(function (c) {
    var cs = L.stats[c.id];
    s = s ? s : { total: 0, sent: 0, pending: 0, active: 0, replied: 0, completed: 0, bounced: 0, unsubscribed: 0, paused: 0, error: 0, next_send_at: null };
    if (cs) {
      Object.keys(s).forEach(function (k) { if (k !== 'next_send_at') s[k] += cs[k] || 0; });
      if (cs.next_send_at !== null && (s.next_send_at === null || cs.next_send_at < s.next_send_at)) s.next_send_at = cs.next_send_at;
    }
    if (L.metrics[c.id]) addMetrics(m, L.metrics[c.id]);
  });
  s = s || { total: 0, sent: 0, pending: 0, active: 0, replied: 0, completed: 0, bounced: 0, unsubscribed: 0, paused: 0, error: 0, next_send_at: null };
  var done = s.replied + s.completed + s.bounced + s.unsubscribed;
  var status = state.deriveStatus(main.status, L.kids[main.id] || []);
  return {
    id: main.id, name: main.name, status: status, created_at: main.created_at, batches: (L.kids[main.id] || []).length,
    leads: s.total, sent: s.sent, progress_pct: s.total ? Math.round(done / s.total * 1000) / 10 : 0, next_send_at: status === 'active' ? s.next_send_at : null,
    stats: s, metrics: m
  };
}

function rollUp(campaigns) {
  var t = { leads: 0, sent: 0, emailed: 0, replied: 0, interested: 0, more_info: 0, not_interested: 0, neutral: 0, bounced: 0, unsubscribed: 0, active: 0, completed: 0, error: 0, done: 0 };
  var next = null;
  campaigns.forEach(function (c) {
    t.leads += c.leads; t.sent += c.sent; t.bounced += c.stats.bounced; t.unsubscribed += c.stats.unsubscribed; t.active += c.stats.active; t.completed += c.stats.completed; t.error += c.stats.error;
    t.done += c.stats.replied + c.stats.completed + c.stats.bounced + c.stats.unsubscribed;
    ['emailed', 'replied', 'interested', 'more_info', 'not_interested', 'neutral'].forEach(function (k) { t[k] += c.metrics[k]; });
    if (c.next_send_at !== null && (next === null || c.next_send_at < next)) next = c.next_send_at;
  });
  return {
    leads: t.leads, sent: t.sent, emailed: t.emailed, replied: t.replied, bounced: t.bounced, unsubscribed: t.unsubscribed, active: t.active, completed: t.completed, errors: t.error,
    sentiment: { interested: t.interested, more_info: t.more_info, not_interested: t.not_interested, neutral: t.neutral },
    reply_rate: pct(t.replied, t.emailed), bounce_rate: pct(t.bounced, t.emailed), unsubscribe_rate: pct(t.unsubscribed, t.emailed),
    opens: null, opens_tracked: false, progress_pct: t.leads ? Math.round(t.done / t.leads * 1000) / 10 : 0, next_send_at: next
  };
}

function describeProject(p, L) {
  var camps = (L.mains[p.id] || []).map(function (m) { return describeCampaign(m, L); });
  var status = camps.length ? state.deriveStatus('draft', camps) : 'empty';
  var totals = rollUp(camps);
  return { id: p.id, name: p.name, description: p.description, archived: !!p.archived, created_at: p.created_at, status: status,
    campaign_count: camps.length, totals: totals, campaigns: camps };
}

P.list = function (userId, q) {
  q = q || {};
  var archived = q.archived === '1' || q.archived === 1 || q.archived === true;
  var search = q.q ? String(q.q).trim().slice(0, 100).toLowerCase() : '';
  return this._load(userId).then(function (L) {
    var rows = L.projects.filter(function (p) { return !!p.archived === archived && (!search || p.name.toLowerCase().indexOf(search) !== -1); })
      .map(function (p) { var d = describeProject(p, L); delete d.campaigns; return d; });   // list stays light: campaigns come with the detail call
    var counts = { active: 0, paused: 0, completed: 0, draft: 0, error: 0, empty: 0 };
    rows.forEach(function (r) { var k = r.status === 'preparing' ? 'draft' : r.status; if (counts[k] !== undefined) counts[k]++; });
    var overall = { projects: rows.length, emailed: 0, replied: 0, bounced: 0, sent: 0 };
    rows.forEach(function (r) { overall.emailed += r.totals.emailed; overall.replied += r.totals.replied; overall.bounced += r.totals.bounced; overall.sent += r.totals.sent; });
    return { items: rows, counts: counts, overall: overall };
  });
};

P.get = function (userId, id) {
  var self = this;
  return this._own(userId, id).then(function (p) {
    return self._load(userId).then(function (L) { return describeProject(p, L); });
  });
};

// Drill-down: one campaign with its batches and a per-step sending funnel.
P.campaignAnalytics = function (userId, campaignId) {
  var self = this;
  return this.db.get('SELECT * FROM campaigns WHERE id = ? AND user_id = ? AND parent_id IS NULL', [campaignId, userId]).then(function (main) {
    if (!main) throw new AppError('not_found', 'Campaign not found', 404);
    return self._load(userId).then(function (L) {
      var camp = describeCampaign(main, L), leaves = leafIds(main, L.kids);
      var batches = (L.kids[main.id] || []).map(function (b) {
        var one = describeCampaign(b, { kids: {}, stats: L.stats, metrics: L.metrics });
        one.batches = 0; return one;
      });
      return self.db.all("SELECT m.step_no AS step, COUNT(*) AS sent FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND m.direction = 'out' AND m.status = 'sent' AND m.step_no IS NOT NULL AND cl.campaign_id IN (" +
        v.placeholders(leaves.length) + ') GROUP BY m.step_no ORDER BY m.step_no', [userId].concat(leaves.map(function (l) { return l.id; }))).then(function (steps) {
        return self.db.get('SELECT project_id FROM campaigns WHERE id = ?', [main.id]).then(function (pj) {
          var totals = rollUp([camp]);
          return { campaign: camp, project_id: pj.project_id, totals: totals, batches: batches, steps: steps };
        });
      });
    });
  });
};

P.create = function (userId, input, ip) {
  var self = this;
  return Promise.resolve().then(function () {
    input = input || {};
    var name = cleanName(input.name), desc = cleanDesc(input.description), t = self.now();
    return self.db.run('INSERT INTO projects (user_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)', [userId, name, desc, t, t]).then(function (r) {
      return audit.log(self.db, { userId: userId, action: 'project.create', entity: 'project', entityId: r.lastID, ip: ip, meta: { name: name } }, self.now).then(function () { return r.lastID; });
    });
  }).then(function (id) { return self.get(userId, id); });
};

P.update = function (userId, id, input, ip) {
  var self = this;
  return this._own(userId, id).then(function (p) {
    input = input || {};
    var name = p.name, desc = p.description, archived = p.archived;
    if (input.name !== undefined) name = cleanName(input.name);
    if (input.description !== undefined) desc = cleanDesc(input.description);
    if (input.archived !== undefined) archived = input.archived ? 1 : 0;
    var guard = archived && !p.archived
      ? self.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE project_id = ? AND user_id = ? AND status IN ('active','preparing')", [id, userId]).then(function (r) {
        if (r.n) throw new AppError('conflict', 'Pause the active campaigns before archiving this project', 409);
      }) : Promise.resolve();
    return guard.then(function () {
      return self.db.run('UPDATE projects SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ? AND user_id = ?', [name, desc, archived, self.now(), id, userId]);
    }).then(function () { return audit.log(self.db, { userId: userId, action: 'project.update', entity: 'project', entityId: id, ip: ip, meta: { archived: archived } }, self.now); });
  }).then(function () { return self.get(userId, id); });
};

// Deletes the project AND its campaigns (batches cascade). Refused while anything is sending.
P.remove = function (userId, id, ip) {
  var self = this;
  return this._own(userId, id).then(function () {
    return self.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ? AND (project_id = ? OR parent_id IN (SELECT id FROM campaigns WHERE project_id = ? AND user_id = ?)) AND status = 'active'", [userId, id, id, userId]);
  }).then(function (r) {
    if (r.n) throw new AppError('conflict', 'Pause the project\'s campaigns before deleting it', 409);
    return self.db.transaction(function (tx) {
      return tx.run('DELETE FROM campaigns WHERE project_id = ? AND user_id = ?', [id, userId])
        .then(function () { return tx.run('DELETE FROM projects WHERE id = ? AND user_id = ?', [id, userId]); })
        .then(function () { return audit.log(tx, { userId: userId, action: 'project.delete', entity: 'project', entityId: id, ip: ip }, self.now); });
    });
  }).then(function () { return { ok: true }; });
};

module.exports = { ProjectsService: ProjectsService };
