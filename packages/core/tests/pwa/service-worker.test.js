import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheVersion, cacheName, buildServiceWorker } from '../../src/pipeline/pwa/service-worker.js';

test('cacheVersion：内容变了指纹就变（否则缓存永不失效）', () => {
  const a = cacheVersion([{ path: '/index.html', bytes: 10, hash: 'aaa' }]);
  const b = cacheVersion([{ path: '/index.html', bytes: 10, hash: 'bbb' }]);
  assert.notEqual(a, b);
});

test('cacheVersion：顺序无关（产物写入顺序不该影响缓存名）', () => {
  const a = cacheVersion([{ path: '/a', hash: '1' }, { path: '/b', hash: '2' }]);
  const b = cacheVersion([{ path: '/b', hash: '2' }, { path: '/a', hash: '1' }]);
  assert.equal(a, b);
});

test('cacheVersion：拼接歧义不撞车', () => {
  // 这条防的是「['ab','c'] 与 ['a','bc'] 拼起来一样」——所以要有分隔符。
  const a = cacheVersion([{ path: 'ab' }, { path: 'c' }].map((x) => ({ ...x, hash: '' })));
  const b = cacheVersion([{ path: 'a' }, { path: 'bc' }].map((x) => ({ ...x, hash: '' })));
  assert.notEqual(a, b);
});

test('cacheVersion：空列表也是稳定值（不返回 undefined 之类的）', () => {
  const v = cacheVersion([]);
  assert.equal(typeof v, 'string');
  assert.equal(v, cacheVersion([]));
});

test('cacheName 带前缀 emeeek-', () => {
  assert.equal(cacheName('abc123'), 'emeeek-abc123');
});

test('SW 里没有 skipWaiting 的自动接管：新 SW 必须等标签页关闭', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: ['/'], offlineUrl: '/offline.html' });
  // skipWaiting + clients.claim 同时出现在 install/activate 是「立刻接管」，
  // 会让正在读的页面突然换掉资源来源（拿到不匹配的 CSS/JS 组合）。
  assert.doesNotMatch(sw, /skipWaiting/);
  assert.match(sw, /self\.clients\.claim\(\)/, 'activate 里 claim 是对的：那是「接管已打开的页面」的最小动作');
});

test('SW：缓存名由 version 决定（改 version = 改字节 = 通知浏览器有新版本）', () => {
  const a = buildServiceWorker({ version: 'aaa', precache: [] });
  const b = buildServiceWorker({ version: 'bbb', precache: [] });
  assert.notEqual(a, b);
  assert.match(a, /const CACHE = "emeeek-aaa"/);
});

test('SW：activate 删掉所有非当前缓存（否则旧缓存永远留着）', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: [] });
  assert.match(sw, /keys\.filter\(\(key\) => key !== CACHE\)\.map\(\(key\) => caches\.delete\(key\)\)/);
});

test('SW：导航请求是 network-first（HTML 是内容，必须最新）', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: [], offlineUrl: '/offline.html' });
  const navBlock = sw.slice(sw.indexOf("request.mode === 'navigate'"), sw.indexOf('// 静态资源'));
  assert.match(navBlock, /fetch\(request\)[\s\S]*\.catch\(\(\) => caches\.match/);
  assert.doesNotMatch(navBlock, /caches\.match\(request\)\.then\([\s\S]*?\) \|\| fetch/, 'cache-first 会让读者永远看上一次构建的首页');
});

test('SW：跨域请求直通，不替第三方做缓存', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: [] });
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
});

test('SW：离线页被写进 PRECACHE（它自己不能靠网络拿）', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: ['/'], offlineUrl: '/offline.html' });
  const precache = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(sw)[1]);
  assert.ok(precache.includes('/offline.html'));
});

test('SW：basePath 前缀落在 scope 判断与预制列表上', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: ['/posts/a.html'], offlineUrl: '/offline.html', basePath: '/blog' });
  const precache = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(sw)[1]);
  assert.ok(precache.every((u) => u.startsWith('/blog')), `全部预制地址都该带前缀，实际 ${precache}`);
  assert.match(sw, /pathname\.startsWith\("\/blog\/"\)/);
});

test('SW：预制列表去重', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: ['/', '/', '/offline.html'], offlineUrl: '/offline.html' });
  const precache = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(sw)[1]);
  assert.equal(new Set(precache).size, precache.length);
});

test('SW：install 失败会打日志，不静默（静默失败将来只能靠猜）', () => {
  const sw = buildServiceWorker({ version: 'v1', precache: [] });
  assert.match(sw, /console\.warn\('\[emeeek-sw\] 预缓存失败/);
});
