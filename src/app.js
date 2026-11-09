'use strict';
// Composition root: opens the database, runs migrations, wires services, routes and the dispatcher.
var fs = require('fs');
var path = require('path');
var database = require('./db');
var migrate = require('./db/migrate').migrate;
var Sessions = require('./services/sessions').Sessions;
var Auth = require('./services/auth').Auth;
var Senders = require('./services/senders').Senders;
var Leads = require('./services/leads').Leads;
var CampaignsService = require('./services/campaigns').CampaignsService;
var RateLimiter = require('./security/rateLimiter').RateLimiter;
var ProjectsService = require('./services/projects').ProjectsService;
var InboxService = require('./services/inbox').InboxService;
var UnsubscribeService = require('./services/unsubscribe').UnsubscribeService;
var SenderTest = require('./services/senderTest').SenderTest;
var SendEngine = require('./engine/sendEngine').SendEngine;
var trackingOk = require('./engine/sendEngine').trackingOk;
var InboxSync = require('./engine/inboxSync').InboxSync;
var Scheduler = require('./engine/scheduler').Scheduler;
var mailerLib = require('./engine/mailer');
var mailboxLib = require('./engine/mailbox');
var createDispatcher = require('./http/router').createDispatcher;
var buildRoutes = require('./routes');

// config: see config.js. Optional extras for tests: config.resolver (DNS), config.dbDriver.
function createApp(config) {
  if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  return database.open(config.dbFile, { driver: config.dbDriver }).then(function (db) {
    return migrate(db).then(function () {
      var cookieName = config.secureCookies ? '__Host-sb_sid' : 'sb_sid';
      var sessions = new Sessions(db, { secret: config.sessionSecret });
      var auth = new Auth(db, sessions, {
        ipLimiter: new RateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }),
        emailLimiter: new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10 })
      });
      var mode = config.sending || 'dry-run';
      var log = config.log || function (m) { if (mode !== 'off') console.log('[engine] ' + m); };
      var mailer = config.mailer || (mode === 'live' ? mailerLib.createLive() : mailerLib.createDryRun(log));
      var mailbox = config.mailbox || (mode === 'live' ? mailboxLib.createLive() : mailboxLib.createDryRun());
      var engine = new SendEngine(db, { key: config.masterKey, mailer: mailer, now: config.now, unsubSecret: config.unsubSecret, publicOrigin: config.publicOrigin,
        requireReplyTracking: mode === 'live', log: log });
      var inboxSync = new InboxSync(db, { key: config.masterKey, mailbox: mailbox, now: config.now, log: log });
      var scheduler = new Scheduler(db, engine, inboxSync, { mode: mode, log: log, tickMs: config.tickMs, syncMs: config.syncMs });
      var deps = {
        config: config, db: db, cookieName: cookieName, sessions: sessions, auth: auth,
        senders: new Senders(db, config.masterKey),
        leads: new Leads(db, { resolver: config.resolver }),
        campaigns: new CampaignsService(db, { now: config.now }),
        inbox: new InboxService(db, { engine: mode === 'off' ? null : engine, now: config.now }),
        unsubscribe: new UnsubscribeService(db, { unsubSecret: config.unsubSecret, now: config.now }),
        inboxSync: mode === 'off' ? null : inboxSync,
        senderTest: new SenderTest(db, { key: config.masterKey, mailer: mailer, mailbox: mailbox, inboxSync: inboxSync, now: config.now })
      };
      deps.projects = new ProjectsService(db, { campaigns: deps.campaigns, now: config.now });
      deps.engineStatus = function (userId) {
        var t = (config.now || Date.now)();
        return db.all('SELECT id, email, status, health_score, next_send_at, last_error, imap_host, imap_last_uid, last_sync_at, sync_error FROM senders WHERE user_id = ? ORDER BY id', [userId]).then(function (rows) {
          return {
            mode: mode, public_origin_set: !!config.publicOrigin, last_tick_at: engine.lastTickAt, last_error: engine.lastError, last_sync_at: inboxSync.lastRunAt,
            senders: rows.map(function (r) {
              return { id: r.id, email: r.email, status: r.status, health_score: r.health_score, next_send_at: r.next_send_at, last_error: r.last_error,
                reply_tracking: r.imap_host ? (trackingOk(r, t, true) ? 'ok' : (r.sync_error ? 'error' : 'pending')) : 'not_configured', sync_error: r.sync_error, last_sync_at: r.last_sync_at };
            })
          };
        });
      };
      var dispatch = createDispatcher({
        routes: buildRoutes(deps), sessions: sessions, cookieName: cookieName,
        allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
        secureCookies: config.secureCookies, trustProxy: config.trustProxy
      });
      var purge = setInterval(function () { sessions.purgeExpired().catch(function () {}); }, 15 * 60 * 1000);
      if (purge.unref) purge.unref();
      return { dispatch: dispatch, db: db, engine: engine, inboxSync: inboxSync, scheduler: scheduler, mode: mode,
        close: function () { clearInterval(purge); scheduler.stop(); return db.close(); } };
    });
  });
}

module.exports = { createApp: createApp };
