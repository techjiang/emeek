import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCssUrls, mapHref, splitCriticalStyles } from '../../src/pipeline/render/asset-url.js';
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

test('预算按**总量**判断，不是单文件 —— 三个 20KB 谁都没超限但总量 60KB', () => {
  // 这是实测抓到的洞：按单文件判断时 Inkstone（29.9KB）、
  // Magazine（39.9KB）总内联量远超阈值却全部通过。
  // 首屏 HTML 的膨胀来自总量，不是来自某一个文件。
  const big = 'x'.repeat(20 * 1024);
  const out = splitCriticalStyles(
    [{ name: 'main.css', content: big }, { name: 'a.css', content: big }, { name: 'b.css', content: big }],
    { limit: 24 * 1024 },
  );
  assert.equal(out.inline.length, 1, '只能内联一个 20KB 的文件（两个就 40KB 超限）');
  assert.ok(out.inlineBytes <= 24 * 1024);
});

test('超限时按用途优先级踢文件：先保住 main.css', () => {
  // 按字母序是 comments → main → search，于是超限时被踢出去的是
  // **排在后面的** —— 实测结果变成「首屏要的 main.css 走外链，
  // 只在搜索页用的 search.css 被内联」，与关键 CSS 的目的正好相反。
  const out = splitCriticalStyles([
    { name: 'comments.css', content: 'x'.repeat(4 * 1024) },
    { name: 'main.css', content: 'x'.repeat(30 * 1024) },
    { name: 'search.css', content: 'x'.repeat(4 * 1024) },
  ], { limit: 24 * 1024 });
  // main.css 单独就超限，必须走外链；但 comments/search 的顺序不能因此颠倒。
  assert.deepEqual(out.external.map((s) => s.name), ['main.css']);
  assert.deepEqual(out.inline.map((s) => s.name), ['comments.css', 'search.css']);
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
