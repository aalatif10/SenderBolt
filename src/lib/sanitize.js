'use strict';
// Allowlist HTML sanitizer for email bodies written in the campaign editor.
//
// It does NOT try to repair arbitrary HTML: it re-serialises the input through a tiny allowlist, so the
// output can only ever contain the tags / attributes / style properties listed below, always well nested
// and always quoted the same way. Anything else is dropped (unknown tags keep their text; script, style,
// iframe, svg ... lose their content too). Properties:
//   - idempotent: clean(clean(x)) === clean(x)
//   - links must be http(s) or mailto (entity / whitespace / control-character tricks are decoded first)
//   - style attributes keep only: font-family (allowlisted families), font-size, font-weight, font-style,
//     text-decoration (underline), color. url(), expression(), escapes and comments can never survive
//   - template syntax ({{first_name|there}}, {Hi|Hello}) is plain text, so it passes through untouched
// It is applied when a sequence is saved, when a preview is rendered, and again right before sending.
// (This is not a general purpose DOM sanitizer: it is only meant for the small HTML subset the editor produces.)

var ALLOWED = { p: 1, div: 1, br: 1, span: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, a: 1, ul: 1, ol: 1, li: 1, blockquote: 1 };
var VOID = { br: 1 };
var DROP_WITH_CONTENT = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, template: 1, noscript: 1, textarea: 1, title: 1, svg: 1, math: 1, head: 1, xmp: 1, plaintext: 1, noframes: 1 };
var MAX_DEPTH = 40;
var MAX_HREF = 2000;

var FAMILIES = ['arial', 'helvetica', 'helvetica neue', 'verdana', 'tahoma', 'trebuchet ms', 'georgia', 'times new roman', 'times', 'courier new', 'courier', 'segoe ui', 'sans-serif', 'serif', 'monospace'];
var SIZE_KEYWORDS = ['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large'];

var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', period: '.', comma: ',' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});?/gi, function (m, e) {
    var k = e.toLowerCase(), n;
    if (k.charAt(0) === '#') {
      n = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint ? String.fromCodePoint(n) : String.fromCharCode(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
  });
}

