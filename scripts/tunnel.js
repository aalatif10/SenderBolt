'use strict';
// Starts a localtunnel for a RUNNING SenderBolt and prints the ready-to-open phone link:  npm run tunnel
// It does what typing "lt --port 3000" by hand does, but it never hangs silently: it checks that SenderBolt answers first, gives each attempt
// 25 seconds to print a URL (then stops it and tries again, up to 3 times), fetches the loca.lt "tunnel password" for you and restarts the tunnel if it drops.
// Needs localtunnel installed once:  npm install -g localtunnel   (npx would download it again on every run, which is the slow part)
// Node 12 compatible. Nothing here is sent anywhere except the localtunnel service itself.
var http = require('http');
var https = require('https');
var cp = require('child_process');
var path = require('path');
var config = require('../src/config');

config.loadEnvFile(path.join(process.cwd(), '.env'));
var env = process.env;
var port = parseInt(env.PORT || '3000', 10) || 3000;
var token = env.SENDERBOLT_ACCESS_TOKEN || (env.SENDERBOLT_SETUP_TOKEN && env.SENDERBOLT_SETUP_TOKEN.length >= 16 ? env.SENDERBOLT_SETUP_TOKEN : '');
var ATTEMPT_MS = parseInt(env.SENDERBOLT_TUNNEL_ATTEMPT_MS, 10) || 25000, MAX_ATTEMPTS = 3, isWin = process.platform === 'win32';
var child = null, stopping = false;

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }

function localUp(cb) {
  var done = false;
  var r = http.get({ host: '127.0.0.1', port: port, path: '/api/auth/status', timeout: 3000 }, function (res) { res.resume(); if (!done) { done = true; cb(res.statusCode > 0); } });
  r.on('timeout', function () { r.destroy(); });
  r.on('error', function () { if (!done) { done = true; cb(false); } });
}

function killChild() {
  if (!child) return;
  try { if (isWin) cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else child.kill(); } catch (e) { /* already gone */ }
  child = null;
}

function tunnelPassword(cb) {   // loca.lt asks first-time visitors for the PUBLIC IP of the computer that runs the tunnel
  var done = false;
  var r = https.get('https://loca.lt/mytunnelpassword', { timeout: 8000 }, function (res) {
    var b = ''; res.on('data', function (c) { if (b.length < 200) b += c; }); res.on('end', function () { if (!done) { done = true; cb(/^[0-9a-fA-F:.]{3,45}$/.test(b.trim()) ? b.trim() : ''); } });
  });
  r.on('timeout', function () { r.destroy(); });
  r.on('error', function () { if (!done) { done = true; cb(''); } });
}

function attempt(n) {
  if (stopping) return;
  console.log('Starting the tunnel (attempt ' + n + ' of ' + MAX_ATTEMPTS + ')... this normally takes a few seconds.');
  var out = '', found = false;
  child = cp.spawn('lt', ['--port', String(port)], { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  var timer = setTimeout(function () {
    if (found) return;
    killChild();
    if (n < MAX_ATTEMPTS) { console.log('No answer from the tunnel service in ' + ATTEMPT_MS / 1000 + ' s. Trying again.'); attempt(n + 1); }
    else die('The tunnel service (localtunnel) did not answer 3 times in a row. It is a free public service and is often slow or down; this is not a SenderBolt problem.\nTry again in a few minutes, or use another tunnel such as cloudflared or ngrok (SenderBolt works with any of them, see the README).');
  }, ATTEMPT_MS);
  function onData(d) {
    out += d.toString();
    var m = /your url is:\s*(https:\/\/\S+)/i.exec(out);
    if (m && !found) { found = true; clearTimeout(timer); ready(m[1].replace(/[\r\n]+$/, '')); }
  }
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('error', function (e) {
    clearTimeout(timer);
    if (e && e.code === 'ENOENT') die('localtunnel is not installed. Install it once (this can take a minute):\n  npm install -g localtunnel\nthen run "npm run tunnel" again.');
    die('Could not start localtunnel: ' + e.message);
  });
  child.on('exit', function () {
    clearTimeout(timer); child = null;
    if (stopping) return;
    if (found) { console.log('\nThe tunnel closed. Opening a new one...'); setTimeout(function () { attempt(1); }, 2000); }
  });
}

function ready(url) {
  console.log('\n==================== Tunnel is up ====================');
  console.log('Open this on your phone (once per device):');
  console.log('  ' + url + '/?token=' + token);
  console.log('======================================================');
  console.log('Keep this window open. Press Ctrl+C to close the tunnel.\n');
  tunnelPassword(function (pw) {   // looked up AFTER the link is shown, so a slow lookup never delays it
    if (pw) console.log('First visit only: loca.lt shows a "tunnel password" page. Type this (the public IP of this computer):\n  ' + pw + '\n');
    else console.log('If loca.lt asks for a "tunnel password", open https://loca.lt/mytunnelpassword on THIS computer and type what it shows.\n');
  });
}

process.on('SIGINT', function () { stopping = true; killChild(); process.exit(0); });
process.on('exit', function () { stopping = true; killChild(); });

if (!token) die('There is no access token yet, so SenderBolt would refuse the tunnel address.\n  1. npm run token\n  2. restart SenderBolt (npm start)\n  3. npm run tunnel');
localUp(function (up) {
  if (!up) die('SenderBolt is not answering on port ' + port + '. Start it first in another window (npm start), then run "npm run tunnel".\n(A tunnel to a server that is not running shows "502 Bad Gateway".)');
  attempt(1);
});
