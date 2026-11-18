'use strict';
// Live campaign operations (src/services/campaignLive.js), mixed into CampaignsService by campaigns.js.
//
//   addSteps(userId, id, {steps:[{subject, body_html, delay_days}]})   append follow-ups to a running campaign
//   leadHistory(userId, id, campaignLeadId)                            everything one person got and wrote, plus step progression
//   updateLead(userId, id, campaignLeadId, {first_name,last_name,company,custom})   fix merge fields on the fly
//   bulkLeads(userId, id, {action: pause|resume|remove|requeue, ids[]})   multi-select actions on people
//   metrics(userId, id)                                                 "Metrics breakdown": per step and for the whole sequence
//   homeOverview(userId, q)                                             the four cards on Home (active, replies, sent today, scheduled)
//
// Rules that keep a running campaign honest:
//   * An email that was already sent is never rewritten (see updateSteps). New follow-ups only reach people who have not finished.
//   * Someone who unsubscribed with the link, complained, or whose address bounced can NOT be re-queued: that would break the
//     promise made to them. Someone who replied "stop campaign" (our own keyword rule) can be, because the owner decides.
//   * "Remove" deletes people nobody has emailed yet. People who already got mail are closed as 'completed' with a note, so
//     the history and the campaign numbers stay correct.
var AppError = require('../lib/errors').AppError;
var v = require('../lib/validate');
var text = require('../lib/text');
var sanitize = require('../lib/sanitize');
var audit = require('./audit');
var state = require('./campaignState');

var MAX_BULK = 500;
var NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

