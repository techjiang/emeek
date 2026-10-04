#!/usr/bin/env node
/**
 * PWA e2e（编排：Node 构建，Python 驱动真浏览器）。
 *
 * 为什么必须真浏览器：Service Worker 的行为在 jsdom / 静态检查里**完全不存在**。
 * 「注册成功了吗」「断网时拿到的是缓存还是空白」——只有真的浏览器 + 真的
 * HTTP 服务能回答。把 sw.js 下载下来看一眼，不构成任何证据。
 *
 * 用法：node scripts/e2e/pwa.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const JSON_ONLY = process.argv.includes('--json');
const SITE = path.join(ROOT, 'examples/pwa-demo');

if (!JSON_ONLY) console.log('▸ 构建 examples/pwa-demo…');
const build = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', SITE], { encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-pwa-e2e-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist: path.join(SITE, 'dist'), root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'pwa.py'), configFile], { encoding: 'utf8', cwd: HERE });
if (result.status !== 0 && !result.stdout) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

const payload = JSON.parse(result.stdout.trim().split('\n').pop());
if (!JSON_ONLY) {
  for (const row of payload.results) {
    console.log(`  ${row.ok ? '✔' : '✘'} ${row.label}${row.detail && !row.ok ? ` — ${row.detail}` : ''}`);
  }
  console.log(`\n  ${payload.results.filter((r) => r.ok).length}/${payload.results.length} 通过`);
}
if (payload.failures.length) {
  if (JSON_ONLY) console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
process.exit(0);
