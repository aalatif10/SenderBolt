'use strict';
// Detects delivery-failure notices (DSNs) arriving in a sender's mailbox and classifies them.
//   hard   - the address does not exist / is permanently unreachable: stop and suppress it
//   policy - the receiving server blocked us (5.7.x spam/blocked): stop, but the address may be fine
//   soft   - temporary (mailbox full, delayed): ignore, the original server keeps retrying
// Unknown wording defaults to SOFT so we never wrongly suppress a good lead.

var FROM_BOUNCE = /^(mailer-daemon|postmaster|mail-daemon|maildelivery|mailerdaemon)/i;
var NAME_BOUNCE = /(mail delivery (sub)?system|delivery status|mailer-daemon|postmaster)/i;
var HARD_WORDS = /(user unknown|no such user|unknown (user|recipient)|address (not found|rejected)|does not exist|couldn'?t be found|could not be found|recipient (address )?rejected|mailbox (unavailable|not found|disabled)|invalid (recipient|address)|no mailbox)/i;
var SOFT_WORDS = /(delayed|temporar|try again later|mailbox (is )?full|over quota|quota exceeded|deferred)/i;
var ID_RE = /<[^<>\s@]{1,120}@[^<>\s]{1,120}>/g;

function localPart(a) { var s = String(a || ''); var i = s.indexOf('@'); return i > 0 ? s.slice(0, i) : s; }

function isBounceMessage(m) {
  if (m.dsn) return true;
  if (/delivery-status/i.test(String(m.contentType || ''))) return true;
  return FROM_BOUNCE.test(localPart(m.from)) || NAME_BOUNCE.test(String(m.fromName || ''));
}

// Returns null (not a bounce) or { kind: 'hard'|'policy'|'soft', recipient: string|null }
function analyze(m) {
  if (!isBounceMessage(m)) return null;
  var body = String(m.dsn || '') + '\n' + String(m.text || '');
  var kind = null;
  var st = /Status:\s*([245])\.(\d{1,3})\.(\d{1,3})/i.exec(body);
  if (st) {
    if (st[1] === '5') kind = st[2] === '7' ? 'policy' : 'hard';
    else kind = 'soft';
    if (st[1] === '2') kind = 'soft';
  } else if (/Action:\s*delayed/i.test(body)) kind = 'soft';
  else if (/Action:\s*failed/i.test(body)) kind = 'hard';
  else if (HARD_WORDS.test(body) && !SOFT_WORDS.test(body)) kind = 'hard';
  else kind = 'soft';
  var rec = /(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/i.exec(body);
  if (!rec) rec = /(?:to|recipient|address)[:\s]+<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i.exec(body);
  return { kind: kind, recipient: rec ? rec[1].toLowerCase() : null };
}

// All Message-IDs mentioned in headers / body (replies and bounces quote ours).
function referencedIds(m) {
  var out = [], seen = {};
  function add(id) { id = String(id || '').trim(); if (id && !seen[id] && out.length < 30) { seen[id] = true; out.push(id); } }
  add(m.inReplyTo);
  (m.references || []).forEach(add);
  var blob = String(m.dsn || '') + '\n' + String(m.text || '');
  (blob.match(ID_RE) || []).forEach(add);
  return out;
}

module.exports = { analyze: analyze, isBounceMessage: isBounceMessage, referencedIds: referencedIds };
