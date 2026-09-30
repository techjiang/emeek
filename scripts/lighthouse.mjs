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

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

async function main() {
  console.log('▸ 构建示例站点…');
  await run(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', SITE]);

  const dist = path.join(SITE, 'dist');
  const server = createServer(dist);
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`▸ 静态服务器 http://localhost:${PORT}\n`);

  const rows = [];
  try {
    for (const [label, url] of PAGES) {
      process.stdout.write(`▸ ${label}…`);
      const report = await lighthouse(`http://localhost:${PORT}${url}`);
      const c = report.categories;
      const a = report.audits;
      rows.push([
        label,
        Math.round(c.performance.score * 100),
        Math.round(c.accessibility.score * 100),
        Math.round(c['best-practices'].score * 100),
        Math.round(c.seo.score * 100),
        a['first-contentful-paint'].displayValue,
        a['largest-contentful-paint'].displayValue,
        a['cumulative-layout-shift'].displayValue,
        a['total-blocking-time'].displayValue,
      ]);
      console.log(' 完成');
    }
  } finally {
    server.close();
  }

  console.log('\n| 页面 | Performance | Accessibility | Best Practices | SEO | FCP | LCP | CLS | TBT |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);

  const worst = Math.min(...rows.flatMap((r) => r.slice(1, 5)));
  console.log(`\n最低分：${worst}`);
  if (worst < 95) {
    console.error('✖ 低于 95 分阈值，性能出现倒退');
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

function lighthouse(url) {
  return new Promise((resolve, reject) => {
    const args = [
      'lighthouse', url,
      '--only-categories=performance,accessibility,best-practices,seo',
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
