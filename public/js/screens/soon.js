(function () {
  'use strict';
  var h = SB.h;
  SB.screens = SB.screens || {};
  SB.screens.soon = function (icon, title, text) {
    return { el: h('div', { class: 'card soon' }, h('div', { class: 'empty' }, SB.icon(icon, 'icon-lg'), h('h2', { text: title }), h('p', { text: text })), h('div', { class: 'small faint', text: 'The data and rules for this area already work in the background; its screen is the next thing being built.' })), destroy: function () {} };
  };
})();
