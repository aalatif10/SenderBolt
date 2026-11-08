'use strict';
// Small input-coercion helpers shared by services.

// Whole number in [lo, hi] from a number or a digit-only string; otherwise null.
function intIn(v, lo, hi) {
  var n = typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim()) ? parseInt(v, 10) : v;
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi ? n : null;
}

// Array of distinct positive integer ids, or null if invalid / out of size bounds.
function idArray(v, min, max) {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  var seen = {}, out = [];
  for (var i = 0; i < v.length; i++) {
    var n = intIn(v[i], 1, 9007199254740991);
    if (n === null) return null;
    if (!seen[n]) { seen[n] = true; out.push(n); }
  }
  return out;
}

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function placeholders(n) { var a = []; for (var i = 0; i < n; i++) a.push('?'); return a.join(','); }

module.exports = { intIn: intIn, idArray: idArray, chunk: chunk, placeholders: placeholders };
