'use strict';
var util = require('util');

function AppError(code, message, status, details) {
  Error.call(this);
  this.name = 'AppError';
  this.code = code;
  this.message = message;
  this.status = status || 400;
  this.details = details || null;
}
util.inherits(AppError, Error);

module.exports = { AppError: AppError };
