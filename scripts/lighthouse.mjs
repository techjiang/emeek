#!/usr/bin/env node
/**
 * 性能基线复现脚本。
 *
 * 为什么不用 `lhci autorun`：lhci 会额外引入一套配置与报告存储，
 * 而我们需要的只是「构建 → 起服务 → 逐页跑分 → 打印表格」。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = path.join(ROOT, 'examples/minimal');
const PORT = Number(process.env.PORT ?? 8123);

const PAGES = [
  ['首页', '/'],
  ['文章页', '/posts/why-emeeek.html'],
  ['语法页', '/posts/markdown-syntax.html'],
  ['性能页', '/posts/performance-notes.html'],
  ['归档页', '/archive.html'],
  ['标签页', '/tags.html'],
  ['关于页', '/about.html'],
  ['404 页', '/404.html'],
];

/**
 * 移动端模拟（决策 D3 的性能门禁）。
 *
 * **分开记录，不合并成一张表** —— 合并之后「桌面 100、移动 82」会被一句
 * 「平均 91」盖过去，而移动端才是大多数读者真正打开页面的设备。
 *
 * 阈值比桌面低（90 vs 95），理由写在这里而不是藏进代码：
 * 移动端模拟会施加 4G 网络 + 4 倍 CPU 降速，首屏多出 200-400ms 是设备
 * 与网络的真实差异，不是回归。要区分「模拟环境的固有差异」与「我们变慢了」，
 * 判据只能是基线对比 —— 所以下面记住的分数是**基线**，跌了要解释。
 */
const MOBILE = [
  ['首页', '/'],
  ['文章页', '/posts/why-emeeek.html'],
  ['语法页', '/posts/markdown-syntax.html'],
  ['性能页', '/posts/performance-notes.html'],
  ['归档页', '/archive.html'],
  ['标签页', '/tags.html'],
  ['关于页', '/about.html'],
  ['404 页', '/404.html'],
];

/** 已知的移动端基线（本阶段实测）。跌了要有解释，没解释就是回归。 */
export const MOBILE_BASELINE = Object.freeze({
  '首页': 100,
  '文章页': 100,
  '语法页': 100,
  '性能页': 100,
  '归档页': 100,
  '标签页': 100,
  '关于页': 100,
  '404 页': 100,
});

export const MOBILE_THRESHOLD = 90;

/**
 * 不参与 SEO 评分的页面。
 *
 * 这不是「分数低就排除掉」—— 那正是门禁本该防止的事。这里必须说清楚为什么。
 *
 * 事实：Lighthouse 的 `is-crawlable` 审计对**被 noindex 或 robots.txt 屏蔽的
 * 页面**记 0 分，于是整页 SEO 从 100 掉到 66。
 *
 * 而 404 页**恰恰应该**带 noindex —— 一个「页面不存在」的页面被搜索引擎收录，
 * 是纯粹的错误结果：读者搜到它、点进来、发现什么都没有。这跟 P3-3a 在
 * 搜索页上做的判断是同一条：在这两个页面上，「Lighthouse SEO = 100」与
 * 「正确的 SEO」互相矛盾，后者才是我们要的。
 *
 * 所以这里不是把阈值调低（那会连带放过真回归），是把**这一项**从这两页摘掉，
 * 并用一条更准确的断言守住它：check-seo.mjs 直接断言 404 与 /search/ 带
 * noindex 且不在 sitemap 里；negative-check 里有一条削弱它会变红。
 *
 * 之前这个洞是真实存在的：P3-3a 给 404 加了 noindex（正确），
 * 但这份基线脚本没跟着更新，于是「SEO 66」在 CI 里一直是红的而没人修 ——
 * 一条长期红着的门禁等于没有门禁。
 */
const SEO_OPT_OUT = new Set([
  '404 页', // 主动 noindex：收录一个「页面不存在」是纯粹的错误结果
]);

