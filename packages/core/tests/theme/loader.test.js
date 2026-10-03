import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTheme } from '../../src/pipeline/render/theme.js';

async function withTheme(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-theme-cfg-'));
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

const META = JSON.stringify({
  name: 'cfg', version: '1.0.0',
  config: {
    colors: { primary: { type: 'color', default: '#111111' } },
    typography: { fontSize: { type: 'number', default: 16, min: 12, max: 24 } },
    features: { math: { type: 'boolean', default: true } },
  },
});

test('加载时解析配置：主题默认值 + 用户覆盖', async () => {
  await withTheme({
    'themes/cfg/theme.json': META,
    'themes/cfg/layouts/index.html': 'x',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 'cfg', colors: { primary: '#ff0000' }, typography: { fontSize: 20 } } });
    assert.equal(theme.config['colors.primary'], '#ff0000');
    assert.equal(theme.config['typography.fontSize'], 20);
    assert.match(theme.variables, /--primary: #ff0000;/);
    assert.match(theme.variables, /--font-size-base: 20px;/);
    assert.match(theme.featureAttrs, /data-feature-math/);
  });
});

test('theme.json 不符合规范时加载失败，错误可读', async () => {
  await withTheme({
    'themes/bad/theme.json': JSON.stringify({ name: 'bad', config: { colors: { primary: { type: 'color' } } } }),
    'themes/bad/layouts/index.html': 'x',
  }, async (dir) => {
    await assert.rejects(() => loadTheme(dir, { theme: { name: 'bad' } }), /不符合规范/);
  });
});

test('规范警告回传但不阻塞加载', async () => {
  await withTheme({
    'themes/warn/theme.json': JSON.stringify({ name: 'warn', features: ['teleport'], layouts: ['index'] }),
    'themes/warn/layouts/index.html': 'x',
  }, async (dir) => {
    const theme = await loadTheme(dir, { theme: { name: 'warn' } });
    assert.ok(theme.warnings.some((w) => /teleport/.test(w.message)));
  });
});

test('内置主题始终能加载且零错误', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'minimal' } });
  assert.equal(theme.meta.name, 'minimal');
  assert.ok(theme.variables.length > 0);
});
