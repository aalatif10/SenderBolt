'use strict';
// Inline images for emails (logos, small pictures) - src/services/images.js
//
// How it works (and why):
//   * The editor uploads a picture once. It is validated by its first bytes (PNG/JPEG/GIF/WebP only), size-limited,
//     stripped of EXIF/GPS data and stored in the database (table email_images), scoped to the user.
//   * Email HTML refers to it as  <img src="sbimg:<id>" alt width height>  (the sanitizer allows ONLY that form, so no
//     external picture, tracker or data: URI can ever get into a campaign).
//   * At send time embed() swaps each reference for a CID reference and attaches the bytes as an inline MIME part
//     (multipart/related). The recipient's mail app shows the picture without contacting any server, and the email
//     is one small self-contained message: no hosting, no hot-linking, no "load remote images" banner.
//   * Deliverability guard rails: upload limit 300 KB, a few images per email, always an alt text, and a nudge in the
//     editor toward small logos. Anything over the per-email cap is dropped at send time rather than blocking the lead.
var crypto = require('crypto');
var AppError = require('../lib/errors').AppError;
var text = require('../lib/text');
var imageMeta = require('../lib/imageMeta');
var audit = require('./audit');

var MAX_UPLOAD = 300 * 1024;        // bytes, as uploaded
var MAX_IMAGES = 100;               // per user
var MAX_TOTAL = 25 * 1024 * 1024;   // per user
var MAX_PER_EMAIL = 5;              // distinct images embedded in one email (body + signature)
var MAX_EMAIL_BYTES = 1024 * 1024;  // all embedded images of one email together
var REF = /<img\b[^>]*?\bsrc="sbimg:(\d{1,15})"[^>]*>/g;

function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }
function ImagesService(db, deps) { this.db = db; this.now = (deps && deps.now) || Date.now; }
var I = ImagesService.prototype;

function describe(r) { return { id: r.id, name: r.name, mime: r.mime, width: r.width, height: r.height, size: r.size, created_at: r.created_at }; }

// input: { name, data } where data is the file as base64 (the JSON API cannot carry raw bytes)
I.upload = function (userId, input, ip) {
  var self = this, buf, name, meta;
  return Promise.resolve().then(function () {
    input = input || {};
    var b64 = typeof input.data === 'string' ? input.data.replace(/^data:[^,]*,/, '') : '';
    if (!b64 || b64.length > Math.ceil(MAX_UPLOAD * 4 / 3) + 8 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(b64)) throw bad('data', 'Choose a picture of at most ' + Math.round(MAX_UPLOAD / 1024) + ' KB. For emails a small logo (under 100 KB) is best.');
    buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_UPLOAD) throw bad('data', 'This picture is ' + Math.round(buf.length / 1024) + ' KB. The limit is ' + Math.round(MAX_UPLOAD / 1024) + ' KB, because heavy emails are more likely to land in spam.');
    try { meta = imageMeta.inspect(buf); } catch (e) { if (e && e.code === 'bad_image') throw bad('data', e.message); throw e; }
    name = text.cleanText(String(input.name || '').replace(/\.[a-z0-9]{2,5}$/i, ''), 80) || 'Picture';
    var hash = crypto.createHash('sha256').update(meta.data).digest('hex');
    return self.db.get('SELECT * FROM email_images WHERE user_id = ? AND sha256 = ?', [userId, hash]).then(function (dup) {
      if (dup) return { image: describe(dup), existing: true };
      return self.db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM email_images WHERE user_id = ?', [userId]).then(function (tot) {
        if (tot.n >= MAX_IMAGES) throw new AppError('conflict', 'You have reached ' + MAX_IMAGES + ' saved pictures. Delete unused ones first.', 409);
        if (Number(tot.bytes) + meta.data.length > MAX_TOTAL) throw new AppError('conflict', 'Your saved pictures take too much space. Delete unused ones first.', 409);
        var t = self.now();
        return self.db.run('INSERT INTO email_images (user_id, name, mime, width, height, size, sha256, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [userId, name, meta.mime, meta.width, meta.height, meta.data.length, hash, meta.data, t]).then(function (r) {
          return audit.log(self.db, { userId: userId, action: 'image.upload', entity: 'image', entityId: r.lastID, ip: ip, meta: { bytes: meta.data.length, mime: meta.mime } }, self.now).then(function () {
            return { image: describe({ id: r.lastID, name: name, mime: meta.mime, width: meta.width, height: meta.height, size: meta.data.length, created_at: t }), existing: false };
          });
        });
      });
    });
  });
};

