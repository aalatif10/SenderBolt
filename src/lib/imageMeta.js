'use strict';
// Inspects an uploaded image WITHOUT trusting its file name or declared type:
//   - the type comes from the first bytes (PNG, JPEG, GIF, WebP only; SVG is refused on purpose, it can carry script)
//   - width and height are read from the file header (so the editor can keep the aspect ratio)
//   - privacy: JPEG EXIF/XMP/IPTC blocks (camera model, GPS position, editing history) and PNG text/EXIF/time chunks
//     are removed before the image is stored, so a logo exported from a phone never leaks where it was taken
// Pure functions on Buffers; no I/O. Returns { mime, width, height, data } or throws Error with .code = 'bad_image'.

var MAX_DIM = 4000;                 // pixels per side
var MAX_PIXELS = 12 * 1000 * 1000;  // decompression-bomb guard

function bad(msg) { var e = new Error(msg); e.code = 'bad_image'; return e; }
function eq(buf, off, str) { for (var i = 0; i < str.length; i++) if (buf[off + i] !== str.charCodeAt(i)) return false; return true; }

// ---- PNG ----
var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
var PNG_KEEP = { IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, iCCP: 1, sBIT: 1, pHYs: 1, acTL: 1, fcTL: 1, fdAT: 1 };
function readPng(buf) {
  var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), off = 8, parts = [buf.slice(0, 8)], sawEnd = false, sawIdat = false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw bad('Not a valid PNG file');
  while (off + 12 <= buf.length) {
    var len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), end = off + 12 + len;
    if (len > buf.length || end > buf.length) throw bad('The PNG file is damaged');
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad('The PNG file is damaged');
    if (PNG_KEEP[type]) parts.push(buf.slice(off, end));
    if (type === 'IDAT') sawIdat = true;
    off = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd || !sawIdat) throw bad('The PNG file is damaged');
  return { width: w, height: h, data: Buffer.concat(parts) };
}

// ---- JPEG ----
function readJpeg(buf) {
  var off = 2, parts = [buf.slice(0, 2)], w = 0, h = 0, sawScan = false;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) throw bad('The JPEG file is damaged');
    var marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; }                                  // fill byte
    if (marker === 0xd9) { parts.push(buf.slice(off, off + 2)); sawScan = sawScan || false; off += 2; break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { parts.push(buf.slice(off, off + 2)); off += 2; continue; }   // markers without a length
    var len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) throw bad('The JPEG file is damaged');
    var seg = buf.slice(off, off + 2 + len);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { h = buf.readUInt16BE(off + 5); w = buf.readUInt16BE(off + 7); }
    var drop = marker === 0xe1 || marker === 0xed || marker === 0xfe || (marker >= 0xe3 && marker <= 0xec) || marker === 0xee || marker === 0xef;   // EXIF/XMP, IPTC, comments, vendor blocks (ICC = APP2 and JFIF = APP0 stay)
    if (!drop) parts.push(seg);
    off += 2 + len;
    if (marker === 0xda) { parts.push(buf.slice(off)); sawScan = true; off = buf.length; break; }          // entropy-coded data runs to the end: copy as is
  }
  if (!w || !h || !sawScan) throw bad('The JPEG file is damaged');
  return { width: w, height: h, data: Buffer.concat(parts) };
}

// ---- GIF ----
function readGif(buf) { return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), data: buf }; }

// ---- WebP ----
function readWebp(buf) {
  if (buf.length < 30) throw bad('The WebP file is damaged');
  var kind = buf.toString('latin1', 12, 16), w, h;
  if (kind === 'VP8 ') { w = buf.readUInt16LE(26) & 0x3fff; h = buf.readUInt16LE(28) & 0x3fff; }
  else if (kind === 'VP8L') { var b = buf.readUInt32LE(21); w = (b & 0x3fff) + 1; h = ((b >> 14) & 0x3fff) + 1; }
  else if (kind === 'VP8X') { w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)); h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)); }
  else throw bad('The WebP file is damaged');
  return { width: w, height: h, data: buf };
}

function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw bad('That does not look like an image');
  var r, mime;
  if (PNG_SIG.every(function (b, i) { return buf[i] === b; })) { mime = 'image/png'; r = readPng(buf); }
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { mime = 'image/jpeg'; r = readJpeg(buf); }
  else if (eq(buf, 0, 'GIF87a') || eq(buf, 0, 'GIF89a')) { mime = 'image/gif'; r = readGif(buf); }
  else if (eq(buf, 0, 'RIFF') && eq(buf, 8, 'WEBP')) { mime = 'image/webp'; r = readWebp(buf); }
  else throw bad('Use a PNG, JPEG, GIF or WebP picture. Other formats (including SVG) are not allowed in emails.');
  if (!(r.width >= 1 && r.height >= 1) || r.width > MAX_DIM || r.height > MAX_DIM || r.width * r.height > MAX_PIXELS) {
    throw bad('The picture is too large (maximum ' + MAX_DIM + ' pixels on each side). Resize it first; logos rarely need more than 600 pixels.');
  }
  return { mime: mime, width: r.width, height: r.height, data: r.data };
}

var EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
module.exports = { inspect: inspect, EXT: EXT, MAX_DIM: MAX_DIM };
