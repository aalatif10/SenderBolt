'use strict';
// Shared campaign status rules used by the campaign service, the sending engine and inbox sync.

// A main campaign's status is derived from its parts (any error > active > paused > preparing > draft > completed).
function deriveStatus(own, kids) {
  if (!kids.length) return own;
  var set = {};
  kids.forEach(function (k) { set[k.status] = true; });
  if (set.error) return 'error';
  if (set.active) return 'active';
  if (set.paused) return 'paused';
  if (set.preparing) return 'preparing';
  if (set.draft) return 'draft';
  return 'completed';
}

// Recompute and store a main campaign's status from its parts. db may be a Database or a tx.
function syncMain(db, mainId, t) {
  return db.all('SELECT status FROM campaigns WHERE parent_id = ?', [mainId]).then(function (kids) {
    if (!kids.length) return null;
    return db.run('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', [deriveStatus('draft', kids), t, mainId]);
  });
}

// An ACTIVE campaign with no lead left to work on becomes 'completed'.
function completeIfDone(db, campaignId, t) {
  return db.get('SELECT status, parent_id FROM campaigns WHERE id = ?', [campaignId]).then(function (c) {
    if (!c || c.status !== 'active') return false;
    return db.get("SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','active','paused')", [campaignId]).then(function (r) {
      if (r.n > 0) return false;
      return db.run("UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ?", [t, campaignId])
        .then(function () { return c.parent_id ? syncMain(db, c.parent_id, t) : null; })
        .then(function () { return true; });
    });
  });
}

// One address must never stay queued anywhere once it is blocked. Stops every waiting (pending / active / paused) entry of this
// address in ALL of the user's campaigns at once: status 'bounced' for a bounce, 'unsubscribed' for everything else. History,
// messages and stats are untouched. Returns how many people were stopped. Call inside the transaction that wrote the block.
function stopQueued(tx, userId, addr, reason, note, t) {
  var status = reason === 'bounced' ? 'bounced' : 'unsubscribed';
  var same = 'lead_id IN (SELECT id FROM leads WHERE user_id = ? AND email = ?)';
  return tx.all("SELECT DISTINCT campaign_id FROM campaign_leads WHERE status IN ('pending','active','paused') AND " + same, [userId, addr]).then(function (camps) {
    if (!camps.length) return 0;
    return tx.run("UPDATE campaign_leads SET status = ?, next_send_at = NULL, status_note = ? WHERE status IN ('pending','active','paused') AND " + same, [status, note, userId, addr]).then(function (r) {
      return camps.reduce(function (p, c) { return p.then(function () { return completeIfDone(tx, c.campaign_id, t); }); }, Promise.resolve()).then(function () { return r.changes || 0; });
    });
  });
}

// ---- Stopping ONE person in ONE campaign ----------------------------------------------------------------------------
// The single place that ends a person's sequence for a campaign-scoped reason. Used by the Inbox "Stop campaign" button, by reply
// detection ("not interested" replies) and by the "stop campaign" phrase, so the three can never drift apart.
// It only touches the given campaign_leads row: no do-not-email entry, no other campaign, no other person. The row gets status
// 'stopped' (its own state, never 'completed') and the reason in status_note, which the UI turns into a badge.
var STOP_NOTES = { manual: 'Stopped manually', not_interested: 'Not interested', stop_phrase: 'Replied "stop campaign"' };
var STOPPABLE_FROM = ['pending', 'active', 'paused', 'error', 'replied', 'completed'];
// Badge kind of a stopped row, from its note: 'not_interested' | 'stop_campaign' | 'manual_stop'.
function stopKind(note) { return note === STOP_NOTES.not_interested ? 'not_interested' : note === STOP_NOTES.stop_phrase ? 'stop_campaign' : 'manual_stop'; }
// Returns true when the row was changed. tx may be a Database or a transaction.
function stopLead(tx, clId, campaignId, reason, t) {
  var note = STOP_NOTES[reason];
  if (!note) return Promise.reject(new Error('Unknown stop reason'));
  return tx.run("UPDATE campaign_leads SET status = 'stopped', next_send_at = NULL, status_note = ? WHERE id = ? AND status IN (" + STOPPABLE_FROM.map(function () { return '?'; }).join(',') + ')',
    [note, clId].concat(STOPPABLE_FROM)).then(function (r) {
    var changed = (r && r.changes) > 0;
    return completeIfDone(tx, campaignId, t).then(function () { return changed; });
  });
}

module.exports = { deriveStatus: deriveStatus, syncMain: syncMain, completeIfDone: completeIfDone, stopQueued: stopQueued, stopLead: stopLead, stopKind: stopKind, STOP_NOTES: STOP_NOTES };
