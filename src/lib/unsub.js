'use strict';
// Signed unsubscribe tokens: "<campaign_lead_id>.<hmac>". The HMAC (keyed with the app secret)
// is the only authorization the public /u/ endpoint needs, and it cannot be guessed or forged.
var tokens = require('./tokens');

function make(secret, campaignLeadId) {
  return campaignLeadId + '.' + tokens.hmac(secret, 'unsub:' + campaignLeadId);
}

// Returns the campaign_lead id (number) or null.
function verify(secret, token) {
  var m = /^(\d{1,15})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  if (!m) return null;
  return tokens.safeEqual(m[2], tokens.hmac(secret, 'unsub:' + m[1])) ? parseInt(m[1], 10) : null;
}

function url(origin, token) { return String(origin).replace(/\/+$/, '') + '/u/' + token; }

module.exports = { make: make, verify: verify, url: url };
