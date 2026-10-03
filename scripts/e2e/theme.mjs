#!/usr/bin/env node
/**
 * 主题系统 e2e（编排：Node 构建，Python 驱动真浏览器）。
 *
 * 为什么必须有真浏览器断言：
 *   「首帧无闪烁」「切换按钮点下去真的翻转」「亮暗两套配色真的不同」
 *   「4 套主题两两布局可辨」—— 这三件事都在渲染结果里，静态检查看不到。
 *   给源码打勾不构成证据。
 *
 * 主题清单动态扫 packages/theme-*。
 *
 * 用法：node scripts/e2e/theme.mjs [--json] [主题...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from '../lib/themes.mjs';
import { buildThemes } from '../lib/build-theme.mjs';
import { layout_signature, signatureDiff } from './theme_signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_ONLY = process.argv.includes('--json');

/**
 * `--json` 是开关，不能被当成主题名。resolveRequested 已跳过 `-` 开头的参数，
 * 但 `--json` 会落到 else 分支吗？不会 —— 它以 `-` 开头，被过滤掉。
 */
const requested = resolveRequested();
const TARGETS = listThemes({ only: requested.length ? requested : undefined });
const dist = buildThemes(TARGETS);

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

/**
 * 「4 套主题两两版面可辨」的判据在这里算，不在 Python 里。
 *
 * Python 只回传每套主题的原始结构指标（LAYOUT_PROBE 的结果），
 * 签名压缩与两两比较走 theme_signature.mjs —— 那个模块有单测钉着，
 * 所以「比较逻辑写错」会在毫秒级的单测里暴露，而不是在 e2e 里装成绿的。
 */
function appendLayoutChecks(list, snapshot) {
  const themes = Object.keys(snapshot ?? {});
  if (themes.length < 2) return;
  const signatures = Object.fromEntries(themes.map((t) => [t, layout_signature(snapshot[t])]));
  for (let i = 0; i < themes.length; i += 1) {
    for (let j = i + 1; j < themes.length; j += 1) {
      const a = themes[i];
      const b = themes[j];
      const diff = signatureDiff(signatures[a], signatures[b]);
      list.push({
        name: `布局结构 ${a} vs ${b} 可辨（≥1 项结构不同）`,
        ok: diff.length >= 1,
        detail: `不同 ${diff.length} 项 ${JSON.stringify(diff)}`,
      });
    }
  }
}

const snapshot = rows.find((r) => r.layout)?.layout;
// 把快照那条内部行去掉，再补上 6 对结构断言 —— 对外只报有意义的结论。
const visible = rows.filter((r) => !r.layout);
appendLayoutChecks(visible, snapshot);
rows.length = 0;
rows.push(...visible);

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(rows));
} else {
  console.log('\n▸ 主题系统 e2e（真浏览器）');
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length - failed.length}/${rows.length} 通过`);
  if (failed.length) process.exitCode = 1;
}
