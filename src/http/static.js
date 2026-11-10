'use strict';
// Serves the web UI from /public (GET/HEAD only). Hardening: extension allowlist, no path traversal
// (decoded, normalised, and confined to the public root after realpath, so symlinks cannot escape),
// no directory listings, no dotfiles, no-cache so updates show immediately. The CSP/nosniff/DENY
// headers are applied by the dispatcher before this runs.
var fs = require('fs');
var path = require('path');
var AppError = require('../lib/errors').AppError;

var TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function create(rootDir) {
  var root = fs.realpathSync(rootDir);
  return function serve(req, res, pathname) {
    return new Promise(function (resolve, reject) {
      var rel;
      try { rel = decodeURIComponent(pathname); } catch (e) { return reject(new AppError('bad_request', 'Bad URL', 400)); }
      if (rel.indexOf('\0') !== -1 || rel.indexOf('\\') !== -1) return reject(new AppError('not_found', 'Not found', 404));
      if (rel === '/' || rel === '') rel = '/index.html';
      var parts = rel.split('/').filter(Boolean);
      if (parts.some(function (p) { return p === '..' || p === '.' || p.charAt(0) === '.'; })) return reject(new AppError('not_found', 'Not found', 404));
      var type = TYPES[path.extname(rel).toLowerCase()];
      if (!type) return reject(new AppError('not_found', 'Not found', 404));
      fs.realpath(path.join(root, parts.join(path.sep)), function (err, real) {
        if (err || (real !== root && real.indexOf(root + path.sep) !== 0)) return reject(new AppError('not_found', 'Not found', 404));
        fs.readFile(real, function (e2, data) {
          if (e2) return reject(new AppError('not_found', 'Not found', 404));
          res.statusCode = 200;
          res.setHeader('Content-Type', type);
          res.setHeader('Content-Length', data.length);
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : data);
          resolve();
        });
      });
    });
  };
}

module.exports = { create: create };
