'use strict';
// SMTP transport adapters. The engine only knows this interface:
//   mailer.send(creds, mail)  -> Promise<{ messageId }>   (rejects with nodemailer-style errors:
//                                 err.code, err.responseCode, err.response)
//   mailer.verify(creds)      -> Promise<true>            (rejects when it cannot log in)
// creds = { host, port, secure, user, pass }
// mail  = { from:{name,address}, to, subject, html, text, headers, messageId, inReplyTo, references[] }
//
// 'live'    uses nodemailer (npm install nodemailer). Plain-text SMTP is never allowed: ports that are
//           not implicit-TLS must upgrade with STARTTLS (requireTLS) and certificates are verified.
// 'dry-run' never touches the network; it pretends every send worked (safe for local testing).

function createLive() {
  var nodemailer;
  function lib() {
    if (!nodemailer) {
      try { nodemailer = require('nodemailer'); } catch (e) { throw new Error('Sending needs the "nodemailer" package. Run: npm install'); }
    }
    return nodemailer;
  }
  function transport(creds) {
    return lib().createTransport({
      host: creds.host, port: creds.port, secure: !!creds.secure, requireTLS: !creds.secure,
      auth: { user: creds.user, pass: creds.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: creds.host }
    });
  }
  return {
    mode: 'live',
    send: function (creds, mail) {
      var tr = transport(creds);
      var opts = {
        from: { name: mail.from.name || '', address: mail.from.address }, to: mail.to, subject: mail.subject,
        html: mail.html, text: mail.text, messageId: mail.messageId, headers: mail.headers || {}
      };
      if (mail.inReplyTo) opts.inReplyTo = mail.inReplyTo;
      if (mail.references && mail.references.length) opts.references = mail.references;
      return tr.sendMail(opts).then(function (info) { tr.close(); return { messageId: info.messageId || mail.messageId }; },
        function (err) { try { tr.close(); } catch (e) { /* ignore */ } throw err; });
    },
    verify: function (creds) {
      var tr = transport(creds);
      return tr.verify().then(function () { tr.close(); return true; }, function (err) { try { tr.close(); } catch (e) { /* ignore */ } throw err; });
    }
  };
}

function createDryRun(log) {
  return {
    mode: 'dry-run',
    send: function (creds, mail) {
      if (log) log('[dry-run] would send "' + mail.subject + '" from ' + mail.from.address + ' to ' + mail.to);
      return Promise.resolve({ messageId: mail.messageId });
    },
    verify: function () { return Promise.resolve(true); }
  };
}

module.exports = { createLive: createLive, createDryRun: createDryRun };
