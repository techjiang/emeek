#!/usr/bin/env node
/**
 * 社交分享端到端验收（P3-4b-rest C）。
 *
 * 与单测的分工：单测断言「链接拼对了、矩阵一致」；这里断言
 * **真实构建的产物 + 真 Chromium 里的行为**：
 *   · 二维码在浏览器里画出来，而且能被**真实解码器**读出正确地址
 *   · 复制按钮真的写进了剪贴板
 *   · 手机视口下折叠能用、不横向溢出
 *
 * 用法：node scripts/e2e/share.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(ROOT, 'packages/cli/bin/emeeek.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (l, e = '') => { pass += 1; console.log(`  ✔ ${l}${e ? `  —— ${e}` : ''}`); };
const bad = (l, e = '') => { fail += 1; failures.push(l); console.log(`  ✘ ${l}${e ? `  —— ${e}` : ''}`); };
const check = (l, c, e = '') => (c ? ok(l, e) : bad(l, e));

function makeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-share-e2e-'));
  fs.mkdirSync(path.join(dir, 'posts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'emeeek.config.js'), `export default {
  site: { title: '分享验收站', description: 'E2E', url: 'https://share-e2e.test', author: 'E2E', language: 'zh-CN' },
  content: { source: 'local', localDirs: ['posts'] },
  share: { enabled: true, platforms: ['twitter', 'weibo', 'wechat', 'copy'], position: 'both' },
};
`, 'utf8');
  fs.writeFileSync(path.join(dir, 'posts/2025-01-01-hello.md'), `---
title: 你好世界
date: 2025-01-01
tags: [分享]
---

# 你好世界

正文，用来验证分享。
`, 'utf8');
  return dir;
}

console.log('▸ 1. 构建产物');

const site = makeSite();
const built = spawnSync('node', [CLI, 'build', '--cwd', site], { encoding: 'utf8', cwd: ROOT });
check('构建成功', built.status === 0, built.status === 0 ? '' : (built.stderr ?? '').slice(0, 300));

const outDir = path.join(site, 'dist');
const postPath = path.join(outDir, 'posts/hello.html');
if (!fs.existsSync(postPath)) {
  bad('生成 dist/posts/hello.html');
  process.exit(1);
}
const html = fs.readFileSync(postPath, 'utf8');

check('四个平台按钮都在', ['twitter', 'weibo', 'wechat', 'copy'].every((id) => html.includes(`share-${id}`) || html.includes(`data-share-${id}`)));
check('分享链接是绝对地址', /https%3A%2F%2Fshare-e2e\.test/.test(html));
check('UTM 参数在', /utm_source%3Demeek|utm_source=emeek/.test(html));
check('position: both → 底部与侧栏各一份', (html.match(/data-share-url=/g) ?? []).length >= 2);
check('无第三方分享 SDK', !/platform\.twitter\.com|connect\.facebook\.net|addthis/.test(html));
check('内联了二维码编码器（配了微信）', html.includes('RS_BLOCK'));
check('二维码 canvas 就位', /<canvas[^>]*data-qr|share-qr-canvas/.test(html));
check('预压缩产物在（继承加速管线）', fs.existsSync(`${postPath}.gz`));

// ── 2. 真浏览器行为 ──
console.log('');
console.log('▸ 2. 真 Chromium 行为（二维码解码 / 剪贴板 / 移动端）');

// 起一个本地静态服务。**必须单独起一个进程** —— 不能用同进程的
// http.createServer：后面用 spawnSync 驱动 Python，那会**阻塞 Node 的事件循环**，
// 同进程的服务永远不回请求，浏览器于是超时。
// 这是我自己踩的坑，写在这里免得后人重走。
const PORT = 18000 + Math.floor(Math.random() * 1000);
const serverProc = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', outDir], {
  cwd: ROOT, stdio: 'ignore',
});
const baseUrl = `http://127.0.0.1:${PORT}`;
const expected = 'https://share-e2e.test/posts/hello.html?';

// 等一下端口起来
await new Promise((resolve) => setTimeout(resolve, 800));

try {
  const result = spawnSync('python3', [path.join(HERE, 'share.py'), baseUrl, expected], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
  const stdout = result.stdout ?? '';
  const lastLine = stdout.trim().split('\n').pop();
  let checks = [];
  try { checks = JSON.parse(lastLine); } catch { /* 见下 */ }
  if (!Array.isArray(checks) || !checks.length) {
    bad('浏览器验收脚本产出结果', (result.stderr ?? stdout).slice(-400));
  } else {
    for (const c of checks) check(c.label, c.ok, c.extra);
  }
} finally {
  serverProc.kill('SIGTERM');
  if (!KEEP) fs.rmSync(site, { recursive: true, force: true });
}

console.log('');
console.log(`  ── ${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
