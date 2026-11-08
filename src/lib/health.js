'use strict';
// Sender health score (0-100). Hard bounces and spam complaints hurt a lot,
// replies help slightly. Below ~20 sends there is not enough data to judge.

var MIN_SAMPLE = 20;
var AUTO_PAUSE_BELOW = 50;

function computeHealth(s) {
  var sent = Number(s.sent) || 0;
  if (sent < MIN_SAMPLE) return 100;
  var bounceRate = (Number(s.hardBounces) || 0) / sent;
  var complaintRate = (Number(s.complaints) || 0) / sent;
  var replyRate = (Number(s.replies) || 0) / sent;
  var score = 100 - bounceRate * 100 * 6 - complaintRate * 100 * 50 + Math.min(5, replyRate * 100 * 0.5);
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = { computeHealth: computeHealth, AUTO_PAUSE_BELOW: AUTO_PAUSE_BELOW, MIN_SAMPLE: MIN_SAMPLE };
