/* Global tooltip (public/js/tooltip.js): one fixed-position bubble for every [data-tip] element.
 * Why: the old CSS-only tooltips were clipped by table rows and scroll containers. A fixed element is never clipped,
 * flips below/above to stay on screen, sits above every panel (z-index 1000) and works for hover and keyboard focus.
 * Text goes in with textContent only. */
(function () {
  'use strict';
  var tip = document.createElement('div');
  tip.className = 'sb-tip'; tip.setAttribute('role', 'tooltip'); tip.id = 'sb-tip';
  var cur = null, timer = null;

  function place(el) {
    var r = el.getBoundingClientRect(), w = tip.offsetWidth, hgt = tip.offsetHeight, m = 8;
    var left = r.left + r.width / 2 - w / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - w - m));
    var top = r.top - hgt - m, below = false;
    if (top < m) { top = r.bottom + m; below = true; }
    if (top + hgt > window.innerHeight - m) top = Math.max(m, window.innerHeight - hgt - m);
    tip.style.left = Math.round(left) + 'px'; tip.style.top = Math.round(top) + 'px';
    tip.classList.toggle('below', below);
  }
  function show(el) {
    var t = el.getAttribute('data-tip');
    if (!t) return;
    cur = el; tip.textContent = t; tip.classList.add('on'); place(el);
    el.setAttribute('aria-describedby', 'sb-tip');
  }
  function hide() {
    clearTimeout(timer);
    if (cur) { cur.removeAttribute('aria-describedby'); cur = null; }
    tip.classList.remove('on');
  }
  function target(e) { return e.target && e.target.closest ? e.target.closest('[data-tip]') : null; }

  document.addEventListener('mouseover', function (e) {
    var el = target(e); if (!el || el === cur) return;
    clearTimeout(timer); timer = setTimeout(function () { show(el); }, 120);
  });
  document.addEventListener('mouseout', function (e) {
    var el = target(e); if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });
  document.addEventListener('focusin', function (e) { var el = target(e); if (el) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.keyCode === 27) hide(); });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide, true);
  // A repaint can remove the element the bubble belongs to; never leave it hanging.
  setInterval(function () { if (cur && !document.body.contains(cur)) hide(); }, 500);
  if (document.body) document.body.appendChild(tip); else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(tip); });
})();
