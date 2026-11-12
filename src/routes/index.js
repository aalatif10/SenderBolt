'use strict';
// Route table assembly. Add new modules here (campaigns, inbox) as they are built.
var Router = require('../http/router').Router;

module.exports = function buildRoutes(deps) {
  var router = new Router();
  require('./auth')(router, deps);
  require('./senders')(router, deps);
  require('./leads')(router, deps);
  require('./campaigns')(router, deps);
  require('./projects')(router, deps);
  require('./drafts')(router, deps);
  require('./inbox')(router, deps);
  require('./public')(router, deps);
  return router.routes;
};
