'use strict';
// Classifies SMTP / network errors thrown while sending, so each failure gets the RIGHT reaction:
//   auth      sender credentials rejected          -> pause the sender, do NOT blame the lead
//   quota     provider daily/rate limit reached     -> stop this sender until tomorrow, do NOT blame the lead
//   recipient the address is permanently bad        -> mark lead bounced + suppress
//   policy    receiving server blocked us (5.7.x)   -> stop this lead, keep address, hurts sender health
//   transient network / 4xx / unknown               -> retry with backoff, count against the lead
// nodemailer errors carry: code (EAUTH, ECONNECTION, ETIMEDOUT...), responseCode, response.

var RECIPIENT = /(\b5\.1\.\d{1,3}\b|\b5\.2\.1\b|user unknown|no such user|unknown (user|recipient)|does not exist|address (not found|rejected)|mailbox (unavailable|not found|disabled)|recipient (address )?rejected|invalid (recipient|address)|no mailbox)/i;
var POLICY = /(\b5\.7\.\d{1,3}\b|blocked|blacklist|spam|policy|reputation|not authorized|denied|rejected due to)/i;
var QUOTA = /(quota|rate limit|too many (messages|recipients|connections)|daily (user )?sending|sending limit|limit exceeded|\b4\.7\.0\b)/i;
var AUTH = /(authentication|username and password not accepted|invalid login|invalid credentials|application-specific password|\b5\.7\.8\b)/i;
var NET_CODES = { ECONNECTION: 1, ETIMEDOUT: 1, ESOCKET: 1, ECONNRESET: 1, ECONNREFUSED: 1, ENOTFOUND: 1, EDNS: 1, EAI_AGAIN: 1, EPIPE: 1, EHOSTUNREACH: 1, ENETUNREACH: 1 };

function classify(err) {
  var code = err && err.code ? String(err.code) : '';
  var rc = err && err.responseCode ? Number(err.responseCode) : 0;
  var text = String((err && (err.response || err.message)) || '');
  if (code === 'EDECRYPT') return { kind: 'auth', message: 'The saved sender password could not be decrypted (was the master key changed?). Re-enter the App Password.' };
  if (code === 'EAUTH' || rc === 535 || rc === 534 || rc === 530 || AUTH.test(text)) return { kind: 'auth', message: 'Sender login was rejected. Check the App Password.' };
  if (NET_CODES[code]) return { kind: 'transient', message: 'Network problem while sending (' + code + ').' };
  if (rc >= 400 && QUOTA.test(text)) return { kind: 'quota', message: 'Provider sending limit reached.' };
  if (rc >= 500 && RECIPIENT.test(text) && !QUOTA.test(text)) return { kind: 'recipient', message: 'Recipient address was rejected by the receiving server.' };
  if (rc >= 500 && POLICY.test(text)) return { kind: 'policy', message: 'The receiving server blocked this message (policy).' };
  if (rc >= 500) return { kind: 'recipient', message: 'The receiving server permanently rejected this message.' };
  return { kind: 'transient', message: 'Temporary sending problem.' };
}

module.exports = { classify: classify };
