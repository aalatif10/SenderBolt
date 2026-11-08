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
      var deps = {
        config: config, db: db, cookieName: cookieName, sessions: sessions, auth: auth,
        senders: new Senders(db, config.masterKey),
        leads: new Leads(db, { resolver: config.resolver }),
        campaigns: new CampaignsService(db)
      };
      var dispatch = createDispatcher({
        routes: buildRoutes(deps), sessions: sessions, cookieName: cookieName,
        allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
        secureCookies: config.secureCookies, trustProxy: config.trustProxy
      });
      var purge = setInterval(function () { sessions.purgeExpired().catch(function () {}); }, 15 * 60 * 1000);
      if (purge.unref) purge.unref();
      return { dispatch: dispatch, db: db, close: function () { clearInterval(purge); return db.close(); } };
    });
  });
}

module.exports = { createApp: createApp };
