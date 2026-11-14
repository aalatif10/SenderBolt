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

// The ONLY opt-out phrase: "stop campaign" (any case, anywhere in the subject or in the NEW text of the reply).
// Single words like "stop", "unsubscribe" or "remove" never opt anybody out; they are too easy to write by accident
// ("don't stop now", "how do I unsubscribe from X?"). The phrase must be those two whole words next to each other.
var STOP_PHRASE = /(^|[^a-z0-9])stop[\s\u00a0]+campaign(?![a-z0-9])/i;
// Lines of OUR OWN footer contain the phrase too; if a reply client quotes them without ">" they must not count.
var FOOTER_LINE = /(rather not receive|stop receiving|stop these) (these )?emails/i;

function isStopRequest(subject, rawText) {
  if (STOP_PHRASE.test(String(subject == null ? '' : subject))) return true;
  var body = stripQuoted(rawText).split('\n').filter(function (l) { return !FOOTER_LINE.test(l); }).join('\n');
  return STOP_PHRASE.test(body);
}

var NOT_INTERESTED = /\b(not (interested|for sale|selling|looking|a (good )?fit|available)|no,? thanks?|no thank you|not at this time|not now|wrong (person|email|address|contact)|not the right (person|contact)|have no (interest|plans)|not (planning|looking) to sell|already (sold|have)|isn'?t for sale|is not for sale)\b/i;
var INTERESTED = /(\binterested\b|\blet'?s (talk|chat|connect|discuss|schedule|set up)\b|\bsounds (good|great|interesting)\b|\bsend (me )?(your |the )?(offer|price|proposal|details|number|quote)\b|\bwhat'?s your (best )?(offer|price|number)\b|\bwhat is your (best )?(offer|price|number)\b|\bmake (me )?an offer\b|\bhappy to (talk|chat|discuss)\b|\bgive me a call\b|\bcall me\b|\bmy (phone )?number is\b|\bopen to (offers|selling|discussing)\b|^\s*(yes|yeah|yep|sure)\b[\s.!]*$)/i;
var MORE_INFO = /(\?|\bmore (info|information|details)\b|\btell me more\b|\bwho (are|is) (you|this)\b|\bhow did you (find|get)\b|\bcan you (explain|clarify)\b|\bwhat do you (mean|want)\b|\bwhich (domain|one|name)\b)/i;

// Returns { sentiment: interested|more_info|not_interested|neutral }. (Opt-outs are decided by isStopRequest only.)
function classify(rawText) {
  var t = stripQuoted(rawText);
  if (!t) return { sentiment: 'neutral' };
  if (NOT_INTERESTED.test(t)) return { sentiment: 'not_interested' };
  if (INTERESTED.test(t)) return { sentiment: 'interested' };
  if (MORE_INFO.test(t)) return { sentiment: 'more_info' };
  return { sentiment: 'neutral' };
}

// Automatic replies (out of office, vacation) must not stop a sequence.
function isAutoReply(m) {
  var h = function (v) { return String(v == null ? '' : v).toLowerCase(); };
  if (h(m.autoSubmitted) && h(m.autoSubmitted) !== 'no') return true;
  if (/^(bulk|auto_reply|junk|list)$/.test(h(m.precedence))) return true;
  if (h(m.xAutoreply) || h(m.xAutoResponseSuppress)) return true;
  return /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|vacation|away from (my )?(desk|office)|on leave)\b/i.test(String(m.subject || ''));
}

module.exports = { classify: classify, isStopRequest: isStopRequest, stripQuoted: stripQuoted, isAutoReply: isAutoReply };
