'use strict';
// .xlsx reader: real-world layouts, hostile files (zip bombs, encryption, truncation) and the import path.
var assert = require('assert');
var zlib = require('zlib');
var fs = require('fs');
var h = require('./helpers');
var xlsx = require('../src/lib/xlsx');
var Leads = require('../src/services/leads').Leads;

function zip(files, opts) {   // minimal zip writer (CRC left 0: the reader does not need it)
  opts = opts || {};
  var locals = [], central = [], off = 0;
  Object.keys(files).forEach(function (name) {
    var raw = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8'), comp = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    var l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(opts.flags || 0, 6); l.writeUInt16LE(8, 8); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(nb.length, 26);
    var c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(opts.flags || 0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, nb, comp); central.push(c, nb); off += 30 + nb.length + comp.length;
  });
  var cd = Buffer.concat(central), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat(locals.concat([cd, e]));
}
var BASE = {
  'xl/workbook.xml': '<workbook><sheets><sheet name="Leads" sheetId="1" r:id="rId7"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/data.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Email</t></si><si><t>First Name</t></si><si><t>Company</t></si><si><t>ann@alpha.com</t></si><si><r><t>An</t></r><r><t>n &amp; Co</t></r></si><si><t>=HYPERLINK("x")</t></si></sst>',
  'xl/worksheets/data.xml': '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Company</t></is></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="D2" t="s"><v>5</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>bob@beta.org</t></is></c><c r="B3"><v>42</v></c></row><row r="4"/></sheetData></worksheet>'
};

h.group('xlsx reader');
h.test('reads the sheet named by the workbook relationships: shared + inline strings, sparse columns, entities', function () {
  var rows = xlsx.readRows(zip(BASE));
  assert.deepStrictEqual(rows[0], ['Email', 'First Name', '', 'Company']);
  assert.deepStrictEqual(rows[1], ['ann@alpha.com', 'Ann & Co', '', '=HYPERLINK("x")']);   // text only: formulas are never evaluated
  assert.deepStrictEqual(rows[2], ['bob@beta.org', '42']);
});
h.test('hostile and broken files are rejected with friendly messages', function () {
  function bad(buf, re) { try { xlsx.readRows(buf); } catch (e) { assert.strictEqual(e.code, 'xlsx'); assert.ok(re.test(e.message), e.message); return; } assert.fail('should reject'); }
  bad(Buffer.from('hello world, not a zip at all'), /not a valid/);
  bad(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(40)]), /old \.xls|password/);
  bad(zip({ 'a.txt': 'x' }), /not an Excel/);
  bad(zip(BASE, { flags: 1 }), /password/);
  var good = zip(BASE); bad(good.slice(0, good.length - 30), /valid|damaged/);
  var bomb = Object.assign({}, BASE, { 'xl/worksheets/data.xml': Buffer.alloc(60 * 1024 * 1024, 32) });
  bad(zip(bomb), /too large/);
  bad(zip(Object.assign({}, BASE, { 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Target="../../etc/passwd"/></Relationships>' })), /unexpected layout|not be found/);
});
h.test('a real workbook written by Excel/openpyxl-style tools imports through the Leads service (formula-looking cells stay text)', function () {
  return h.freshDb().then(function (db) {
    return h.mkUser(db, 'a@x.com').then(function (a) {
      var svc = new Leads(db, { resolver: { resolveMx: function () { return Promise.resolve([{ exchange: 'm', priority: 1 }]); }, resolveAddr: function () { return Promise.resolve([]); } } });
      return svc.createFolder(a, 'F').then(function (f) {
        return svc.importLeads(a, f.id, 'xlsx', zip(BASE).toString('base64')).then(function (r) {
          assert.strictEqual(r.imported, 2);
          return svc.listLeads(a, f.id, { search: 'ann' });
        }).then(function (l) {
          assert.strictEqual(l.items[0].first_name, 'Ann & Co');
          return h.expectReject(svc.importLeads(a, f.id, 'xlsx', Buffer.from('nope').toString('base64')), 'validation');
        }).then(function () { return h.expectReject(svc.importLeads(a, f.id, 'xlsx', 'not base64 !!'), 'validation'); });
      });
    });
  });
});
h.run();
