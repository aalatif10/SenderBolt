'use strict';
// alerts.js - the ONE list behind Home "Campaign health" (src/services/alerts.js).
//
//   list(userId) -> { items: [{ key, level, title, detail, href, action, is_new }], all_keys: [...], counts: { critical, warning, unreviewed, total, dismissed } }
//
// Everything that can stop or hurt sending is computed here on the server (never in the browser), so no problem can be dropped by a
// client-side filter and the numbers shown on Home always match the real state. Every query is scoped by user_id.
// Alert keys are stable (kind:id:reason) so "reviewed" and "dismissed" survive a refresh and a returning problem counts as new:
//   p:<project>:bounce                      project bounce rate is high
//   s:<sender>:down | err | floor | force | conn | sync | track | limit
//   c:<main campaign>:error | people | stalled | window | paused | unassigned | overdue
//   e:0:engine                              the sending engine has stopped ticking
// The state of "reviewed" / "dismissed" lives in user_settings (see services/settings.js).
var nextEmail = require('./nextEmail');
var settingsLib = require('./settings');

var OVERDUE_MS = 60 * 60000;   // an email that could go out right now but is more than an hour late counts as a queue stall
var ENGINE_STALE_MS = 2 * 60000;   // the engine ticks every few seconds; two minutes of silence means it is not running
var MAX_ITEMS = 150;   // keeps the stored reviewed/dismissed lists (max 200 keys) always able to hold every alert

function AlertsService(db, deps) {
  this.db = db; this.senders = deps.senders; this.projects = deps.projects; this.settings = deps.settings;
  this.engineInfo = deps.engineInfo || null;   // optional: () -> { mode, last_tick_at } of the sending engine
  this.now = deps.now || Date.now;
}

var REASON_TEXT = {
  paused: 'The sender that owns these people is paused.',
  health: 'The sender that owns these people is below its health protection threshold, so nothing is sent until its health recovers.',
  tracking: 'The sender that owns these people cannot check its inbox for replies yet, so it waits instead of risking a follow-up to someone who answered.'
};

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

