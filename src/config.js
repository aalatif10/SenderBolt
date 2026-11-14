'use strict';
// Configuration from environment (+ optional .env file, parsed here so no dotenv dependency).
// Fails fast on missing or weak secrets.
var fs = require('fs');
var path = require('path');
var vault = require('./lib/vault');
var tokens = require('./lib/tokens');

function loadEnvFile(file, env) {
  env = env || process.env;
  var raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  raw.split(/\r?\n/).forEach(function (line) {
    var m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().charAt(0) === '#') return;
    var v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  });
}

function build(env) {
  env = env || process.env;
  var host = env.HOST || '127.0.0.1';
  var port = env.PORT === undefined || env.PORT === '' ? 3000 : parseInt(env.PORT, 10);
  if (!(port >= 0 && port <= 65535)) throw new Error('PORT must be 0-65535');
  var secret = env.SENDERBOLT_SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('SENDERBOLT_SESSION_SECRET must be at least 32 characters (run: npm run init)');
  var hosts = [host + ':' + port, 'localhost:' + port, '127.0.0.1:' + port];
  var origins = hosts.map(function (h) { return 'http://' + h; });
  if (env.SENDERBOLT_PUBLIC_ORIGIN) {
    var o = env.SENDERBOLT_PUBLIC_ORIGIN.replace(/\/+$/, '');
    origins.push(o);
    hosts.push(o.replace(/^https?:\/\//, ''));
  }
  // Real sending is the only mode. SENDERBOLT_SENDING=off is a kill switch that stops the engine (nothing is simulated).
  var sending = (env.SENDERBOLT_SENDING || 'live').toLowerCase();
  if (sending === 'dry-run') throw new Error('SENDERBOLT_SENDING=dry-run no longer exists: SenderBolt always sends for real. Remove the line from .env (or use "off" to stop the engine).');
  if (['off', 'live'].indexOf(sending) === -1) throw new Error('SENDERBOLT_SENDING must be live (default) or off');
  var publicOrigin = '';
  if (env.SENDERBOLT_PUBLIC_ORIGIN) {
    var pu;
    try { pu = new URL(env.SENDERBOLT_PUBLIC_ORIGIN); } catch (e) { throw new Error('SENDERBOLT_PUBLIC_ORIGIN must be a full URL such as https://app.example.com'); }
    if (pu.protocol !== 'https:' && pu.protocol !== 'http:') throw new Error('SENDERBOLT_PUBLIC_ORIGIN must be http(s)');
    publicOrigin = pu.origin;
  }
  return {
    sending: sending, publicOrigin: publicOrigin,
    unsubSecret: tokens.hmac(secret, 'senderbolt:unsub:v1'),
    host: host, port: port,
    masterKey: vault.loadKey(env.SENDERBOLT_MASTER_KEY),
    sessionSecret: secret,
    setupToken: env.SENDERBOLT_SETUP_TOKEN || '',
    dbFile: env.SENDERBOLT_DB_FILE || path.join(process.cwd(), 'data', 'senderbolt.db'),
    secureCookies: env.SENDERBOLT_SECURE_COOKIES === '1',
    trustProxy: env.SENDERBOLT_TRUST_PROXY === '1',
    allowedHosts: hosts, allowedOrigins: origins
  };
}

module.exports = { build: build, loadEnvFile: loadEnvFile };
