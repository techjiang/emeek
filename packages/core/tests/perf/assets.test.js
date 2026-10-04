import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCssUrls, mapHref } from '../../src/pipeline/render/asset-url.js';
import { planStyles, injectAssets } from '../../src/pipeline/render/output.js';

test('rewriteCssUrls：站内相对地址绝对化到 base', () => {
  assert.equal(
    rewriteCssUrls('a{background:url(font.woff2)}', { base: '/blog' }),
    'a{background:url(/blog/font.woff2)}',
  );
  assert.equal(
    rewriteCssUrls("a{background:url('./x.png')}", { base: '/blog' }),
    'a{background:url(\'/blog/x.png\')}',  // 引号原样保留
  );
});

test('rewriteCssUrls：不该动的地址一个都不动', () => {
  const css = [
    'a{background:url(data:image/png;base64,AAA)}',
    'b{background:url(https://cdn.example.com/x.png)}',
    'c{background:url(//cdn.example.com/x.png)}',
    'd{background:url(/already-absolute.png)}',
    'e{background:url(#gradient)}',
  ].join('\n');
  assert.equal(rewriteCssUrls(css, { base: '/blog' }), css);
});

test('rewriteCssUrls：base 为空时整段原样返回（不做无意义改写）', () => {
  const css = 'a{background:url(x.png)}';
  assert.equal(rewriteCssUrls(css, { base: '' }), css);
});

test('rewriteCssUrls：@import 两种写法都改，且不被 url() 规则先吃掉', () => {
  const out = rewriteCssUrls('@import "a.css";\n@import url(b.css);', { base: '/blog' });
  assert.match(out, /@import "\/blog\/a\.css"/);
  assert.match(out, /@import url\(\/blog\/b\.css\)/);
});

test('mapHref：已绝对化的地址再次调用不会叠加前缀', () => {
  // 这条防的是「构建跑两次前缀叠两次」—— 产物里会出现 /blog/blog/x.png。
  assert.equal(mapHref('/blog/x.png', '/blog'), '/blog/x.png');
});

test('planStyles：小主题整份内联，不产生外链', () => {
  const plan = planStyles({ styles: [{ name: 'main.css', content: 'a{}' }] }, { perf: {} });
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.external.length, 0);
});

test('planStyles：超限的走外链，且合并成一个文件（避免 N 个请求）', () => {
  const big = 'x'.repeat(30 * 1024);
  const plan = planStyles(
    { styles: [{ name: 'main.css', content: 'a{}' }, { name: 'big.css', content: big }, { name: 'big2.css', content: big }] },
    { perf: {} },
  );
  // 一个 26KB 的文件不该把 9KB 的 main.css 也一起踢出去 —— main.css 才是首屏要的。
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.external.length, 1, '两份超限样式合成一个 theme.css');
  assert.equal(plan.external[0].publicPath, '/assets/theme.css');
});

test('planStyles：criticalCSS=false 时整份外链', () => {
  const plan = planStyles({ styles: [{ name: 'main.css', content: 'a{}' }] }, { perf: { criticalCSS: false } });
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.external.length, 1);
});

test('injectAssets：变量覆盖块排在最后（否则同权重选择器会被主题默认值盖掉）', () => {
  const html = '<html><head></head><body></body></html>';
  const out = injectAssets(html, {
    cssPlan: { base: '', inline: [{ content: 'body{color:red}' }], external: [], vars: '<style>:root{--accent:#fff}</style>' },
    headExtra: '<link rel="stylesheet" href="/assets/x.css" />',
  });
  const inlineAt = out.indexOf('body{color:red}');
  const varsAt = out.indexOf('--accent:#fff');
  assert.ok(inlineAt > -1 && varsAt > inlineAt, '变量块必须在主题 CSS 之后');
  assert.ok(out.indexOf('rel="stylesheet"') < varsAt, '外链也要在变量块之前');
});
