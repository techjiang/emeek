#!/usr/bin/env node
/**
 * SEO 自检。
 *
 * 为什么需要它：SEO 元数据错了，**页面看起来毫无异常**。
 * 一个重复的 canonical、一段 JSON.parse 失败的 JSON-LD、一个
 * 忘了 og:image 的社交卡片 —— 这些在浏览器里全都不可见，
 * 只有搜索引擎和社交平台知道。所以必须有一条自动化的线盯着它们。
 *
 * 三块检查：
 *   A. 每页 <head> 完整性（title/description/canonical/OG/Twitter 唯一且齐备）
 *   B. JSON-LD 能用真 JSON 解析器解析（不是正则扫一眼）
 *   C. sitemap.xml / robots.txt 的结构与交叉一致性
 *
 * 用法：
 *   node scripts/check-seo.mjs                  # 构建 examples/themes-demo 的 4 套主题并全查
 *   node scripts/check-seo.mjs --dist <目录>     # 只查一个已构建的产物目录
 *   node scripts/check-seo.mjs aurora           # 只查某几套主题
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listThemes, resolveRequested } from './lib/themes.mjs';
import { buildThemes } from './lib/build-theme.mjs';

const args = process.argv.slice(2);
const distIndex = args.indexOf('--dist');
const singleDist = distIndex >= 0 ? args[distIndex + 1] : null;
const requested = resolveRequested(args.filter((a) => a !== '--dist' && a !== singleDist));

const failures = [];
const notes = [];

function fail(scope, message) {
  failures.push(`✘ [${scope}] ${message}`);
}

/** 收集产物的全部 HTML 页面。 */
function listHtml(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listHtml(full, base, acc);
    else if (entry.name.endsWith('.html')) acc.push('/' + path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

/** 把一个标签的所有出现位置抠出来，用于「恰好一个」类断言。 */
function tags(html, pattern) {
  return [...html.matchAll(pattern)].map((m) => m[1]);
}

function attr(html, pattern) {
  const m = pattern.exec(html);
  return m ? m[1] : null;
}

/**
 * 检查单个页面。
 *
 * 每个断言都对应一类「页面看着正常但搜索引擎看到的是错的」的失败。
 */
function checkPage(theme, route, html) {
  const scope = `${theme}${route}`;

  // ── A. <head> 基础 ──────────────────────────────────────────
  const titles = tags(html, /<title>([\s\S]*?)<\/title>/g);
  if (titles.length !== 1) fail(scope, `<title> 有 ${titles.length} 个，必须恰好 1 个`);
  else if (!titles[0].trim()) fail(scope, '<title> 为空');

  const descs = tags(html, /<meta name="description" content="([^"]*)"/g);
  if (descs.length !== 1) fail(scope, `meta description 有 ${descs.length} 个，必须恰好 1 个`);
  else if (descs[0].length > 200) fail(scope, `meta description ${descs[0].length} 字符，超过 200 会被截断`);

  const canonicals = tags(html, /<link rel="canonical" href="([^"]*)"/g);
  if (canonicals.length !== 1) fail(scope, `canonical 有 ${canonicals.length} 个，必须恰好 1 个`);
  else if (!/^https?:\/\//.test(canonicals[0])) fail(scope, `canonical 不是绝对地址：${canonicals[0]}`);

  // ── 唯一 h1（多 h1 让搜索引擎不知道该把哪个当标题） ──────────
  const h1s = tags(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/g);
  if (route !== '/404.html' && h1s.length === 0) fail(scope, '页面没有 <h1>');
  if (h1s.length > 1) fail(scope, `<h1> 有 ${h1s.length} 个（应只有 1 个作为页面主标题）`);

  // ── lang 属性 ──────────────────────────────────────────────
  const lang = attr(html, /<html[^>]*\blang="([^"]*)"/);
  if (!lang) fail(scope, '<html> 缺少 lang 属性');

  // ── B. Open Graph / Twitter ────────────────────────────────
  for (const property of ['og:type', 'og:title', 'og:description', 'og:url', 'og:site_name', 'og:locale']) {
    const values = tags(html, new RegExp(`<meta property="${property}" content="([^"]*)"`, 'g'));
    if (values.length !== 1) fail(scope, `${property} 有 ${values.length} 个，必须恰好 1 个`);
    else if (!values[0]) fail(scope, `${property} 为空`);
  }
  const ogUrl = attr(html, /<meta property="og:url" content="([^"]*)"/);
  if (ogUrl && canonicals[0] && ogUrl !== canonicals[0]) {
    fail(scope, `og:url (${ogUrl}) 与 canonical (${canonicals[0]}) 不一致`);
  }
  for (const name of ['twitter:card', 'twitter:title', 'twitter:description']) {
    const values = tags(html, new RegExp(`<meta name="${name}" content="([^"]*)"`, 'g'));
    if (values.length !== 1) fail(scope, `${name} 有 ${values.length} 个，必须恰好 1 个`);
  }
  const card = attr(html, /<meta name="twitter:card" content="([^"]*)"/);
  if (card && !['summary', 'summary_large_image'].includes(card)) fail(scope, `twitter:card 值非法：${card}`);
  const ogImage = attr(html, /<meta property="og:image" content="([^"]*)"/);
  if (ogImage && !/^https?:\/\//.test(ogImage)) fail(scope, `og:image 不是绝对地址：${ogImage}`);

  // ── B2. noindex 的页面必须真的带 noindex ──────────────────
  //
  // 这一条是 lighthouse.mjs 里那条「404 页 SEO 豁免」的**对价**。
  // 豁免一项分数是可以的，但必须换成更准确的断言守住同一个事实 ——
  // 否则豁免就退化成「把分数低的东西删掉」。
  //
  // 事实链：404 页的 SEO 分低，是因为它带 noindex，而 Lighthouse 的
  // is-crawlable 对 noindex 页面记 0 分。所以「豁免 SEO 分」成立的唯一前提
  // 是「404 页确实带 noindex」。这条断言盯的就是那个前提。
  if (route === '/404.html') {
    const robots = attr(html, /<meta name="robots" content="([^"]*)"/);
    if (!robots || !robots.includes('noindex')) {
      fail(scope, '404 页没有 noindex —— 收录一个「页面不存在」是纯粹的错误结果，且会让 lighthouse.mjs 的 SEO 豁免失去依据');
    }
  }

  // ── C. JSON-LD 真解析 ──────────────────────────────────────
  //
  // 关键：用 JSON.parse，不用正则。正则「看起来像 JSON」的东西里
  // 一个未转义的引号就能让它整体失效，而页面完全正常。
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (blocks.length === 0) fail(scope, '缺少 JSON-LD 结构化数据');
  for (const [i, block] of blocks.entries()) {
    let data;
    try {
      data = JSON.parse(block[1]);
    } catch (error) {
      fail(scope, `JSON-LD #${i + 1} 无法解析：${error.message}`);
      continue;
    }
    if (!data['@context']?.includes('schema.org')) fail(scope, `JSON-LD #${i + 1} 的 @context 不是 schema.org`);
    const nodes = data['@graph'] ?? [data];
    for (const node of nodes) {
      if (!node['@type']) fail(scope, `JSON-LD #${i + 1} 有节点缺少 @type`);
    }
    // 真实字段校验：BlogPosting 必须有 headline + datePublished，
    // 缺了会让富媒体结果整个拿不到（但页面看不出来）。
    for (const node of nodes) {
      if (node['@type'] === 'BlogPosting') {
        for (const field of ['headline', 'datePublished', 'author', 'mainEntityOfPage']) {
          if (!node[field]) fail(scope, `BlogPosting 缺少 ${field}`);
        }
      }
      if (node['@type'] === 'BreadcrumbList') {
        const items = node.itemListElement ?? [];
        if (items.length < 2) fail(scope, `BreadcrumbList 只有 ${items.length} 项（至少 2 项）`);
        items.forEach((item, index) => {
          if (item.position !== index + 1) fail(scope, `BreadcrumbList 第 ${index + 1} 项 position 应为 ${index + 1}`);
        });
      }
    }
  }

  // ── D. 外链安全 ────────────────────────────────────────────
  //
  // 外链缺 rel 不是「样式问题」：noopener 关掉的是 window.opener 那条
  // 跨域改写标签页的路径。这条以前在渲染器里根本没加。
  for (const [href, rel] of [...html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]*)"([^>]*)>/g)].map((m) => [m[1], m[2]])) {
    if (new URL(href).host === new URL(canonicals[0] ?? 'https://x').host) continue;
    if (!/rel="[^"]*noopener/.test(rel)) fail(scope, `外链缺 rel="noopener"：${href}`);
    if (!/rel="[^"]*noreferrer/.test(rel)) fail(scope, `外链缺 rel="noreferrer"：${href}`);
  }

  // ── E. 图片 alt ────────────────────────────────────────────
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const img of imgs) {
    if (!/\balt=/.test(img)) fail(scope, `图片缺 alt：${img.slice(0, 80)}`);
  }
  const inferred = imgs.filter((img) => /data-alt-inferred="true"/.test(img)).length;
  if (inferred) notes.push(`· [${scope}] ${inferred} 张图片的 alt 由引擎推导（作者可补写以提升图片搜索效果）`);
}

