'use strict';
// Email syntax checks, normalization and header-injection guards.

var ROLE_LOCALS = {};
['info', 'sales', 'admin', 'support', 'contact', 'office', 'hello', 'help', 'team', 'marketing',
  'billing', 'accounts', 'hr', 'jobs', 'careers', 'press', 'media', 'webmaster', 'postmaster',
  'noreply', 'no-reply', 'enquiries', 'inquiries', 'service', 'mail'].forEach(function (k) { ROLE_LOCALS[k] = true; });

var LOCAL_RE = /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
var LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normalize(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

// CR, LF, NUL and the Unicode line/paragraph separators (code-based on purpose).
function hasControlChars(s) {
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// Returns { ok: boolean, reason?: string }
function checkSyntax(raw) {
  var e = normalize(raw);
  if (!e) return { ok: false, reason: 'empty' };
  if (hasControlChars(e)) return { ok: false, reason: 'control_characters' };
  if (e.length > 254) return { ok: false, reason: 'too_long' };
  var at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return { ok: false, reason: 'missing_at' };
  var local = e.slice(0, at), domain = e.slice(at + 1);
  if (local.length > 64) return { ok: false, reason: 'local_too_long' };
  if (!LOCAL_RE.test(local)) return { ok: false, reason: 'bad_local_part' };
  var labels = domain.split('.');
  if (labels.length < 2) return { ok: false, reason: 'bad_domain' };
  for (var i = 0; i < labels.length; i++) {
    if (!LABEL_RE.test(labels[i])) return { ok: false, reason: 'bad_domain' };
  }
  if (!/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) return { ok: false, reason: 'bad_tld' };
  return { ok: true };
}

function domainOf(email) {
  var e = normalize(email);
  var at = e.lastIndexOf('@');
  return at < 0 ? '' : e.slice(at + 1);
}

function isRoleAddress(email) {
  var e = normalize(email);
  var at = e.lastIndexOf('@');
  return at > 0 && ROLE_LOCALS[e.slice(0, at)] === true;
}

// Reject any value destined for an email header (subject, names) containing CR/LF.
function assertSafeHeader(value, name) {
  if (hasControlChars(value)) throw new Error('Header injection attempt in ' + (name || 'header'));
  return String(value);
}

module.exports = {
  normalize: normalize, checkSyntax: checkSyntax, domainOf: domainOf,
  isRoleAddress: isRoleAddress, assertSafeHeader: assertSafeHeader
};
