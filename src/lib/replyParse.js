'use strict';
// Splits the text of an incoming reply into three parts so the Inbox can show them cleanly:
//   body          what the person actually wrote
//   signature     an automatic device / app signature ("Sent from my Galaxy", "Get Outlook for Android") or a "-- " signature block
//   quoted        the earlier conversation they replied under (our own email), without the ">" markers
//   quotedHeader  the line that introduces the quote ("On Tue, 11 Nov 2026, Sam <sam@x.com> wrote:")
// Pure text in, plain text out: nothing here produces HTML, so the result can only ever be shown with textContent.
// Mail clients often glue these parts together on one line ("Thanks!Sent from my Galaxy"), so a few well-known
// phrases are split apart first. Anything not recognised stays in the body: we never throw away what someone wrote.

var MAX_QUOTED = 20000;

var DEVICE_WORDS = '(iphone|ipad|ipod|galaxy|samsung|android|huawei|xiaomi|redmi|oppo|vivo|realme|oneplus|pixel|nokia|motorola|blackberry|windows phone|' +
  'mobile|smartphone|tablet|phone|device|verizon|t-mobile|at&t|sprint|outlook|yahoo mail|mail for (windows|ios|android|iphone)|mail\\.ru|gmail|aol|proton ?mail|spark|superhuman|bluemail|aqua mail|k-?9 mail|my ?mail|hey)';
// A whole line that is an automatic signature.
var DEVICE_LINE = [
  new RegExp('^(sent|sent from|sent via|sent using|sent with)\\b.{0,120}\\b' + DEVICE_WORDS + '\\b.{0,120}$', 'i'),
  /^(get|download) outlook for (ios|android)\b.{0,120}$/i,
  /^(envoy[ée]|enviado|gesendet|inviato|verzonden|skickat|wys[łl]ano)\s+(de|depuis|desde|von|da|vanaf|fr[åa]n|z)\b.{0,120}$/i,
  /^(تم الإرسال|مرسل|أرسلت|ارسلت|تم الارسال)\s+(من|عبر)(\s.{0,120})?$/
];
// The same signatures glued after other text on one line. Deliberately narrow (specific device words only), because a
// normal sentence may contain "sent from my account".
var DEVICE_INLINE = new RegExp('(Sent from my (iPhone|iPad|iPod|Galaxy|Samsung|Android|Huawei|Xiaomi|Redmi|Oppo|Vivo|Realme|OnePlus|Pixel|Nokia|Motorola|BlackBerry|Windows Phone|mobile|phone|device|smartphone|tablet|Verizon|T-Mobile|AT&T|Sprint)|' +
  'Sent from (Yahoo Mail|Outlook|Mail for (Windows|iOS|Android|iPhone)|Mail\\.ru|Samsung|Spark|BlueMail|Aqua Mail|ProtonMail)|Get Outlook for (iOS|Android)|Sent via the (Samsung|Galaxy)|Envoy[ée] de mon (iPhone|iPad|Galaxy|Samsung))');

var QUOTE_START_WORDS = /^((On|Le|El|Am|Il|Em|Op|Den)\b|في\s)/;      // JS \b only knows ASCII letters, so the Arabic word is matched with \s
var QUOTE_HEADERS = [
  /^On\s.{5,300}?\swrote:\s*$/i,
  /^(Le|El|Am|Il|Em|Op|Den)\s.{5,300}?(a écrit|a ecrit|escribió|escribio|schrieb|ha scritto|escreveu|schreef|skrev)\s*:?\s*$/i,
  /^في\s.{3,300}?(كتب|كتبت)\s*:?\s*$/
];
var RULE = /^[\s_\-=]{5,}$/;
var ORIGINAL_MARK = /^-{2,}\s*(original message|forwarded message|original nachricht|message d'origine|mensaje original|messaggio originale|الرسالة الأصلية)\s*-{2,}$/i;
var HDR_FROM = /^(from|de|von|da|van|från|من)\s*:\s*\S/i;
var HDR_SENT = /^(sent|date|envoy[ée]|gesendet|fecha|data|verzonden|تاريخ الإرسال|أرسلت)\s*:/i;

var INVISIBLE = new RegExp('[' + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200f) + String.fromCharCode(0x2028, 0x2029, 0xfeff) + ']', 'g');
var NBSP = new RegExp(String.fromCharCode(0xa0), 'g');

