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
    plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18', check: 'M5 13l4 4L19 7',
    alert: 'M12 3l10 18H2zM12 10v5M12 18v.01', play: 'M7 4l13 8-13 8z', pause: 'M8 5v14M16 5v14',
    chevron: 'M9 6l6 6-6 6', back: 'M15 6l-6 6 6 6', logout: 'M9 4H4v16h5M16 8l4 4-4 4M20 12H9',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14', upload: 'M12 16V5M7 9l5-5 5 5M5 20h14', edit: 'M4 20h4L19 9l-4-4L4 16z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v.01M11 12h1v5h1'
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
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function mount(el, node) { clear(el); el.appendChild(node); }
  window.SB = window.SB || {};
  SB.h = h; SB.icon = icon; SB.clear = clear; SB.mount = mount;
})();
