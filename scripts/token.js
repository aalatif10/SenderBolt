'use strict';
// Remote / tunnel access token helper: node scripts/token.js  (npm run token)
//   npm run token             show the token in effect; create SENDERBOLT_ACCESS_TOKEN in .env if there is none
//   npm run token -- --new    replace it with a fresh one (every device must enter the new token again)
// The token is stored only in .env (never commit that file). Open  https://YOUR-TUNNEL-ADDRESS/?token=THE_TOKEN  once on each device.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var file = path.join(process.cwd(), '.env');
var fresh = process.argv.indexOf('--new') !== -1;
var raw = '';
try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('No .env found here. Run "npm run init" first (in the SenderBolt folder).'); process.exit(1); }

function read(name) {
  var m = new RegExp('^\\s*' + name + '\\s*=\\s*(.*?)\\s*$', 'm').exec(raw);
  if (!m) return '';
  var v = m[1];
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
  return v;
}
var access = read('SENDERBOLT_ACCESS_TOKEN'), setup = read('SENDERBOLT_SETUP_TOKEN');
var inEffect = access || (setup.length >= 16 ? setup : ''), source = access ? 'SENDERBOLT_ACCESS_TOKEN' : 'SENDERBOLT_SETUP_TOKEN';

if (!inEffect || fresh) {
  var token = crypto.randomBytes(24).toString('hex');   // 48 hex characters
  if (/^\s*SENDERBOLT_ACCESS_TOKEN\s*=/m.test(raw)) raw = raw.replace(/^\s*SENDERBOLT_ACCESS_TOKEN\s*=.*$/m, 'SENDERBOLT_ACCESS_TOKEN=' + token);
  else raw = raw.replace(/\s*$/, '\n') + '# Remote / tunnel access token (npm run token). Devices that open the tunnel address must present it once.\nSENDERBOLT_ACCESS_TOKEN=' + token + '\n';
  fs.writeFileSync(file, raw, { mode: 384 });
  inEffect = token; source = 'SENDERBOLT_ACCESS_TOKEN';
  console.log(fresh ? 'New access token created. Devices that used the old one must enter this one.' : 'Access token created and saved to .env.');
} else {
  console.log('Access token in effect (from ' + source + ' in .env):');
}
console.log('');
console.log('  ' + inEffect);
console.log('');
console.log('Use it once per device: open  https://YOUR-TUNNEL-ADDRESS/?token=' + inEffect);
console.log('or open the address and type the token into the page. Restart SenderBolt after changing .env.');
