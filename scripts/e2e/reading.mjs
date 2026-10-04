#!/usr/bin/env node
/**
 * 长文导航 e2e（编排：Node 构建，Python 驱动真浏览器）。
 *
 * 三件事只在渲染与滚动里成立：目录点了跳不跳、滚动高亮对不对、
 * 进度条涨不涨。静态检查只能确认「DOM 里有这些元素」，那离「它工作」还差很远。
 *
 * 用法：node scripts/e2e/reading.mjs [主题...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from '../lib/themes.mjs';
import { buildThemes } from '../lib/build-theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_ONLY = process.argv.includes('--json');
const requested = resolveRequested();
const TARGETS = listThemes({ only: requested.length ? requested : undefined });

if (!JSON_ONLY) console.log(`▸ 构建 ${TARGETS.join(' / ')}…`);
const dist = buildThemes(TARGETS);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-reading-e2e-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'reading.py'), configFile], { encoding: 'utf8', cwd: HERE });
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
    for (const row of rows) {
      console.log(`  ${row.ok ? '✔' : '✘'} ${row.label}${row.detail && !row.ok ? ` — ${row.detail}` : ''}`);
    }
  }
  const pass = payload.results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${payload.results.length} 通过`);
}
if (payload.failures.length) {
  if (JSON_ONLY) console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