function install(C, h) {
  var bad = h.bad, seq = h.seq;

  // Leaves (what holds the people) of a main campaign, checked to belong to the user.
  function family(self, userId, id) {
    return self._own(userId, id).then(function (c) {
      if (c.parent_id) throw bad('id', 'Use the main campaign');
      return self.db.all('SELECT * FROM campaigns WHERE parent_id = ? AND user_id = ? ORDER BY id', [id, userId]).then(function (kids) {
        return { camp: c, kids: kids, leaves: kids.length ? kids : [c], all: [c].concat(kids) };
      });
    });
  }
  function ids(list) { return list.map(function (x) { return x.id; }); }

  // ---------- add follow-ups ----------
  C.addSteps = function (userId, id, input, ip) {
    var self = this, fam, add;
    return Promise.resolve().then(function () { return family(self, userId, id); }).then(function (f) {
      fam = f;
      if (f.leaves.some(function (l) { return l.status === 'completed' || l.status === 'preparing'; })) throw new AppError('conflict', 'A finished campaign cannot get new follow-ups. Start a new campaign instead.', 409);
      var list = input && input.steps;
      if (!Array.isArray(list) || !list.length) throw bad('steps', 'Send the follow-up to add');
      return self.db.get('SELECT COUNT(*) AS n FROM campaign_steps WHERE campaign_id = ?', [id]).then(function (r) {
        if (r.n + list.length > h.MAX_STEPS) throw bad('steps', 'A sequence can have at most ' + h.MAX_STEPS + ' emails (the first email plus ' + (h.MAX_STEPS - 1) + ' follow-ups)');
        add = list.map(function (s, k) { return h.validateStep(s, r.n + k); });
        if (add.some(function (s) { return s.step_no === 0; })) throw bad('steps', 'Invalid step');
      });
    }).then(function () {
      var t = self.now();
      return self.db.transaction(function (tx) {
        return seq(fam.all, function (c) {
          return seq(add, function (s) {
            return tx.run('INSERT INTO campaign_steps (campaign_id, step_no, delay_days, subject, body_html) VALUES (?,?,?,?,?)', [c.id, s.step_no, s.delay_days, s.subject, s.body_html]);
          });
        }).then(function () { return tx.run('UPDATE campaigns SET updated_at = ? WHERE id = ?', [t, id]); })
          .then(function () { return audit.log(tx, { userId: userId, action: 'campaign.steps_add', entity: 'campaign', entityId: id, ip: ip, meta: { added: add.length } }, self.now); });
      });
    }).then(function () { return self.get(userId, id); });
  };

  // ---------- remove an unsent follow-up ----------
  // Only a follow-up nobody has been sent (and no later one has been sent either) can go: later emails move up one place.
  C.removeStep = function (userId, id, stepNo, ip) {
    var self = this, fam, n = v.intIn(stepNo, 0, h.MAX_STEPS - 1), t = self.now(), count;
    return Promise.resolve().then(function () { return family(self, userId, id); }).then(function (f) {
      fam = f;
      if (n === null) throw bad('step', 'Invalid step');
      if (n === 0) throw bad('step', 'The first email cannot be removed. Edit it or delete the campaign.');
      if (f.leaves.some(function (l) { return l.status === 'completed' || l.status === 'preparing'; })) throw new AppError('conflict', 'A finished campaign cannot be changed', 409);
      return Promise.all([
        self.db.all('SELECT step_no, delay_days FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [id]),
        require('./stepProgress').lockedSteps(self.db, userId, ids(f.leaves))
      ]);
    }).then(function (r) {
      var steps = r[0], locked = r[1];
      count = steps.length;
      if (n >= count) throw new AppError('not_found', 'This follow-up does not exist', 404);
      for (var k = n; k < count; k++) if (locked[k]) throw new AppError('conflict', 'This follow-up (or one after it) has already been sent to some people, so it cannot be removed. Pause those people instead.', 409, { step: n });
      var newDelay = n + 1 < count ? steps[n + 1].delay_days : 0;
      return self.db.transaction(function (tx) {
        return seq(fam.all, function (c) {
          return tx.run('DELETE FROM campaign_steps WHERE campaign_id = ? AND step_no = ?', [c.id, n]).then(function () {
            var rest = []; for (var k = n + 1; k < count; k++) rest.push(k);
            return seq(rest, function (k) { return tx.run('UPDATE campaign_steps SET step_no = ? WHERE campaign_id = ? AND step_no = ?', [k - 1, c.id, k]); });
          });
        }).then(function () {
          return seq(fam.leaves, function (c) {
            // Everyone who was waiting for the removed email now waits for the one that took its place (or is done if it was the last).
            var p;
            if (n === count - 1) {
              p = tx.run("UPDATE campaign_leads SET status = 'completed', next_send_at = NULL WHERE campaign_id = ? AND current_step = ? AND status IN ('pending','active','paused')", [c.id, n]);
            } else {
              p = tx.run("UPDATE campaign_leads SET next_send_at = MAX(?, COALESCE(last_sent_at, ?) + ?) WHERE campaign_id = ? AND current_step = ? AND status IN ('active','pending') AND last_sent_at IS NOT NULL", [t, t, newDelay * 86400000, c.id, n]);
            }
            return p.then(function () { return tx.run('UPDATE campaign_leads SET current_step = current_step - 1 WHERE campaign_id = ? AND current_step > ?', [c.id, n]); });
          });
        }).then(function () { return seq(fam.leaves, function (c) { return state.completeIfDone(tx, c.id, t); }); })
          .then(function () { return fam.kids.length ? state.syncMain(tx, id, t) : null; })
          .then(function () { return tx.run('UPDATE campaigns SET updated_at = ? WHERE id = ?', [t, id]); })
          .then(function () { return audit.log(tx, { userId: userId, action: 'campaign.step_remove', entity: 'campaign', entityId: id, ip: ip, meta: { step: n } }, self.now); });
      });
    }).then(function () { return self.get(userId, id); });
  };

  // ---------- one person ----------
  function leadRow(self, userId, id, clId) {
    return family(self, userId, id).then(function (f) {
      var cid = v.intIn(clId, 1, 9007199254740991);
      if (cid === null) throw bad('lead', 'Invalid person');
      return self.db.get('SELECT cl.*, l.email, l.first_name, l.last_name, l.company, l.custom, l.domain, s.email AS sender_email, sp.reason AS suppression_reason ' +
        'FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN senders s ON s.id = cl.sender_id LEFT JOIN suppression sp ON sp.user_id = ? AND sp.email = l.email ' +
        'WHERE cl.id = ? AND cl.campaign_id IN (' + v.placeholders(f.leaves.length) + ')', [userId, cid].concat(ids(f.leaves))).then(function (row) {
        if (!row) throw new AppError('not_found', 'Person not found in this campaign', 404);
        return { fam: f, row: row };
      });
    });
  }
  // When the next email of someone coming back into the queue is due. A step that was missed while they were paused goes out
  // right away (catch-up); if everything before it was delivered, the normal gap after the last email is respected, so the
  // sequence never jumps ahead. First email (nothing sent yet) goes now.
  var DAY_MS = 86400000;
  function naturalDue(row, delays, now) {
    if (!row.current_step || !row.last_sent_at) return now;
    var due = row.last_sent_at + (delays[row.current_step] || 0) * DAY_MS;
    return due > now ? due : now;
  }
  // Why this person can (not) be put back in the queue, in words the UI shows.
  function requeueInfo(row, stepCount) {
    if (row.status === 'bounced') return { ok: false, why: 'The address bounced. Sending again would hurt your sender reputation.' };
    if (row.status === 'unsubscribed' && row.suppression_reason && row.suppression_reason !== 'replied_stop') return { ok: false, why: 'This person used the unsubscribe link or complained. They must not be emailed again.' };
    if (['replied', 'unsubscribed', 'error', 'paused'].indexOf(row.status) === -1) return { ok: false, why: '' };
    if (row.current_step >= stepCount) return { ok: false, why: 'This person already received every email in the sequence.' };
    return { ok: true, why: '' };
  }

  C.leadHistory = function (userId, id, clId) {
    var self = this;
    return leadRow(self, userId, id, clId).then(function (r) {
      var row = r.row;
      return Promise.all([
        self.db.all('SELECT step_no, delay_days, subject FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [row.campaign_id]),
        self.db.all('SELECT id, direction, kind, status, step_no, subject, body_html, body_text, sent_at, received_at, created_at, open_count, last_opened_at, sentiment, error FROM messages ' +
          'WHERE user_id = ? AND campaign_lead_id = ? ORDER BY COALESCE(sent_at, received_at, created_at), id', [userId, row.id])
      ]).then(function (res) {
        var steps = res[0], msgs = res[1], open = ['pending', 'active', 'paused'].indexOf(row.status) !== -1;
        var sentBy = {}; msgs.forEach(function (m) { if (m.direction === 'out' && m.status === 'sent' && m.step_no !== null) sentBy[m.step_no] = m; });
        var progress = steps.map(function (s) {
          var m = sentBy[s.step_no], st = 'not_sent';
          if (m) st = 'sent'; else if (open && s.step_no === row.current_step && row.next_send_at) st = 'scheduled';
          return { step_no: s.step_no, subject: s.subject, delay_days: s.delay_days, state: st, sent_at: m ? m.sent_at : null, scheduled_at: st === 'scheduled' ? row.next_send_at : null,
            opens: m ? m.open_count : 0, last_opened_at: m ? m.last_opened_at : null };
        });
        var ri = requeueInfo(row, steps.length), custom = null;
        try { custom = row.custom ? JSON.parse(row.custom) : null; } catch (e) { custom = null; }
        return {
          lead: { id: row.id, lead_id: row.lead_id, campaign_id: row.campaign_id, email: row.email, first_name: row.first_name, last_name: row.last_name, company: row.company, custom: custom,
            status: row.status, status_note: row.status_note, current_step: row.current_step, next_send_at: row.next_send_at, sender_email: row.sender_email,
            can_requeue: ri.ok, requeue_blocked: ri.why },
          steps: progress,
          messages: msgs.map(function (m) {
            return { id: m.id, direction: m.direction, kind: m.kind, status: m.status, step_no: m.step_no, subject: m.subject || '', at: m.sent_at || m.received_at || m.created_at,
              // Our own outgoing HTML is sanitized again on the way out; incoming mail is only ever sent as plain text.
              body_html: m.direction === 'out' ? sanitize.clean(m.body_html || '') : null,
              body_text: m.direction === 'in' ? String(m.body_text || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').slice(0, 20000) : null,
              opens: m.open_count || 0, last_opened_at: m.last_opened_at, sentiment: m.sentiment, error: m.status === 'failed' ? (m.error || 'Could not be sent') : null };
          })
        };
      });
    });
  };

  // ---------- edit merge fields ----------
  C.updateLead = function (userId, id, clId, input, ip) {
    var self = this, row;
    return leadRow(self, userId, id, clId).then(function (r) {
      row = r.row; input = input || {};
      var sets = [], params = [];
      ['first_name', 'last_name', 'company'].forEach(function (k) {
        if (input[k] === undefined) return;
        if (input[k] !== null && typeof input[k] !== 'string') throw bad(k, 'Invalid value');
        var val = text.cleanText(input[k] || '', 200); sets.push(k + ' = ?'); params.push(val || null);
      });
      if (input.custom !== undefined) {
        if (input.custom !== null && (typeof input.custom !== 'object' || Array.isArray(input.custom))) throw bad('custom', 'Custom fields must be name/value pairs');
        var c = {}, keys = Object.keys(input.custom || {});
        if (keys.length > 20) throw bad('custom', 'At most 20 custom fields');
        keys.forEach(function (k) {
          var key = String(k).toLowerCase();
          if (!NAME_RE.test(key) || ['first_name', 'last_name', 'company', 'email', 'domain'].indexOf(key) !== -1) throw bad('custom', 'Field name "' + k + '" is not valid. Use letters, digits and underscores, starting with a letter.');
          var val = text.cleanText(input.custom[k] == null ? '' : String(input.custom[k]), 500); if (val) c[key] = val;
        });
        sets.push('custom = ?'); params.push(Object.keys(c).length ? JSON.stringify(c) : null);
      }
      if (!sets.length) throw bad('lead', 'Nothing to change');
      // The person record is shared with the list it came from, so the fix applies everywhere they appear.
      return self.db.run('UPDATE leads SET ' + sets.join(', ') + ' WHERE id = ? AND user_id = ?', params.concat([row.lead_id, userId]));
    }).then(function () {
      return audit.log(self.db, { userId: userId, action: 'campaign.lead_edit', entity: 'campaign', entityId: id, ip: ip, meta: { campaign_lead: row.id } }, self.now);
    }).then(function () { return self.leadHistory(userId, id, clId); });
  };

  // ---------- multi-select actions ----------
  C.bulkLeads = function (userId, id, input, ip) {
    var self = this, fam, rows, stepCount, action, t = self.now(), delays = {};
    return Promise.resolve().then(function () {
      input = input || {};
      action = input.action;
      if (['pause', 'resume', 'remove', 'requeue'].indexOf(action) === -1) throw bad('action', 'Choose pause, resume, remove or re-queue');
      var list = v.idArray(input.ids, 1, MAX_BULK);
      if (!list) throw bad('ids', 'Select between 1 and ' + MAX_BULK + ' people');
      return family(self, userId, id).then(function (f) {
        fam = f;
        return self.db.all('SELECT step_no, delay_days FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [id]);
      }).then(function (sc) {
        stepCount = sc.length;
        sc.forEach(function (x) { delays[x.step_no] = x.delay_days; });
        return self.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.current_step, cl.next_send_at, cl.last_sent_at, cl.sender_id, l.email, sp.reason AS suppression_reason, ' +
          '(SELECT COUNT(*) FROM messages m WHERE m.campaign_lead_id = cl.id AND m.direction = \'out\' AND m.status IN (\'sent\',\'sending\')) AS mails ' +
          'FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN suppression sp ON sp.user_id = ? AND sp.email = l.email ' +
          'WHERE cl.id IN (' + v.placeholders(list.length) + ') AND cl.campaign_id IN (' + v.placeholders(fam.leaves.length) + ')', [userId].concat(list, ids(fam.leaves)));
      });
    }).then(function (found) {
      rows = found;
      var res = { action: action, done: [], skipped: [] };
      var leafIds = {};
      return self.db.transaction(function (tx) {
        return seq(rows, function (r) {
          function skip(why) { res.skipped.push({ id: r.id, email: r.email, message: why }); return null; }
          function ok() { res.done.push(r.id); leafIds[r.campaign_id] = true; }
          if (action === 'pause') {
            if (r.status !== 'active') return skip('Only people who are in the sequence can be paused');
            return tx.run("UPDATE campaign_leads SET status = 'paused' WHERE id = ? AND status = 'active'", [r.id]).then(ok);
          }
          if (action === 'resume') {
            if (r.status !== 'paused') return skip('This person is not paused');
            return tx.run("UPDATE campaign_leads SET status = 'active', next_send_at = ? WHERE id = ? AND status = 'paused'", [naturalDue(r, delays, t), r.id]).then(ok);
          }
          if (action === 'remove') {
            // Bounced / unsubscribed / finished people keep their row (status, messages, analytics) and are only hidden from the list,
            // so removing problem addresses never rewrites the campaign's history.
            if (['bounced', 'unsubscribed', 'completed'].indexOf(r.status) !== -1) return tx.run('UPDATE campaign_leads SET removed_at = ? WHERE id = ?', [t, r.id]).then(ok);
            if (r.mails) return tx.run("UPDATE campaign_leads SET status = 'completed', next_send_at = NULL, status_note = 'Removed from the campaign' WHERE id = ? AND status IN ('pending','active','paused','error','replied')", [r.id]).then(ok);
            return tx.run('DELETE FROM campaign_leads WHERE id = ?', [r.id]).then(ok);
          }
          var ri = requeueInfo(r, stepCount);
          if (!ri.ok) return skip(ri.why || 'This person cannot be re-queued');
          // Our own "stop campaign" keyword rule put them on the suppression list; the owner overrides it, only for that reason.
          var p = r.status === 'unsubscribed' ? tx.run("DELETE FROM suppression WHERE user_id = ? AND email = ? AND reason = 'replied_stop'", [userId, r.email]) : Promise.resolve();
          return p.then(function () {
            return tx.run("UPDATE campaign_leads SET status = 'active', next_send_at = ?, status_note = NULL WHERE id = ?", [naturalDue(r, delays, t), r.id]);
          }).then(function () {
            // A finished campaign that gets somebody back starts working again.
            return tx.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ? AND status = 'completed'", [t, r.campaign_id]);
          }).then(ok);
        }).then(function () {
          var touched = Object.keys(leafIds).map(Number);
          return seq(touched, function (cid) { return action === 'requeue' ? null : state.completeIfDone(tx, cid, t); })
            .then(function () { return fam.camp.parent_id === null && fam.kids.length ? state.syncMain(tx, id, t) : null; });
        }).then(function () {
          return audit.log(tx, { userId: userId, action: 'campaign.leads_' + action, entity: 'campaign', entityId: id, ip: ip, meta: { done: res.done.length, skipped: res.skipped.length } }, self.now);
        }).then(function () {
          // People asked for but not found in this campaign are reported, never silently dropped.
          var seen = {}; rows.forEach(function (r) { seen[r.id] = true; });
          (input.ids || []).forEach(function (x) { if (!seen[x]) res.skipped.push({ id: x, email: '', message: 'Not found in this campaign' }); });
          return res;
        });
      });
    });
  };

  // ---------- move / add people to another campaign (any project) ----------
  // mode 'move': they leave this campaign (closed like "Remove") and start in the target. mode 'add': they stay here and are added there too.
  C.moveLeads = function (userId, id, input, ip) {
    var self = this, fam, rows, tfam, leaf, mode, t = self.now();
    return Promise.resolve().then(function () {
      input = input || {};
      mode = input.mode === 'add' ? 'add' : input.mode === 'move' ? 'move' : null;
      if (!mode) throw bad('mode', 'Choose move or add');
      var list = v.idArray(input.ids, 1, MAX_BULK), target = v.intIn(input.target_campaign_id, 1, 9007199254740991);
      if (!list) throw bad('ids', 'Select between 1 and ' + MAX_BULK + ' people');
      if (target === null) throw bad('target_campaign_id', 'Choose a campaign');
      if (target === id) throw bad('target_campaign_id', 'Choose a different campaign');
      return Promise.all([family(self, userId, id), family(self, userId, target)]).then(function (ff) {
        fam = ff[0]; tfam = ff[1];
        if (tfam.leaves.every(function (l) { return l.status === 'completed' || l.status === 'preparing'; })) throw new AppError('conflict', 'That campaign is finished or still being prepared. Choose another one.', 409);
        return self.db.all('SELECT cl.id, cl.campaign_id, cl.status, cl.lead_id, l.email, sp.reason AS suppression_reason, ' +
          '(SELECT COUNT(*) FROM messages m WHERE m.campaign_lead_id = cl.id AND m.direction = \'out\' AND m.status IN (\'sent\',\'sending\')) AS mails ' +
          'FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN suppression sp ON sp.user_id = ? AND sp.email = l.email ' +
          'WHERE cl.id IN (' + v.placeholders(list.length) + ') AND cl.campaign_id IN (' + v.placeholders(fam.leaves.length) + ')', [userId].concat(list, ids(fam.leaves)));
      });
    }).then(function (found) {
      rows = found;
      // The target part with the fewest people receives them, so a split stays balanced.
      var open = tfam.leaves.filter(function (l) { return l.status !== 'completed' && l.status !== 'preparing'; });
      return Promise.all(open.map(function (l) {
        return self.db.get('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS pos FROM campaign_leads WHERE campaign_id = ?', [l.id]).then(function (r) { return { l: l, n: r.n, pos: r.pos }; });
      }));
    }).then(function (counts) {
      counts.sort(function (a, b) { return a.n - b.n || a.l.id - b.l.id; });
      leaf = counts[0];
      return Promise.all([
        self.db.all('SELECT sender_id FROM campaign_senders WHERE campaign_id = ? ORDER BY sender_id', [leaf.l.id]),
        self.db.all('SELECT lead_id FROM campaign_leads WHERE campaign_id IN (' + v.placeholders(tfam.leaves.length) + ')', ids(tfam.leaves))
      ]);
    }).then(function (rr) {
      var senders = rr[0].map(function (x) { return x.sender_id; }), inTarget = {};
      rr[1].forEach(function (x) { inTarget[x.lead_id] = true; });
      var res = { mode: mode, target: { id: tfam.camp.id, name: tfam.camp.name }, done: [], skipped: [] }, pos = leaf.pos, touched = {};
      var live = leaf.l.status === 'active' || leaf.l.status === 'paused';
      return self.db.transaction(function (tx) {
        return seq(rows, function (r) {
          function skip(why) { res.skipped.push({ id: r.id, email: r.email, message: why }); return null; }
          if (r.status === 'bounced') return skip('The address bounced');
          if (r.status === 'replied') return skip('This person replied. Move them only after you decide to email them again.');
          if (r.suppression_reason && r.suppression_reason !== 'replied_stop') return skip('This person must not be emailed (unsubscribed, complained or blocked)');
          if (inTarget[r.lead_id]) return skip('Already in "' + tfam.camp.name + '"');
          inTarget[r.lead_id] = true; pos++;
          var sender = senders.length ? senders[(pos + 1) % senders.length] : null;
          return tx.run('INSERT INTO campaign_leads (campaign_id, lead_id, sender_id, position, status, current_step, next_send_at) VALUES (?,?,?,?,?,0,?)',
            [leaf.l.id, r.lead_id, sender, pos, live ? 'active' : 'pending', live ? t : null]).then(function () {
            res.done.push(r.id);
            if (mode === 'move') {
              touched[r.campaign_id] = true;
              if (r.mails) return tx.run("UPDATE campaign_leads SET status = 'completed', next_send_at = NULL, status_note = ? WHERE id = ? AND status IN ('pending','active','paused','error','replied')", ['Moved to "' + tfam.camp.name + '"', r.id]);
              return tx.run('DELETE FROM campaign_leads WHERE id = ?', [r.id]);
            }
            return null;
          });
        }).then(function () {
          return seq(Object.keys(touched).map(Number), function (cid) { return state.completeIfDone(tx, cid, t); })
            .then(function () { return fam.kids.length ? state.syncMain(tx, id, t) : null; });
        }).then(function () {
          return audit.log(tx, { userId: userId, action: 'campaign.leads_' + mode, entity: 'campaign', entityId: id, ip: ip, meta: { to: tfam.camp.id, done: res.done.length, skipped: res.skipped.length } }, self.now);
        }).then(function () { return res; });
      });
    });
  };

  // ---------- metrics breakdown ----------
  C.metrics = function (userId, id) {
    var self = this;
    return family(self, userId, id).then(function (f) {
      var L = ids(f.leaves), ph = v.placeholders(L.length);
      var base = 'FROM messages m JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.user_id = ? AND cl.campaign_id IN (' + ph + ')';
      var P = [userId].concat(L);
      // Step a reply or bounce belongs to: the latest email we sent that person before it arrived.
      var attributed = "(SELECT o.step_no FROM messages o WHERE o.campaign_lead_id = m.campaign_lead_id AND o.direction = 'out' AND o.status = 'sent' AND o.step_no IS NOT NULL AND o.sent_at <= m.received_at ORDER BY o.sent_at DESC LIMIT 1)";
      return Promise.all([
        self.db.all('SELECT step_no, subject FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no', [id]),
        self.db.all("SELECT m.step_no AS step, COUNT(*) AS sent, SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END) AS opened " + base + " AND m.direction = 'out' AND m.status = 'sent' AND m.step_no IS NOT NULL GROUP BY m.step_no", P),
        self.db.all("SELECT " + attributed + " AS step, COUNT(DISTINCT m.campaign_lead_id) AS n, SUM(CASE WHEN m.sentiment = 'interested' THEN 1 ELSE 0 END) AS good " + base + " AND m.direction = 'in' AND m.kind = 'email' GROUP BY step", P),
        self.db.all("SELECT MAX(0, cl.current_step - 1) AS step, cl.status AS st, COUNT(*) AS n FROM campaign_leads cl WHERE cl.campaign_id IN (" + ph + ") AND cl.status IN ('bounced','unsubscribed') GROUP BY step, st", L),
        self.db.all("SELECT cl.current_step AS cur, COUNT(*) AS n FROM campaign_leads cl WHERE cl.campaign_id IN (" + ph + ") AND cl.status IN ('pending','active','paused') GROUP BY cl.current_step", L),
        self.db.get("SELECT COUNT(DISTINCT CASE WHEN m.open_count > 0 THEN m.campaign_lead_id END) AS opened, COUNT(DISTINCT CASE WHEN m.direction = 'in' AND m.kind = 'email' THEN m.campaign_lead_id END) AS replied, " +
          "COUNT(DISTINCT CASE WHEN m.direction = 'in' AND m.kind = 'email' AND m.sentiment = 'interested' THEN m.campaign_lead_id END) AS good " + base, P),
        self.db.get("SELECT SUM(CASE WHEN cl.status = 'bounced' THEN 1 ELSE 0 END) AS bounced, SUM(CASE WHEN cl.status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsub FROM campaign_leads cl WHERE cl.campaign_id IN (" + ph + ')', L)
      ]).then(function (r) {
        var meta = r[0], n = meta.length, rows = [];
        var by = function () { var o = []; for (var k = 0; k < n; k++) o.push({ scheduled: 0, sent: 0, delivered: 0, opened: 0, replied: 0, successful: 0, bounced: 0, unsubscribed: 0 }); return o; }();
        r[1].forEach(function (x) { if (by[x.step]) { by[x.step].sent = Number(x.sent); by[x.step].opened = Number(x.opened) || 0; } });
        r[2].forEach(function (x) { if (x.step !== null && by[x.step]) { by[x.step].replied += Number(x.n); by[x.step].successful += Number(x.good) || 0; } });
        r[3].forEach(function (x) { var s = Math.min(x.step, n - 1); if (by[s]) { if (x.st === 'bounced') by[s].bounced += Number(x.n); else by[s].unsubscribed += Number(x.n); } });
        // People still waiting with current_step c are scheduled for step c and every step after it.
        r[4].forEach(function (x) { for (var k = x.cur; k < n; k++) by[k].scheduled += Number(x.n); });
        by.forEach(function (b) { b.delivered = Math.max(0, b.sent - b.bounced); });
        var total = { scheduled: 0, sent: 0, delivered: 0 };
        by.forEach(function (b) { total.scheduled += b.scheduled; total.sent += b.sent; total.delivered += b.delivered; });
        // The whole-sequence row counts PEOPLE once, not once per email, so it is not the sum of the rows below it.
        var seqRow = { key: 'sequence', label: 'Sequence', scheduled: total.scheduled, sent: total.sent, delivered: total.delivered, opened: Number(r[5].opened) || 0, replied: Number(r[5].replied) || 0,
          successful: Number(r[5].good) || 0, bounced: Number(r[6].bounced) || 0, unsubscribed: Number(r[6].unsub) || 0 };
        rows.push(seqRow);
        meta.forEach(function (m, k) { rows.push(Object.assign({ key: 'step' + m.step_no, step_no: m.step_no, label: m.step_no === 0 ? 'First email' : 'Follow-up ' + m.step_no, subject: m.subject || '' }, by[k])); });
        return { rows: rows, track_opens: !!f.camp.track_opens, people: { total: null } };
      });
    });
  };

  // ---------- Home cards ----------
  C.homeOverview = function (userId, q) {
    var self = this, off = v.intIn(q && q.tz, -720, 840); if (off === null) off = 0;
    var DAY = 86400000, t = self.now();
    var dayStart = Math.floor((t + off * 60000) / DAY) * DAY - off * 60000;
    return Promise.all([
      self.db.get("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ? AND parent_id IS NULL AND status = 'active'", [userId]),
      self.db.get("SELECT COUNT(DISTINCT m.campaign_lead_id) AS n FROM messages m WHERE m.user_id = ? AND m.direction = 'in' AND m.kind = 'email' AND m.campaign_lead_id IS NOT NULL", [userId]),
      self.db.get("SELECT COUNT(DISTINCT m.campaign_lead_id) AS n FROM messages m WHERE m.user_id = ? AND m.direction = 'in' AND m.kind = 'email' AND m.campaign_lead_id IS NOT NULL AND m.read_at IS NULL", [userId]),
      self.db.get("SELECT COUNT(*) AS n FROM messages m WHERE m.user_id = ? AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ?", [userId, dayStart]),
      self.db.get("SELECT COALESCE(SUM(ns.n - cl.current_step), 0) AS n FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id " +
        "JOIN (SELECT campaign_id, COUNT(*) AS n FROM campaign_steps GROUP BY campaign_id) ns ON ns.campaign_id = cl.campaign_id " +
        "WHERE c.user_id = ? AND c.status = 'active' AND cl.status IN ('pending','active') AND ns.n > cl.current_step", [userId])
    ]).then(function (r) { return { active_campaigns: r[0].n, replies: r[1].n, replies_unread: r[2].n, replies_7d: r[1].n, sent_today: r[3].n, scheduled: Number(r[4].n) || 0 }; });
  };
}

module.exports = { install: install };
