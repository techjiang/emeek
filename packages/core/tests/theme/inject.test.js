import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCss, sanitizeInjection, buildNoFlashScript, buildInjections } from '../../src/theme/inject.js';

// ── customCSS：唯一的逃逸口是 </style>，必须堵死 ──────────────
test('customCSS 里的 </style> 被拆解，无法跳出样式上下文', () => {
  const out = sanitizeCss('body{color:red}</style><script>alert(1)</script>');
  assert.ok(!/<\/style/i.test(out), '不能有可用的 </style');
  assert.match(out, /<\\\/style/);
});

test('</STYLE> 大小写与空白变形同样被挡', () => {
  for (const payload of ['</STYLE>', '</ style >', '</Style  >']) {
    const out = sanitizeCss(`a{}${payload}<script>x</script>`);
    assert.ok(!/<\/\s*style/i.test(out), `${payload} 未被挡`);
  }
});

test('CSS expression() / -moz-binding 被中立化', () => {
  const out = sanitizeCss('a{width:expression(alert(1))}b{-moz-binding:url(x)}');
  assert.ok(!/expression\s*\(/i.test(out));
  assert.ok(!/-moz-binding\s*:/i.test(out));
});

test('@import 只允许 http(s)', () => {
  const out = sanitizeCss('@import url("javascript:alert(1)");@import "http://x/a.css";');
  assert.ok(!/javascript:/i.test(out));
});

// ── customHead / customFooter 白名单 ─────────────────────────
test('head 里的 <script> 连内容一起被移除', () => {
  const out = sanitizeInjection('<meta name="a" content="b"><script>alert(1)</script>', 'head');
  assert.match(out, /<meta name="a"/);
  assert.ok(!/script/i.test(out));
  assert.ok(!/alert/.test(out), '脚本内容不该留下');
});

test('footer 里的 on* 事件属性被剥掉', () => {
  const out = sanitizeInjection('<div onclick="alert(1)" class="c">hi</div>', 'footer');
  assert.match(out, /<div class="c">hi<\/div>/);
  assert.ok(!/onclick/.test(out));
});

test('head 不允许 div 这类正文标签（位置收敛）', () => {
  const out = sanitizeInjection('<div>nope</div><meta name="ok" content="1">', 'head');
  assert.ok(!/<div/.test(out));
  assert.match(out, /<meta/);
});

test('footer 不允许 <script>（与「主题配置不得注入脚本」一致）', () => {
  const out = sanitizeInjection('<script src="x.js"></script><span>ok</span>', 'footer');
  assert.ok(!/<script/i.test(out));
  assert.match(out, /<span>ok<\/span>/);
});

test('href 上的 javascript: 被丢弃', () => {
  const out = sanitizeInjection('<a href="javascript:alert(1)">x</a><a href="https://ok">y</a>', 'footer');
  assert.ok(!/javascript:/i.test(out));
  assert.match(out, /href="https:\/\/ok"/);
});

test('data:text/html 被拒（data:image 图片仍可）', () => {
  const out = sanitizeInjection('<img src="data:text/html,<script>1</script>"><img src="data:image/png;base64,AA">', 'footer');
  assert.ok(!/data:text\/html/i.test(out));
  assert.match(out, /data:image\/png/);
});

test('meta refresh 指向 javascript: 被拒', () => {
  const out = sanitizeInjection('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', 'head');
  assert.ok(!/javascript:/i.test(out));
});

test('head 里的 <style> 会过一遍 sanitizeCss', () => {
  const out = sanitizeInjection('<style>body{}</style><script>x</script>', 'head');
  assert.match(out, /<style>body\{\}<\/style>/);
});

// ── 首帧无闪烁脚本 ───────────────────────────────────────────
test('no-flash 脚本同步设置 data-theme，读 localStorage 与系统偏好', () => {
  const js = buildNoFlashScript('auto');
  assert.match(js, /localStorage\.getItem\('emeeek-theme'\)/);
  assert.match(js, /prefers-color-scheme: dark/);
  assert.match(js, /setAttribute\('data-theme'/);
  assert.ok(!/async|await|setTimeout/.test(js), '必须同步执行，不能异步');
});

test('强制 light/dark 时忽略 localStorage 与系统', () => {
  assert.match(buildNoFlashScript('dark'), /var m="dark"/);
  assert.match(buildNoFlashScript('light'), /var m="light"/);
  assert.match(buildNoFlashScript('auto'), /var m=null/);
});

test('脚本异常被 try/catch 包住（隐私模式下 localStorage 抛错不能白屏）', () => {
  assert.match(buildNoFlashScript('auto'), /try\{/);
});

// ── 组合 ────────────────────────────────────────────────────
test('buildInjections 组合变量、自定义 CSS 与注入位置', () => {
  const theme = { variables: ':root { --x: 1; }' };
  const out = buildInjections(theme, {
    customCSS: '.a{}', customHead: '<meta name="k">', customFooter: '<span>f</span>', darkMode: 'auto',
  });
  assert.match(out.headStyle, /--x: 1/);
  assert.match(out.headStyle, /\.a\{\}/);
  assert.match(out.headExtra, /<meta name="k"/);
  assert.match(out.footerExtra, /<span>f<\/span>/);
  assert.match(out.noFlash, /data-theme/);
});

test('customCSS 里的逃逸尝试在组合阶段被挡', () => {
  const out = buildInjections({ variables: '' }, { customCSS: 'x{}</style><script>alert(1)</script>' });
  assert.ok(!/<\/style><script/i.test(out.headStyle));
});

test('没有任何自定义时 headStyle 为空', () => {
  const out = buildInjections({ variables: '' }, {});
  assert.equal(out.headStyle, '');
  assert.equal(out.headExtra, '');
  assert.equal(out.footerExtra, '');
});
