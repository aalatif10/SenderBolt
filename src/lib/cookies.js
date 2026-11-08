'use strict';
// Minimal cookie parse/serialize. Values are restricted to a safe alphabet so a
// value can never inject extra attributes or headers.

function parse(header) {
  var out = {};
  if (!header || typeof header !== 'string' || header.length > 8192) return out;
  header.split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i < 1) return;
    var k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  });
  return out;
}

function serialize(name, value, opts) {
  opts = opts || {};
  if (!/^[A-Za-z0-9_\-]+$/.test(name)) throw new Error('Invalid cookie name');
  if (!/^[A-Za-z0-9_\-.~]*$/.test(value)) throw new Error('Invalid cookie value');
  var s = name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict';
  if (opts.secure) s += '; Secure';
  if (opts.maxAgeSec !== undefined) s += '; Max-Age=' + Math.max(0, Math.floor(opts.maxAgeSec));
  return s;
}

function clear(name, opts) { return serialize(name, '', { secure: opts && opts.secure, maxAgeSec: 0 }); }

module.exports = { parse: parse, serialize: serialize, clear: clear };