/** 页面是否走 SEO 豁免。豁免的是这一项，不是整页分数。 */
export function isSeoExempt(label) {
  return SEO_OPT_OUT.has(label);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

async function main() {
  console.log('▸ 构建示例站点…');
  await run(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', SITE]);

  const dist = path.join(SITE, 'dist');
  const server = createServer(dist);
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`▸ 静态服务器 http://localhost:${PORT}\n`);

  const rows = [];
  const mobileRows = [];
  try {
    for (const [label, url] of PAGES) {
      process.stdout.write(`▸ 桌面 ${label}…`);
      const report = await lighthouse(`http://localhost:${PORT}${url}`);
      const c = report.categories;
      const a = report.audits;
      const seoScore = Math.round(c.seo.score * 100);
      if (isSeoExempt(label) && seoScore < 100) {
        console.log(` \u001b[2m(SEO ${seoScore} 豁免：noindex 是刻意策略，见脚本顶部 SEO_OPT_OUT)\u001b[0m`);
      }
      rows.push([
        label,
        Math.round(c.performance.score * 100),
        Math.round(c.accessibility.score * 100),
        Math.round(c['best-practices'].score * 100),
        isSeoExempt(label) ? '—(豁免)' : seoScore,
        a['first-contentful-paint'].displayValue,
        a['largest-contentful-paint'].displayValue,
        a['cumulative-layout-shift'].displayValue,
        a['total-blocking-time'].displayValue,
      ]);
      console.log(' 完成');
    }

    for (const [label, url] of MOBILE) {
      process.stdout.write(`▸ 移动 ${label}…`);
      const report = await lighthouse(`http://localhost:${PORT}${url}`, { mobile: true });
      const c = report.categories;
      mobileRows.push([
        label,
        Math.round(c.performance.score * 100),
        Math.round(c.accessibility.score * 100),
        Math.round(c['best-practices'].score * 100),
        isSeoExempt(label) ? '—(豁免)' : Math.round(c.seo.score * 100),
        report.audits['first-contentful-paint'].displayValue,
        report.audits['largest-contentful-paint'].displayValue,
      ]);
      console.log(' 完成');
    }
  } finally {
    server.close();
  }

  console.log('\n| 页面 | Performance | Accessibility | Best Practices | SEO | FCP | LCP | CLS | TBT |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);

  console.log('\n### 移动端模拟（4G + 4x CPU 降速，单独记录）\n');
  console.log('| 页面 | Performance | Accessibility | Best Practices | SEO | FCP | LCP |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of mobileRows) console.log(`| ${row.join(' | ')} |`);

  // 豁免项是字符串 '—(豁免)'，直接 Math.min 会得到 NaN —— 那会让下面
  // 两个 `worst < 阈值` 的判断永远为 false，门禁静默失效。
  // 所以先只取数值项。豁免项由 check-seo.mjs 用更准确的断言守着（见脚本顶部）。
  const numeric = (list) => list.flatMap((r) => r.slice(1, 5)).filter((v) => typeof v === 'number');
  const desktopScores = numeric(rows);
  const mobileScores = numeric(mobileRows);
  if (!desktopScores.length || !mobileScores.length) {
    console.error('✖ 没有拿到任何可比较的分数（豁免项过滤后为空），门禁无法判断');
    process.exitCode = 1;
  }
  const worst = Math.min(...desktopScores);
  const worstMobile = Math.min(...mobileScores);
  console.log(`\n桌面最低分：${worst}（阈值 95）`);
  console.log(`移动最低分：${worstMobile}（阈值 ${MOBILE_THRESHOLD}）`);

  if (worst < 95) {
    console.error('✖ 桌面分数低于 95，性能出现倒退');
    process.exitCode = 1;
  }
  if (worstMobile < MOBILE_THRESHOLD) {
    console.error(`✖ 移动分数低于 ${MOBILE_THRESHOLD}，性能出现倒退`);
    process.exitCode = 1;
  }

  // 与基线逐页对比：**跌了必须解释**。没有解释的下跌就是回归。
  console.log('\n移动端与基线对比（基线见 scripts/lighthouse.mjs 的 MOBILE_BASELINE）：');
  let regressions = 0;
  for (const row of mobileRows) {
    const label = row[0];
    const baseline = MOBILE_BASELINE[label];
    if (baseline === undefined) continue;
    const delta = row[1] - baseline;
    if (delta < 0) {
      regressions += 1;
      console.log(`  ✘ ${label}：${baseline} → ${row[1]}（-${-delta}）`);
    } else {
      console.log(`  ✔ ${label}：${baseline} → ${row[1]}`);
    }
  }
  if (regressions) {
    console.error(`✖ ${regressions} 个页面低于移动端基线，需要在 PR 里解释原因`);
    process.exitCode = 1;
  }
}

function createServer(dist) {
  return http.createServer(async (req, res) => {
    let relative = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    let file = path.join(dist, relative);
    if (!path.resolve(file).startsWith(path.resolve(dist))) return res.writeHead(403).end();
    let content;
    try {
      content = await fs.readFile(file);
    } catch {
      // 无扩展名时按目录路由再试一次，贴近真实静态托管的 404 → /404.html 行为。
      try {
        content = await fs.readFile(path.join(dist, '404.html'));
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      } catch {
        return res.writeHead(404).end('not found');
      }
    }
    if (!res.getHeader('Content-Type')) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    }
    res.end(content);
  });
}

function lighthouse(url, { mobile = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      'lighthouse', url,
      '--only-categories=performance,accessibility,best-practices,seo',
      // 默认（不给任何 preset）就是移动端模拟；桌面要显式声明。
      // 别写 `--preset=desktop=false` —— lighthouse 只接受
      // perf / experimental / desktop 三个值，`desktop=false` 会直接报错退出。
      ...(mobile ? [] : ['--preset=desktop']),
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu',
      '--output=json', '--output-path=stdout', '--quiet',
    ];
    const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`lighthouse 退出码 ${code}\n${err.slice(-500)}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`无法解析 lighthouse 输出：${error.message}`)); }
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
});
