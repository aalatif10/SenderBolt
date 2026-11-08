'use strict';
// Dependency-free CSV parser (quotes, escaped quotes, CRLF, BOM, delimiter
// sniffing) plus CSV/formula-injection neutralization for imports and exports.

var MAX_CELLS = 2000000;

function sniffDelimiter(text) {
  var firstLine = text.split(/\r?\n/, 1)[0] || '';
  var best = ',', bestCount = -1;
  [',', ';', '\t'].forEach(function (d) {
    var c = firstLine.split(d).length - 1;
    if (c > bestCount) { best = d; bestCount = c; }
  });
  return best;
}

function parse(text, opts) {
  opts = opts || {};
  text = String(text);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var delim = opts.delimiter || sniffDelimiter(text);
  var rows = [], row = [], cell = '', inQ = false, cells = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { inQ = false; }
      } else { cell += ch; }
    } else if (ch === '"' && cell === '') {
      inQ = true;
    } else if (ch === delim) {
      row.push(cell); cell = ''; if (++cells > MAX_CELLS) throw new Error('CSV too large');
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else { cell += ch; }
  }
  if (inQ) throw new Error('Unterminated quoted field');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Neutralize spreadsheet formula injection: cells starting with = + - @ TAB CR
// are prefixed with an apostrophe so Excel/Sheets treat them as text.
function sanitizeCell(value) {
  var s = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function stringify(rows) {
  return rows.map(function (r) {
    return r.map(function (v) {
      var s = sanitizeCell(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n') + '\r\n';
}

module.exports = { parse: parse, sanitizeCell: sanitizeCell, stringify: stringify };
