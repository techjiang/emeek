#!/usr/bin/env node
/**
 * 生成主题预览图：packages/theme-<name>/preview.png（暗色）与 preview-light.png（亮色）。
 * 512x256 的取景由 Python 侧的 viewport 决定（1280x640 渲染 → LANCZOS 缩到 512x256）。
 *
 * 主题清单来自 packages/theme-* 动态扫描 —— 新主题加进来即自动包含。
 *
 * 用法：
 *   node scripts/preview-images.mjs               # 全部内置主题
 *   node scripts/preview-images.mjs aurora        # 只做一套
 *   node scripts/preview-images.mjs --theme aurora,minimal
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes, resolveRequested } from './lib/themes.mjs';
import { buildThemes } from './lib/build-theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = listThemes({ only: resolveRequested() });
const dist = buildThemes(TARGETS);

const themepkg = Object.fromEntries(TARGETS.map((t) => [t, path.join(ROOT, 'packages', `theme-${t}`)]));
const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-preview-')), 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, themepkg }));
const r = spawnSync('python3', [path.join(HERE, 'preview-images.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (r.status !== 0) { process.stderr.write(r.stderr || r.stdout); process.exit(1); }
console.log(`▸ 预览图已生成（${TARGETS.length} 套主题）：`);
for (const file of JSON.parse(r.stdout.trim())) console.log('  ' + path.relative(ROOT, file));