AlertsService.prototype.list = function (userId) {
  var self = this, now = this.now(), db = this.db;
  return Promise.all([
    this.senders.list(userId),
    this.projects.list(userId, {}),
    settingsLib.loadGuard(db, userId),
    // Main campaigns (a split campaign's parts roll up to their main one) with their problems.
    db.all("SELECT COALESCE(c.parent_id, c.id) AS mid, c.status AS status, c.last_error AS last_error FROM campaigns c WHERE c.user_id = ? AND (c.status = 'error' OR (c.status = 'paused' AND c.last_error IS NOT NULL))", [userId]),
    db.all("SELECT COALESCE(c.parent_id, c.id) AS mid, COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND cl.status = 'error' AND cl.removed_at IS NULL GROUP BY COALESCE(c.parent_id, c.id)", [userId]),
    db.all("SELECT cl.sender_id AS sid, COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND c.status = 'active' AND cl.status = 'active' AND cl.removed_at IS NULL GROUP BY cl.sender_id", [userId]),
    db.all("SELECT c.id AS cid, COALESCE(c.parent_id, c.id) AS mid, COUNT(*) AS n, SUM(CASE WHEN cl.sender_id IS NULL THEN 1 ELSE 0 END) AS unassigned, SUM(CASE WHEN cl.next_send_at IS NOT NULL AND cl.next_send_at < ? THEN 1 ELSE 0 END) AS overdue FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ? AND c.status = 'active' AND cl.status = 'active' AND cl.removed_at IS NULL GROUP BY c.id", [now - OVERDUE_MS, userId]),
    db.all('SELECT c.id AS id, c.name AS name, c.project_id AS project_id FROM campaigns c WHERE c.user_id = ? AND c.parent_id IS NULL', [userId]),
    this.settings.get(userId)
  ]).then(function (r) {
    var senders = r[0].items || r[0], projects = r[1].items, guard = r[2], badCamps = r[3], errPeople = r[4], waitBySender = r[5], waitByCamp = r[6], mains = r[7], st = r[8].settings;
    var mainById = {}; mains.forEach(function (m) { mainById[m.id] = m; });
    var waiting = {}; waitBySender.forEach(function (x) { if (x.sid !== null) waiting[x.sid] = Number(x.n); });
    return nextEmail.compute(db, userId, now, { guard: guard }).then(function (ne) {
      var items = [];
      function add(key, level, title, detail, href, action) { items.push({ key: key, level: level, title: title, detail: detail, href: href, action: action }); }
      function campHref(mid) { var m = mainById[mid]; return m && m.project_id ? '#/project/' + m.project_id : '#/'; }
      function campName(mid) { var m = mainById[mid]; return m ? m.name : 'Campaign'; }

      // Projects: bounce rate protects every sending account, so it is critical.
      projects.forEach(function (p) {
        var t = p.totals;
        if (t.emailed >= 20 && t.bounce_rate >= 5) add('p:' + p.id + ':bounce', 'critical', p.name + ': high bounce rate (' + t.bounce_rate + '%)', 'Pause the campaign and verify your lead list to protect your sending accounts.', '#/project/' + p.id, 'Review');
      });

      // Sending accounts.
      senders.forEach(function (s) {
        var name = s.label || s.email, id = s.id;
        if (s.status !== 'active') add('s:' + id + ':down', 'critical', name + ': ' + s.status, s.last_error || 'This account is not sending right now.', '#/senders', 'Open');
        else {
          if (s.last_error) add('s:' + id + ':err', 'warning', name + ': reporting an error', s.last_error, '#/senders', 'Open');
          if (!s.force_active && s.health_score < s.health_floor) add('s:' + id + ':floor', 'critical', name + ': health ' + s.health_score + ' is below its protection threshold (' + s.health_floor + ')', 'Sending is blocked until the score recovers or you use Force continue.', '#/senders', 'Open');
          if (s.force_active) add('s:' + id + ':force', 'warning', name + ': Force continue is on', 'Automatic health pauses are skipped until it expires. Watch bounces closely.', '#/senders', 'Open');
          if (s.connection_error) add('s:' + id + ':conn', 'warning', name + ': connection problem', s.connection_error, '#/senders', 'Open');
          if (s.sync_error && (s.sync_transient !== 1 || s.sync_failures >= 3) && s.imap_host && s.reply_detection !== 0) add('s:' + id + ':sync', 'warning', name + ': cannot read the inbox', 'Reply detection is failing: ' + s.sync_error, '#/senders', 'Open');
          if (ne.senderBlock[id] === 'tracking') add('s:' + id + ':track', 'warning', name + ': waiting for reply tracking', REASON_TEXT.tracking, '#/senders', 'Open');
          if (waiting[id] && s.limit_today > 0 && s.remaining_today <= 0) add('s:' + id + ':limit', 'warning', name + ': daily limit reached', 'Sent ' + s.sent_today + ' of ' + s.limit_today + ' today. ' + plural(waiting[id], 'person is', 'people are') + ' waiting and will go out after midnight (UTC).', '#/senders', 'Open');
        }
      });

      // Campaigns.
      badCamps.forEach(function (c) {
        if (c.status === 'error') add('c:' + c.mid + ':error', 'critical', campName(c.mid) + ': campaign error', c.last_error || 'The campaign stopped because of an error.', campHref(c.mid), 'Review');
        else add('c:' + c.mid + ':paused', 'warning', campName(c.mid) + ': paused with a problem', c.last_error, campHref(c.mid), 'Review');
      });
      errPeople.forEach(function (x) { add('c:' + x.mid + ':people', 'warning', campName(x.mid) + ': ' + plural(Number(x.n), 'person', 'people') + ' could not be emailed', 'Open the campaign people list and filter by "Error" to see why. You can queue them again after fixing the cause.', campHref(x.mid), 'Review'); });
      var stalled = {}, windowed = {}, unassigned = {}, overdue = {};
      waitByCamp.forEach(function (x) {
        var why = ne.campaignBlock[x.cid], noOwner = Number(x.unassigned) || 0;
        if (noOwner) unassigned[x.mid] = (unassigned[x.mid] || 0) + noOwner;
        if (why) { stalled[x.mid] = stalled[x.mid] || { n: 0, why: why }; stalled[x.mid].n += Number(x.n) - noOwner; }
        else if (ne.byCampaign[x.cid] === undefined) { if (Number(x.n) - noOwner > 0) windowed[x.mid] = (windowed[x.mid] || 0) + Number(x.n) - noOwner; }
        // Queue stall: people are far overdue although an owner could send right now (window open, capacity left, nothing blocking).
        else if (Number(x.overdue) > 0 && ne.byCampaign[x.cid] <= now + 60000) overdue[x.mid] = (overdue[x.mid] || 0) + Number(x.overdue);
      });
      Object.keys(unassigned).forEach(function (mid) { add('c:' + mid + ':unassigned', 'warning', campName(Number(mid)) + ': ' + plural(unassigned[mid], 'person has', 'people have') + ' no sending account', 'Their sending account was removed. Open the campaign and re-queue them or change its sending accounts.', campHref(Number(mid)), 'Review'); });
      Object.keys(overdue).forEach(function (mid) { add('c:' + mid + ':overdue', 'warning', campName(Number(mid)) + ': ' + plural(overdue[mid], 'email is', 'emails are') + ' more than an hour late', 'A sending account is able to send, but these emails did not go out. Check the sending engine and the account connection.', campHref(Number(mid)), 'Review'); });
      var eng = self.engineInfo ? self.engineInfo() : null;
      if (eng && eng.mode !== 'off' && eng.last_tick_at && now - eng.last_tick_at > ENGINE_STALE_MS) add('e:0:engine', 'critical', 'The sending engine is not running', 'It has not checked the queue for ' + Math.round((now - eng.last_tick_at) / 60000) + ' minutes, so no email is going out. Restart SenderBolt.', '#/senders', 'Open');
      Object.keys(stalled).forEach(function (mid) { var s = stalled[mid]; add('c:' + mid + ':stalled', 'warning', campName(Number(mid)) + ': ' + plural(s.n, 'person is', 'people are') + ' not being emailed', REASON_TEXT[s.why], campHref(Number(mid)), 'Review'); });
      Object.keys(windowed).forEach(function (mid) { add('c:' + mid + ':window', 'warning', campName(Number(mid)) + ': sending hours never overlap', 'The campaign sending window and your System Preferences guardrail never open at the same time, so nothing can be sent.', campHref(Number(mid)), 'Review'); });

      var seen = st.health_seen || [], dismissed = st.health_dismissed || [];
      var allKeys = items.map(function (x) { return x.key; });
      // A problem that went away is forgotten here (not only when the browser next saves), so if it comes back it shows again, as new,
      // even if it had been dismissed or reviewed before.
      var keepSeen = seen.filter(function (k) { return allKeys.indexOf(k) !== -1; }), keepDismissed = dismissed.filter(function (k) { return allKeys.indexOf(k) !== -1; });
      var prune = Promise.resolve();
      if (keepSeen.length !== seen.length) prune = prune.then(function () { return self.settings.setHealthSeen(userId, keepSeen); });
      if (keepDismissed.length !== dismissed.length) prune = prune.then(function () { return self.settings.setHealthDismissed(userId, keepDismissed); });
      seen = keepSeen; dismissed = keepDismissed;
      var visible = items.filter(function (x) { return dismissed.indexOf(x.key) === -1; });
      visible.forEach(function (x) { x.is_new = seen.indexOf(x.key) === -1; });
      visible.sort(function (a, b) { return (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1) || (b.is_new - a.is_new); });
      var shown = visible.slice(0, MAX_ITEMS);
      return prune.then(function () { return {
        items: shown, all_keys: allKeys.slice(0, 200),
        counts: { critical: visible.filter(function (x) { return x.level === 'critical'; }).length, warning: visible.filter(function (x) { return x.level !== 'critical'; }).length,
          unreviewed: visible.filter(function (x) { return x.is_new; }).length, total: visible.length, dismissed: items.length - visible.length }
      }; });
    });
  });
};

module.exports = { AlertsService: AlertsService };
