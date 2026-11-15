'use strict';
// Per-step progress for the segmented progress bar (src/services/stepProgress.js).
//
// For every email step of a campaign: how many emails went out ("sent") out of how many people can still or already
// did receive that step ("capacity"):
//   capacity(step k) = people still waiting in the campaign (pending / running / paused)
//                    + people who already got step k and then finished (replied, bounced, opted out, completed, error)
// People who ended BEFORE reaching step k (for example somebody who replied after the first email) drop out of the
// capacity of every later step, so a bar reads "34 of 112" instead of showing a misleading 34 of 150.
// A person who has sent steps 0..j has current_step = j + 1 (the engine advances it in the same transaction as the send),
// which is why the capacity can be computed from one small GROUP BY on campaign_leads, without touching messages.
// Works for a plain campaign or for the parts (batches) of a split campaign: sum() adds the parts up per step.
var v = require('../lib/validate');

var OPEN_STATES = { pending: 1, active: 1, paused: 1 };

// -> { [campaignId]: [{ sent, capacity }] } for every campaign of the user (or only onlyIds).
function load(db, userId, onlyIds) {
  var f = onlyIds && onlyIds.length ? ' AND cl.campaign_id IN (' + v.placeholders(onlyIds.length) + ')' : '';
  var p = onlyIds && onlyIds.length ? [userId].concat(onlyIds) : [userId];
  var out = {};
  return Promise.all([
    db.all('SELECT cs.campaign_id AS cid, COUNT(*) AS n FROM campaign_steps cs JOIN campaigns c ON c.id = cs.campaign_id WHERE c.user_id = ?' + f.replace(/cl\.campaign_id/g, 'cs.campaign_id') + ' GROUP BY cs.campaign_id', p),
    db.all('SELECT cl.campaign_id AS cid, cl.status AS st, cl.current_step AS cur, COUNT(*) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.user_id = ?' + f + ' GROUP BY cl.campaign_id, cl.status, cl.current_step', p),
    db.all("SELECT cl.campaign_id AS cid, m.step_no AS step, COUNT(*) AS n FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND m.direction = 'out' AND m.status = 'sent' AND m.step_no IS NOT NULL" + f + ' GROUP BY cl.campaign_id, m.step_no', p)
  ]).then(function (r) {
    var groups = {}, sent = {};
    r[1].forEach(function (g) { (groups[g.cid] = groups[g.cid] || []).push(g); });
    r[2].forEach(function (s) { (sent[s.cid] = sent[s.cid] || {})[s.step] = Number(s.n); });
    r[0].forEach(function (row) {
      var arr = [], n = Number(row.n);
      for (var k = 0; k < n; k++) {
        var cap = 0;
        (groups[row.cid] || []).forEach(function (g) { if (OPEN_STATES[g.st] || g.cur > k) cap += Number(g.n); });
        var s = (sent[row.cid] && sent[row.cid][k]) || 0;
        arr.push({ sent: s, capacity: Math.max(cap, s) });
      }
      out[row.cid] = arr;
    });
    return out;
  });
}

// Adds the per-step numbers of several campaigns (the parts of one split campaign).
function sum(lists) {
  var out = [];
  lists.forEach(function (list) {
    (list || []).forEach(function (st, k) {
      if (!out[k]) out[k] = { sent: 0, capacity: 0 };
      out[k].sent += st.sent; out[k].capacity += st.capacity;
    });
  });
  return out;
}

// Joins the numbers with the step definitions (rows of campaign_steps: step_no, delay_days, subject).
function describe(meta, nums) {
  nums = nums || [];
  return (meta || []).map(function (m, k) {
    var n = nums[k] || { sent: 0, capacity: 0 };
    return { step: m.step_no, subject: m.subject || '', delay_days: m.delay_days, sent: n.sent, capacity: n.capacity,
      pct: n.capacity ? Math.round(n.sent / n.capacity * 1000) / 10 : 0 };
  });
}

// Step numbers that can no longer be edited: at least one email of that step was sent or is being sent right now.
// db may be a Database or a transaction object.
function lockedSteps(db, userId, leafIds) {
  if (!leafIds.length) return Promise.resolve({});
  return db.all("SELECT DISTINCT m.step_no AS step FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND m.direction = 'out' AND m.status IN ('sent','sending') AND m.step_no IS NOT NULL AND cl.campaign_id IN (" +
    v.placeholders(leafIds.length) + ')', [userId].concat(leafIds)).then(function (rows) {
    var o = {}; rows.forEach(function (r) { o[r.step] = true; }); return o;
  });
}

// campaign_steps rows (step_no, delay_days, subject) for many campaigns: { [campaignId]: [rows] }
function metaFor(db, userId) {
  return db.all('SELECT cs.campaign_id AS cid, cs.step_no, cs.delay_days, cs.subject FROM campaign_steps cs JOIN campaigns c ON c.id = cs.campaign_id WHERE c.user_id = ? ORDER BY cs.campaign_id, cs.step_no', [userId]).then(function (rows) {
    var o = {}; rows.forEach(function (r) { (o[r.cid] = o[r.cid] || []).push(r); }); return o;
  });
}

module.exports = { load: load, sum: sum, describe: describe, lockedSteps: lockedSteps, metaFor: metaFor };
