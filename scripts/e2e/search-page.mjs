#!/usr/bin/env node
/**
 * 搜索页 e2e 编排（Node 构建 4 套主题 → Python 驱动真浏览器）。
 *
 * 用法：node scripts/e2e/search-page.mjs [--json] [主题...]
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
const dist = buildThemes(TARGETS);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-search-e2e-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, targets: TARGETS, root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'search_browser.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}
const payload = JSON.parse(result.stdout.trim().split('\n').pop());
const rows = payload.rows;

/**
 * 「4 套搜索页两两可辨」——比较的是计算样式快照，不是「颜色值不同」。
 * 判据：任意两套主题至少 3 项样式维度不同（圆角 / 高亮色 / 网格列数 /
 * 最大宽度 / 边框风格）。少于 3 项就意味着它们其实共用同一套排版，
 * 只是换了个颜色 —— 那不叫「每套主题都适配了搜索页」。
 */
const FEATURES = ['resultRadius', 'inputRadius', 'submitColor', 'markerColor', 'gridCols', 'resultBorder', 'maxWidth'];
const themes = Object.keys(payload.signatures ?? {});
for (let i = 0; i < themes.length; i += 1) {
  for (let j = i + 1; j < themes.length; j += 1) {
    const a = themes[i];
    const b = themes[j];
    const diff = FEATURES.filter((f) => String(payload.signatures[a][f]) !== String(payload.signatures[b][f]));
    rows.push({
      name: `搜索页 ${a} 与 ${b} 样式可辨（≥3 项不同）`,
      ok: diff.length >= 3,
      detail: `不同 ${diff.length} 项 ${JSON.stringify(diff)}`,
    });
  }
}

if (JSON_ONLY) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
}
const passed = rows.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${rows.length} 通过`);
process.exit(passed === rows.length ? 0 : 1);
