#!/usr/bin/env node
/**
 * 主题系统 e2e（编排：Node 构建，Python 驱动真浏览器）。
 *
 * 为什么必须有真浏览器断言：
 *   「首帧无闪烁」「切换按钮点下去真的翻转」「亮暗两套配色真的不同」——
 *   这三件事都在渲染结果里，静态检查看不到。给源码打勾不构成证据。
 *
 * 用法：node scripts/e2e/theme.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DEMO = path.join(ROOT, 'examples/themes-demo');
const JSON_ONLY = process.argv.includes('--json');
const TARGETS = ['aurora', 'minimal', 'inkstone', 'magazine'];

function build(theme) {
  const file = path.join(DEMO, 'emeeek.config.js');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${theme}', darkMode: 'auto' }`));
  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', DEMO], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`构建 ${theme} 失败：\n${result.stderr}`);
  } finally {
    fs.writeFileSync(file, original);
  }
  const target = path.join(DEMO, `.dist-${theme}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(DEMO, 'dist'), target);
  return target;
}

const dist = {};
for (const theme of TARGETS) dist[theme] = build(theme);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-theme-e2e-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, targets: TARGETS, root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'theme.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}
const rows = JSON.parse(result.stdout.trim().split('\n').pop());
if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(rows));
} else {
  console.log('\n▸ 主题系统 e2e（真浏览器）');
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length - failed.length}/${rows.length} 通过`);
  if (failed.length) process.exitCode = 1;
}
