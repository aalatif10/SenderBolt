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

module.exports = { deriveStatus: deriveStatus, syncMain: syncMain, completeIfDone: completeIfDone };