function escText(s) {
  // keep valid entities (&amp; &#39; ...), escape a lone &, and make < > impossible
  return s.replace(/&(?!(?:#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function stripControl(s) {
  // NUL and other C0 controls (keep tab, LF, CR), DEL, and the Unicode line/paragraph separators
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '');
}

// ---- URLs ------------------------------------------------------------------------------------------
function cleanHref(raw) {
  var v = decodeEntities(raw);
  // browsers ignore tabs / newlines / spaces / zero-width characters inside the scheme, so remove them before judging
  var probe = v.replace(/[\u0000- \u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '').toLowerCase();
  if (!/^(https?:\/\/[^\/\s]|mailto:[^\s])/.test(probe)) return null;
  v = v.trim().replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '');
  if (!v || v.length > MAX_HREF) return null;
  return v.replace(/ /g, '%20').replace(/"/g, '%22').replace(/'/g, '%27').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\\/g, '%5C');
}

// ---- style attribute -------------------------------------------------------------------------------
function cleanFamily(value) {
  var parts = value.split(','), out = [];
  if (parts.length > 6) return null;
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim().replace(/^["']|["']$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (FAMILIES.indexOf(name) === -1) return null;
    out.push(name.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }).replace(/\bMs\b/, 'MS').replace(/^Sans-serif$/i, 'sans-serif').replace(/^Serif$/i, 'serif').replace(/^Monospace$/i, 'monospace'));
  }
  return out.length ? out.join(', ') : null;
}
function cleanStyle(raw) {
  var decls = decodeEntities(raw).replace(/\/\*[\s\S]*?\*\//g, '').split(';'), out = [], seen = {};
  decls.forEach(function (d) {
    var i = d.indexOf(':');
    if (i < 1) return;
    var prop = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim().toLowerCase(), clean = null, m;
    if (/[\\@{}<>"`]|url\s*\(|expression|javascript|!important/.test(val)) return;
    if (prop === 'font-family') clean = cleanFamily(d.slice(i + 1).trim());
    else if (prop === 'font-size') {
      if (SIZE_KEYWORDS.indexOf(val) !== -1) clean = val;
      else if ((m = /^(\d{1,2}(?:\.\d)?)(px|pt)$/.exec(val))) { var n = parseFloat(m[1]); if (m[2] === 'px' ? (n >= 8 && n <= 48) : (n >= 6 && n <= 36)) clean = val; }
    } else if (prop === 'font-weight') { if (val === 'bold' || val === '700' || val === '600' || val === 'bolder') clean = 'bold'; else if (val === 'normal' || val === '400') clean = 'normal'; }
    else if (prop === 'font-style') { if (val === 'italic' || val === 'normal') clean = val; }
    else if (prop === 'text-decoration' || prop === 'text-decoration-line') { if (val === 'underline' || val === 'none') clean = val; }
    else if (prop === 'color') {
      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(val)) clean = val;
      else if ((m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(val)) && m[1] <= 255 && m[2] <= 255 && m[3] <= 255) clean = 'rgb(' + m[1] + ', ' + m[2] + ', ' + m[3] + ')';
    }
    if (clean !== null && !seen[prop]) { seen[prop] = true; out.push(prop + ': ' + clean); }
  });
  return out.join('; ');
}

// ---- tokenizer -------------------------------------------------------------------------------------
// Reads one tag starting at src[i] === '<'. Returns { end, name, closing, attrs } or null (not a tag: treat '<' as text).
function readTag(src, i) {
  var j = i + 1, closing = false;
  if (src.charAt(j) === '/') { closing = true; j++; }
  var m = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(src.slice(j, j + 40));
  if (!m) return null;
  var name = m[0].toLowerCase(), attrs = {};
  j += m[0].length;
  for (;;) {
    while (j < src.length && /[\s\/]/.test(src.charAt(j))) j++;
    if (j >= src.length) return null;                               // never closed: not a tag
    if (src.charAt(j) === '>') { j++; break; }
    var am = /^[^\s=\/>"']+/.exec(src.slice(j, j + 200));
    if (!am) { j++; continue; }                                     // stray quote etc.
    var an = am[0].toLowerCase(), val = '';
    j += am[0].length;
    while (j < src.length && /\s/.test(src.charAt(j))) j++;
    if (src.charAt(j) === '=') {
      j++;
      while (j < src.length && /\s/.test(src.charAt(j))) j++;
      var q = src.charAt(j);
      if (q === '"' || q === "'") {
        var e = src.indexOf(q, j + 1);
        if (e < 0) return null;
        val = src.slice(j + 1, e); j = e + 1;
      } else {
        var um = /^[^\s>]*/.exec(src.slice(j, j + 4000));
        val = um[0]; j += um[0].length;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(attrs, an)) attrs[an] = val;
  }
  return { end: j, name: name, closing: closing, attrs: attrs };
}

function clean(input) {
  var src = stripControl(String(input == null ? '' : input)), out = '', stack = [], i = 0, n = src.length;
  function closeTo(idx) { while (stack.length > idx) out += '</' + stack.pop() + '>'; }
  function indexOfOpen(tag) { for (var k = stack.length - 1; k >= 0; k--) if (stack[k] === tag) return k; return -1; }
  function indexOfAny(tags) { for (var k = stack.length - 1; k >= 0; k--) if (tags.indexOf(stack[k]) !== -1) return k; return -1; }

  while (i < n) {
    var lt = src.indexOf('<', i);
    if (lt < 0) { out += escText(src.slice(i)); break; }
    if (lt > i) out += escText(src.slice(i, lt));
    if (src.substr(lt, 4) === '<!--') { var ce = src.indexOf('-->', lt + 4); i = ce < 0 ? n : ce + 3; continue; }
    var nx = src.charAt(lt + 1);
    if (nx === '!' || nx === '?') { var de = src.indexOf('>', lt + 2); i = de < 0 ? n : de + 1; continue; }
    var tag = readTag(src, lt);
    if (!tag) { out += '&lt;'; i = lt + 1; continue; }
    i = tag.end;
    if (DROP_WITH_CONTENT[tag.name]) {
      if (!tag.closing) {
        var re = new RegExp('</' + tag.name + '[\\s/>]', 'i'), rest = src.slice(i), mm = re.exec(rest);
        if (!mm) { i = n; } else { var gt = rest.indexOf('>', mm.index); i += gt < 0 ? rest.length : gt + 1; }
      }
      continue;
    }
    if (!ALLOWED[tag.name]) continue;                                 // unknown tag: drop the tag, keep its text

    if (tag.closing) {
      if (VOID[tag.name]) continue;
      var at = indexOfOpen(tag.name);
      if (at >= 0) closeTo(at);
      continue;
    }
    if (tag.name === 'br') { out += '<br>'; continue; }
    if (stack.length >= MAX_DEPTH) continue;

    // simple nesting hygiene
    if (tag.name === 'p') { var pi = indexOfOpen('p'); if (pi >= 0) closeTo(pi); }
    if (tag.name === 'li') { var li = indexOfAny(['li', 'ul', 'ol']); if (li >= 0 && stack[li] === 'li') closeTo(li); }
    if (tag.name === 'a') { var ai = indexOfOpen('a'); if (ai >= 0) closeTo(ai); }

    var attrOut = '';
    if (tag.name === 'a') {
      var href = Object.prototype.hasOwnProperty.call(tag.attrs, 'href') ? cleanHref(tag.attrs.href) : null;
      if (href === null) { continue; }                                // a link without a safe target is just text
      attrOut += ' href="' + escAttr(href) + '"';
    }
    if (Object.prototype.hasOwnProperty.call(tag.attrs, 'style')) {
      var st = cleanStyle(tag.attrs.style);
      if (st) attrOut += ' style="' + escAttr(st) + '"';
    }
    out += '<' + tag.name + attrOut + '>';
    stack.push(tag.name);
  }
  closeTo(0);
  return out;
}

// True when the HTML has no visible text (only tags, spaces, &nbsp;, <br>).
function isBlank(html) {
  return !String(html == null ? '' : html).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;| /gi, ' ').trim();
}

module.exports = { clean: clean, isBlank: isBlank, cleanStyle: cleanStyle, cleanHref: cleanHref, FAMILIES: FAMILIES, ALLOWED: ALLOWED };