I.list = function (userId) {
  return this.db.all('SELECT id, name, mime, width, height, size, created_at FROM email_images WHERE user_id = ? ORDER BY id DESC LIMIT ' + MAX_IMAGES, [userId]).then(function (rows) { return { items: rows.map(describe) }; });
};

// -> { mime, data: Buffer, name } or 404 (foreign ids look exactly like missing ones)
I.read = function (userId, id) {
  return this.db.get('SELECT name, mime, data FROM email_images WHERE id = ? AND user_id = ?', [id, userId]).then(function (r) {
    if (!r) throw new AppError('not_found', 'Picture not found', 404);
    return { mime: r.mime, name: r.name, data: Buffer.from(r.data) };
  });
};

// Where is this picture used? Counted so that deleting a picture that live campaigns still show is refused.
I.usage = function (userId, id) {
  var plain = '%src="sbimg:' + id + '"%', json = '%src=\\"sbimg:' + id + '\\"%', db = this.db;
  return Promise.all([
    db.get('SELECT COUNT(DISTINCT s.campaign_id) AS n FROM campaign_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE c.user_id = ? AND s.body_html LIKE ?', [userId, plain]),
    db.get('SELECT COUNT(*) AS n FROM senders WHERE user_id = ? AND signature_html LIKE ?', [userId, plain]),
    db.get('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ? AND default_signature_html LIKE ?', [userId, plain]),
    db.get('SELECT COUNT(*) AS n FROM wizard_drafts WHERE user_id = ? AND data LIKE ?', [userId, json])
  ]).then(function (r) { return { campaigns: r[0].n, senders: r[1].n, default_signature: r[2].n, drafts: r[3].n, total: r[0].n + r[1].n + r[2].n + r[3].n }; });
};

I.remove = function (userId, id, ip) {
  var self = this;
  return this.db.get('SELECT id FROM email_images WHERE id = ? AND user_id = ?', [id, userId]).then(function (r) {
    if (!r) throw new AppError('not_found', 'Picture not found', 404);
    return self.usage(userId, id);
  }).then(function (u) {
    if (u.total) throw new AppError('conflict', 'This picture is still used in ' + [u.campaigns ? u.campaigns + ' campaign(s)' : '', u.senders ? u.senders + ' sender signature(s)' : '', u.default_signature ? 'your default signature' : '', u.drafts ? u.drafts + ' draft(s)' : ''].filter(Boolean).join(', ') + '. Remove it there first.', 409);
    return self.db.run('DELETE FROM email_images WHERE id = ? AND user_id = ?', [id, userId]);
  }).then(function () { return audit.log(self.db, { userId: userId, action: 'image.delete', entity: 'image', entityId: id, ip: ip }, self.now); })
    .then(function () { return { ok: true }; });
};

// Ids referenced by sbimg: sources in some HTML, in order, unique.
function referencedIds(html) {
  var ids = [], m, re = new RegExp(REF.source, 'g');
  while ((m = re.exec(String(html || '')))) { var n = parseInt(m[1], 10); if (ids.indexOf(n) === -1) ids.push(n); }
  return ids;
}

// html -> { html, attachments }: every <img src="sbimg:N"> becomes <img src="cid:..."> and the bytes travel inline.
// Missing pictures (deleted, foreign) and pictures over the per-email caps are removed; the email itself is still sent.
function embed(db, userId, html) {
  var ids = referencedIds(html);
  if (!ids.length) return Promise.resolve({ html: html, attachments: [] });
  var use = ids.slice(0, MAX_PER_EMAIL);
  return db.all('SELECT id, name, mime, data FROM email_images WHERE user_id = ? AND id IN (' + use.map(function () { return '?'; }).join(',') + ')', [userId].concat(use)).then(function (rows) {
    var byId = {}, total = 0, attachments = [];
    rows.forEach(function (r) {
      var data = Buffer.from(r.data);
      if (total + data.length > MAX_EMAIL_BYTES) return;
      total += data.length; byId[r.id] = true;
      attachments.push({ cid: 'sbimg-' + r.id + '@senderbolt', filename: (r.name || 'image').replace(/[^\w.\- ]+/g, '') + '.' + imageMeta.EXT[r.mime], contentType: r.mime, content: data });
    });
    var out = String(html).replace(new RegExp(REF.source, 'g'), function (tag, id) {
      var n = parseInt(id, 10);
      return byId[n] ? tag.replace('src="sbimg:' + id + '"', 'src="cid:sbimg-' + n + '@senderbolt"') : '';
    });
    return { html: out, attachments: attachments };
  });
}

module.exports = { ImagesService: ImagesService, embed: embed, referencedIds: referencedIds, MAX_UPLOAD: MAX_UPLOAD, MAX_PER_EMAIL: MAX_PER_EMAIL };
