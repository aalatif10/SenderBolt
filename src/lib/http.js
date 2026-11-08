'use strict';
// Tiny JSON response helpers that work with plain http and Express responses.

function sendJson(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (headers) Object.keys(headers).forEach(function (k) { res.setHeader(k, headers[k]); });
  res.end(JSON.stringify(body));
}

// Never leak internals: AppErrors expose code/message, everything else is generic.
function sendError(res, err) {
  if (err && err.name === 'AppError') {
    var headers = {};
    if (err.details && err.details.retryAfterMs) headers['Retry-After'] = String(Math.ceil(err.details.retryAfterMs / 1000));
    return sendJson(res, err.status, { error: err.code, message: err.message, details: err.code === 'validation' ? err.details : undefined }, headers);
  }
  return sendJson(res, 500, { error: 'internal_error', message: 'Something went wrong' });
}

module.exports = { sendJson: sendJson, sendError: sendError };
