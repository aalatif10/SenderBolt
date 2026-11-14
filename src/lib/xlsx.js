'use strict';
// Minimal, defensive .xlsx reader (first worksheet only, values only; formulas are never evaluated).
// An .xlsx is a ZIP of XML files. We read the ZIP central directory ourselves and inflate only the three
// parts we need, with hard limits against zip bombs and malformed files:
//   - total file <= MAX_FILE, entries <= MAX_ENTRIES, each inflated part <= MAX_PART (zlib maxOutputLength)
//   - rows <= MAX_ROWS, columns <= MAX_COLS, cell text <= MAX_CELL
//   - encrypted / password protected / macro-only / non-xlsx files are rejected with a plain message
// No XML parser is used (regex tokenizer over a bounded string), so no entity expansion or external fetches can happen.
var zlib = require('zlib');

var MAX_FILE = 8 * 1024 * 1024, MAX_ENTRIES = 2000, MAX_PART = 40 * 1024 * 1024, MAX_ROWS = 60000, MAX_COLS = 60, MAX_CELL = 2000;

function fail(msg) { var e = new Error(msg); e.code = 'xlsx'; return e; }

function readZip(buf) {
  if (buf.length < 22 || buf.length > MAX_FILE) throw fail('The Excel file is empty or too large (max 8 MB). Save it as CSV instead.');
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    if (buf.slice(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') throw fail('This looks like an old .xls file or a password-protected workbook. Open it in Excel and use Save As: Excel Workbook (.xlsx), or CSV.');
    throw fail('This is not a valid .xlsx file.');
  }
  var eocd = -1, i;
  for (i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw fail('This is not a valid .xlsx file (zip directory not found).');
  var count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || cdOff + cdSize > buf.length) throw fail('This .xlsx file looks damaged.');
  var entries = {}, p = cdOff, n;
  for (n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail('This .xlsx file looks damaged.');
    var flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    var nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    var name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    entries[name] = { flags: flags, method: method, csize: csize, usize: usize, lho: lho };
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function readPart(buf, entries, name) {
  var e = entries[name];
  if (!e) return null;
  if (e.flags & 1) throw fail('This workbook is password protected. Remove the password, or save it as CSV.');
  if (e.usize > MAX_PART) throw fail('This workbook is too large to import. Save it as CSV instead.');
  var o = e.lho;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw fail('This .xlsx file looks damaged.');
  var start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  if (start + e.csize > buf.length) throw fail('This .xlsx file looks damaged.');
  var raw = buf.slice(start, start + e.csize);
  try {
    if (e.method === 0) return raw.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART }).toString('utf8');
  } catch (err) { throw fail('This workbook is too large or damaged to import. Save it as CSV instead.'); }
  throw fail('This .xlsx file uses an unsupported compression.');
}

var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, g) {
    if (g[0] === '#') { var c = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return c > 0 && c < 0x110000 && !(c >= 0xd800 && c < 0xe000) ? String.fromCodePoint(c) : ''; }
    return ENT[g.toLowerCase()];
  });
}
function textOf(xml) {   // concatenate <t> runs (rich text), skipping phonetic <rPh>
  xml = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
  while ((m = re.exec(xml)) !== null) out += unxml(m[1]);
  return out;
}
function colIndex(ref) {
  var m = /^([A-Z]{1,3})\d+$/.exec(ref), n = 0, i;
  if (!m) return -1;
  for (i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
  return n - 1;
}

// Returns rows: array of arrays of strings (first worksheet). Throws Error{code:'xlsx'} with a user-friendly message.
function readRows(buf) {
  var entries = readZip(buf);
  if (!entries['xl/workbook.xml']) throw fail('This is not an Excel workbook (.xlsx).');
  var sheetPath = 'xl/worksheets/sheet1.xml';
  var wb = readPart(buf, entries, 'xl/workbook.xml'), rels = readPart(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    var sm = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    if (sm) {
      var rm = new RegExp('<Relationship\\b[^>]*\\bId="' + sm[1].replace(/[^A-Za-z0-9_\-]/g, '') + '"[^>]*>').exec(rels), tm = rm && /\bTarget="([^"]+)"/.exec(rm[0]);
      if (tm) sheetPath = tm[1].charAt(0) === '/' ? tm[1].slice(1) : 'xl/' + tm[1].replace(/^\.\//, '');
    }
  }
  if (!/^xl\/[A-Za-z0-9_\-\/\.]+\.xml$/.test(sheetPath) || sheetPath.indexOf('..') !== -1) throw fail('This workbook has an unexpected layout.');
  var sheet = readPart(buf, entries, sheetPath);
  if (!sheet) throw fail('The first sheet of this workbook could not be found.');
  var strings = [], ss = readPart(buf, entries, 'xl/sharedStrings.xml');
  if (ss) {
    var sre = /<si\b[^>]*>([\s\S]*?)<\/si>/g, sx;
    while ((sx = sre.exec(ss)) !== null && strings.length < 2000000) strings.push(textOf(sx[1]).slice(0, MAX_CELL));
  }
  var rows = [], rre = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g, rx;
  while ((rx = rre.exec(sheet)) !== null) {
    if (rows.length >= MAX_ROWS) throw fail('This sheet has more than ' + MAX_ROWS + ' rows. Split it into smaller files.');
    var row = [], cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cx, seq = 0;
    while (rx[1] && (cx = cre.exec(rx[1])) !== null) {
      var attrs = cx[1], body = cx[2] || '', ref = /\br="([A-Z]+\d+)"/.exec(attrs), type = /\bt="([a-zA-Z]+)"/.exec(attrs);
      var idx = ref ? colIndex(ref[1]) : seq; seq = idx + 1;
      if (idx < 0 || idx >= MAX_COLS) continue;
      var val = '';
      if (type && type[1] === 'inlineStr') val = textOf(body);
      else {
        var vm = /<v>([\s\S]*?)<\/v>/.exec(body); val = vm ? unxml(vm[1]) : '';
        if (type && type[1] === 's') val = strings[parseInt(val, 10)] || '';
        else if (type && type[1] === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        else if (type && type[1] === 'e') val = '';
      }
      while (row.length < idx) row.push('');
      row[idx] = val.slice(0, MAX_CELL);
    }
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();
  return rows;
}

module.exports = { readRows: readRows, MAX_FILE: MAX_FILE };
