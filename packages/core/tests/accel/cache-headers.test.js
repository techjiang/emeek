import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cacheHeaders, classifyCache, buildHeaderManifest, CACHE_CLASS } from '../../src/accel/cache-headers.js';

describe('缓存头策略', () => {
  test('带指纹的静态资源 → immutable 长缓存', () => {
    const h = cacheHeaders('/assets/theme.a1b2c3d4.css', { fingerprinted: true });
    assert.equal(h['Cache-Control'], 'public, max-age=31536000, immutable');
  });

  test('HTML → 短缓存 + stale-while-revalidate', () => {
    const h = cacheHeaders('/index.html');
    assert.equal(h['Cache-Control'], 'public, max-age=300, stale-while-revalidate=3600');
  });

  test('搜索索引 → 不缓存（否则用户搜不到新内容）', () => {
    assert.equal(classifyCache('/search-index.json'), CACHE_CLASS.DATA);
    const h = cacheHeaders('/search-index.json');
    assert.match(h['Cache-Control'], /max-age=60/);
  });

  test('sitemap / rss / robots 视为会变的稳定入口', () => {
    for (const f of ['/sitemap.xml', '/rss.xml', '/robots.txt']) {
      assert.equal(classifyCache(f), CACHE_CLASS.DATA, f);
    }
  });

  test('未指纹的静态资源不能 immutable —— 内容变 URL 不变会发旧版本', () => {
    assert.equal(classifyCache('/assets/theme.css', { fingerprinted: false }), CACHE_CLASS.HTML);
    assert.doesNotMatch(cacheHeaders("/assets/theme.css")["Cache-Control"], /immutable/);
  });

  test('指纹优先于扩展名判定', () => {
    assert.equal(classifyCache('/assets/x.a1b2c3d4.css', { fingerprinted: true }), CACHE_CLASS.IMMUTABLE);
  });

  test('etag 透传', () => {
    const h = cacheHeaders('/a.a1b2c3d4.css', { fingerprinted: true, etag: 'a1b2c3d4' });
    assert.equal(h.ETag, '"a1b2c3d4"');
  });

  test('自定义 policy 可覆盖默认值', () => {
    const h = cacheHeaders('/index.html', { policy: { html: { 'Cache-Control': 'no-cache' } } });
    assert.equal(h['Cache-Control'], 'no-cache');
  });

  test('buildHeaderManifest 按策略归组', () => {
    const manifest = buildHeaderManifest([
      { path: '/a.abc12345.css', fingerprint: 'abc12345' },
      { path: '/b.def67890.js', fingerprint: 'def67890' },
      { path: '/index.html' },
    ]);
    const immutable = manifest.find((m) => m.class === CACHE_CLASS.IMMUTABLE);
    const html = manifest.find((m) => m.class === CACHE_CLASS.HTML);
    assert.equal(immutable.match.length, 2);
    assert.equal(html.match.length, 1);
  });
});
