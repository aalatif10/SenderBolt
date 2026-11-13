'use strict';
// "Send me a test email" (src/services/testSend.js).
// Sends ONE real email, composed exactly like a campaign email (same template engine, sanitizer, signature,
// footer), from one of the user's own senders to a test address, so formatting can be checked in a real inbox.
// Safety rules:
//  - never touches campaigns, leads, counters or suppression: it cannot start, advance or affect a campaign;
//  - the recipient defaults to the user's own login address; any other address must be written correctly
//    and is limited by the route rate limit (10 per 10 minutes per user);
//  - only an ACTIVE sender owned by the user can be used; its limit for today must not be used up;
//  - subject is prefixed "[TEST]"; the unsubscribe link is NOT generated (it could not work for a test);
//  - in dry-run mode nothing is sent and the answer says so;
//  - errors are reduced to friendly text (no server responses, never the password).
var AppError = require('../lib/errors').AppError;
var email = require('../lib/email');
var text = require('../lib/text');
var tpl = require('../lib/template');
var v = require('../lib/validate');
var sanitize = require('../lib/sanitize');
var sendErrors = require('../lib/sendErrors');
var throttle = require('../lib/throttle');
var audit = require('./audit');
var withSignature = require('./settings').withSignature;

var SAMPLE_LEAD = { first_name: 'Alex', last_name: 'Morgan', company: 'Acme Domains', email: 'alex@acme-domains.com', domain: 'acme-domains.com' };
function bad(field, msg) { var d = {}; d[field] = msg; return new AppError('validation', msg, 400, d); }

function TestSendService(db, deps) { this.db = db; this.engine = deps.engine; this.mailer = deps.mailer; this.now = deps.now || Date.now; }
var T = TestSendService.prototype;

// user: { id, email }; input: { sender_id, to?, subject, body_html, previous_subject?, lead_id? }
T.send = function (user, input, ip) {
  var self = this, sender, lead = SAMPLE_LEAD, usedLead = false, to, sid, previous;
  return Promise.resolve().then(function () {
    input = input || {};
    sid = v.intIn(input.sender_id, 1, 9007199254740991);
    if (sid === null) throw bad('sender_id', 'Choose which sender account to send the test from');
    to = input.to === undefined || input.to === null || input.to === '' ? user.email : String(input.to).trim();
    var chk = email.checkSyntax(to);
    if (!chk.ok || to.length > 254) throw bad('to', 'Enter a valid email address for the test');
    var subject = typeof input.subject === 'string' ? input.subject : '', body = typeof input.body_html === 'string' ? input.body_html : '';
    if (subject.length > 200 || body.length > 50000 || text.hasControl(subject)) throw bad('subject', 'Subject or message is too long or invalid');
    previous = typeof input.previous_subject === 'string' ? input.previous_subject.slice(0, 200) : '';
    if (text.hasControl(previous)) previous = '';
    if (!subject.trim() && !previous) throw bad('subject', 'Add a subject first');
    if (sanitize.isBlank(sanitize.clean(body))) throw bad('body_html', 'Write the message first');
    return self.db.get('SELECT * FROM senders WHERE id = ? AND user_id = ?', [sid, user.id]);
  }).then(function (row) {
    if (!row) throw new AppError('not_found', 'Sender not found', 404);
    sender = row;
    if (sender.status !== 'active') throw new AppError('conflict', 'This sender is not active, so it cannot send. Fix or resume it on the Senders page.', 409);
    var dateStr = new Date(self.now()).toISOString().slice(0, 10);
    if (sender.sent_today_date === dateStr && sender.sent_today >= throttle.limitToday(sender, dateStr)) throw new AppError('conflict', 'This sender has reached today\'s limit. Use another sender or try tomorrow.', 409);
    if (input.lead_id === undefined || input.lead_id === null) return null;
    var lid = v.intIn(input.lead_id, 1, 9007199254740991);
    if (lid === null) throw bad('lead_id', 'Invalid lead');
    return self.db.get('SELECT email, domain, first_name, last_name, company, custom FROM leads WHERE id = ? AND user_id = ?', [lid, user.id]).then(function (l) {
      if (!l) throw new AppError('not_found', 'Lead not found', 404);
      lead = l; usedLead = true;
    });
  }).then(function () {
    // compose like a campaign email, but addressed to the test recipient (lead data only fills the fields)
    var c = { test: true, cl_id: 0, current_step: 0, email: to, domain: lead.domain, first_name: lead.first_name, last_name: lead.last_name, company: lead.company, custom: lead.custom };
    var history = previous ? [{ subject: previous, message_id_hdr: null }] : [];
    return withSignature(self.db, user.id, sender).then(function (snd) {
      var composed = self.engine._compose(snd, c, { subject: String(input.subject || '').trim(), body_html: input.body_html }, history);
      var mail = composed.mail;
      mail.to = to; mail.subject = '[TEST] ' + mail.subject.replace(/[\r\n]+/g, ' ');
      mail.inReplyTo = null; mail.references = [];
      var live = self.mailer.mode === 'live';
      var out = { to: to, sender: snd.email, subject: mail.subject, delivered: live, dry_run: !live, missing: composed.missing, used_lead: usedLead };
      return audit.log(self.db, { userId: user.id, action: 'test_email.send', entity: 'sender', entityId: snd.id, ip: ip, meta: { to: to, live: live } }, self.now).then(function () {
        if (!live) return out;
        return self.engine.deliver(snd, mail).then(function () { return out; }, function (err) {
          throw new AppError('conflict', 'The test email was not sent: ' + sendErrors.classify(err).message, 502);
        });
      });
    });
  });
};

module.exports = { TestSendService: TestSendService };
