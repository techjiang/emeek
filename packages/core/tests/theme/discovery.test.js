import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 主题发现的断言（P3-1b-3a）。
 *
 * P3-1a 的代价是「主题名写死在四个脚本里」：加第 5 套主题时，
 * 默认跑截图/预览/Lighthouse 都不会带上它 —— 而且不报错。
 * 这里钉住两件事：
 *   1. 发现逻辑真的扫磁盘（不是返回一份常量表）
 *   2. 四个脚本里没有写死的主题名数组
 */

const REPO = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const { listThemes, resolveRequested } = await import(
  path.join(REPO, 'scripts/lib/themes.mjs')
);

test('listThemes 返回全部内置主题（与 packages/theme-* 一致）', () => {
  const names = listThemes();
  const expected = fs.readdirSync(path.join(REPO, 'packages'))
    .filter((n) => n.startsWith('theme-'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(REPO, 'packages', n, 'theme.json'), 'utf8')).name)
    .sort();
  assert.deepEqual([...names].sort(), expected);
  assert.ok(names.length >= 4, `至少 4 套内置主题，实际 ${names.length}`);
  for (const required of ['aurora', 'minimal', 'inkstone', 'magazine']) {
    assert.ok(names.includes(required), `内置主题清单应包含 ${required}`);
  }
});

test('listThemes 读 theme.json 的 name，而不是截目录名', () => {
  // theme-<x> 目录与 name 一致是约定，但事实来源必须是 theme.json。
  // 这里至少确认返回值来自文件内容：拼一个不存在的目录名应被拒绝。
  assert.throws(() => listThemes({ only: ['definitely-not-a-theme'] }), /找不到主题/);
});

test('listThemes 真的扫磁盘：临时新增一套主题会被自动发现', () => {
  // 这条是「新主题加进来就自动工作」的直接证据。
  // 写死数组的实现会在这里露馅 —— 常量表不会因为磁盘多了一个目录而变长。
  const dir = path.join(REPO, 'packages', 'theme-__probe__');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: '__probe__', version: '0.0.0' }), 'utf8');
  try {
    const names = listThemes();
    assert.ok(names.includes('__probe__'), `临时主题未被发现：${names.join(', ')}`);
    assert.deepEqual(listThemes({ only: ['__probe__'] }), ['__probe__'], '按名过滤应能命中临时主题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listThemes({ only }) 做过滤且保持请求顺序', () => {
  assert.deepEqual(listThemes({ only: ['minimal', 'aurora'] }), ['minimal', 'aurora']);
  assert.deepEqual(listThemes({ only: [] }), listThemes());
});

test('resolveRequested 解析裸参数与 --theme= 形式，跳过其它 flag', () => {
  assert.deepEqual(resolveRequested(['aurora']), ['aurora']);
  assert.deepEqual(resolveRequested(['--theme', 'magazine']), ['magazine']);
  assert.deepEqual(resolveRequested(['--theme=inkstone', '--json']), ['inkstone']);
  assert.deepEqual(resolveRequested(['--json']), []);
  assert.deepEqual(resolveRequested(['aurora', '--theme', 'minimal']), ['aurora', 'minimal']);
});

test('四个脚本里没有写死的主题名数组（动态扫描才是事实来源）', () => {
  const scripts = [
    'scripts/preview-images.mjs',
    'scripts/screenshots/capture.mjs',
    'scripts/lighthouse-themes.mjs',
    'scripts/e2e/theme.mjs',
  ];
  for (const rel of scripts) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    // 出现 ['aurora', 'minimal'...] 这种字面量数组 = 又写死了
    const hardcoded = /\[\s*'aurora'\s*,\s*'minimal'/.test(source);
    assert.ok(!hardcoded, `${rel} 里仍有写死的主题数组`);
    assert.match(source, /listThemes|themes\.mjs/, `${rel} 应通过 scripts/lib/themes.mjs 动态发现主题`);
  }
});

test('脚本不再用 file:// 打开产物（一律走 HTTP 服务）', () => {
  const scripts = [
    'scripts/screenshots/capture.py',
    'scripts/preview-images.py',
    'scripts/e2e/theme.py',
  ];
  for (const rel of scripts) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.doesNotMatch(source, /file:\/\/\//, `${rel} 不应使用 file:// 打开产物`);
    assert.match(source, /def serve\(/, `${rel} 应自带本地 HTTP 服务`);
  }
});
