'use strict';
// IMAP mailbox adapters (reply + bounce detection). The inbox sync only knows this interface:
//   mailbox.baseline(creds)           -> Promise<{ uidValidity, lastUid }>   (current end of INBOX)
//   mailbox.fetchSince(creds, state)  -> Promise<{ uidValidity, lastUid, reset, messages[] }>
//   mailbox.verify(creds)             -> Promise<true>
// creds = { host, port, user, pass }.  The INBOX is opened READ-ONLY: SenderBolt never marks mail as
// read, moves or deletes anything in the user's mailbox.
// normalized message = { uid, messageId, inReplyTo, references[], from, fromName, to, subject, date,
//   text, html, autoSubmitted, precedence, xAutoreply, xAutoResponseSuppress, contentType, dsn }
//
// 'live' uses the "imap" and "mailparser" packages. NOTE: written to their documented APIs; it has not
// been run against a real mailbox yet (see docs/ARCHITECTURE.md).

var BATCH = 100;

function createLive() {
  var Imap, parser;
  function libs() {
    if (!Imap) {
      try { Imap = require('imap'); parser = require('mailparser'); } catch (e) { throw new Error('Reply tracking needs the "imap" and "mailparser" packages. Run: npm install'); }
    }
  }
  function withImap(creds, fn) {
    libs();
    var imap = new Imap({ user: creds.user, password: creds.pass, host: creds.host, port: creds.port, tls: true,
      tlsOptions: { servername: creds.host, minVersion: 'TLSv1.2' }, connTimeout: 15000, authTimeout: 15000 });
    var lateError = null;
    imap.on('error', function (e) { lateError = e; });                   // never let a socket error crash the process
    return new Promise(function (resolve, reject) {
      imap.once('ready', resolve); imap.once('error', reject); imap.connect();
    }).then(function () {
      return new Promise(function (resolve, reject) {
        imap.openBox('INBOX', true, function (err, box) { if (err) reject(err); else resolve(box); });   // true = read-only
      });
    }).then(function (box) { return fn(imap, box); }).then(function (r) { try { imap.end(); } catch (e) { /* ignore */ } return r; },
      function (e) { try { imap.end(); } catch (x) { /* ignore */ } throw e; });
  }
  function header(p, name) {
    var v = p.headers && p.headers.get ? p.headers.get(name) : null;
    if (v && typeof v === 'object' && v.value !== undefined) v = v.value;
    return v ? String(v) : '';
  }
  function normalize(uid, p) {
    var refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
    var from = p.from && p.from.value && p.from.value[0] ? p.from.value[0] : {};
    var to = p.to && p.to.value && p.to.value[0] ? p.to.value[0].address : '';
    var dsn = null;
    (p.attachments || []).forEach(function (a) {
      if (/delivery-status/i.test(a.contentType || '') && a.content) dsn = (dsn || '') + a.content.toString('utf8').slice(0, 20000);
    });
    return {
      uid: uid, messageId: p.messageId || null, inReplyTo: p.inReplyTo || null, references: refs,
      from: from.address || '', fromName: from.name || '', to: to, subject: p.subject || '', date: p.date ? +p.date : null,
      text: String(p.text || '').slice(0, 100000), html: typeof p.html === 'string' ? p.html.slice(0, 200000) : null,
      autoSubmitted: header(p, 'auto-submitted'), precedence: header(p, 'precedence'),
      xAutoreply: header(p, 'x-autoreply') || header(p, 'x-autorespond'), xAutoResponseSuppress: header(p, 'x-auto-response-suppress'),
      contentType: header(p, 'content-type'), dsn: dsn
    };
  }
  return {
    mode: 'live',
    verify: function (creds) { return withImap(creds, function () { return true; }); },
    baseline: function (creds) {
      return withImap(creds, function (imap, box) { return { uidValidity: box.uidvalidity, lastUid: Math.max(0, (box.uidnext || 1) - 1) }; });
    },
    fetchSince: function (creds, st) {
      return withImap(creds, function (imap, box) {
        if (box.uidvalidity !== st.uidValidity) return { uidValidity: box.uidvalidity, lastUid: Math.max(0, (box.uidnext || 1) - 1), reset: true, messages: [] };
        return new Promise(function (resolve, reject) {
          imap.search([['UID', (st.lastUid + 1) + ':*']], function (err, uids) {
            if (err) return reject(err);
            uids = (uids || []).filter(function (u) { return u > st.lastUid; }).sort(function (a, b) { return a - b; }).slice(0, BATCH);
            if (!uids.length) return resolve({ uidValidity: box.uidvalidity, lastUid: st.lastUid, messages: [] });
            var pending = [], f = imap.fetch(uids, { bodies: '' });
            f.on('message', function (msg) {
              var info = { uid: null, parse: null };
              msg.on('body', function (stream) { info.parse = parser.simpleParser(stream); });
              msg.once('attributes', function (a) { info.uid = a.uid; });
              msg.once('end', function () {
                pending.push(Promise.resolve(info.parse).then(function (p) { return { uid: info.uid, msg: p ? normalize(info.uid, p) : null }; },
                  function () { return { uid: info.uid, msg: null }; }));
              });
            });
            f.once('error', reject);
            f.once('end', function () {
              Promise.all(pending).then(function (rows) {
                rows.sort(function (a, b) { return a.uid - b.uid; });
                var top = rows.reduce(function (m, r) { return r.uid > m ? r.uid : m; }, st.lastUid);
                resolve({ uidValidity: box.uidvalidity, lastUid: top, messages: rows.filter(function (r) { return r.msg; }).map(function (r) { return r.msg; }) });
              }, reject);
            });
          });
        });
      });
    }
  };
}

function createDryRun() {
  return {
    mode: 'dry-run',
    verify: function () { return Promise.resolve(true); },
    baseline: function () { return Promise.resolve({ uidValidity: 1, lastUid: 0 }); },
    fetchSince: function (creds, st) { return Promise.resolve({ uidValidity: st.uidValidity, lastUid: st.lastUid, messages: [] }); }
  };
}

module.exports = { createLive: createLive, createDryRun: createDryRun, BATCH: BATCH };
