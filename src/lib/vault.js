'use strict';
// AES-256-GCM encryption for credentials at rest (sender app passwords).
// Format: v1.<iv>.<tag>.<ciphertext> (base64 parts). Optional AAD binds a
// ciphertext to its owner (e.g. "sender:12") so rows cannot be swapped.
var crypto = require('crypto');

function loadKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SENDERBOLT_MASTER_KEY must be 64 hex chars (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain, key, aad) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  var ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();
  return 'v1.' + [iv, tag, ct].map(function (b) { return b.toString('base64'); }).join('.');
}

function decrypt(token, key, aad) {
  var parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid ciphertext format');
  var iv = Buffer.from(parts[1], 'base64');
  var tag = Buffer.from(parts[2], 'base64');
  var ct = Buffer.from(parts[3], 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid ciphertext format');
  var decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { loadKey: loadKey, encrypt: encrypt, decrypt: decrypt };
