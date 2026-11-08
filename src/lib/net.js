'use strict';
// Hostname validation used for sender SMTP/IMAP hosts and the tracking domain.
// IP literals and internal-looking names are rejected outright (SSRF guard).
// TODO: also re-check resolved IPs at connect time to defeat DNS rebinding.

var LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
var BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.home.arpa'];

function assertPublicHostname(host, field) {
  var h = String(host == null ? '' : host).trim().toLowerCase();
  var name = field || 'host';
  if (!h || h.length > 253) return name + ' is required (max 253 chars)';
  if (h === 'localhost') return name + ' must be a public hostname';
  var labels = h.split('.');
  if (labels.length < 2) return name + ' must be a fully qualified domain name';
  for (var i = 0; i < labels.length; i++) {
    if (!LABEL_RE.test(labels[i])) return name + ' is not a valid hostname';
  }
  // The last label must contain a letter: this rejects all IPv4 literals.
  if (!/[a-z]/.test(labels[labels.length - 1])) return name + ' must be a domain name, not an IP address';
  for (var j = 0; j < BLOCKED_SUFFIXES.length; j++) {
    var s = BLOCKED_SUFFIXES[j];
    if (h.length > s.length && h.slice(-s.length) === s) return name + ' must be a public hostname';
  }
  return null; // null = OK
}

module.exports = { assertPublicHostname: assertPublicHostname };
