import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

/**
 * 版本号只有一个真相（packages/core/src/version.js 读的是 core 的 package.json）。
 * 这几条断言的作用是：**任何一处漏改都会立刻变红** ——
 * 而不是等到 Release 发出去了、用户 `--version` 看到一个对不上的号。
 */
test('版本号形如 semver', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('根包与三个子包版本号一致', () => {
  const versions = {
    root: read('package.json').version,
    cli: read('packages/cli/package.json').version,
    core: read('packages/core/package.json').version,
    editor: read('packages/editor/package.json').version,
  };
  const unique = new Set(Object.values(versions));
  assert.equal(unique.size, 1, `四处版本号不一致：${JSON.stringify(versions)}`);
});

test('VERSION 常量与 package.json 相同（CLI --version 与产物 meta 同源）', () => {
  assert.equal(VERSION, read('packages/core/package.json').version);
});

test('构建产物的 generator meta 带版本号', async () => {
  const { renderSeoTags } = await import('../src/pipeline/transform/seo.js');
  const html = renderSeoTags({
    title: 't', description: 'd', canonical: null, noindex: false,
    og: { type: 'website', title: 't', description: 'd', url: 'https://x', siteName: 's', locale: 'zh_CN' },
    twitter: { card: 'summary', title: 't', description: 'd' },
    jsonLd: [], prev: null, next: null, breadcrumbs: [], feed: [],
  });
  assert.ok(html.includes(`Emeek ${VERSION}`), `产物 meta 未带版本号 ${VERSION}`);
});
