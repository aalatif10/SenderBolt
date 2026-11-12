'use strict';
var assert = require('assert');
var S = require('../src/lib/sanitize');
var n = 0;
function ok(name, fn) { fn(); n++; }

var VECTORS = [
  '<script>alert(1)</script>x', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)><circle/></svg>',
  '<a href="javascript:alert(1)">x</a>', '<a href="JaVa\tScRiPt:alert(1)">x</a>', '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>', '<a href="data:text/html;base64,AAAA">x</a>', '<a href="vbscript:x">x</a>',
  '<a href=" ​javascript:alert(1)">x</a>', '<iframe src="//evil"></iframe>', '<p style="background:url(javascript:alert(1))">x</p>',
  '<p style="width:expression(alert(1))">x</p>', '<span style="color:red;\\63olor:red">x</span>', '<div onmouseover="x()">hi</div>',
  '<style>body{display:none}</style>t', '<!--<script>-->alert(1)<!-->', '<<script>script>alert(1)<</script>/script>',
  '<object data=x></object>', '<form action=x><input></form>', '<a href="http://x" onclick="y()">z</a>',
  '<a href=\'http://x" onmouseover="y\'>z</a>', '<base href="//evil/">', '<meta http-equiv=refresh content="0;url=//evil">',
  '<math><mi xlink:href="javascript:x">', '<p/onclick=alert(1)>x', '<b <script>alert(1)</script>>x'
];

ok('no vector survives with active content', function () {
  VECTORS.forEach(function (v) {
    var c = S.clean(v);
    assert(!/<\s*(script|iframe|svg|style|object|form|input|base|meta|math|img)/i.test(c), 'tag survived: ' + v + ' -> ' + c);
    assert(!/<[^>]*\son[a-z]+\s*=/i.test(c), 'handler survived: ' + v + ' -> ' + c);
    assert(!/javascript:|vbscript:|data:|expression\(|url\(/i.test(c.replace(/&#\d+;/g, '')), 'scheme survived: ' + v + ' -> ' + c);
    assert.strictEqual(S.clean(c), c, 'not idempotent: ' + v);
  });
});
ok('keeps formatting the editor produces', function () {
  var h = '<p>Hi <b>there</b>, <i>x</i> <u>y</u> <a href="https://a.com/p?a=1&amp;b=2">link</a></p><ul><li>one</li><li>two</li></ul><br>';
  assert.strictEqual(S.clean(h), h);
  var st = '<span style="font-family: Georgia, serif; font-size: 18px; color: #ff0000; font-weight: bold">t</span>';
  assert.strictEqual(S.clean(st), st);
});
ok('style filtering', function () {
  assert.strictEqual(S.clean('<span style="font-family: Comic Sans, x; color:#123">t</span>'), '<span style="color: #123">t</span>');
  assert.strictEqual(S.clean('<span style="font-size:200px">t</span>'), '<span>t</span>');
  assert.strictEqual(S.clean('<span style="position:fixed;top:0">t</span>'), '<span>t</span>');
});
ok('links', function () {
  assert.strictEqual(S.clean('<a href="mailto:a@b.com">m</a>'), '<a href="mailto:a@b.com">m</a>');
  assert.strictEqual(S.clean('<a href="/relative">r</a>'), 'r');
  assert.strictEqual(S.clean('<a>nohref</a>'), 'nohref');
});
ok('template syntax preserved', function () {
  var t = '<p>Hi {{first_name|there}}, {Hello|Hi} {{company}}</p>';
  assert.strictEqual(S.clean(t), t);
});
ok('text and structure', function () {
  assert.strictEqual(S.clean('1 < 2 & 3 > 0'), '1 &lt; 2 &amp; 3 &gt; 0');
  assert.strictEqual(S.clean('<p>a<p>b'), '<p>a</p><p>b</p>');
  assert.strictEqual(S.clean('<b><i>x</b>y'), '<b><i>x</i></b>y');
  assert.strictEqual(S.clean('a\u0000b'), 'ab');
  assert.strictEqual(S.clean(null), '');
  var deep = ''; for (var i = 0; i < 500; i++) deep += '<div>'; deep += 'x';
  assert(S.clean(deep).split('<div>').length <= 42);
});
ok('isBlank', function () {
  assert(S.isBlank('')); assert(S.isBlank('<p><br></p>')); assert(S.isBlank('<p>&nbsp;</p>'));
  assert(!S.isBlank('<p>x</p>'));
});
ok('fuzz: idempotent and never emits active content', function () {
  var parts = ['<', '>', '/', '"', "'", '=', ' ', 'a', 'href', 'javascript:', 'script', 'onerror', '&#x', '&', ';', 'style', 'url(', '<p>', '</p>', '<b>', '<a ', '<!--', '-->', '\n', '{{x|y}}', 'on', 'img', 'svg'];
  var seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (var k = 0; k < 4000; k++) {
    var s = '', len = 1 + Math.floor(rnd() * 25);
    for (var j = 0; j < len; j++) s += parts[Math.floor(rnd() * parts.length)];
    var c = S.clean(s);
    assert.strictEqual(S.clean(c), c, 'idempotence: ' + JSON.stringify(s));
    assert(!/<\s*(script|iframe|svg|style|img|object)/i.test(c), 'tag: ' + JSON.stringify(s));
    assert(!/<[^>]*\son[a-z]+\s*=/i.test(c), 'handler: ' + JSON.stringify(s) + ' -> ' + c);
  }
});
console.log('sanitize: ' + n + '/' + n + ' passed');
