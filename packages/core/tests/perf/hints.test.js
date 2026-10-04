import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHintable, originOf, collectPreconnect, renderResourceHints, planPrefetch, PREFETCH_POLICY,
} from '../../src/pipeline/transform/hints.js';

test('isHintable：只放行站内绝对路径', () => {
  assert.equal(isHintable('/posts/a.html'), true);
  assert.equal(isHintable('/a.png?v=1'), true);
  // 这些都必须拒绝，拒绝的理由各不相同，写在下面。
  assert.equal(isHintable('https://cdn.example.com/a.js'), false, '外链预加载=替第三方提前发起请求');
  assert.equal(isHintable('//evil.example.com/a.js'), false, '协议相对地址是外链');
  assert.equal(isHintable('/#section'), false, '锚点不是资源');
  assert.equal(isHintable('posts/a.html'), false, '相对路径在不同页面解析结果不同');
  assert.equal(isHintable(''), false);
  assert.equal(isHintable(null), false);
  assert.equal(isHintable(undefined), false);
});

test('originOf：非 http(s) 与非法地址返回空串而不是抛错', () => {
  assert.equal(originOf('https://a.example.com/x'), 'https://a.example.com');
  assert.equal(originOf('http://a.example.com:8080/x'), 'http://a.example.com:8080');
  assert.equal(originOf('mailto:x@y.com'), '');
  assert.equal(originOf('javascript:alert(1)'), '');
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(''), '');
});

test('collectPreconnect：排除站点自身 origin（它已经连着，写了也是无效项）', () => {
  const out = collectPreconnect(
    ['https://site.example.com/a', 'https://site.example.com/b', 'https://cdn.example.com/x'],
    { siteUrl: 'https://site.example.com' },
  );
  assert.deepEqual(out, ['https://cdn.example.com']);
});

test('renderResourceHints：拒绝集生效 —— 外链不会被写进产物', () => {
  const html = renderResourceHints({
    preconnect: ['https://cdn.example.com'],
    prefetch: ['/posts/a.html', 'https://evil.example.com/x', '//y.example.com/z'],
  });
  assert.match(html, /rel="preconnect" href="https:\/\/cdn\.example\.com"/);
  assert.match(html, /rel="prefetch" href="\/posts\/a\.html"/);
  assert.doesNotMatch(html, /evil\.example\.com/);
  assert.doesNotMatch(html, /y\.example\.com/);
});

test('planPrefetch：只在文章页规划，且有条数上限', () => {
  assert.deepEqual(planPrefetch({ layout: 'index', related: ['/posts/a.html'] }), []);
  assert.deepEqual(planPrefetch({ layout: 'archive', related: ['/posts/a.html'] }), []);
  const out = planPrefetch({
    layout: 'post',
    newer: '/posts/new.html',
    related: [{ url: '/posts/a.html' }, { url: '/posts/b.html' }, { url: '/posts/c.html' }, { url: '/posts/d.html' }],
  });
  assert.equal(out.length, PREFETCH_POLICY.maxPrefetch);
  assert.equal(out[0], '/posts/new.html', '更新的一篇优先');
  // 上限是刻意的：给 10 条会让每个访客空闲时下载 10 个页面。
  assert.equal(PREFETCH_POLICY.maxPrefetch, 3);
});

test('planPrefetch：去重，且外链被过滤掉', () => {
  const out = planPrefetch({
    layout: 'post',
    newer: '/posts/a.html',
    related: [{ url: '/posts/a.html' }, { url: 'https://evil.example.com/x' }, { url: '/posts/b.html' }],
  });
  assert.deepEqual(out, ['/posts/a.html', '/posts/b.html']);
});
