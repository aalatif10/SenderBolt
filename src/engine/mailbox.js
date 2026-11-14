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
// Uses the "imap" and "mailparser" packages (see `npm run doctor` if they fail to load).

var BATCH = 100;

function createLive(opts) {
  var load = (opts && opts.require) || require;
  var Imap = null, parser = null;
  // Both libraries are loaded into locals first and only published when BOTH loaded, so a half-loaded state
  // (the cause of "Cannot read property 'simpleParser' of undefined") is impossible; a failure is retried next sync.
  function libs() {
    if (Imap && parser) return;
    var i, m, which = 'imap';
    try { i = load('imap'); which = 'mailparser'; m = load('mailparser'); } catch (e) {
      var err = new Error('Reply tracking could not load the "' + which + '" package: ' + String((e && e.message) || e).split('\n')[0] +
        ' - run "npm install", then "npm run doctor" for details');
      err.code = 'mailbox_libs'; throw err;
    }
    if (typeof m.simpleParser !== 'function') { var e2 = new Error('The installed "mailparser" has no simpleParser (unsupported version) - run "npm run doctor"'); e2.code = 'mailbox_libs'; throw e2; }
    Imap = i; parser = m;
  }
  function parseStream(stream) {
    return Promise.resolve().then(function () { return parser.simpleParser(stream); });   // sync throws become rejections
  }
  function withImap(creds, fn) {
    try { libs(); } catch (e) { return Promise.reject(e); }      // always a rejection, never a synchronous throw
    var imap;
    try { imap = new Imap({ user: creds.user, password: creds.pass, host: creds.host, port: creds.port, tls: true,
      tlsOptions: { servername: creds.host, minVersion: 'TLSv1.2' }, connTimeout: 15000, authTimeout: 15000 }); } catch (e2) { return Promise.reject(e2); }
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
              msg.on('body', function (stream) { try { info.parse = parseStream(stream); info.parse.catch(function () { /* handled at 'end' */ }); } catch (e) { info.parse = null; } });
              msg.once('attributes', function (a) { info.uid = a.uid; });
              msg.once('end', function () {
                pending.push(Promise.resolve(info.parse).then(function (p) { return { uid: info.uid, msg: p ? normalize(info.uid, p) : null }; },
                  function () { return { uid: info.uid, msg: null }; }).then(function (r) { return r; }));
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

module.exports = { createLive: createLive, BATCH: BATCH };
