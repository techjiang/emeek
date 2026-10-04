#!/usr/bin/env node
/**
 * 评论系统 e2e（编排：Node 构建 4 套主题的评论演示站，Python 驱动真浏览器）。
 *
 * 为什么必须真浏览器：评论内容是**运行时**由脚本填的。静态检查只能确认
 * 「DOM 里有 data-comments-*」，而这段逻辑里最要紧的一条是 XSS 防线 ——
 * 只有真浏览器能证明恶意正文没有被当成 HTML 执行。
 *
 * 用法：node scripts/e2e/comments.mjs [主题...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from '../lib/themes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_ONLY = process.argv.includes('--json');
const SITE = path.join(ROOT, 'examples/comments-demo');
const requested = resolveRequested();
const TARGETS = listThemes({ only: requested.length ? requested : undefined });

/** 逐主题构建：改 theme.name → 构建 → 产物改名。 */
function buildForTheme(theme) {
  const configFile = path.join(SITE, 'emeeek.config.js');
  const original = fs.readFileSync(configFile, 'utf8');
  if (!/theme:\s*\{[^}]*\}/.test(original)) throw new Error('comments-demo 的配置里没有 theme.name');
  fs.writeFileSync(configFile, original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${theme}', darkMode: 'auto' }`));
  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', SITE], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`构建 ${theme} 失败：\n${result.stderr || result.stdout}`);
  } finally {
    fs.writeFileSync(configFile, original);
  }
  const target = path.join(SITE, `.dist-${theme}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(SITE, 'dist'), target);
  return target;
}

const dist = {};
for (const theme of TARGETS) {
  if (!JSON_ONLY) process.stdout.write(`▸ 构建 ${theme}…`);
  dist[theme] = buildForTheme(theme);
  if (!JSON_ONLY) console.log(' 完成');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-comments-e2e-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'comments.py'), configFile], { encoding: 'utf8', cwd: HERE });
if (!result.stdout) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}
const payload = JSON.parse(result.stdout.trim().split('\n').pop());

if (!JSON_ONLY) {
  const byTheme = {};
  for (const row of payload.results) (byTheme[row.theme] ??= []).push(row);
  for (const [theme, rows] of Object.entries(byTheme)) {
    console.log(`\n▸ ${theme}`);
    for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.label}${row.detail && !row.ok ? ` — ${row.detail}` : ''}`);
  }
  console.log(`\n  ${payload.results.filter((r) => r.ok).length}/${payload.results.length} 通过`);
}
if (payload.failures.length) {
  if (JSON_ONLY) console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
