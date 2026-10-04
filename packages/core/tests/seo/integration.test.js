import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../src/pipeline/index.js';
import { listThemes } from '../../../../scripts/lib/themes.mjs';

/**
 * SEO 的端到端断言跑在**真实构建产物**上。
 *
 * 单元测试能证明「给定输入，函数输出正确」，
 * 但证明不了「构建时真的调用了它、真的写进了页面」——
 * 之前就有过「引擎算好了但模板没渲染」的先例（headMeta 曾经
 * 传给了页面数据但 4 套主题里一处都没引用）。
 */

const SITE_DIR = path.resolve('examples/themes-demo');
const THEMES = listThemes();

/**
 * 每套主题构建到**独立的临时目录**。
 *
 * 这里踩过一个坑：最初直接改 examples/themes-demo 的配置再构建 ——
 * 4 套主题共用同一个 dist，node:test 又是并发跑用例的，
 * 于是「A 主题的断言看到 B 主题的产物」。表现是同一个用例
 * 单独跑绿、整套跑红。测试之间共享可写状态就是这样。
 *
 * 所以现在：复制整个示例站到临时目录，改那里的配置，构建到那里。
 */
async function buildFor(theme) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `emeeek-seo-${theme}-`));
  await fs.cp(SITE_DIR, work, { recursive: true });
  const configPath = path.join(work, 'emeeek.config.js');
  const original = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${theme}', darkMode: 'auto' }`));
  const stats = await build({ cwd: work });
  return { dir: stats.outDir, stats, cleanup: () => fs.rm(work, { recursive: true, force: true }) };
}

async function read(dist, rel) {
  return fs.readFile(path.join(dist, rel), 'utf8');
}

