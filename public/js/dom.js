/* Safe DOM building. There is deliberately NO innerHTML anywhere in the UI: every string becomes a
   text node, so data from the server (names, email text, ...) can never become markup (XSS-proof by
   construction). A test fails the build if forbidden APIs appear in /public/js. */
(function () {
  'use strict';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
    folder: 'M3 6h6l2 2h10v11H3z',
    users: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21c0-4 4-6 8-6s8 2 8 6',
    send: 'M3 11l18-8-8 18-2-8z',
    inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
    settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
    plus: 'M12 5v14M5 12h14', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2', x: 'M6 6l12 12M18 6L6 18', check: 'M5 13l4 4L19 7',
    alert: 'M12 3l10 18H2zM12 10v5M12 18v.01', play: 'M7 4l13 8-13 8z', pause: 'M8 5v14M16 5v14',
    copy: 'M9 9h11v11H9zM5 15V4h11', archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    chevron: 'M9 6l6 6-6 6', back: 'M15 6l-6 6 6 6', logout: 'M9 4H4v16h5M16 8l4 4-4 4M20 12H9',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14', upload: 'M12 16V5M7 9l5-5 5 5M5 20h14', edit: 'M4 20h4L19 9l-4-4L4 16z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    hourglass: 'M6 3h12M6 21h12M7 3c0 6 5 6 5 9s-5 3-5 9M17 3c0 6-5 6-5 9s5 3 5 9',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01', chart: 'M4 20V4M4 20h16M8 16v-5M13 16V8M18 16v-9', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6', ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M5.6 5.6l12.8 12.8', mail: 'M3 5h18v14H3zM3 6l9 7 9-7', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v.01M11 12h1v5h1'
  };
  function icon(name, cls) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'icon' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name] || ICONS.info); s.appendChild(p);
    return s;
  }
  function append(el, kids) {
    kids.forEach(function (k) {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) return append(el, k);
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
  }
  var FOCUSABLE = { a: 1, button: 1, input: 1, select: 1, textarea: 1 };
  // h('div', { class: 'x', on: { click: fn }, tip: 'help' }, child, 'text', ...)
  function h(tag, props) {
    var el = document.createElement(tag), kids = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
        else if (k === 'tip') { el.setAttribute('data-tip', String(v)); if (!FOCUSABLE[tag]) el.setAttribute('tabindex', '0'); }
        else if (k === 'href') { var s = String(v); if (/^#/.test(s) || (/^\/[^\/]/.test(s))) el.setAttribute('href', s); }   // only same-page (#) or same-origin (/) links are ever allowed
        else if (/^on/i.test(k) || k === 'style' || k === 'innerHTML' || k === 'outerHTML' || k === 'srcdoc') return;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    append(el, kids);
    return el;
  }
  // SVG builder for charts: attributes only (no style / on* / href), so data can never become script. svg('line', { x1: 0, ... })
  var SVG_TAGS = { svg: 1, g: 1, path: 1, line: 1, rect: 1, circle: 1, text: 1, title: 1, polyline: 1 };
  function svg(tag, attrs) {
    if (!SVG_TAGS[tag]) throw new Error('svg tag not allowed');
    var el = document.createElementNS(SVG_NS, tag), kids = Array.prototype.slice.call(arguments, 2);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false || /^on/i.test(k) || k === 'style' || k === 'href' || k === 'xlink:href') return;
      if (k === 'text') el.textContent = String(v); else el.setAttribute(k, String(v));
    });
    kids.forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  // Replace the content of el. While the page is scrolled, the old height is held for a moment so a background refresh
  // (skeleton first, data later) can never shrink the page and make the browser jump back to the top.
  function mount(el, node) {
    var y = window.pageYOffset || 0, hgt = el.offsetHeight;
    if (y > 0 && hgt > 0) {
      el.style.minHeight = hgt + 'px'; clearTimeout(el.sbMh);
      el.sbMh = setTimeout(function () { el.style.minHeight = ''; }, 1500);
    }
    clear(el); el.appendChild(node);
    if ((window.pageYOffset || 0) !== y) window.scrollTo(0, y);
  }
  window.SB = window.SB || {};
  SB.h = h; SB.svg = svg; SB.icon = icon; SB.clear = clear; SB.mount = mount;
})();