/** sitemap.xml 的结构与内容检查。 */
function checkSitemap(theme, dist) {
  const scope = `${theme}/sitemap.xml`;
  const file = path.join(dist, 'sitemap.xml');
  if (!fs.existsSync(file)) return fail(scope, 'sitemap.xml 不存在');
  const xml = fs.readFileSync(file, 'utf8');

  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) fail(scope, '缺少 XML 声明');
  if (!/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml)) {
    fail(scope, '缺少正确的 urlset 命名空间');
  }
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  if (!locs.length) return fail(scope, '没有任何 <loc> 条目');
  if (locs.length > 50000) fail(scope, `${locs.length} 条 URL 超过单文件上限 50000（应拆 sitemap-index）`);

  // loc 必须绝对地址，且不能有重复（重复会被搜索引擎判为低质量）
  const seen = new Set();
  for (const loc of locs) {
    if (!/^https?:\/\//.test(loc)) fail(scope, `<loc> 不是绝对地址：${loc}`);
    if (seen.has(loc)) fail(scope, `<loc> 重复：${loc}`);
    seen.add(loc);
  }

  // 元素顺序：sitemaps.org 的 XSD 是 sequence，错了整份无效
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const body = block[1];
    const order = ['lastmod', 'changefreq', 'priority', 'loc']
      .map((name) => ({ name, index: body.indexOf(`<${name}>`) }))
      .filter((x) => x.index >= 0)
      .map((x) => x.index);
    if (order.join(',') !== [...order].sort((a, b) => a - b).join(',')) {
      fail(scope, '<url> 子元素顺序不符合 XSD（应为 lastmod → changefreq → priority → loc）');
      break;
    }
  }

  // priority 取值域必须是 [0.0, 1.0] 且一位小数
  for (const value of [...xml.matchAll(/<priority>([^<]*)<\/priority>/g)].map((m) => m[1])) {
    if (!/^[01]\.\d$/.test(value)) fail(scope, `priority 值非法：${value}（应为 0.0~1.0，一位小数）`);
  }

  // changefreq 取值域
  const ALLOWED = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];
  for (const value of [...xml.matchAll(/<changefreq>([^<]*)<\/changefreq>/g)].map((m) => m[1])) {
    if (!ALLOWED.includes(value)) fail(scope, `changefreq 值非法：${value}`);
  }

  // lastmod 必须是 W3C 日期格式，且不能是未来时间
  const today = new Date().toISOString().slice(0, 10);
  for (const value of [...xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1])) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(value)) fail(scope, `lastmod 格式非法：${value}`);
    else if (value.slice(0, 10) > today) fail(scope, `lastmod 是未来时间：${value}`);
  }

  // 交叉一致性：sitemap 里的 URL 必须有对应产物，且不能在 sitemap 里
  // 出现「已被 noindex 的页面」—— 那两个信号互相矛盾，爬虫会降低信任。
  const routes = new Set(listHtml(dist));
  for (const loc of locs) {
    const route = new URL(loc).pathname;
    const candidates = route.endsWith('/') ? [`${route}index.html`, route] : [route];
    const hit = candidates.find((c) => routes.has(c));
    if (!hit) {
      fail(scope, `sitemap 里的 ${route} 没有对应产物`);
      continue;
    }
    const html = fs.readFileSync(path.join(dist, hit.replace(/^\//, '')), 'utf8');
    if (/<meta name="robots" content="[^"]*noindex/.test(html)) {
      fail(scope, `${route} 被 noindex 却出现在 sitemap 里`);
    }
  }
  notes.push(`· [${scope}] ${locs.length} 条 URL，全部有对应产物`);
}

function checkRobots(theme, dist) {
  const scope = `${theme}/robots.txt`;
  const file = path.join(dist, 'robots.txt');
  if (!fs.existsSync(file)) return fail(scope, 'robots.txt 不存在');
  const text = fs.readFileSync(file, 'utf8');

  if (!/^User-agent: \*/m.test(text)) fail(scope, '缺少 `User-agent: *` 段');
  if (!/^Allow: \/$/m.test(text)) fail(scope, '缺少 `Allow: /`');
  // 搜索页必须屏蔽：它对爬虫是空壳（内容靠 JS 渲染），
  // 收录它只会产生重复内容并稀释权重。
  if (!/^Disallow: \/search\/$/m.test(text)) fail(scope, '没有屏蔽 /search/（爬虫看到的搜索页是空壳）');
  if (!/^Disallow: \/\*?\?q=$/m.test(text)) fail(scope, '没有屏蔽查询参数 /*?q=');
  const sitemapLines = [...text.matchAll(/^Sitemap: (.*)$/gm)].map((m) => m[1]);
  if (sitemapLines.length !== 1) fail(scope, `Sitemap 行有 ${sitemapLines.length} 条，必须恰好 1 条`);
  else if (!/^https?:\/\/.+\/sitemap\.xml$/.test(sitemapLines[0])) fail(scope, `Sitemap 地址非法：${sitemapLines[0]}`);
  if (/\n{3,}/.test(text)) fail(scope, 'robots.txt 有超过 2 个连续空行');
}

function checkDist(theme, dist) {
  if (!fs.existsSync(dist)) return fail(theme, `产物目录不存在：${dist}`);
  const routes = listHtml(dist);
  if (!routes.length) return fail(theme, '没有任何 HTML 产物');
  for (const route of routes) {
    checkPage(theme, route, fs.readFileSync(path.join(dist, route.replace(/^\//, '')), 'utf8'));
  }
  if (fs.existsSync(path.join(dist, 'sitemap.xml'))) checkSitemap(theme, dist);
  if (fs.existsSync(path.join(dist, 'robots.txt'))) checkRobots(theme, dist);
}

// ── 主流程 ──────────────────────────────────────────────────────
if (singleDist) {
  const dist = path.resolve(singleDist);
  distIndex >= 0 ? checkDist(path.basename(dist), dist) : checkDist('dist', dist);
} else {
  const THEMES = listThemes({ only: requested.length ? requested : undefined });
  const dist = buildThemes(THEMES);
  for (const theme of THEMES) checkDist(theme, dist[theme]);
}

if (notes.length) console.log(notes.join('\n'));
if (failures.length) {
  console.error(`\n✖ SEO 自检发现 ${failures.length} 个问题：`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log('\n✔ SEO 自检全部通过');
