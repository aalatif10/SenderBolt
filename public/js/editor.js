/* public/js/editor.js - lightweight rich-text editor for email bodies.
   Built on contenteditable + execCommand (no libraries, no build step). Safety model:
   - HTML never goes in through innerHTML. Saved HTML is parsed with DOMParser (an inert document) and
     rebuilt node by node through an ALLOWLIST (same tags and style properties as the server sanitizer).
   - HTML comes out through our own serializer that walks the DOM and emits only allowlisted tags/attributes.
   - Pasted content takes the same path. The server sanitizes again (src/lib/sanitize.js) on save, preview and send.
   API: SB.editor.create({ value, placeholder, variables, onChange }) -> { el, getHtml, setHtml, focus, insertText, isEmpty }
        SB.editor.render(html) -> DocumentFragment (safe DOM for previews) */
(function () {
  'use strict';
  var h = SB.h;
  // NOTE: execCommand runs with styleWithCSS off (our CSP blocks inline style attributes), so it produces <font face size>; that is converted to a styled span on the way in and out.
  var SIZE_KW = { 1: 'x-small', 2: 'small', 3: 'medium', 4: 'large', 5: 'x-large', 6: 'xx-large', 7: 'xx-large' };
  var TAGS = { p: 1, div: 1, br: 1, span: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, a: 1, ul: 1, ol: 1, li: 1, blockquote: 1 };
  var DROP = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, template: 1, noscript: 1, textarea: 1, title: 1, svg: 1, math: 1, head: 1 };
  var FONTS = [['Default', ''], ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Verdana', 'Verdana'], ['Tahoma', 'Tahoma'], ['Trebuchet MS', 'Trebuchet MS'], ['Times New Roman', 'Times New Roman'], ['Courier New', 'Courier New']];
  var SIZES = [['Small', '2'], ['Normal', '3'], ['Large', '4'], ['Huge', '5']];
  var FAMILY_OK = /^(arial|helvetica|helvetica neue|verdana|tahoma|trebuchet ms|georgia|times new roman|times|courier new|courier|segoe ui|sans-serif|serif|monospace)$/;

  function safeHref(v) {
    var probe = String(v || '').replace(/[\u0000- \u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '').toLowerCase();
    return /^(https?:\/\/[^\/]|mailto:[^\s])/.test(probe) && String(v).length <= 2000 ? String(v).trim() : null;
  }
  // Style handling. IMPORTANT: our CSP blocks inline style attributes even inside DOMParser documents, so HTML is
  // rewritten as text first (style="..." becomes data-st="...", <style> blocks are removed) and the declarations are
  // validated by hand. Styles are only ever applied through CSSOM property setters.
  var COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
  function parseStyle(str) {
    var o = {}; String(str || '').split(';').forEach(function (d) { var i = d.indexOf(':'); if (i > 0) o[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); });
    return o;
  }
  function cleanDecl(str) {
    var d = parseStyle(str), o = {}, v;
    if (d['font-family'] && d['font-family'].split(',').every(function (x) { return FAMILY_OK.test(x.trim().replace(/^["']|["']$/g, '').toLowerCase()); })) o['font-family'] = d['font-family'].replace(/["']/g, '');
    v = (d['font-size'] || '').toLowerCase(); if (sizeNum(v)) o['font-size'] = v;
    if (COLOR_RE.test(d.color || '')) o.color = d.color;
    v = (d['font-weight'] || '').toLowerCase(); if (v === 'bold' || v === '700' || v === '600') o['font-weight'] = 'bold';
    v = (d['font-style'] || '').toLowerCase(); if (v === 'italic') o['font-style'] = 'italic';
    v = (d['text-decoration'] || d['text-decoration-line'] || '').toLowerCase().split(' ')[0]; if (v === 'underline') o['text-decoration'] = 'underline';
    return o;
  }
  function neutralise(html) {
    return String(html || '').replace(/<style[\s\S]*?(<\/style\s*>|$)/gi, '').replace(/(\s)style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1data-st=$2');
  }
  // live element -> allowed declarations text (elements styled through CSSOM)
  function safeStyle(el) {
    var st = el.style, out = [];
    if (!st) return '';
    var c = cleanDecl('font-family:' + st.fontFamily + ';font-size:' + st.fontSize + ';color:' + st.color + ';font-weight:' + st.fontWeight + ';font-style:' + st.fontStyle + ';text-decoration:' + (st.textDecorationLine || st.textDecoration));
    Object.keys(c).forEach(function (k) { out.push(k + ': ' + c[k]); });
    return out.join('; ');
  }

  // Source node (from an inert document or the live editor) -> appended into `into` (a live node), allowlisted.
  function copyInto(src, into, depth) {
    if (depth > 40) return;
    Array.prototype.forEach.call(src.childNodes, function (n) {
      if (n.nodeType === 3) { into.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      if (DROP[tag]) return;
      if (tag === 'font') {
        var f = document.createElement('font'), face = (n.getAttribute('face') || '').trim(), sz = n.getAttribute('size');
        if (face && face.split(',').every(function (x) { return FAMILY_OK.test(x.trim().replace(/^["']|["']$/g, '').toLowerCase()); })) f.setAttribute('face', face);
        if (SIZE_KW[sz]) f.setAttribute('size', sz);
        copyInto(n, f, depth + 1); into.appendChild(f); return;
      }
      if (tag === 'img') { var pic = imgFrom(n); if (pic) into.appendChild(pic); return; }
      if (!TAGS[tag]) { copyInto(n, into, depth + 1); return; }
      var el = document.createElement(tag);
      if (tag === 'a') {
        var href = safeHref(n.getAttribute('href'));
        if (!href) { copyInto(n, into, depth + 1); return; }
        el.setAttribute('href', href);
      }
      var decl = cleanDecl(n.getAttribute && (n.getAttribute('data-st') || ''));
      var face = decl['font-family'], size = sizeNum(decl['font-size']), target = into;
      // font family / size are kept as <font face size> (what execCommand produces with CSS styles off)
      if (face || size) {
        var fe = document.createElement('font'); if (face) fe.setAttribute('face', face.replace(/["']/g, '')); if (size) fe.setAttribute('size', size);
        into.appendChild(fe); target = fe;
      }
      ['color', 'font-weight', 'font-style', 'text-decoration'].forEach(function (k) { if (decl[k]) el.style.setProperty(k, decl[k]); });   // CSSOM property setters are allowed under our CSP
      if (tag !== 'br') copyInto(n, el, depth + 1);
      target.appendChild(el);
      return;
    });
  }
  // Pictures: only OUR library pictures are allowed (src "sbimg:ID" when saved, "/api/images/ID" while editing). Anything else
  // (external urls, data: uris, tracking pixels) is dropped, which also keeps pasted web content from smuggling pictures in.
  var IMG_SRC = /^(?:sbimg:|\/api\/images\/)(\d{1,9})$/;
  function dim(v, lo, hi) { var n = /^\d{1,5}$/.test(String(v || '')) ? parseInt(v, 10) : 0; return n >= lo && n <= hi ? n : 0; }
  function imgFrom(n) {
    var m = IMG_SRC.exec(String(n.getAttribute('src') || '').trim());
    if (!m) return null;
    var im = document.createElement('img'), w = dim(n.getAttribute('width'), 8, 1000), ht = dim(n.getAttribute('height'), 8, 1600);
    im.setAttribute('src', '/api/images/' + m[1]); im.setAttribute('data-sb-img', m[1]);
    im.setAttribute('alt', String(n.getAttribute('alt') || '').slice(0, 125));
    if (w) im.setAttribute('width', String(w)); if (ht) im.setAttribute('height', String(ht));
    return im;
  }
  function sizeNum(kw) { for (var k in SIZE_KW) { if (SIZE_KW[k] === kw) return k; } return null; }
  function render(html) {
    var frag = document.createDocumentFragment();
    var doc = new DOMParser().parseFromString('<!doctype html><body>' + neutralise(html), 'text/html');
    copyInto(doc.body, frag, 0);
    return frag;
  }

  function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function serialize(node, depth) {
    var out = '';
    if (depth > 40) return out;
    Array.prototype.forEach.call(node.childNodes, function (n) {
      if (n.nodeType === 3) { out += esc(n.nodeValue.replace(/ /g, ' ')); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      if (DROP[tag]) return;
      if (tag === 'font') {
        var fs = [], face = (n.getAttribute('face') || '').trim(), sz = n.getAttribute('size');
        if (face && face.split(',').every(function (x) { return FAMILY_OK.test(x.trim().replace(/^["']|["']$/g, '').toLowerCase()); })) fs.push('font-family: ' + face);
        if (SIZE_KW[sz]) fs.push('font-size: ' + SIZE_KW[sz]);
        out += fs.length ? '<span style="' + fs.join('; ') + '">' + serialize(n, depth + 1) + '</span>' : serialize(n, depth + 1); return;
      }
      if (tag === 'img') {
        var pic = imgFrom(n);
        if (pic) out += '<img src="sbimg:' + pic.getAttribute('data-sb-img') + '" alt="' + esc(pic.getAttribute('alt')).replace(/"/g, '&quot;') + '"' +
          (pic.getAttribute('width') ? ' width="' + pic.getAttribute('width') + '"' : '') + (pic.getAttribute('height') ? ' height="' + pic.getAttribute('height') + '"' : '') + '>';
        return;
      }
      if (!TAGS[tag]) { out += serialize(n, depth + 1); return; }
      if (tag === 'br') { out += '<br>'; return; }
      var attrs = '';
      if (tag === 'a') {
        var href = safeHref(n.getAttribute('href'));
        if (!href) { out += serialize(n, depth + 1); return; }
        attrs += ' href="' + href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"';
      }
      var st = safeStyle(n);
      if (st) attrs += ' style="' + st.replace(/"/g, '&quot;') + '"';
      out += '<' + tag + attrs + '>' + serialize(n, depth + 1) + '</' + tag + '>';
    });
    return out;
  }

  function create(o) {
    o = o || {};
    var area = h('div', { class: 'ed-area', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': o.label || 'Email text', 'data-placeholder': o.placeholder || '', spellcheck: 'true' });
    var saved = null, changeTimer = null;

    function changed() { if (o.onChange) { clearTimeout(changeTimer); changeTimer = setTimeout(function () { o.onChange(getHtml()); }, 150); } }
    function getHtml() { return serialize(area, 0); }
    function setHtml(html) { SB.clear(area); area.appendChild(render(html)); }
    function isEmpty() { return !area.textContent.replace(/ /g, ' ').trim() && !area.querySelector('a,li'); }
    function focus() { area.focus(); }
    function remember() { var s = window.getSelection(); if (s && s.rangeCount && area.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); }
    function restore() { area.focus(); if (saved) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); } }
    function cmd(name, val) {
      restore();
      try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* older engines */ }
      try { document.execCommand(name, false, val === undefined ? null : val); } catch (e) { /* not supported: ignore */ }
      remember(); changed(); refresh();
    }
    function insertText(t) { restore(); try { document.execCommand('insertText', false, t); } catch (e) { /* ignore */ } remember(); changed(); }

    area.addEventListener('input', changed);
    area.addEventListener('keyup', function () { remember(); refresh(); });
    area.addEventListener('mouseup', function () { remember(); refresh(); });
    area.addEventListener('blur', remember);
    area.addEventListener('paste', function (e) {
      var cd = e.clipboardData; if (!cd) return;
      e.preventDefault();
      var html = cd.getData('text/html'), txt = cd.getData('text/plain');
      try {
        if (html) {
          var tmp = document.createElement('div'); tmp.appendChild(render(html));
          document.execCommand('insertHTML', false, serialize(tmp, 0));
        } else document.execCommand('insertText', false, txt);
      } catch (err) { /* ignore */ }
      changed();
    });
    area.addEventListener('drop', function (e) { e.preventDefault(); });      // no dragging files / html into the editor
    area.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); linkDialog(); }
    });

    // ---- toolbar ----
    var buttons = {};
    function btn(key, icon, label, tip, fn) {
      var b = h('button', { class: 'ed-btn', type: 'button', 'aria-label': label, tip: tip });
      b.appendChild(icon); b.addEventListener('mousedown', function (e) { e.preventDefault(); });     // keep the selection
      b.addEventListener('click', fn); buttons[key] = b; return b;
    }
    function glyph(t, cls) { return h('span', { class: 'ed-glyph ' + (cls || ''), text: t }); }
    function select(label, opts, onPick) {
      var s = h('select', { class: 'ed-select', 'aria-label': label, tip: label }, opts.map(function (x) { return h('option', { value: x[1] }, x[0]); }));
      s.addEventListener('mousedown', remember);
      s.addEventListener('change', function () { if (s.value !== '') onPick(s.value); s.selectedIndex = 0; });
      return s;
    }
    function linkDialog() {
      remember();
      var sel = saved ? saved.toString() : '';
      var url = h('input', { class: 'input', id: 'ed-url', placeholder: 'https://example.com', maxlength: 2000 });
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      var existing = null; if (saved) { var n = saved.startContainer; while (n && n !== area) { if (n.nodeType === 1 && n.tagName === 'A') { existing = n; break; } n = n.parentNode; } }
      if (existing) url.value = existing.getAttribute('href') || '';
      SB.ui.modal({ title: existing ? 'Edit link' : 'Add link', body: h('div', null, err,
        h('div', { class: 'field' }, h('label', { for: 'ed-url' }, 'Web address'), url, h('div', { class: 'hint', text: sel ? 'The selected text "' + sel.slice(0, 60) + '" becomes the link.' : 'Select some text first, or the address itself is shown as the link text.' }))),
        actions: [{ label: 'Cancel' }].concat(existing ? [{ label: 'Remove link', kind: 'danger', onClick: function (close) { close(); cmd('unlink'); } }] : []).concat([{ label: 'Apply', kind: 'primary', onClick: function (close) {
          var v = url.value.trim();
          if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s@]+\.[^\s]+$/.test(v)) v = 'https://' + v;
          if (!v) { err.textContent = 'Enter a web address.'; err.classList.remove('hidden'); return Promise.reject(new Error('x')); }
          if (!safeHref(v)) { err.textContent = 'Only web (http, https) and email (mailto:) links are allowed.'; err.classList.remove('hidden'); return Promise.reject(new Error('x')); }
          close();
          if (sel || existing) cmd('createLink', v); else cmd('insertHTML', '<a href="' + v.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' + esc(v) + '</a>');
        } }]) });
    }
    // ---- pictures (logo, small images): stored once in the library, embedded in the email as an inline part ----
    function pictureDialog() {
      remember();
      var P = SB.S.images, box = h('div', { class: 'pic-lib' }), chosen = null, alt = h('input', { class: 'input', id: 'pic-alt', maxlength: 125, placeholder: P.altPlaceholder });
      var width = h('select', { class: 'input', id: 'pic-w', 'aria-label': 'Width in the email' }, [80, 120, 160, 240, 320, 480].map(function (w) { return h('option', { value: w }, w + ' px' + (w === 120 ? ' (logo)' : '')); }));
      width.value = '120';
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden', 'aria-label': 'Choose a picture file' });
      function fail(m) { err.textContent = m; err.classList.remove('hidden'); }
      function paint(items) {
        SB.clear(box);
        if (!items.length) { box.appendChild(h('p', { class: 'small muted', text: P.empty })); return; }
        items.forEach(function (it) {
          var img = h('img', { src: '/api/images/' + it.id, alt: it.name, width: 56, height: 56, class: 'pic-thumb' });
          var del = h('button', { class: 'pic-del', type: 'button', 'aria-label': 'Delete ' + it.name, tip: P.deleteTip, on: { click: function (e) {
            e.stopPropagation();
            SB.api.del('/api/images/' + it.id).then(function () { if (chosen && chosen.id === it.id) chosen = null; return load(); }, function (er) { fail(SB.api.friendly(er)); });
          } } }, SB.icon('x'));
          var tile = h('div', { class: 'pic-tile' + (chosen && chosen.id === it.id ? ' on' : ''), role: 'button', tabindex: '0', 'aria-label': it.name + ', ' + it.width + ' by ' + it.height, tip: it.name + ' \u00b7 ' + Math.round(it.size / 1024) + ' KB' }, img, h('span', { class: 'small', text: it.name }), del);
          function pick() { chosen = it; if (!alt.value) alt.value = it.name; paint(items); }
          tile.addEventListener('click', pick);
          tile.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
          box.appendChild(tile);
        });
      }
      var cache = [];
      function load() { return SB.api.get('/api/images').then(function (r) { cache = r.items; paint(cache); }, function (e) { fail(SB.api.friendly(e)); }); }
      file.addEventListener('change', function () {
        var f = file.files && file.files[0]; if (!f) return;
        err.classList.add('hidden');
        if (f.size > 300 * 1024) { fail(P.tooBig); file.value = ''; return; }
        var rd = new FileReader();
        rd.onload = function () {
          var b64 = String(rd.result).replace(/^data:[^,]*,/, '');
          SB.api.post('/api/images', { name: f.name, data: b64 }).then(function (r) { chosen = r.image; alt.value = alt.value || r.image.name; return load(); }, function (e) { fail(SB.api.friendly(e)); });
        };
        rd.onerror = function () { fail(P.readFail); };
        rd.readAsDataURL(f); file.value = '';
      });
      load();
      SB.ui.modal({ title: P.title, body: h('div', null, err, h('p', { class: 'small muted', text: P.intro }),
        h('div', { class: 'actions pad-b' }, h('button', { class: 'btn btn-sm', type: 'button', on: { click: function () { file.click(); } } }, SB.icon('upload'), P.upload), file), box,
        h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', { for: 'pic-alt' }, P.alt, SB.ui.info(P.altTip)), alt), h('div', { class: 'field' }, h('label', { for: 'pic-w' }, P.width), width)),
        h('p', { class: 'small faint', text: P.limits })),
        actions: [{ label: 'Cancel' }, { label: P.insert, kind: 'primary', onClick: function (close) {
          if (!chosen) { fail(P.choose); return Promise.reject(new Error('x')); }
          if (!alt.value.trim()) { fail(P.needAlt); return Promise.reject(new Error('x')); }
          if (area.querySelectorAll('img').length >= 3) { fail(P.tooMany); return Promise.reject(new Error('x')); }
          var w = parseInt(width.value, 10), ht = Math.max(8, Math.round(w * chosen.height / chosen.width));
          close();
          cmd('insertHTML', '<img src="/api/images/' + chosen.id + '" data-sb-img="' + chosen.id + '" alt="' + esc(alt.value.trim()).replace(/"/g, '&quot;') + '" width="' + w + '" height="' + ht + '">');
        } }] });
    }
    var varSelect = null;
    if (o.variables && o.variables.length) {
      varSelect = select('Insert a personalisation field, for example the first name', [['Insert field', '']].concat(o.variables.map(function (v) { return [v[0], v[1]]; })), function (val) { insertText(val); });
    }
    var bar = h('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': 'Text formatting' },
      select('Font', FONTS.map(function (f) { return [f[0], f[1]]; }).map(function (f, i) { return i === 0 ? ['Font', ''] : f; }), function (v) { cmd('fontName', v); }),
      select('Text size', [['Size', '']].concat(SIZES), function (v) { cmd('fontSize', v); }),
      h('span', { class: 'ed-sep' }),
      btn('bold', glyph('B', 'b'), 'Bold', 'Bold (Ctrl+B)', function () { cmd('bold'); }),
      btn('italic', glyph('I', 'i'), 'Italic', 'Italic (Ctrl+I)', function () { cmd('italic'); }),
      btn('underline', glyph('U', 'u'), 'Underline', 'Underline (Ctrl+U)', function () { cmd('underline'); }),
      h('span', { class: 'ed-sep' }),
      btn('ul', glyph('•≡'), 'Bulleted list', 'Bulleted list', function () { cmd('insertUnorderedList'); }),
      btn('ol', glyph('1.'), 'Numbered list', 'Numbered list', function () { cmd('insertOrderedList'); }),
      btn('link', SB.icon('edit'), 'Link', 'Add or edit a link (Ctrl+K)', linkDialog),
      o.pictures === false ? null : btn('picture', SB.icon('image'), 'Picture', SB.S.images.tip, pictureDialog),
      btn('clear', glyph('Tx', 'clr'), 'Clear formatting', 'Remove formatting from the selected text', function () { cmd('removeFormat'); }),
      varSelect ? h('span', { class: 'ed-sep' }) : null, varSelect);
    function refresh() {
      ['bold', 'italic', 'underline'].forEach(function (k) {
        var on = false; try { on = document.queryCommandState(k); } catch (e) { on = false; }
        buttons[k].classList.toggle('on', !!on && document.activeElement === area);
      });
    }
    if (o.value) setHtml(o.value);
    var el = h('div', { class: 'ed' }, bar, area);
    return { el: el, area: area, getHtml: getHtml, setHtml: setHtml, focus: focus, insertText: insertText, isEmpty: isEmpty };
  }

  SB.editor = { create: create, render: render, serialize: serialize };
})();
