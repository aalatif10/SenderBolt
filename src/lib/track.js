'use strict';
// Signed open-tracking tokens: "<campaign_lead_id>.<step>.<hmac>". The pixel URL reveals nothing but two ids and
// cannot be forged or enumerated without the app secret.
var tokens = require('./tokens');

function make(secret, clId, step) { return clId + '.' + step + '.' + tokens.hmac(secret, 'open:' + clId + ':' + step); }
// -> { clId, step } or null
function verify(secret, token) {
  var m = /^(\d{1,15})\.(\d{1,3})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  if (!m) return null;
  return tokens.safeEqual(m[3], tokens.hmac(secret, 'open:' + m[1] + ':' + m[2])) ? { clId: parseInt(m[1], 10), step: parseInt(m[2], 10) } : null;
}
function url(origin, token) { return String(origin).replace(/\/+$/, '') + '/t/o/' + token + '.gif'; }

// 1x1 transparent GIF
var PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

module.exports = { make: make, verify: verify, url: url, PIXEL: PIXEL };
