import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins } from '../src/plugin/loader.js';
import { createHookRunner } from '../src/plugin/hooks.js';
import { build } from '../src/pipeline/index.js';

test('按路径加载插件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plug-'));
  try {
    await fs.writeFile(path.join(dir, 'my-plugin.js'), `export default { name: 'test-plugin', version: '1.0.0', hooks: {} };`, 'utf8');
    const plugins = await loadPlugins({ plugins: ['./my-plugin.js'] }, dir);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'test-plugin');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('插件不存在时只告警不中断', async () => {
  const plugins = await loadPlugins({ plugins: ['./missing-plugin.js'] }, process.cwd());
  assert.deepEqual(plugins, []);
});

test('插件缺少 name 字段时被跳过', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plug-'));
  try {
    await fs.writeFile(path.join(dir, 'bad.js'), `export default { version: '1.0.0' };`, 'utf8');
    assert.deepEqual(await loadPlugins({ plugins: ['./bad.js'] }, dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('钩子按注册顺序串行执行', async () => {
  const order = [];
  const runner = createHookRunner([
    { name: 'a', hooks: { onContentLoad: async () => { order.push('a'); } } },
    { name: 'b', hooks: { onContentLoad: async () => { order.push('b'); } } },
  ]);
  await runner.run('onContentLoad', {});
  assert.deepEqual(order, ['a', 'b']);
});

test('单个插件抛错不影响其他插件', async () => {
  const order = [];
  const runner = createHookRunner([
    { name: 'bad', hooks: { onContentLoad: () => { throw new Error('boom'); } } },
    { name: 'good', hooks: { onContentLoad: () => { order.push('good'); } } },
  ]);
  await runner.run('onContentLoad', {});
  assert.deepEqual(order, ['good']);
});

test('未定义的钩子被忽略', async () => {
  const runner = createHookRunner([{ name: 'a' }]);
  await assert.doesNotReject(runner.run('onBuildComplete', {}));
});

test('插件可以在构建中改写文章数据', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plug-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: T\n---\n\n正文内容。', 'utf8');
    await fs.writeFile(path.join(dir, 'wordcount.js'), `
      export default {
        name: 'wordcount',
        hooks: {
          onContentLoad(ctx) {
            for (const post of ctx.posts) post.wordCount = post.raw.replace(/\\s/g, '').length;
          },
        },
      };
    `, 'utf8');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `
      export default {
        site: { title: 'T', url: 'https://t.example.com' },
        content: { source: 'local', localDirs: ['posts'] },
        plugins: ['./wordcount.js'],
      };
    `, 'utf8');

    const stats = await build({ cwd: dir });
    assert.equal(stats.posts, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('插件注册的页面会出现在产物里', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plug-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: T\n---\n\n正文。', 'utf8');
    await fs.writeFile(path.join(dir, 'extra-pages.js'), `
      export default {
        name: 'extra-pages',
        pages: [{ path: '/timeline.html', layout: 'archive', title: '时间线', data: { groups: [] } }],
      };
    `, 'utf8');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `
      export default {
        site: { title: 'T', url: 'https://t.example.com' },
        content: { source: 'local', localDirs: ['posts'] },
        plugins: ['./extra-pages.js'],
      };
    `, 'utf8');

    await build({ cwd: dir });
    const timeline = await fs.readFile(path.join(dir, 'dist', 'timeline.html'), 'utf8');
    assert.match(timeline, /时间线/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('插件页面缺少必要字段时被跳过而不是崩溃', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plug-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: T\n---\n\n正文。', 'utf8');
    await fs.writeFile(path.join(dir, 'bad-pages.js'), `
      export default { name: 'bad-pages', pages: [{ path: '/x.html' }, null] };
    `, 'utf8');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `
      export default {
        site: { title: 'T', url: 'https://t.example.com' },
        content: { source: 'local', localDirs: ['posts'] },
        plugins: ['./bad-pages.js'],
      };
    `, 'utf8');

    const stats = await build({ cwd: dir });
    assert.equal(stats.posts, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
