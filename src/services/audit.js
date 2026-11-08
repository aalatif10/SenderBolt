'use strict';
// Append-only audit trail. Metadata is redacted so secrets can never land in the log.

var SENSITIVE = /pass|secret|token|key|authorization|cookie|signature_html/i;

function redact(value, depth) {
  if (depth > 3) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map(function (v) { return redact(v, depth + 1); });
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (k) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(value[k], depth + 1);
    });
    return out;
  }
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '...';
  return value;
}

// db may be the Database or a transaction object (both expose run()).
function log(db, e, now) {
  var meta = e.meta ? JSON.stringify(redact(e.meta, 0)).slice(0, 2000) : null;
  return db.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, ip, meta, created_at) VALUES (?,?,?,?,?,?,?)',
    [e.userId || null, e.action, e.entity || null, e.entityId || null, e.ip || null, meta, (now || Date.now)()]
  );
}

module.exports = { log: log, redact: redact };
