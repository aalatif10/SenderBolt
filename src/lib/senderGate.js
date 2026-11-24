'use strict';
// Reply-tracking gate shared by the sending engine and the "next email" calculation (one rule, one place).
var SYNC_FRESH_MS = 15 * 60000;

// May this sender send right now as far as reply tracking goes? Reply detection exists so that nobody gets a follow-up after
// answering; a sender whose inbox cannot be checked (never armed, failing, or not checked for 15 minutes) waits.
function trackingOk(s, t, required) {
  if (!required || !s.imap_host || s.reply_detection === 0) return true;     // reply detection switched off by the owner: nothing to wait for
  return s.imap_last_uid !== null && s.imap_last_uid !== undefined && (!s.sync_error || s.sync_transient === 1) && s.last_sync_at !== null && s.last_sync_at !== undefined && t - s.last_sync_at <= SYNC_FRESH_MS;
}

// Whether the running engine requires reply tracking (app.js turns it on, exactly like the engine's requireReplyTracking).
// The display side (services/nextEmail.js) reads it so a countdown is never shown for a sender the engine will hold back.
var required = false;
function setRequired(on) { required = !!on; }
function isRequired() { return required; }

module.exports = { trackingOk: trackingOk, SYNC_FRESH_MS: SYNC_FRESH_MS, setRequired: setRequired, isRequired: isRequired };