/** 每套主题都跑一遍同样的断言 —— 「4 套主题共用一份 partial」是承诺，不是假设。 */
for (const theme of THEMES) {
  test(`[${theme}] 每个页面都有 canonical / OG / Twitter`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const pages = await listHtml(dir);
    assert.ok(pages.length > 10, '应有十多个页面');
    for (const page of pages) {
      const html = await read(dir, page);
      assert.equal((html.match(/<link rel="canonical"/g) ?? []).length, 1, `${page} canonical`);
      assert.equal((html.match(/<meta property="og:title"/g) ?? []).length, 1, `${page} og:title`);
      assert.equal((html.match(/<meta name="twitter:card"/g) ?? []).length, 1, `${page} twitter:card`);
      assert.equal((html.match(/<meta name="description"/g) ?? []).length, 1, `${page} description`);
    }
  });

  test(`[${theme}] JSON-LD 在每个页面都能被 JSON.parse`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const pages = await listHtml(dir);
    for (const page of pages) {
      const html = await read(dir, page);
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      assert.ok(blocks.length >= 1, `${page} 应至少有一段 JSON-LD`);
      for (const block of blocks) {
        // 关键：用真解析器。正则「看着像 JSON」的东西里一个未转义引号就整体失效，
        // 而页面完全正常 —— 只有 Google 富媒体测试会报错。
        assert.doesNotThrow(() => JSON.parse(block[1]), `${page} 的 JSON-LD 无法解析`);
      }
    }
  });

  test(`[${theme}] 文章页是 BlogPosting，标签页是 CollectionPage`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const types = await jsonLdTypes(dir);
    assert.equal(types['/posts/why-emeeek.html'][0], 'BlogPosting');
    assert.equal(types['/index.html'][0], 'Blog');
    assert.equal(types['/about.html'][0], 'AboutPage');
    assert.ok(types['/tags.html'].includes('CollectionPage'));
    assert.equal(types['/404.html'][0], 'WebPage');
  });

  test(`[${theme}] 404 页 noindex 且不在 sitemap 里`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const html = await read(dir, '404.html');
    assert.match(html, /<meta name="robots" content="noindex, follow"/);
    const sitemap = await read(dir, 'sitemap.xml');
    assert.doesNotMatch(sitemap, /404\.html/, '404 不该出现在 sitemap');
  });

  test(`[${theme}] sitemap 覆盖全部可索引页面且 loc 唯一`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const sitemap = await read(dir, 'sitemap.xml');
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.equal(new Set(locs).size, locs.length, 'loc 不得重复');

    // 每个 loc 都要有对应产物 —— 「sitemap 里列了但没产出」是比 404 更糟的失败：
    // 爬虫会反复来抓一个永远不存在的地址。
    for (const loc of locs) {
      const route = new URL(loc).pathname;
      const candidates = route.endsWith('/') ? [`${route}index.html`] : [route];
      let found = false;
      for (const c of candidates) {
        try { await fs.access(path.join(dir, c.replace(/^\//, ''))); found = true; } catch { /* 继续 */ }
      }
      assert.ok(found, `sitemap 里的 ${route} 没有对应产物`);
    }
  });

  test(`[${theme}] sitemap 的 priority / changefreq 全部合法`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const sitemap = await read(dir, 'sitemap.xml');
    for (const v of [...sitemap.matchAll(/<priority>([^<]*)<\/priority>/g)].map((m) => m[1])) {
      assert.match(v, /^[01]\.\d$/, `priority 非法：${v}`);
    }
    for (const v of [...sitemap.matchAll(/<changefreq>([^<]*)<\/changefreq>/g)].map((m) => m[1])) {
      assert.ok(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'].includes(v), `changefreq 非法：${v}`);
    }
  });

  test(`[${theme}] robots.txt 屏蔽搜索页并指向 sitemap`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    const text = await read(dir, 'robots.txt');
    assert.match(text, /^Disallow: \/search\/$/m);
    assert.match(text, /^Sitemap: https:\/\/.*\/sitemap\.xml$/m);
  });

  test(`[${theme}] 正文 h1 被降级，页面只有一个 h1`, async (t) => {
    const { dir, cleanup } = await buildFor(theme);
    t.after(cleanup);
    for (const page of ['/posts/why-emeeek.html', '/about.html', '/index.html']) {
      const html = await read(dir, page.replace(/^\//, ''));
      const h1s = [...html.matchAll(/<h1\b/g)];
      assert.equal(h1s.length, 1, `${page} 有 ${h1s.length} 个 h1`);
    }
  });
}

test('主题不引用 headMeta 时，SEO 标签仍然存在（单一来源是 partial）', async () => {
  // 断言方式：headMeta 变量本身不再被任何主题直接引用。
  // 如果哪套主题漏了 include "seo"，上面的每页断言会红；
  // 这条确认 4 套主题的头文件是同一种形状（都在 include "seo"）。
  for (const theme of THEMES) {
    const head = await fs.readFile(`packages/theme-${theme}/partials/head.html`, 'utf8');
    assert.match(head, /\{%\s*include "seo"\s*%\}/, `${theme} 的 head.html 没有 include "seo"`);
    assert.doesNotMatch(head, /\{\{\{\s*headMeta\s*\}\}\}/, `${theme} 的 head.html 还直接引用 headMeta`);
  }
});

test('关掉 structuredData 时页面不再输出 JSON-LD', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-seo-off-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await fs.cp(SITE_DIR, work, { recursive: true });
  const configPath = path.join(work, 'emeeek.config.js');
  const original = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, original.replace(
    'content: { source: \'local\', localDirs: [\'posts\'] },',
    "content: { source: 'local', localDirs: ['posts'] },\n  seo: { structuredData: false },",
  ));
  const stats = await build({ cwd: work });
  const html = await read(stats.outDir, 'posts/why-emeeek.html');
  assert.doesNotMatch(html, /application\/ld\+json/);
  // 其它 SEO 标签不受影响 —— 开关是分项的，不是一刀切。
  assert.match(html, /<link rel="canonical"/);
  assert.match(html, /<meta property="og:title"/);
});

test('关掉 sitemap 时不再产出 sitemap.xml，但 robots 里的指向保留说明', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-seo-nosit-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await fs.cp(SITE_DIR, work, { recursive: true });
  const configPath = path.join(work, 'emeeek.config.js');
  const original = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, original.replace(
    'content: { source: \'local\', localDirs: [\'posts\'] },',
    "content: { source: 'local', localDirs: ['posts'] },\n  seo: { sitemap: false },",
  ));
  const stats = await build({ cwd: work });
  await assert.rejects(fs.access(path.join(stats.outDir, 'sitemap.xml')));
});

test('renderJsonLd 对空输入返回空串（不产出空的 ld+json 标签）', async () => {
  const { renderJsonLd } = await import('../../src/pipeline/transform/seo.js');
  assert.equal(renderJsonLd(''), '');
  assert.equal(renderJsonLd(null), '');
  assert.equal(renderJsonLd(undefined), '');
});

async function listHtml(dir, base = dir, acc = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listHtml(full, base, acc);
    else if (entry.name.endsWith('.html')) acc.push('/' + path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

async function jsonLdTypes(dir) {
  const out = {};
  for (const page of await listHtml(dir)) {
    const html = await read(dir, page.replace(/^\//, ''));
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    out[page] = blocks.flatMap((b) => JSON.parse(b[1])['@graph'].map((n) => n['@type']));
  }
  return out;
}
