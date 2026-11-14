'use strict';
// Entry point: node src/server.js   (or: npm start)
var http = require('http');
var path = require('path');
var config = require('./config');
var createApp = require('./app').createApp;

config.loadEnvFile(path.join(process.cwd(), '.env'));
var cfg;
try { cfg = config.build(process.env); } catch (e) { console.error('Configuration error: ' + e.message); process.exit(1); }

// A bad mail, a socket reset or a library error must never take the whole server down.
var crashes = [];
function guard(kind) {
  return function (e) {
    console.error('[' + kind + '] ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n'));
    var now = Date.now(); crashes.push(now);
    crashes = crashes.filter(function (t) { return now - t < 60000; });
    if (crashes.length > 20) { console.error('Too many unexpected errors in one minute - exiting.'); process.exit(1); }
  };
}
process.on('uncaughtException', guard('uncaughtException'));
process.on('unhandledRejection', guard('unhandledRejection'));

createApp(cfg).then(function (app) {
  var server = http.createServer(app.dispatch);
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
  server.listen(cfg.port, cfg.host, function () {
    console.log('SenderBolt listening on http://' + cfg.host + ':' + cfg.port + '  (db: ' + cfg.dbFile + ', driver: ' + app.db.driver + ')');
    console.log(cfg.sending === 'off' ? 'Sending engine: STOPPED (SENDERBOLT_SENDING=off)' : 'Sending engine: running - emails are sent for real');
    if (cfg.sending !== 'off' && !cfg.publicOrigin) console.warn('NOTE: SENDERBOLT_PUBLIC_ORIGIN is not set, so emails get a "reply to unsubscribe" footer instead of a one-click link.');
    app.scheduler.start();
    if (cfg.host !== '127.0.0.1' && !cfg.secureCookies) console.warn('WARNING: listening beyond localhost without SENDERBOLT_SECURE_COOKIES=1. Put HTTPS in front of it.');
  });
  function shutdown() {
    console.log('Shutting down...');
    server.close(function () { app.close().then(function () { process.exit(0); }, function () { process.exit(1); }); });
    setTimeout(function () { process.exit(1); }, 5000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch(function (e) { console.error('Startup failed: ' + e.message); process.exit(1); });
