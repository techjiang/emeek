#!/usr/bin/env node
/**
 * 统计页端到端验收（P3-4b-rest A/B）。
 *
 * 与单测的分工：单测断言的是**函数**（buildStatsView 输出了什么），
 * 这个脚本断言的是**真实构建的产物 + 真 Chromium 里的行为**。
 * 两者都要有，因为有几条纪律只在真实渲染下才成立：
 *
 *   · 统计页真的零 JS —— 得在浏览器里数 <script> 与监听器，而不是数字符串
 *   · 图表真的画出来了 —— SVG 在 DOM 里存在且尺寸非零
 *   · 响应式真的生效 —— 手机视口下不横向溢出
 *   · 无数据源的区块真的不见了 —— 而不是「标题在、图是空的」
 *
 * 用法：
 *   node scripts/e2e/stats.mjs            # 全部
 *   node scripts/e2e/stats.mjs --keep     # 保留临时站点（调试用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listThemes } from '../lib/themes.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(ROOT, 'packages/cli/bin/emeeek.js');
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, extra = '') {
  pass += 1;
  console.log(`  ✔ ${label}${extra ? `  —— ${extra}` : ''}`);
}

function bad(label, extra = '') {
  fail += 1;
  failures.push(label);
  console.log(`  ✘ ${label}${extra ? `  —— ${extra}` : ''}`);
}

function check(label, condition, extra = '') {
  if (condition) ok(label, extra);
  else bad(label, extra);
}

/** 造一个带 N 篇文章的临时站点。 */
function makeSite({ posts = 12, analytics = '', theme = 'minimal' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-stats-e2e-'));
  fs.mkdirSync(path.join(dir, 'posts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'emeeek.config.js'), `export default {
  site: { title: '统计验收站', description: 'E2E', url: 'https://stats-e2e.test', author: 'E2E', language: 'zh-CN' },
  content: { source: 'local', localDirs: ['posts'] },
  theme: { name: ${JSON.stringify(theme)} },
  analytics: { enabled: false, statsPage: { enabled: true }${analytics ? `, ${analytics}` : ''} },
};
`, 'utf8');
  for (let i = 1; i <= posts; i += 1) {
    const month = String(((i - 1) % 12) + 1).padStart(2, '0');
    fs.writeFileSync(path.join(dir, 'posts', `2025-${month}-10-post-${i}.md`), `---
title: 第 ${i} 篇文章
date: 2025-${month}-10
tags: [Emeek, 标签${i % 4}]
---

# 第 ${i} 篇

正文内容，用来验证统计页的图表渲染与字数统计。

## 小节

更多内容。
`, 'utf8');
  }
  return dir;
}

function build(cwd) {
  const result = spawnSync('node', [CLI, 'build', '--cwd', cwd], { encoding: 'utf8', cwd: ROOT });
  return result;
}

// ── 1. 构建期断言 ────────────────────────────────────────────────
console.log('▸ 1. 统计页产物');

const site = makeSite();
const built = build(site);
check('构建成功', built.status === 0, built.status === 0 ? '' : (built.stderr ?? '').slice(0, 200));

const outDir = path.join(site, 'dist');
const statsPath = path.join(outDir, 'stats/index.html');

if (!fs.existsSync(statsPath)) {
  bad('生成 dist/stats/index.html');
  console.log('\n构建失败，后续断言跳过。');
  process.exit(1);
}
ok('生成 dist/stats/index.html');

const html = fs.readFileSync(statsPath, 'utf8');
const svgClasses = [...html.matchAll(/<svg class="chart chart-([a-z]+)"/g)].map((m) => m[1]);

check('渲染了全部 5 类图表', ['bars', 'line', 'pie', 'heatmap', 'cloud'].every((c) => svgClasses.includes(c)),
  svgClasses.join(' / '));

check('统计页无外部脚本引用', !/<script[^>]+src=/i.test(html));
check('统计页无 canvas（无 JS 时它是空的）', !/<canvas/i.test(html));

const scriptCount = (html.match(/<script\b/gi) ?? []).length;
check('统计页 script 数 ≤ 4（no-flash + 主题 + JSON-LD）', scriptCount <= 4, `实际 ${scriptCount}`);

check('数字卡片存在', /data-key="posts"/.test(html));
check('无数据源显示 —（不是 0）', /data-key="comments"[\s\S]{0,200}?—/.test(html));
check('标注了「无数据源」', /无数据源/.test(html));
check('写出排序依据', /按\S+排序/.test(html));
check('数据来源区块在', /数据来源/.test(html));
check('没有 PV 数据时整块不渲染', !/id="stats-pv"/.test(html));

const sitemap = fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8');
check('统计页进了 sitemap', sitemap.includes('/stats/'));

const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
check('导航里有统计入口', indexHtml.includes('href="/stats/"'));

// 加速管线也处理了统计页
check('统计页有预压缩产物', fs.existsSync(`${statsPath}.gz`) && fs.existsSync(`${statsPath}.br`));

// ── 2. 零追踪：默认关闭时不得有任何统计脚本 ──────────────────────
console.log('');
console.log('▸ 2. 零追踪（默认关闭）');

const zeroSite = makeSite({ analytics: '' });
// 把 statsPage 也关掉，模拟「完全没碰 analytics」的默认状态
fs.writeFileSync(path.join(zeroSite, 'emeeek.config.js'), `export default {
  site: { title: '默认站', url: 'https://zero.test', author: 'A', language: 'zh-CN' },
  content: { source: 'local', localDirs: ['posts'] },
};
`, 'utf8');
build(zeroSite);
const zeroIndex = fs.readFileSync(path.join(zeroSite, 'dist/index.html'), 'utf8');
const zeroMarkers = ['plausible.io', 'goatcounter', 'umami', 'data-domain', 'data-website-id', 'sendBeacon'];
check('默认产物里没有任何统计域名', zeroMarkers.every((m) => !zeroIndex.includes(m)),
  zeroMarkers.filter((m) => zeroIndex.includes(m)).join(' / ') || '');
check('默认不产出统计页', !fs.existsSync(path.join(zeroSite, 'dist/stats/index.html')));
check('默认导航里没有统计入口', !zeroIndex.includes('/stats/'));

// ── 3. 各 provider 注入 ──────────────────────────────────────────
console.log('');
console.log('▸ 3. 分析 provider 注入');

for (const [name, cfg, marker] of [
  ['plausible', "enabled: true, provider: 'plausible', plausible: { domain: 'e2e.test' }", 'data-domain="e2e.test"'],
  ['goatcounter', "enabled: true, provider: 'goatcounter', goatcounter: { code: 'e2e' }", 'e2e.goatcounter.com/count'],
  ['umami', "enabled: true, provider: 'umami', umami: { websiteId: 'wid', scriptSrc: 'https://u.test/u.js' }", 'data-website-id="wid"'],
]) {
  const s = makeSite({ posts: 2, analytics: cfg });
  const r = build(s);
  if (r.status !== 0) {
    bad(`${name} 构建`, (r.stderr ?? '').slice(0, 160));
    continue;
  }
  const page = fs.readFileSync(path.join(s, 'dist/index.html'), 'utf8');
  check(`${name} 注入脚本`, page.includes(marker), marker);
  check(`${name} 脚本在 head 里`, page.indexOf(marker) < page.indexOf('</head>'));
  if (!KEEP) fs.rmSync(s, { recursive: true, force: true });
}

// ── 4. 真实浏览器 ────────────────────────────────────────────────
console.log('');
console.log('▸ 4. 真 Chromium：零 JS / 图表 / 响应式');

const browserScript = `
import asyncio, json, sys, os, http.server, socketserver, threading, functools
from playwright.async_api import async_playwright

root = sys.argv[1]
themes = json.loads(sys.argv[2])

def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]

async def main():
    out = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/usr/local/bin/chromium", args=["--no-sandbox"])
        for theme, dist in themes:
            httpd, port = serve(dist)
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(f"http://127.0.0.1:{port}/stats/index.html")
            await page.wait_for_timeout(400)
            row = {"theme": theme, "pageErrors": errors}
            row["scripts"] = await page.evaluate("document.querySelectorAll('script').length")
            row["scriptSrcs"] = await page.evaluate("[...document.querySelectorAll('script[src]')].map(s=>s.src)")
            row["charts"] = await page.evaluate("[...document.querySelectorAll('svg.chart')].map(s=>s.getAttribute('class'))")
            row["chartSizes"] = await page.evaluate("[...document.querySelectorAll('svg.chart')].map(s=>{const r=s.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})")
            row["totals"] = await page.evaluate("document.querySelectorAll('[data-key]').length")
            # 横向溢出检测（响应式）
            row["overflowDesktop"] = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            await ctx.close()

            # 手机视口
            ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            page = await ctx.new_page()
            await page.goto(f"http://127.0.0.1:{port}/stats/index.html")
            await page.wait_for_timeout(400)
            row["overflowMobile"] = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            row["mobileCharts"] = await page.evaluate("[...document.querySelectorAll('svg.chart')].filter(s=>s.getBoundingClientRect().width>0).length")
            await ctx.close()
            httpd.shutdown()
            out.append(row)
        await browser.close()
    print(json.dumps(out))

asyncio.run(main())
`;

const pyFile = path.join(os.tmpdir(), `emeeek-stats-e2e-${process.pid}.py`);
fs.writeFileSync(pyFile, browserScript, 'utf8');

// 为每套内置主题各构建一份带统计页的站点
const themes = listThemes();
const themeDists = [];
for (const name of themes) {
  const s = makeSite({ posts: 12, theme: name });
  const r = build(s);
  if (r.status !== 0) {
    bad(`${name} 主题构建`, (r.stderr ?? '').slice(0, 160));
    continue;
  }
  themeDists.push([name, path.join(s, 'dist'), s]);
}

const py = spawnSync('python3', [pyFile, ROOT, JSON.stringify(themeDists.map(([n, d]) => [n, d]))], {
  encoding: 'utf8',
  cwd: ROOT,
});
if (py.status !== 0) {
  bad('浏览器检查执行', (py.stderr ?? '').slice(0, 400));
} else {
  const rows = JSON.parse(py.stdout.trim().split('\n').pop());
  for (const row of rows) {
    const t = row.theme;
    check(`${t}：无运行时错误`, row.pageErrors.length === 0, row.pageErrors.join('; '));
    check(`${t}：统计页无外部脚本`, row.scriptSrcs.length === 0, row.scriptSrcs.join(', '));
    check(`${t}：5 类图表都渲染`, row.charts.length === 5, `${row.charts.length} 张`);
    check(`${t}：图表都有非零尺寸`, row.chartSizes.every(([w, h]) => w > 0 && h > 0), JSON.stringify(row.chartSizes));
    check(`${t}：数字卡片都渲染`, row.totals >= 4, `${row.totals} 个`);
    check(`${t}：桌面无横向溢出`, row.overflowDesktop <= 0, `${row.overflowDesktop}px`);
    check(`${t}：手机无横向溢出`, row.overflowMobile <= 0, `${row.overflowMobile}px`);
    check(`${t}：手机端图表可见`, row.mobileCharts === 5, `${row.mobileCharts} 张`);
  }
}

fs.rmSync(pyFile, { force: true });
if (!KEEP) {
  fs.rmSync(site, { recursive: true, force: true });
  fs.rmSync(zeroSite, { recursive: true, force: true });
  for (const [, , dir] of themeDists) fs.rmSync(dir, { recursive: true, force: true });
} else {
  console.log(`\n保留临时站点：${site}`);
}

console.log('');
console.log(`  ── ${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('');
  for (const f of failures) console.log(`  ✘ ${f}`);
  process.exit(1);
}
