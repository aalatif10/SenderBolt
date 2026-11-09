'use strict';
// Small HTML <-> text helpers for outgoing mail (plain-text alternative part, manual replies).
// These are NOT sanitizers: never use them to make untrusted HTML safe to render.
var escapeHtml = require('./template').escapeHtml;

var ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    var k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    var n = k.charAt(0) === '#' ? (k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)) : NaN;
    return isFinite(n) && n > 31 && n < 0x10ffff ? String.fromCharCode(n) : m;
  });
}

function htmlToText(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, label) {
    var t = label.replace(/<[^>]+>/g, '').trim();
    return t && t !== href ? t + ' (' + href + ')' : href;
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|tr|ul|ol|blockquote)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\r/g, '');
  s = s.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// Plain text typed by the user -> safe HTML paragraphs.
function textToHtml(text) {
  var paras = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  return paras.map(function (p) { return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>'; }).join('\n');
}

module.exports = { htmlToText: htmlToText, textToHtml: textToHtml, escapeHtml: escapeHtml };
