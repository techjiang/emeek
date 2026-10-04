#!/usr/bin/env node
/**
 * Feed e2e：构建 4 套主题 → 用真 XML 解析器 + 规范规则校验 rss.xml / atom.xml。
 *
 * 「RSS 验证器通过」这条要求不能靠「我看了一眼」达成 —— 阅读器对
 * 日期格式、命名空间、元素嵌套都很挑，而肉眼看不出来。
 *
 * 用法：node scripts/e2e/feed.mjs [--json] [主题...]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from '../lib/themes.mjs';
import { buildThemes } from '../lib/build-theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_ONLY = process.argv.includes('--json');
const requested = resolveRequested();
const TARGETS = listThemes({ only: requested.length ? requested : undefined });
const dist = buildThemes(TARGETS);

const args = TARGETS.map((t) => `${dist[t]}=${t}`);
const result = spawnSync('python3', [path.join(HERE, 'feed.py'), ...args], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}
const rows = JSON.parse(result.stdout.trim().split('\n').pop());

if (JSON_ONLY) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
}
const passed = rows.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${rows.length} 通过`);
process.exit(passed === rows.length ? 0 : 1);
