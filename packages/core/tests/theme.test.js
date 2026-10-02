import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTheme, renderLayout } from '../src/pipeline/render/theme.js';

async function withTheme(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-theme-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const META = JSON.stringify({ name: 'test-theme', version: '1.0.0', entryLayout: 'index' });

test('加载内置主题', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'minimal' } });
  assert.equal(theme.meta.name, 'minimal');
  assert.ok(theme.layouts.has('index'));
  assert.ok(theme.layouts.has('post'));
  assert.ok(theme.partials.has('header'));
  assert.ok(theme.styles.length > 0, '应读到样式文件');
});

test('加载项目内 themes/<name> 主题', async () => {
  await withTheme({
    'themes/custom/theme.json': META,
    'themes/custom/layouts/index.html': '<h1>{{ site.title }}</h1>',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 'custom' } });
    assert.equal(theme.meta.name, 'test-theme');
  });
});

test('加载相对路径指定的主题', async () => {
  await withTheme({
    './my-theme/theme.json': META,
    './my-theme/layouts/index.html': 'ok',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: './my-theme' } });
    assert.equal(theme.layouts.get('index').source, 'ok');
  });
});

test('主题不存在时给出可读的候选路径', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-theme-'));
  try {
    await assert.rejects(() => loadTheme(dir, { theme: { name: 'nope' } }), (error) => {
      assert.match(error.message, /找不到主题「nope」/);
      assert.match(error.message, /themes\/nope/);
      return true;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('缺少入口布局时抛错', async () => {
  await withTheme({
    'themes/broken/theme.json': JSON.stringify({ name: 'broken', entryLayout: 'index' }),
    'themes/broken/layouts/other.html': 'x',
  }, async (dir) => {
    await assert.rejects(() => loadTheme(dir, { theme: { name: 'broken' } }), /缺少首页布局/);
  });
});

test('收集样式与脚本', async () => {
  await withTheme({
    'themes/t/theme.json': META,
    'themes/t/layouts/index.html': 'x',
    'themes/t/styles/a.css': '.a{}',
    'themes/t/styles/b.css': '.b{}',
    'themes/t/scripts/main.js': 'var x;',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 't' } });
    assert.equal(theme.styles.length, 2);
    assert.equal(theme.scripts.length, 1);
  });
});

test('renderLayout 注入局部变量并支持 include', async () => {
  await withTheme({
    'themes/t/theme.json': META,
    'themes/t/layouts/index.html': '<title>{{ site.title }}</title>{% include "nav" %}',
    'themes/t/partials/nav.html': '<nav>{{ count }} items</nav>',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 't' } });
    const html = renderLayout(theme, 'index', { site: { title: '站点' }, count: 3 });
    assert.match(html, /<title>站点<\/title>/);
    assert.match(html, /<nav>3 items<\/nav>/);
  });
});

test('缺少 partial 时输出注释而不是崩溃', async () => {
  await withTheme({
    'themes/t/theme.json': META,
    'themes/t/layouts/index.html': '{% include "nope" %}',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 't' } });
    assert.match(renderLayout(theme, 'index', {}), /缺少 partial: nope/);
  });
});

test('请求不存在的布局时回退到 entryLayout', async () => {
  await withTheme({
    'themes/t/theme.json': META,
    'themes/t/layouts/index.html': 'fallback',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 't' } });
    assert.equal(renderLayout(theme, 'does-not-exist', {}), 'fallback');
  });
});
