'use strict';
// Text sanitizing helpers (code-based on purpose: no control characters in regex literals).

function isControl(c) { return c < 32 || c === 127 || c === 0x2028 || c === 0x2029; }

function hasControl(s) {
  s = String(s);
  for (var i = 0; i < s.length; i++) if (isControl(s.charCodeAt(i))) return true;
  return false;
}

function stripControl(s) {
  s = String(s);
  var out = '';
  for (var i = 0; i < s.length; i++) out += isControl(s.charCodeAt(i)) ? ' ' : s.charAt(i);
  return out;
}

// Trim, collapse whitespace, strip control chars, cap length. Returns null if empty.
function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  var s = stripControl(String(v)).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = { hasControl: hasControl, stripControl: stripControl, cleanText: cleanText };
