import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins } from '../src/plugin/loader.js';
import { createHookRunner } from '../src/plugin/hooks.js';
import { pluginApi } from '../src/plugin/loader.js';
import {
  CAPABILITIES, HOOK_CAPABILITY, FORBIDDEN_CAPABILITIES, CapabilityError,
  normalizeCapabilities, createCapabilityGuard, stripSecrets,
} from '../src/plugin/capabilities.js';
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

/** 造一个「已声明能力」的插件。钩子必须在 manifest 里声明过能力才会跑（D4）。 */
function plugin(name, hooks, capabilities = ['content:transform']) {
  return { name, hooks, capabilities: new Set(capabilities), guard: { has: (c) => capabilities.includes(c) } };
}

test('钩子按注册顺序串行执行', async () => {
  const order = [];
  const runner = createHookRunner([
    plugin('a', { onContentLoad: async () => { order.push('a'); } }),
    plugin('b', { onContentLoad: async () => { order.push('b'); } }),
  ]);
  await runner.run('onContentLoad', {});
  assert.deepEqual(order, ['a', 'b']);
});

test('单个插件抛错不影响其他插件', async () => {
  const order = [];
  const runner = createHookRunner([
    plugin('bad', { onContentLoad: () => { throw new Error('boom'); } }),
    plugin('good', { onContentLoad: () => { order.push('good'); } }),
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

/**
 * 插件能力声明（决策 D4）。
 *
 * 「先立规则再写 API」的落点：未声明能力 → 拒绝，并且说清谁、想干什么、缺什么。
 * 凭证访问刻意不在能力表里 —— 不靠审核，靠不存在。
 */
describe('能力声明与守卫', () => {
  test('未声明能力的钩子被跳过，且说明缺什么', async () => {
    const warns = [];
    const runner = createHookRunner(
      [{ name: 'silent', hooks: { onContentLoad: () => { throw new Error('不该跑到这里'); } }, capabilities: new Set(), guard: { has: () => false } }],
      { logger: { warn: (msg) => warns.push(msg) } },
    );
    await runner.run('onContentLoad', {});
    assert.equal(runner.skipped.length, 1);
    assert.equal(runner.skipped[0].plugin, 'silent');
    assert.equal(runner.skipped[0].capability, 'content:transform');
    assert.match(warns[0], /silent/);
    assert.match(warns[0], /content:transform/);
  });

  test('声明了能力就能跑', async () => {
    const calls = [];
    const runner = createHookRunner([
      { name: 'ok', hooks: { onContentLoad: () => calls.push('ran') }, capabilities: new Set(['content:transform']), guard: { has: (c) => c === 'content:transform' } },
    ]);
    await runner.run('onContentLoad', {});
    assert.deepEqual(calls, ['ran']);
    assert.equal(runner.skipped.length, 0);
  });

  test('钩子超时被跳过，不把构建挂死', async () => {
    const warns = [];
    const runner = createHookRunner(
      [{ name: 'slow', hooks: { onContentLoad: () => new Promise(() => {}) }, capabilities: new Set(['content:transform']), guard: { has: () => true } }],
      { logger: { warn: (msg) => warns.push(msg) }, timeoutMs: 30 },
    );
    await runner.run('onContentLoad', {});
    assert.match(warns[0], /超过 30ms/);
  });

  test('申请不允许的能力会被拒，而且不是拼错的措辞', () => {
    assert.throws(
      () => normalizeCapabilities(['key:read'], { name: 'evil' }),
      /凭证访问不向插件开放/,
    );
    for (const forbidden of FORBIDDEN_CAPABILITIES) {
      assert.throws(() => normalizeCapabilities([forbidden], { name: 'x' }), CapabilityError);
    }
  });

  test('拼错的能力名报错，而不是静默忽略', () => {
    // 静默忽略会让插件作者以为自己申请到了权限，然后在运行时才发现没有
    assert.throws(() => normalizeCapabilities(['content:reed'], { name: 'typo' }), /未知能力/);
    assert.throws(() => normalizeCapabilities('content:read', { name: 'x' }), /必须是数组/);
  });

  test('能力表里没有任何一条与凭证相关', () => {
    for (const capability of Object.keys(CAPABILITIES)) {
      assert.doesNotMatch(capability, /key|secret|token|credential|env/i, `能力「${capability}」不该存在`);
    }
  });

  test('能力表是一份「被检查的动作」清单：每条钩子都映射到具体能力', () => {
    for (const hook of ['onContentLoad', 'onBeforeRender', 'onAfterRender', 'onBuildComplete']) {
      assert.ok(HOOK_CAPABILITY[hook], `${hook} 没有映射到能力 —— 那它就没有被检查`);
      assert.ok(CAPABILITIES[HOOK_CAPABILITY[hook]], `${hook} 映射到了不存在的能力`);
    }
  });

  test('守卫记录每一次拒绝（不靠翻日志）', () => {
    const guard = createCapabilityGuard({ name: 'p', capabilities: new Set() }, { logger: { warn: () => {} } });
    assert.equal(guard.require('content:write', '写入内容文件'), false);
    assert.equal(guard.denials.length, 1);
    assert.match(guard.denials[0].message, /写入内容文件/);
    assert.equal(guard.require('content:read', '读取内容文件'), false);
    assert.equal(guard.denials.length, 2);
  });
});

describe('凭证不进插件', () => {
  test('stripSecrets 剔掉按字段名识别的凭证', () => {
    const clean = stripSecrets({
      ai: { apiKey: 'sk-abcdefghijklmnopqrst', model: 'gpt-4o-mini' },
      site: { title: 'T' },
      token: 'abc',
      nested: { authorization: 'Bearer x' },
    });
    assert.equal(clean.ai.apiKey, undefined);
    assert.equal(clean.ai.model, 'gpt-4o-mini');
    assert.equal(clean.token, undefined);
    assert.equal(clean.nested.authorization, undefined);
    assert.equal(clean.site.title, 'T');
    assert.doesNotMatch(JSON.stringify(clean), /sk-abcdefghij/);
  });

  test('字段名随便起也剔：按值认长得像 Key 的字符串', () => {
    const clean = stripSecrets({ 随便一个名字: 'sk-proj-abcdefghijklmnopqrstuvwxyz', normal: '正常文本' });
    assert.equal(clean['随便一个名字'], undefined);
    assert.equal(clean.normal, '正常文本');
  });

  test('函数不进 config（插件不该拿到宿主的可执行对象）', () => {
    const clean = stripSecrets({ helper: () => {}, name: 'x' });
    assert.equal(clean.helper, undefined);
    assert.equal(clean.name, 'x');
  });

  test('自引用对象不会把 stripSecrets 转死', () => {
    const loop = { name: 'x' }; loop.self = loop;
    assert.doesNotThrow(() => stripSecrets(loop));
  });

  test('pluginApi 上不存在任何读 Key 的方法', () => {
    const api = pluginApi({ name: 'p', capabilities: new Set(['content:read']), config: {}, cwd: '/x' });
    for (const key of Object.keys(api)) {
      assert.doesNotMatch(key, /key|secret|token|env/i, `pluginApi 不该有 ${key}`);
    }
    assert.equal(typeof api.readContent, 'function');
  });

  test('pluginApi 的 config 里没有凭证', () => {
    const api = pluginApi({ name: 'p', capabilities: new Set(), cwd: '/x', config: stripSecrets({ ai: { apiKey: 'sk-x' }, site: { title: 'T' } }) });
    assert.doesNotMatch(JSON.stringify(api.config), /apiKey/);
  });

  test('未声明 content:read 时 readContent 被拒', async () => {
    const denials = [];
    const api = pluginApi({
      name: 'p',
      capabilities: new Set(),
      cwd: '/x',
      config: {},
      guard: { require: (c, action) => { denials.push({ c, action }); return false; } },
    });
    const result = await api.readContent('posts/a.md');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'forbidden');
    assert.equal(denials[0].c, 'content:read');
  });
});

describe('加载期的规则（决策 D4）', () => {
  async function tempProject(files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-plugin-'));
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return dir;
  }

  test('插件路径必须在项目内', async () => {
    const dir = await tempProject({
      'emeeek.config.js': `export default { plugins: ['../../tmp/evil.js'] };`,
    });
    const outside = path.resolve(dir, '../../tmp/evil.js');
    try {
      await fs.mkdir(path.dirname(outside), { recursive: true });
      await fs.writeFile(outside, `export default { name: 'evil', capabilities: ['content:read'], hooks: {} };`);
      const plugins = await loadPlugins({ plugins: [outside] }, dir, { logger: { info: () => {}, warn: () => {} } });
      assert.equal(plugins.length, 0, '项目外的插件不该被加载');
      assert.match(plugins.rejected[0].reason, /项目外/);
    } finally {
      await fs.rm(outside, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('申请不允许的能力 → 整个插件被拒（不是只拒那个动作）', async () => {
    const dir = await tempProject({
      'evil.js': `export default { name: 'evil', capabilities: ['key:read'], hooks: {} };`,
    });
    try {
      const plugins = await loadPlugins({ plugins: ['./evil.js'] }, dir, { logger: { info: () => {}, warn: () => {} } });
      assert.equal(plugins.length, 0);
      assert.match(plugins.rejected[0].reason, /凭证访问不向插件开放/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('传给插件的 config 已经剔掉凭证', async () => {
    const dir = await tempProject({
      'spy.js': `export default { name: 'spy', capabilities: [], hooks: {} };`,
    });
    try {
      const config = { plugins: ['./spy.js'], ai: { apiKey: 'sk-proj-abcdefghijklmnop', model: 'gpt-4o-mini' }, site: { title: 'T' } };
      const plugins = await loadPlugins(config, dir, { logger: { info: () => {}, warn: () => {} } });
      assert.equal(plugins.length, 1);
      const captured = JSON.stringify(plugins[0].config);
      assert.doesNotMatch(captured, /sk-proj-abcdefghij/, '插件拿到的 config 里不能有 Key');
      assert.equal(plugins[0].config.ai.model, 'gpt-4o-mini', '非凭证字段照常可用');
      assert.equal(plugins[0].config.site.title, 'T');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('有钩子但没声明能力 → 告警（避免「装了但什么都没发生」）', async () => {
    const dir = await tempProject({
      'quiet.js': `export default { name: 'quiet', hooks: { onContentLoad() {} } };`,
    });
    const warns = [];
    try {
      const plugins = await loadPlugins({ plugins: ['./quiet.js'] }, dir, { logger: { info: () => {}, warn: (m) => warns.push(m) } });
      assert.equal(plugins.length, 1, '插件本身加载成功，被跳过的是钩子');
      assert.match(warns.join('\n'), /没有声明 capabilities/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('加载期语法错误被隔离，其他插件照常加载', async () => {
    const dir = await tempProject({
      'bad.js': `export default { name: 'bad', capabilities: [], hooks: {`,
      'good.js': `export default { name: 'good', capabilities: ['content:transform'], hooks: {} };`,
    });
    try {
      const plugins = await loadPlugins({ plugins: ['./bad.js', './good.js'] }, dir, { logger: { info: () => {}, warn: () => {} } });
      assert.deepEqual(plugins.map((p) => p.name), ['good']);
      assert.equal(plugins.rejected.length, 1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('越权插件在真实构建里被拦住', () => {
  test('未声明 content:transform 的插件改不动 posts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-build-'));
    try {
      await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
      await fs.writeFile(path.join(dir, 'posts', 'a.md'), '---\ntitle: A\n---\n\n# A\n\n正文\n');
      await fs.mkdir(path.join(dir, 'plugins'), { recursive: true });
      // 这个插件想改标题，但没声明能力
      await fs.writeFile(path.join(dir, 'plugins', 'sneaky.js'),
        `export default { name: 'sneaky', hooks: { onContentLoad(ctx) { ctx.posts.forEach((p) => { p.title = 'HACKED'; }); } } };`, 'utf8');

      const plugins = await loadPlugins({ plugins: ['./plugins/sneaky.js'] }, dir, { logger: { info: () => {}, warn: () => {} } });
      const runner = createHookRunner(plugins, { logger: { warn: () => {} } });
      const posts = [{ title: 'A' }];
      await runner.run('onContentLoad', { posts });
      assert.equal(posts[0].title, 'A', '未声明能力的钩子不该跑到 —— 它就是没跑');
      assert.equal(runner.skipped.length, 1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
