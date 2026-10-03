import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listBuiltinThemes, listAvailableThemes } from '../../src/theme/registry.js';

/**
 * 主题注册表（P3-1b-3b 的 CLI `theme list` 依赖它）。
 *
 * 两条底线：内置主题必须全在；项目内的自定义主题必须可见且优先于同名内置。
 */

test('listBuiltinThemes 扫出全部内置主题', async () => {
  const themes = await listBuiltinThemes();
  const names = themes.map((t) => t.name).sort();
  assert.deepEqual(names, ['aurora', 'inkstone', 'magazine', 'minimal']);
  for (const theme of themes) {
    assert.ok(theme.dir.startsWith('packages/') || theme.dir.includes('packages'), 'dir 应指向 packages/theme-*');
    assert.ok(theme.meta.name, '每套主题都带 meta');
  }
});

test('listAvailableThemes 收起项目内 themes/<name>', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-registry-'));
  try {
    await fs.mkdir(path.join(dir, 'themes', 'my-theme'), { recursive: true });
    await fs.writeFile(path.join(dir, 'themes', 'my-theme', 'theme.json'), JSON.stringify({ name: 'my-theme', version: '1.0.0' }), 'utf8');
    const themes = await listAvailableThemes(dir);
    const names = themes.map((t) => t.name);
    assert.ok(names.includes('my-theme'), `项目内主题应可见：${names.join(', ')}`);
    assert.ok(names.includes('aurora'), '内置主题也应在清单里');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('项目内同名主题优先于内置', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-registry-'));
  try {
    await fs.mkdir(path.join(dir, 'themes', 'aurora'), { recursive: true });
    await fs.writeFile(path.join(dir, 'themes', 'aurora', 'theme.json'), JSON.stringify({ name: 'aurora', version: '9.9.9' }), 'utf8');
    const themes = await listAvailableThemes(dir);
    const aurora = themes.find((t) => t.name === 'aurora');
    assert.equal(aurora.meta.version, '9.9.9', '项目内的同名主题应覆盖内置');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('缺 theme.json 或 JSON 损坏的目录被跳过（不抛错）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-registry-'));
  try {
    await fs.mkdir(path.join(dir, 'themes', 'broken'), { recursive: true });
    await fs.writeFile(path.join(dir, 'themes', 'broken', 'theme.json'), '{ not json', 'utf8');
    await fs.mkdir(path.join(dir, 'themes', 'no-meta'), { recursive: true });
    const themes = await listAvailableThemes(dir);
    const names = themes.map((t) => t.name);
    assert.ok(!names.includes('broken') && !names.includes('no-meta'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
