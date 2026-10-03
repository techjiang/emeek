#!/usr/bin/env node
/**
 * 主题截图编排：Node 负责构建（复用 CLI），Python 负责渲染（真 Chromium）。
 *
 * 为什么拆成两段：构建是 Node 的事，浏览器是 Python/Playwright 的事。
 * 仓库里 e2e 也是这个分工（*.mjs 编排 + *.py 驱动浏览器），不引入 Node 侧
 * 的浏览器依赖，避免多装一套 Chromium。
 *
 * 主题清单动态扫 packages/theme-*（新主题自动纳入）。
 *
 * 用法：
 *   node scripts/screenshots/capture.mjs                 # 全部主题
 *   node scripts/screenshots/capture.mjs magazine        # 单套
 *   node scripts/screenshots/capture.mjs --theme magazine,aurora
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from '../lib/themes.mjs';
import { buildThemes } from '../lib/build-theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'docs/assets/themes');

const requested = resolveRequested();
const TARGETS = listThemes({ only: requested.length ? requested : undefined });
const dist = buildThemes(TARGETS);

const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-shot-')), 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, out: OUT, root: ROOT, targets: TARGETS }));
const result = spawnSync('python3', [path.join(HERE, 'capture.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) { process.stderr.write(result.stderr || ''); process.exit(1); }
const summary = JSON.parse(result.stdout.trim().split('\n').pop());
console.log(`\n▸ 截图完成：${summary.count} 张（${TARGETS.join(' / ')}）`);
for (const row of summary.manifest) console.log(`  ${row.file}`);
