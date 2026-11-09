'use strict';
// Public one-click unsubscribe (token-authorised, no session). The token is an HMAC-signed
// campaign_lead id (lib/unsub.js). Unsubscribing suppresses the ADDRESS for that user everywhere:
// every pending/active/paused sequence aimed at it ends, and future imports/campaigns skip it.
// Invalid tokens and unknown ids look identical to callers (no information leak).
var unsub = require('../lib/unsub');
var state = require('./campaignState');

function UnsubscribeService(db, deps) {
  this.db = db;
  this.secret = deps.unsubSecret;
  this.now = deps.now || Date.now;
}

// -> { valid: bool, email?: masked } without changing anything (used by the confirmation page)
UnsubscribeService.prototype.lookup = function (token) {
  var id = unsub.verify(this.secret, token);
  if (!id) return Promise.resolve({ valid: false });
  return this.db.get('SELECT l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ?', [id]).then(function (r) {
    if (!r) return { valid: false };
    var parts = r.email.split('@');
    return { valid: true, email: parts[0].charAt(0) + '***@' + parts[1] };
  });
};

UnsubscribeService.prototype.apply = function (token) {
  var self = this, id = unsub.verify(this.secret, token), t = this.now();
  if (!id) return Promise.resolve({ valid: false });
  return this.db.get('SELECT l.email, l.user_id FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.id = ?', [id]).then(function (r) {
    if (!r) return { valid: false };
    return self.db.transaction(function (tx) {
      return tx.run("INSERT OR IGNORE INTO suppression (user_id, email, reason, created_at) VALUES (?,?,'unsubscribed',?)", [r.user_id, r.email, t])
        .then(function () {
          return tx.all("SELECT DISTINCT campaign_id FROM campaign_leads WHERE status IN ('pending','active','paused') AND lead_id IN (SELECT id FROM leads WHERE user_id = ? AND email = ?)", [r.user_id, r.email]);
        }).then(function (camps) {
          return tx.run("UPDATE campaign_leads SET status = 'unsubscribed', next_send_at = NULL, status_note = 'Unsubscribed' WHERE status IN ('pending','active','paused') AND lead_id IN (SELECT id FROM leads WHERE user_id = ? AND email = ?)", [r.user_id, r.email])
            .then(function () { return camps.reduce(function (p, c) { return p.then(function () { return state.completeIfDone(tx, c.campaign_id, t); }); }, Promise.resolve()); });
        });
    }).then(function () { return { valid: true }; });
  });
};

module.exports = { UnsubscribeService: UnsubscribeService };
