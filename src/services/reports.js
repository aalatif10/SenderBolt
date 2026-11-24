'use strict';
// Reports & open drill-down (src/services/reports.js)
//
//   overview(userId, q)  -> everything the Reports page draws, for a date range and an optional campaign / sender filter:
//     totals (+ change against the previous period of equal length), cohort funnel, daily series, per-step replies,
//     sentiment split, campaign leaderboard, per-sender performance, replies by weekday.
//   opens(userId, campaignId, q) -> who opened what: one row per recipient with open count and last-opened time.
//
// Definitions (shown as tooltips in the UI):
//   * Funnel is a COHORT: people whose first email went out inside the range, and what happened to them afterwards.
//   * Series are EVENTS: emails sent / replies received on each day in the range.
//   * "Opened" only counts when open tracking was switched on for the campaign; an open is an estimate (mail apps that
//     pre-load images inflate it), which the UI says plainly.
// Every query is scoped by user_id and uses bound parameters; the campaign filter is resolved to a set of ids first.
var AppError = require('../lib/errors').AppError;
var v = require('../lib/validate');

var DAY = 86400000;
var MAX_RANGE_DAYS = 366;

function ratio(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function dayKey(ms, offMin) { return new Date(ms + offMin * 60000).toISOString().slice(0, 10); }

function ReportsService(db, deps) { this.db = db; this.now = (deps && deps.now) || Date.now; }

// q: { days (7..366, default 30) | from,to (ms), campaign_id, sender_id, tz (minutes offset) }
ReportsService.prototype._range = function (q) {
  q = q || {};
  var off = v.intIn(q.tz, -720, 840); if (off === null) off = 0;
  var days = v.intIn(q.days, 1, MAX_RANGE_DAYS); if (days === null) days = 30;
  // Day boundaries follow the viewer's own clock so "today" is the viewer's today.
  var t = this.now();
  var endDay = Math.floor((t + off * 60000) / DAY) * DAY - off * 60000 + DAY;   // start of tomorrow (exclusive end)
  var to = endDay, from = endDay - days * DAY;
  return { from: from, to: to, days: days, off: off, prevFrom: from - days * DAY };
};

// Campaign ids (main + parts) the filter covers, or null for "all".
ReportsService.prototype._scope = function (userId, campaignId) {
  if (campaignId === undefined || campaignId === null || campaignId === '') return Promise.resolve(null);
  var id = v.intIn(campaignId, 1, 9007199254740991);
  if (id === null) return Promise.reject(new AppError('validation', 'Choose a valid campaign.', 400));
  return this.db.all('SELECT id FROM campaigns WHERE user_id = ? AND (id = ? OR parent_id = ?)', [userId, id, id]).then(function (rows) {
    if (!rows.length) throw new AppError('not_found', 'Campaign not found.', 404);
    return rows.map(function (r) { return r.id; });
  });
};

ReportsService.prototype.overview = function (userId, q) {
  var self = this, db = this.db, R = this._range(q), senderId = null;
  if (q && q.sender_id !== undefined && q.sender_id !== '') {
    senderId = v.intIn(q.sender_id, 1, 9007199254740991);
    if (senderId === null) return Promise.reject(new AppError('validation', 'Choose a valid sender.', 400));
  }
  return this._scope(userId, q && q.campaign_id).then(function (ids) {
    // Shared filter fragments. "m" = messages, "cl" = campaign_leads.
    var fm = '', fp = [];
    if (ids) { fm += ' AND cl.campaign_id IN (' + v.placeholders(ids.length) + ')'; fp = fp.concat(ids); }
    if (senderId) { fm += ' AND m.sender_id = ?'; fp.push(senderId); }
    var base = ' FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ?' + fm;

    function sentIn(a, b) {
      return db.get("SELECT COUNT(*) AS sent, SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END) AS opened" + base +
        " AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ? AND m.sent_at < ?", [userId].concat(fp, [a, b]));
    }
    function repliesIn(a, b) {
      return db.get("SELECT COUNT(DISTINCT m.campaign_lead_id) AS replied, SUM(CASE WHEN m.sentiment = 'interested' THEN 1 ELSE 0 END) AS interested" + base +
        " AND m.direction = 'in' AND m.kind = 'email' AND m.received_at >= ? AND m.received_at < ?", [userId].concat(fp, [a, b]));
    }
    function bouncesIn(a, b) {
      return db.get("SELECT COUNT(DISTINCT m.campaign_lead_id) AS bounced" + base +
        " AND m.direction = 'in' AND m.kind = 'bounce' AND m.received_at >= ? AND m.received_at < ?", [userId].concat(fp, [a, b]));
    }
    function totals(a, b) {
      return Promise.all([sentIn(a, b), repliesIn(a, b), bouncesIn(a, b),
        db.get("SELECT COUNT(DISTINCT cl.id) AS leads" + base + " AND m.direction = 'out' AND m.status = 'sent' AND m.step_no = 0 AND m.sent_at >= ? AND m.sent_at < ?", [userId].concat(fp, [a, b]))
      ]).then(function (r) {
        return { sent: Number(r[0].sent) || 0, opened: Number(r[0].opened) || 0, replied: Number(r[1].replied) || 0,
          interested: Number(r[1].interested) || 0, bounced: Number(r[2].bounced) || 0, contacted: Number(r[3].leads) || 0 };
      });
    }

    // Cohort funnel: people whose step-0 email was sent in range.
    var cohortSql = "SELECT cl.id AS id, cl.status AS status, cl.current_step AS cur FROM campaign_leads cl WHERE cl.id IN (" +
      "SELECT m.campaign_lead_id" + base + " AND m.direction = 'out' AND m.status = 'sent' AND m.step_no = 0 AND m.sent_at >= ? AND m.sent_at < ?)";

    return Promise.all([
      totals(R.from, R.to),
      totals(R.prevFrom, R.from),
      db.all("SELECT m.sent_at AS t, m.open_count AS oc" + base + " AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ? AND m.sent_at < ?", [userId].concat(fp, [R.from, R.to])),
      db.all("SELECT m.received_at AS t, m.kind AS kind, m.sentiment AS s" + base + " AND m.direction = 'in' AND m.kind IN ('email','bounce') AND m.received_at >= ? AND m.received_at < ?", [userId].concat(fp, [R.from, R.to])),
      db.all(cohortSql, [userId].concat(fp, [R.from, R.to])),
      db.all("SELECT m.step_no AS step, COUNT(*) AS sent, SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END) AS opened" + base +
        " AND m.direction = 'out' AND m.status = 'sent' AND m.step_no IS NOT NULL AND m.sent_at >= ? AND m.sent_at < ? GROUP BY m.step_no ORDER BY m.step_no", [userId].concat(fp, [R.from, R.to])),
      // Which step did people reply to: the latest email sent to the lead before the reply.
      db.all("SELECT rep.id AS id, (SELECT o.step_no FROM messages o WHERE o.campaign_lead_id = rep.campaign_lead_id AND o.direction = 'out' AND o.status = 'sent' AND o.step_no IS NOT NULL AND o.sent_at <= rep.received_at ORDER BY o.sent_at DESC LIMIT 1) AS step" +
        " FROM messages rep JOIN campaign_leads cl ON cl.id = rep.campaign_lead_id WHERE rep.user_id = ? AND rep.direction = 'in' AND rep.kind = 'email' AND rep.received_at >= ? AND rep.received_at < ?" +
        (ids ? ' AND cl.campaign_id IN (' + v.placeholders(ids.length) + ')' : '') + (senderId ? ' AND rep.sender_id = ?' : ''),
        [userId, R.from, R.to].concat(ids || [], senderId ? [senderId] : []))
    ]).then(function (r) {
      var cur = r[0], prev = r[1];
      // Daily series
      var series = [], idx = {}, i;
      for (i = 0; i < R.days; i++) { var dk = dayKey(R.from + i * DAY, R.off); idx[dk] = i; series.push({ date: dk, sent: 0, opened: 0, replied: 0, bounced: 0 }); }
      r[2].forEach(function (m) { var s = series[idx[dayKey(m.t, R.off)]]; if (s) { s.sent++; if (m.oc > 0) s.opened++; } });
      var sent = { interested: 0, more_info: 0, not_interested: 0, neutral: 0, out_of_office: 0, unclassified: 0 };
      var weekday = [0, 0, 0, 0, 0, 0, 0];
      r[3].forEach(function (m) {
        var s = series[idx[dayKey(m.t, R.off)]];
        if (m.kind === 'bounce') { if (s) s.bounced++; return; }
        if (s) s.replied++;
        sent[m.s && sent.hasOwnProperty(m.s) ? m.s : 'unclassified']++;
        weekday[new Date(m.t + R.off * 60000).getUTCDay()]++;
      });
      // Funnel
      var cohort = r[4], f = { contacted: cohort.length, followed_up: 0, replied: 0, interested: 0, bounced: 0, opted_out: 0, stopped: 0, still_running: 0 };
      cohort.forEach(function (c) {
        if (c.cur > 1) f.followed_up++;
        if (c.status === 'replied') f.replied++;
        else if (c.status === 'bounced') f.bounced++;
        else if (c.status === 'unsubscribed') f.opted_out++;
        else if (c.status === 'stopped') f.stopped++;
        else if (c.status === 'pending' || c.status === 'active' || c.status === 'paused') f.still_running++;
      });
      var cohortIds = cohort.map(function (c) { return c.id; });
      var pInterested = cohortIds.length ? Promise.all(v.chunk(cohortIds, 400).map(function (part) {
        return db.get("SELECT COUNT(DISTINCT campaign_lead_id) AS n FROM messages WHERE user_id = ? AND direction = 'in' AND kind = 'email' AND sentiment = 'interested' AND campaign_lead_id IN (" + v.placeholders(part.length) + ')', [userId].concat(part));
      })).then(function (rows) { return rows.reduce(function (a, x) { return a + Number(x.n); }, 0); }) : Promise.resolve(0);

      // Replies per step
      var perStep = {}; r[6].forEach(function (x) { if (x.step !== null) perStep[x.step] = (perStep[x.step] || 0) + 1; });
      var steps = r[5].map(function (s) {
        return { step: s.step, sent: Number(s.sent), opened: Number(s.opened) || 0, replied: perStep[s.step] || 0,
          open_rate: ratio(Number(s.opened) || 0, Number(s.sent)), reply_rate: ratio(perStep[s.step] || 0, Number(s.sent)) };
      });

      return pInterested.then(function (interestedLeads) {
        f.interested = interestedLeads;
        // Leaderboard + senders (only when not already narrowed so far as one campaign / sender).
        var lbSql = "SELECT COALESCE(c.parent_id, c.id) AS root, COUNT(*) AS sent, SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END) AS opened" +
          " FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id JOIN campaigns c ON c.id = cl.campaign_id WHERE m.user_id = ?" + fm +
          " AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ? AND m.sent_at < ? GROUP BY root";
        var lbRep = "SELECT COALESCE(c.parent_id, c.id) AS root, COUNT(DISTINCT m.campaign_lead_id) AS replied FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id JOIN campaigns c ON c.id = cl.campaign_id WHERE m.user_id = ?" + fm +
          " AND m.direction = 'in' AND m.kind = 'email' AND m.received_at >= ? AND m.received_at < ? GROUP BY root";
        var sdSql = "SELECT m.sender_id AS sid, COUNT(*) AS sent, SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END) AS opened" + base +
          " AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ? AND m.sent_at < ? GROUP BY m.sender_id";
        var sdRep = "SELECT m.sender_id AS sid, COUNT(DISTINCT m.campaign_lead_id) AS replied, SUM(CASE WHEN m.kind = 'bounce' THEN 1 ELSE 0 END) AS bounces" + base +
          " AND m.direction = 'in' AND m.kind IN ('email','bounce') AND m.received_at >= ? AND m.received_at < ? GROUP BY m.sender_id";
        var args = [userId].concat(fp, [R.from, R.to]);
        return Promise.all([db.all(lbSql, args), db.all(lbRep, args), db.all(sdSql, args), db.all(sdRep, args),
          db.all('SELECT id, name FROM campaigns WHERE user_id = ? AND parent_id IS NULL', [userId]),
          db.all('SELECT id, label, email FROM senders WHERE user_id = ?', [userId])]);
      }).then(function (x) {
        var names = {}; x[4].forEach(function (c) { names[c.id] = c.name; });
        var rep = {}; x[1].forEach(function (a) { rep[a.root] = Number(a.replied); });
        var campaigns = x[0].map(function (a) {
          return { id: a.root, name: names[a.root] || ('Campaign ' + a.root), sent: Number(a.sent), opened: Number(a.opened) || 0, replied: rep[a.root] || 0,
            open_rate: ratio(Number(a.opened) || 0, Number(a.sent)), reply_rate: ratio(rep[a.root] || 0, Number(a.sent)) };
        }).sort(function (a, b) { return b.sent - a.sent; }).slice(0, 25);
        var sn = {}; x[5].forEach(function (s) { sn[s.id] = s; });
        var srep = {}; x[3].forEach(function (a) { srep[a.sid] = a; });
        var senders = x[2].filter(function (a) { return a.sid; }).map(function (a) {
          var rr = srep[a.sid] || { replied: 0, bounces: 0 };
          return { id: a.sid, label: sn[a.sid] ? sn[a.sid].label : 'Removed sender', email: sn[a.sid] ? sn[a.sid].email : '', sent: Number(a.sent),
            replied: Number(rr.replied), bounced: Number(rr.bounces) || 0, reply_rate: ratio(Number(rr.replied), Number(a.sent)), bounce_rate: ratio(Number(rr.bounces) || 0, Number(a.sent)) };
        }).sort(function (a, b) { return b.sent - a.sent; });

        function rates(t) { return { open_rate: ratio(t.opened, t.sent), reply_rate: ratio(t.replied, t.sent), interested_rate: ratio(t.interested, t.replied), bounce_rate: ratio(t.bounced, t.sent) }; }
        return {
          range: { from: R.from, to: R.to, days: R.days },
          totals: Object.assign({}, cur, rates(cur)),
          previous: Object.assign({}, prev, rates(prev)),
          funnel: f, series: series, steps: steps, sentiment: sent, weekday: weekday, campaigns: campaigns, senders: senders
        };
      });
    });
  });
};

// Open drill-down for one campaign (main or part): recipient, step, how often, first and last time.
ReportsService.prototype.opens = function (userId, campaignId, q) {
  var db = this.db;
  return this._scope(userId, campaignId).then(function (ids) {
    if (!ids) throw new AppError('validation', 'Choose a campaign.', 400);
    var lim = v.intIn(q && q.limit, 1, 500) || 200;
    var off = v.intIn(q && q.offset, 0, 1000000) || 0;
    var from = ' FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id JOIN leads l ON l.id = cl.lead_id WHERE m.user_id = ? AND cl.campaign_id IN (' + v.placeholders(ids.length) + ")" +
      " AND m.direction = 'out' AND m.status = 'sent' AND m.open_count > 0";
    var p = [userId].concat(ids);
    return Promise.all([
      db.get('SELECT COUNT(*) AS n, COALESCE(SUM(m.open_count),0) AS total' + from, p),
      db.get("SELECT COUNT(*) AS sent FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND cl.campaign_id IN (" + v.placeholders(ids.length) + ") AND m.direction = 'out' AND m.status = 'sent'", p),
      db.all('SELECT m.id AS message_id, m.step_no AS step, m.subject AS subject, m.sent_at AS sent_at, m.opened_at AS first_opened_at, m.last_opened_at AS last_opened_at, m.open_count AS opens,' +
        ' l.email AS email, l.first_name AS first_name, l.last_name AS last_name, l.company AS company, cl.status AS lead_status' + from +
        ' ORDER BY COALESCE(m.last_opened_at, m.opened_at) DESC, m.id DESC LIMIT ? OFFSET ?', p.concat([lim, off])),
      db.get('SELECT track_opens FROM campaigns WHERE id = ? AND user_id = ?', [ids[0], userId])
    ]).then(function (r) {
      return { tracking_enabled: !!(r[3] && r[3].track_opens), emails_sent: Number(r[1].sent), opened_emails: Number(r[0].n), total_opens: Number(r[0].total),
        open_rate: ratio(Number(r[0].n), Number(r[1].sent)), limit: lim, offset: off, rows: r[2] };
    });
  });
};

module.exports = { ReportsService: ReportsService };
