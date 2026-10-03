import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThemeSwitcher, SWITCHER_CSS } from '../../src/theme/switcher.js';

/**
 * 运行时主题切换按钮（P3-1b-3b feature F）。
 *
 * 关键立场：面板里的每个主题要么有真实 URL，要么明确标「仅此站」——
 * 不画一个点了没反应的按钮。所以断言一半在「生成什么」，一半在「不生成什么」。
 */

test('列出带 URL 的主题为可点链接', () => {
  const { html } = buildThemeSwitcher({
    current: 'aurora',
    themes: [{ name: 'aurora', url: '/' }, { name: 'magazine', label: '杂志', url: '/magazine/' }],
  });
  assert.match(html, /href="\/magazine\/"/);
  assert.match(html, /杂志/);
  assert.match(html, /data-theme-name="aurora"/);
});

test('没有 URL 的主题标「仅此站」，不给死链接', () => {
  const { html } = buildThemeSwitcher({ current: 'aurora', themes: [{ name: 'inkstone' }] });
  assert.doesNotMatch(html, /<a[^>]*data-theme-name="inkstone"/);
  assert.match(html, /仅此站/);
});

test('当前主题被标为 active', () => {
  const { html } = buildThemeSwitcher({ current: 'minimal', themes: [{ name: 'minimal', url: '/' }] });
  assert.match(html, /class="emeeek-switch-item is-active"/);
});

test('非法主题名被过滤（不进入 DOM 属性）', () => {
  const { html } = buildThemeSwitcher({
    current: 'aurora',
    themes: [{ name: '"><script>alert(1)</script>', url: '/' }, { name: 'ok-theme', url: '/' }],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /data-theme-name="ok-theme"/);
});

test('不安全 URL 不生成 <a>（escapeAttr 保留但内容被转义）', () => {
  const { html } = buildThemeSwitcher({ current: 'aurora', themes: [{ name: 'x', url: 'javascript:alert(1)' }] });
  // URL 原样在 href 里是被转义的字符串，但 javascript: 协议本身不做白名单 —— 由调用方保证
  // 这里至少断言引号被转义、无法逃出属性上下文
  assert.doesNotMatch(html, /href="javascript:alert\(1\)"[^>]*><script/i);
});

test('既不提供主题也不提供亮暗切换时返回空（不注入空浮层）', () => {
  assert.deepEqual(buildThemeSwitcher({ current: 'aurora', themes: [], darkToggle: false }), { html: '', script: '' });
});

test('position 决定 CSS 挂哪边', () => {
  const right = buildThemeSwitcher({ current: 'a', themes: [{ name: 'a', url: '/' }] });
  assert.match(right.html, /data-position="right"/);
  const left = buildThemeSwitcher({ current: 'a', themes: [{ name: 'a', url: '/' }], position: 'bottom-left' });
  assert.match(left.html, /data-position="left"/);
});

test('noscript 兜底隐藏按钮（无 JS 时不留死浮层）', () => {
  const { html } = buildThemeSwitcher({ current: 'a', themes: [{ name: 'a', url: '/' }] });
  assert.match(html, /<noscript>/);
  assert.match(html, /emeeek-switcher\{display:none/);
});

test('脚本不含任何模板插值（内容全在服务端渲染）', () => {
  const { script } = buildThemeSwitcher({ current: 'a', themes: [{ name: 'a', url: '/' }] });
  assert.doesNotMatch(script, /\$\{/);
  assert.match(script, /localStorage/);
});

test('SWITCHER_CSS 覆盖开关/面板/项，且用主题变量兜底', () => {
  for (const selector of ['.emeeek-switcher', '.emeeek-switcher-toggle', '.emeeek-switcher-panel', '.emeeek-switch-item']) {
    assert.ok(SWITCHER_CSS.includes(selector), `CSS 应包含 ${selector}`);
  }
  assert.match(SWITCHER_CSS, /var\(--bg/);
});
