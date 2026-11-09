'use strict';
// Rule-based reply classification. Quoted text (our own earlier email!) is removed first so
// words from OUR message ("interested in selling?") never count as the prospect's answer.
// The user can always override the result manually in the inbox.

function stripQuoted(text) {
  var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  var cuts = [
    /\n[ \t]*On\s[\s\S]{0,300}?\swrote:/i,            // Gmail / Apple Mail
    /\n[ \t]*-{2,}\s*Original Message\s*-{2,}/i,       // Outlook
    /\n[ \t]*From:\s.+\n[ \t]*(Sent|Date):\s/i,        // Outlook header block
    /\n[ \t]*_{5,}\s*\n/                               // Outlook divider
  ];
  var padded = '\n' + s;                       // the leading newline lets patterns match at the very start
  cuts.forEach(function (re) { var m = re.exec(padded); if (m) padded = padded.slice(0, m.index); });
  s = padded.slice(1);
  return s.split('\n').filter(function (l) { return !/^\s*>/.test(l); }).join('\n').trim();
}

var STOP = /\b(un-?subscribe|remove (me|us)( from)?|take (me|us) off|stop (emailing|e-mailing|contacting|sending|messaging|writing)|do not (contact|email|e-mail|write)|don'?t (contact|email|e-mail|write)|opt[- ]?out|no more (emails?|e-mails?|messages)|cease and desist)\b/i;
var NOT_INTERESTED = /\b(not (interested|for sale|selling|looking|a (good )?fit|available)|no,? thanks?|no thank you|not at this time|not now|wrong (person|email|address|contact)|not the right (person|contact)|have no (interest|plans)|not (planning|looking) to sell|already (sold|have)|isn'?t for sale|is not for sale)\b/i;
var INTERESTED = /(\binterested\b|\blet'?s (talk|chat|connect|discuss|schedule|set up)\b|\bsounds (good|great|interesting)\b|\bsend (me )?(your |the )?(offer|price|proposal|details|number|quote)\b|\bwhat'?s your (best )?(offer|price|number)\b|\bwhat is your (best )?(offer|price|number)\b|\bmake (me )?an offer\b|\bhappy to (talk|chat|discuss)\b|\bgive me a call\b|\bcall me\b|\bmy (phone )?number is\b|\bopen to (offers|selling|discussing)\b|^\s*(yes|yeah|yep|sure)\b[\s.!]*$)/i;
var MORE_INFO = /(\?|\bmore (info|information|details)\b|\btell me more\b|\bwho (are|is) (you|this)\b|\bhow did you (find|get)\b|\bcan you (explain|clarify)\b|\bwhat do you (mean|want)\b|\bwhich (domain|one|name)\b)/i;

// Returns { sentiment: interested|more_info|not_interested|neutral, stop: bool }
function classify(rawText) {
  var t = stripQuoted(rawText);
  if (!t) return { sentiment: 'neutral', stop: false };
  if (STOP.test(t)) return { sentiment: 'not_interested', stop: true };
  if (NOT_INTERESTED.test(t)) return { sentiment: 'not_interested', stop: false };
  if (INTERESTED.test(t)) return { sentiment: 'interested', stop: false };
  if (MORE_INFO.test(t)) return { sentiment: 'more_info', stop: false };
  return { sentiment: 'neutral', stop: false };
}

// Automatic replies (out of office, vacation) must not stop a sequence.
function isAutoReply(m) {
  var h = function (v) { return String(v == null ? '' : v).toLowerCase(); };
  if (h(m.autoSubmitted) && h(m.autoSubmitted) !== 'no') return true;
  if (/^(bulk|auto_reply|junk|list)$/.test(h(m.precedence))) return true;
  if (h(m.xAutoreply) || h(m.xAutoResponseSuppress)) return true;
  return /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|vacation|away from (my )?(desk|office)|on leave)\b/i.test(String(m.subject || ''));
}

module.exports = { classify: classify, stripQuoted: stripQuoted, isAutoReply: isAutoReply };
