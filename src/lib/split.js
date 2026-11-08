'use strict';
// Smart Split Engine: seeded shuffle, domain-aware spreading, batch splitting.

var email = require('./email');

// Small deterministic PRNG so a shuffle can be reproduced from its saved seed.
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newSeed() {
  return require('crypto').randomBytes(4).readUInt32BE(0);
}

function shuffle(arr, seed) {
  var rnd = mulberry32(seed), a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Shuffle, then spread leads of the same company domain as far apart as
// possible (round-robin across domain groups, largest groups first), so
// info@/sales@/ceo@ of one company never sit next to each other.
function domainAwareShuffle(leads, seed) {
  var groups = {}, order = [];
  shuffle(leads, seed).forEach(function (l) {
    var d = email.domainOf(l.email) || '_';
    if (!groups[d]) { groups[d] = []; order.push(d); }
    groups[d].push(l);
  });
  order.sort(function (x, y) { return groups[y].length - groups[x].length; });
  // Place each group (largest first) at evenly spaced free slots.
  var total = leads.length, out = new Array(total), free = [], i;
  for (i = 0; i < total; i++) free.push(i);
  order.forEach(function (d) {
    var g = groups[d], k = g.length, picks = [], n;
    for (n = 0; n < k; n++) picks.push(Math.floor((n + 0.5) * free.length / k));
    var chosen = picks.map(function (p) { return free[p]; });
    chosen.forEach(function (slot, idx) { out[slot] = g[idx]; });
    var taken = {};
    chosen.forEach(function (s) { taken[s] = true; });
    free = free.filter(function (s) { return !taken[s]; });
  });
  return out;
}

// Split into consecutive batches of batchSize; the last batch takes the remainder.
function splitBatches(items, batchSize) {
  var n = Math.floor(Number(batchSize));
  if (!isFinite(n) || n < 1) throw new Error('Batch size must be a positive integer');
  var out = [];
  for (var i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// Preview shown to the user before launch, e.g. [26, 26, 26, 22].
function previewSizes(total, batchSize) {
  var n = Math.floor(Number(batchSize));
  if (!isFinite(n) || n < 1) throw new Error('Batch size must be a positive integer');
  var sizes = [];
  for (var left = total; left > 0; left -= n) sizes.push(Math.min(n, left));
  return sizes;
}

module.exports = {
  mulberry32: mulberry32, newSeed: newSeed, shuffle: shuffle,
  domainAwareShuffle: domainAwareShuffle, splitBatches: splitBatches, previewSizes: previewSizes
};
