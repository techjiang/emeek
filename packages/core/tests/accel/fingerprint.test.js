import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentHash,
  fingerprintPath,
  shouldFingerprint,
  buildAssetMap,
  rewriteHtmlReferences,
  isLocalUrl,
} from '../../src/accel/fingerprint.js';

describe('资源指纹', () => {
  test('同一内容永远得到同一指纹（幂等）', () => {
    const a = contentHash('body { color: red }', 'css');
    const b = contentHash('body { color: red }', 'css');
    assert.equal(a, b);
    assert.equal(a.length, 8);
  });

  test('内容变一个字节，指纹就变', () => {
    const a = contentHash('body { color: red }', 'css');
    const b = contentHash('body { color: red} ', 'css');
    assert.notEqual(a, b);
  });

  test('内容相同但扩展名不同时指纹不同（避免类型混用）', () => {
    assert.notEqual(contentHash('x', 'css'), contentHash('x', 'js'));
  });

  test('fingerprintPath 保留目录与扩展名，只插哈希', () => {
    assert.match(fingerprintPath('/assets/theme.css', 'abc'), /^\/assets\/theme\.[0-9a-f]{8}\.css$/);
    assert.match(fingerprintPath('app.js', 'abc'), /^app\.[0-9a-f]{8}\.js$/);
  });

  test('HTML 不指纹 —— 它是稳定入口，变了要立刻被看见', () => {
    assert.equal(shouldFingerprint('/index.html'), false);
    assert.equal(shouldFingerprint('/posts/a.html'), false);
  });

  test('静态资源指纹，数据入不指纹', () => {
    assert.equal(shouldFingerprint('/assets/theme.css'), true);
    assert.equal(shouldFingerprint('/assets/f.woff2'), true);
    assert.equal(shouldFingerprint('/search-index.json'), false);
    assert.equal(shouldFingerprint('/sitemap.xml'), false);
    assert.equal(shouldFingerprint('/robots.txt'), false);
  });

  test('buildAssetMap 关闭时退化为恒等映射（调用方无需分支）', () => {
    const { map, assets } = buildAssetMap([{ path: '/a.css', content: 'x' }], { enabled: false });
    assert.equal(map.get('/a.css'), '/a.css');
    assert.equal(assets[0].fingerprint, null);
  });

  test('buildAssetMap 输出可直接用于改写', () => {
    const { map } = buildAssetMap([
      { path: '/assets/theme.css', content: 'a' },
      { path: '/index.html', content: 'b' },
    ]);
    assert.match(map.get('/assets/theme.css'), /theme\.[0-9a-f]{8}\.css/);
    assert.equal(map.get('/index.html'), '/index.html');
  });

  test('rewriteHtmlReferences 改写 href/src', () => {
    const { map } = buildAssetMap([{ path: '/assets/theme.css', content: 'x' }]);
    const html = '<link href="/assets/theme.css" rel="stylesheet" /><script src="/assets/app.js"></script>';
    const out = rewriteHtmlReferences(html, map);
    assert.match(out, /href="\/assets\/theme\.[0-9a-f]{8}\.css"/);
    // 未命中映射的保持原样
    assert.match(out, /src="\/assets\/app\.js"/);
  });

  test('rewriteHtmlReferences 保留 query 与 hash', () => {
    const { map } = buildAssetMap([{ path: '/a.css', content: 'x' }]);
    const out = rewriteHtmlReferences('<link href="/a.css?v=1#top" />', map);
    assert.match(out, /\/a\.[0-9a-f]{8}\.css\?v=1#top/);
  });

  test('rewriteHtmlReferences 处理 srcset 多候选', () => {
    const { map } = buildAssetMap([
      { path: '/img/a.webp', content: 'a' },
      { path: '/img/b.webp', content: 'b' },
    ]);
    const out = rewriteHtmlReferences('<img srcset="/img/a.webp 1x, /img/b.webp 2x" />', map);
    assert.match(out, /\/img\/a\.[0-9a-f]{8}\.webp 1x/);
    assert.match(out, /\/img\/b\.[0-9a-f]{8}\.webp 2x/);
  });

  test('rewriteHtmlReferences 不碰外链与 data URL', () => {
    const { map } = buildAssetMap([{ path: '/a.css', content: 'x' }]);
    const html = '<img src="https://cdn.example.com/a.png" /><img src="data:image/png;base64,AAA" />';
    assert.equal(rewriteHtmlReferences(html, map), html);
  });

  test('空映射是恒等变换', () => {
    const html = '<link href="/a.css" />';
    assert.equal(rewriteHtmlReferences(html, new Map()), html);
  });

  test('isLocalUrl 区分本地与外部', () => {
    assert.equal(isLocalUrl('/assets/a.css'), true);
    assert.equal(isLocalUrl('./a.css'), true);
    assert.equal(isLocalUrl('https://x.com/a.css'), false);
    assert.equal(isLocalUrl('//cdn.x.com/a.css'), false);
    assert.equal(isLocalUrl('data:text/css,a'), false);
    assert.equal(isLocalUrl('#top'), false);
  });
});
