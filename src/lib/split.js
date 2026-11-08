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

// Smart Split: distribute leads into batches of batchSize (last batch = remainder) so that
// contacts of the same company domain land in DIFFERENT batches whenever possible.
// Largest company groups are placed first; each lead goes to the batch that currently holds
// the fewest contacts of its domain (ties: most free room, then seeded random). Deterministic
// for a given seed. Order inside each batch is shuffled again so send order looks natural.
function splitSpread(items, batchSize, seed) {
  var sizes = previewSizes(items.length, batchSize);
  var rnd = mulberry32(seed >>> 0);
  var batches = sizes.map(function () { return []; });
  var room = sizes.slice();
  var groups = {}, order = [];
  shuffle(items, seed).forEach(function (l) {
    var d = email.domainOf(l.email) || ('_' + l.id);
    if (!groups[d]) { groups[d] = []; order.push(d); }
    groups[d].push(l);
  });
  order.sort(function (a, b) { return groups[b].length - groups[a].length; });   // stable for ties (shuffled order kept)
  order.forEach(function (d) {
    var counts = batches.map(function () { return 0; });
    groups[d].forEach(function (lead) {
      var best = [], bestCount = Infinity, bestRoom = -1, i;
      for (i = 0; i < batches.length; i++) {
        if (room[i] <= 0) continue;
        if (counts[i] < bestCount || (counts[i] === bestCount && room[i] > bestRoom)) {
          bestCount = counts[i]; bestRoom = room[i]; best = [i];
        } else if (counts[i] === bestCount && room[i] === bestRoom) best.push(i);
      }
      var pick = best[Math.floor(rnd() * best.length)];
      batches[pick].push(lead); counts[pick]++; room[pick]--;
    });
  });
  return batches.map(function (b, i) { return shuffle(b, (seed >>> 0) + i + 1); });
}

// Number of leads that share a company domain with another lead in the same batch.
function countConflicts(batches) {
  var total = 0;
  batches.forEach(function (b) {
    var seen = {};
    b.forEach(function (l) { var d = email.domainOf(l.email); seen[d] = (seen[d] || 0) + 1; });
    Object.keys(seen).forEach(function (d) { if (seen[d] > 1) total += seen[d] - 1; });
  });
  return total;
}

module.exports = {
  mulberry32: mulberry32, newSeed: newSeed, shuffle: shuffle,
  domainAwareShuffle: domainAwareShuffle, splitBatches: splitBatches, previewSizes: previewSizes,
  splitSpread: splitSpread, countConflicts: countConflicts
};
