'use strict';
// npm run doctor - checks the runtime and the optional mail libraries and prints the REAL error if one fails.
var out = [], bad = 0;
function check(name, fn) {
  try { out.push('  ok    ' + name + (fn() ? ' (' + fn() + ')' : '')); }
  catch (e) { bad++; out.push('  FAIL  ' + name + ': ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        ')); }
}
console.log('Node ' + process.version + ' on ' + process.platform);
if (parseInt(process.versions.node, 10) < 12) { bad++; console.log('  FAIL  Node 12 or newer is required'); }
check('sqlite3', function () { require('sqlite3'); return require('sqlite3/package.json').version; });
check('nodemailer (SMTP sending)', function () { require('nodemailer'); return require('nodemailer/package.json').version; });
check('imap (reply tracking)', function () { require('imap'); return require('imap/package.json').version; });
check('mailparser (reply tracking)', function () {
  var m = require('mailparser');
  if (typeof m.simpleParser !== 'function') throw new Error('simpleParser is missing from this mailparser version');
  return require('mailparser/package.json').version;
});
console.log(out.join('\n'));
if (bad) { console.log('\nFix: run "npm install" in this folder. If a package still fails, send the FAIL lines above.'); process.exit(1); }
console.log('\nAll good.');
