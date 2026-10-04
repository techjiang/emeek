#!/usr/bin/env node
/**
 * 每套主题的 Lighthouse 门禁（Performance / A11y / Best Practices / SEO ≥ 90）。
 *
 * 与 scripts/lighthouse.mjs 的区别：那个盯 examples/minimal 的性能基线，
 * 这个盯「每套主题都达标」。主题是最容易悄悄拖慢站点的东西 ——
 * 一个 backdrop-filter 或一个大渐变就能把移动端 Performance 拉下来，
 * 而桌面看不出来。所以这里桌面与移动都跑，取各自最低分。
 *
 * 主题清单动态扫 packages/theme-*。
 *
 * 用法：node scripts/lighthouse-themes.mjs [主题...]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from './lib/themes.mjs';
import { buildThemes } from './lib/build-theme.mjs';

const PORT = Number(process.env.PORT ?? 8231);
const THRESHOLD = Number(process.env.THEME_LH_THRESHOLD ?? 90);

const requested = resolveRequested();
const THEMES = listThemes({ only: requested.length ? requested : undefined });

const PAGES = [
  ['首页', '/index.html'],
  ['文章页', '/posts/design-notes.html'],
  ['归档页', '/archive.html'],
  ['标签页', '/tags.html'],
  // 搜索页：内联了索引与客户端脚本，是最容易把 Performance 拉下来的页面 ——
  // 不测它就等于没守「搜索页 4 套主题 Lighthouse ≥ 90」这条要求。
  ['搜索页', '/search/index.html'],
];

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

/** 与其它脚本共用的本地静态服务（走 HTTP，绝不用 file://）。 */
function serve(dist) {
  return http.createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    try {
      const content = await fsp.readFile(path.join(dist, rel));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

function runLighthouse(url, { mobile }) {
  return new Promise((resolve, reject) => {
    const args = [
      'lighthouse', url,
      '--only-categories=performance,accessibility,best-practices,seo',
      ...(mobile ? [] : ['--preset=desktop']),
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu',
      '--output=json', '--output-path=stdout', '--quiet',
    ];
    // Lighthouse 需要知道用哪个 Chrome。默认它会去下自己那份 —— 离线环境里
    // 那是失败源。这里指到系统/CI 已装的 Chromium。
    const chromePath = process.env.CHROME_PATH || '/opt/ms-playwright/chromium-1243/chrome-linux64/chrome';
    const child = spawn('npx', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CHROME_PATH: chromePath },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`lighthouse 退出码 ${code}\n${err.slice(-400)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`解析 lighthouse 输出失败：${e.message}`)); }
    });
  });
}

async function main() {
  const dist = buildThemes(THEMES);
  const summary = [];
  for (const theme of THEMES) {
    console.log(`\n▸ 主题 ${theme}`);
    const server = serve(dist[theme]);
    await new Promise((r) => server.listen(PORT, r));
    try {
      for (const [label, route] of PAGES) {
        for (const mobile of [false, true]) {
          process.stdout.write(`  ${mobile ? '移动' : '桌面'} ${label}…`);
          const report = await runLighthouse(`http://localhost:${PORT}${route}`, { mobile });
          const scores = {
            perf: Math.round(report.categories.performance.score * 100),
            a11y: Math.round(report.categories.accessibility.score * 100),
            best: Math.round(report.categories['best-practices'].score * 100),
            seo: Math.round(report.categories.seo.score * 100),
          };
          summary.push({ theme, device: mobile ? 'mobile' : 'desktop', page: label, ...scores });
          console.log(` perf ${scores.perf} / a11y ${scores.a11y} / bp ${scores.best} / seo ${scores.seo}`);
        }
      }
    } finally {
      server.close();
    }
  }

  console.log('\n| 主题 | 设备 | 页面 | Performance | Accessibility | Best Practices | SEO |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of summary) {
    console.log(`| ${row.theme} | ${row.device} | ${row.page} | ${row.perf} | ${row.a11y} | ${row.best} | ${row.seo} |`);
  }

  const failures = summary.filter((r) => Math.min(r.perf, r.a11y, r.best, r.seo) < THRESHOLD);
  if (failures.length) {
    console.error(`\n✖ ${failures.length} 项低于阈值 ${THRESHOLD}：`);
    for (const f of failures) console.error(`  ${f.theme} ${f.device} ${f.page}: perf ${f.perf} a11y ${f.a11y} bp ${f.best} seo ${f.seo}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✔ 全部 ${summary.length} 项 ≥ ${THRESHOLD}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
