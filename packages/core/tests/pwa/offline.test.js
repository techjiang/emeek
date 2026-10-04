import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOfflinePage, buildRegisterScript, buildInstallPrompt, buildDisplayModeScript } from '../../src/pipeline/pwa/offline.js';

test('离线页：noindex（它是路牌，不是内容）', () => {
  const html = buildOfflinePage({ site: { title: 'x' }, cachedPosts: [] });
  assert.match(html, /name="robots" content="noindex"/);
});

test('离线页：样式内联，不引外部 CSS', () => {
  const html = buildOfflinePage({ site: { title: 'x' }, cachedPosts: [] });
  // 引一份可能没被缓存的 CSS，离线时就会得到裸 HTML。
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.match(html, /<style>/);
});

test('离线页：列出确实缓存过的文章，且链接带 basePath', () => {
  const html = buildOfflinePage({
    site: { title: 'x' },
    basePath: '/blog',
    cachedPosts: [{ title: '为什么', url: '/posts/why.html' }],
  });
  assert.match(html, /href="\/blog\/posts\/why\.html"/);
  assert.match(html, />为什么</);
});

test('离线页：没有可离线内容时给出说明而不是空列表', () => {
  const html = buildOfflinePage({ site: { title: 'x' }, cachedPosts: [] });
  assert.doesNotMatch(html, /<ul>/);
  assert.match(html, /还没有可以离线阅读的内容/);
});

test('离线页：标题与文章名里的 HTML 被转义（标题可以来自 Issue）', () => {
  const html = buildOfflinePage({
    site: { title: '<script>alert(1)</script>' },
    cachedPosts: [{ title: '<img src=x onerror=alert(1)>', url: '/a.html' }],
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  // 转义后的文本里仍然有 "onerror=alert" 这串字面量，所以断言要盯**真实标签**：
  // 未转义时产物里会出现 <img 标签本身。
  assert.doesNotMatch(html, /<img\s+src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('离线页：有重试按钮，且不依赖 JS 也能回到首页', () => {
  const html = buildOfflinePage({ site: { title: 'x' }, cachedPosts: [] });
  assert.match(html, /location\.reload\(\)/);
  assert.match(html, /class="button" href="\/"/);
});

test('注册脚本：非安全上下文直接被挡（不在控制台留红字）', () => {
  const script = buildRegisterScript({});
  assert.match(script, /location\.protocol==='https:'/);
  assert.match(script, /localhost/);
});

test('注册脚本：在 load 之后注册（不与首屏抢带宽）', () => {
  const script = buildRegisterScript({});
  assert.match(script, /addEventListener\('load'/);
});

test('注册脚本：scope 与 SW 地址都带 basePath', () => {
  const script = buildRegisterScript({ basePath: '/blog' });
  assert.match(script, /"\/blog\/sw\.js"/);
  assert.match(script, /"\/blog\/"/);
});

test('注册脚本：注册失败只 warn，不抛（站点在线照常可用）', () => {
  const script = buildRegisterScript({});
  assert.match(script, /console\.warn\('\[emeeek\] Service Worker 注册失败/);
  assert.doesNotMatch(script, /throw/);
});

test('安装提示：只在读过至少一篇文章后才可能弹', () => {
  const script = buildInstallPrompt({});
  assert.match(script, /function hasRead\(\)/);
  assert.match(script, /if\(dismissed\(\)\|\|!hasRead\(\)\)return;/);
});

test('安装提示：点过「以后再说」永久记录（不是 sessionStorage）', () => {
  const script = buildInstallPrompt({});
  assert.match(script, /localStorage\.setItem\(KEY,'1'\)/);
  assert.doesNotMatch(script, /sessionStorage/);
});

test('显示模式脚本：暴露状态而不决定视觉', () => {
  const script = buildDisplayModeScript();
  assert.match(script, /data-display-mode/);
  assert.doesNotMatch(script, /style\./, '引擎不替主题决定长什么样');
});
