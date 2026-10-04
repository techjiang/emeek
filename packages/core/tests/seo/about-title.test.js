import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../src/pipeline/index.js';
import { extractAboutTitle } from '../../src/pipeline/transform/about.js';

/**
 * 关于页主标题必须来自正文，不是布局里写死的「关于」。
 *
 * 为什么要专门守：布局里那句 `<h1>关于</h1>` 看起来「反正对」，
 * 于是很容易被当成不需要处理的东西。但作者写的是
 * 「关于这个演示站」—— 页面主标题跟他写的不是同一句话，
 * 那么浏览器标签页、搜索结果摘要、社交分享卡片全都在显示一个
 * 作者从未写过的标题。
 */
test('extractAboutTitle 从正文提出标题并摘掉原 h1', () => {
  const { title, html, titleSource } = extractAboutTitle('<h1 id="x">关于这个演示站</h1>\n<p>正文</p>');
  assert.equal(title, '关于这个演示站');
  assert.equal(titleSource, 'content');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /<p>正文<\/p>/);
});

test('正文没有 h1 时退到兜底标题', () => {
  const { title, titleSource } = extractAboutTitle('<p>只有散文</p>', '关于');
  assert.equal(title, '关于');
  assert.equal(titleSource, 'fallback');
});

test('标题里的行内标签被剥掉（不进 meta / JSON-LD）', () => {
  const { title } = extractAboutTitle('<h1>关于 <code>Emeek</code> 这个项目</h1>');
  assert.equal(title, '关于 Emeek 这个项目');
});

test('只摘第一个 h1，后面的保留', () => {
  const { html } = extractAboutTitle('<h1>一</h1><p>x</p><h1>二</h1>');
  assert.doesNotMatch(html, /<h1[^>]*>一</);
  assert.match(html, /<h1[^>]*>二</);
});

test('空白的 h1 退到兜底标题（不产出空标题）', () => {
  const { title } = extractAboutTitle('<h1>   </h1>');
  assert.equal(title, '关于');
});

test('构建产物里关于页的主标题来自 ABOUT.md', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-about-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await fs.cp(path.resolve('examples/themes-demo'), work, { recursive: true });
  const stats = await build({ cwd: work });

  const html = await fs.readFile(path.join(stats.outDir, 'about.html'), 'utf8');
  const source = await fs.readFile(path.join(work, 'ABOUT.md'), 'utf8');
  const expected = /^#\s+(.+)$/m.exec(source)[1].trim();

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1];
  assert.equal(h1, expected, '关于页主标题必须等于 ABOUT.md 里的一级标题');
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, '关于页只有一个 h1');
  // 标题同时要进 title / og:title —— 三处都要跟着走，
  // 漏一处就会出现「标签页标题跟页面标题不一样」。
  assert.match(html, new RegExp(`<title>${expected} · `));
  assert.match(html, new RegExp(`og:title" content="${expected} · `));
  // 结构化数据里的 name 也要跟着走。
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(ld['@graph'][0].name, expected);
});