function normalize(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(NBSP, ' ').replace(INVISIBLE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Put glued-together parts on their own line.
function unglue(text) {
  var s = text.replace(/([^\s])[ \t]*(On\s[^\n]{5,250}?\swrote:)/g, function (m, before, hdr) { return /\d/.test(hdr) ? before + '\n' + hdr : m; });
  return s.split('\n').map(function (line) {
    var m = DEVICE_INLINE.exec(line);
    if (m && m.index > 0 && line.slice(0, m.index).trim()) return line.slice(0, m.index).replace(/\s+$/, '') + '\n' + line.slice(m.index);
    return line;
  }).join('\n');
}

// Index of the first line of the quoted part, or -1. Also reports how many lines the introducing header takes.
function findQuote(lines) {
  var i, j, joined;
  for (i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t) continue;
    if (ORIGINAL_MARK.test(t)) return { at: i, headerLines: 0 };
    if (QUOTE_START_WORDS.test(t)) {
      joined = t;
      for (j = i; j < Math.min(lines.length, i + 3); j++) {
        if (j > i) joined += ' ' + lines[j].trim();
        for (var k = 0; k < QUOTE_HEADERS.length; k++) if (QUOTE_HEADERS[k].test(joined)) return { at: i, headerLines: j - i + 1 };
      }
    }
    if (HDR_FROM.test(t)) {                                           // Outlook block: From: / Sent: / To: / Subject:
      var hit = false;
      for (j = i + 1; j < Math.min(lines.length, i + 6); j++) if (HDR_SENT.test(lines[j].trim())) { hit = true; break; }
      if (hit) {
        var at = i;
        while (at > 0 && (!lines[at - 1].trim() || RULE.test(lines[at - 1].trim()))) { at--; if (RULE.test(lines[at].trim())) break; }
        return { at: at < i && RULE.test(lines[at].trim()) ? at : i, headerLines: 0 };
      }
    }
    if (/^\s*>/.test(lines[i])) {                                     // a trailing block of "> quoted" lines
      var allQuoted = true;
      for (j = i; j < lines.length; j++) if (lines[j].trim() && !/^\s*>/.test(lines[j])) { allQuoted = false; break; }
      if (allQuoted) return { at: i, headerLines: 0 };
    }
  }
  return null;
}

function cutSignature(lines) {
  var i, t;
  for (i = lines.length - 1; i >= 0 && i >= lines.length - 14; i--) {       // classic "-- " delimiter
    t = lines[i].replace(/\s+$/, '');
    if (t === '--' && i > 0) { return { body: lines.slice(0, i), sig: lines.slice(i + 1) }; }
  }
  for (i = Math.max(0, lines.length - 6); i < lines.length; i++) {          // device line + up to 3 short lines after it
    t = lines[i].trim();
    if (!t) continue;
    for (var k = 0; k < DEVICE_LINE.length; k++) {
      if (DEVICE_LINE[k].test(t)) {
        var rest = lines.slice(i + 1).filter(function (l) { return l.trim(); });
        if (rest.length <= 3 && rest.every(function (l) { return l.length <= 160; })) return { body: lines.slice(0, i), sig: lines.slice(i) };
      }
    }
  }
  return null;
}

function stripMarks(line) { return line.replace(/^(\s*>)+ ?/, ''); }
function join(lines) { return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(); }

function parse(text) {
  var src = unglue(normalize(text)), lines = src ? src.split('\n') : [];
  var out = { body: '', signature: '', quoted: '', quotedHeader: '' };
  if (!lines.length) return out;
  var q = findQuote(lines), fresh = lines;
  if (q) {
    fresh = lines.slice(0, q.at);
    var header = lines.slice(q.at, q.at + q.headerLines).map(function (l) { return l.trim(); }).join(' ');
    out.quotedHeader = header.slice(0, 300);
    out.quoted = join(lines.slice(q.at + q.headerLines).map(stripMarks)).slice(0, MAX_QUOTED);
    if (!out.quotedHeader && lines[q.at] && !/^\s*>/.test(lines[q.at]) && q.headerLines === 0) {       // "-----Original Message-----" style: the marker is the header
      var first = lines[q.at].trim();
      if (ORIGINAL_MARK.test(first)) { out.quotedHeader = first.replace(/^-+\s*|\s*-+$/g, ''); out.quoted = join(lines.slice(q.at + 1).map(stripMarks)).slice(0, MAX_QUOTED); }
    }
  }
  var sig = cutSignature(fresh);
  if (sig) { out.body = join(sig.body); out.signature = join(sig.sig); } else out.body = join(fresh);
  // Nothing recognisable at all (for example the whole message is "> quoted"): keep the text rather than show an empty reply.
  if (!out.body && !out.signature && !out.quoted) out.body = join(lines);
  return out;
}

// One-line preview of what the person wrote (never the quote or the signature).
function snippet(text, max) {
  var p = parse(text), s = (p.body || p.signature || p.quoted || '').replace(/\s+/g, ' ').trim();
  return s.length > (max || 160) ? s.slice(0, (max || 160) - 1) + '…' : s;
}

module.exports = { parse: parse, snippet: snippet, normalize: normalize };
