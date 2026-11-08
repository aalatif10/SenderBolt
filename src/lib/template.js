'use strict';
// Email template engine.
//   {{first_name}}            variable
//   {{first_name|there}}      variable with fallback (used when the value is empty)
//   {Hi|Hello|Hey}            spintax (one option picked per email, seedable)
// Safety rules:
//   - values are HTML-escaped in html mode, so a lead named "<script>" cannot inject markup
//   - values are never re-scanned, so a value containing "{{x}}" or "{a|b}" stays literal
//   - subject mode strips line breaks so a value can never inject extra mail headers
var text = require('./text');

var NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
var MAX_FALLBACK = 100;
var MAX_SPIN_OPTIONS = 20;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parse(src) {
  src = String(src == null ? '' : src);
  var tokens = [], buf = '', i = 0;
  function flush() { if (buf) { tokens.push({ t: 'text', v: buf }); buf = ''; } }
  while (i < src.length) {
    var c = src.charAt(i);
    if (c === '{' && src.charAt(i + 1) === '{') {
      var end = src.indexOf('}}', i + 2);
      if (end < 0) { buf += c; i++; continue; }
      var inner = src.slice(i + 2, end), bar = inner.indexOf('|');
      var name = (bar < 0 ? inner : inner.slice(0, bar)).trim().toLowerCase();
      var fb = bar < 0 ? null : inner.slice(bar + 1).trim();
      if (!NAME_RE.test(name) || (fb !== null && fb.length > MAX_FALLBACK)) { buf += src.slice(i, end + 2); i = end + 2; continue; }
      flush(); tokens.push({ t: 'var', name: name, fallback: fb }); i = end + 2; continue;
    }
    if (c === '{') {
      var close = src.indexOf('}', i + 1), nextOpen = src.indexOf('{', i + 1);
      if (close > 0 && (nextOpen < 0 || nextOpen > close)) {
        var body = src.slice(i + 1, close);
        if (body.indexOf('|') >= 0) {
          var opts = body.split('|');
          if (opts.length <= MAX_SPIN_OPTIONS) { flush(); tokens.push({ t: 'spin', options: opts }); i = close + 1; continue; }
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return tokens;
}

// Names of all variables used (unique, in order of appearance).
function findVariables(src) {
  var seen = {}, out = [];
  parse(src).forEach(function (t) { if (t.t === 'var' && !seen[t.name]) { seen[t.name] = true; out.push(t.name); } });
  return out;
}

// opts: { html: boolean (escape values), rnd: function (0..1) }
// Returns { text, missing: [names that were empty and had no fallback] }
function render(src, vars, opts) {
  opts = opts || {};
  var rnd = opts.rnd || Math.random, esc = opts.html ? escapeHtml : function (s) { return String(s); };
  var missing = [], out = '';
  vars = vars || {};
  parse(src).forEach(function (t) {
    if (t.t === 'text') { out += t.v; return; }
    if (t.t === 'spin') { out += t.options[Math.floor(rnd() * t.options.length)]; return; }
    var v = Object.prototype.hasOwnProperty.call(vars, t.name) ? vars[t.name] : null;
    v = v === null || v === undefined ? '' : String(v).trim();
    if (v) out += esc(v);
    else if (t.fallback !== null) out += esc(t.fallback);
    else if (missing.indexOf(t.name) === -1) missing.push(t.name);
  });
  if (!opts.html) out = text.stripControl(out).replace(/ {2,}/g, ' ').trim();   // subject / plain text: no line breaks
  return { text: out, missing: missing };
}

// Merge-field values for one lead row (custom columns included; keys must be valid names).
function leadVars(lead) {
  var v = {
    first_name: lead.first_name || '', last_name: lead.last_name || '', company: lead.company || '',
    email: lead.email || '', domain: lead.domain || ''
  };
  if (lead.custom) {
    var c = lead.custom;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    if (c && typeof c === 'object') {
      Object.keys(c).forEach(function (k) {
        if (NAME_RE.test(k) && !Object.prototype.hasOwnProperty.call(v, k)) v[k] = String(c[k]);
      });
    }
  }
  return v;
}

module.exports = { parse: parse, findVariables: findVariables, render: render, leadVars: leadVars, escapeHtml: escapeHtml, NAME_RE: NAME_RE };
