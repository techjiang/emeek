#!/usr/bin/env node
/**
 * 生成主题预览图：themes/<name>/preview.png（暗色）与 preview-light.png（亮色）。
 * 512x256 的取景由 Python 侧的 viewport 决定（1024x512，2x 逻辑不变，
 * 实际 PNG 尺寸按 viewport 走 —— 文档里按「首屏缩略图」使用）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEMO = path.join(ROOT, 'examples/themes-demo');
const TARGETS = ['aurora', 'minimal'];

function withTheme(name, fn) {
  const file = path.join(DEMO, 'emeeek.config.js');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${name}', darkMode: 'auto' }`));
  try { return fn(); } finally { fs.writeFileSync(file, original); }
}

const dist = {};
for (const theme of TARGETS) {
  withTheme(theme, () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', DEMO], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    const target = path.join(DEMO, `.dist-${theme}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(DEMO, 'dist'), target);
    dist[theme] = target;
  });
}

const themepkg = Object.fromEntries(TARGETS.map((t) => [t, path.join(ROOT, 'packages', `theme-${t}`)]));
const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-preview-')), 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, themepkg }));
const r = spawnSync('python3', [path.join(HERE, 'preview-images.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (r.status !== 0) { process.stderr.write(r.stderr || r.stdout); process.exit(1); }
console.log('▸ 预览图已生成：');
for (const file of JSON.parse(r.stdout.trim())) console.log('  ' + path.relative(ROOT, file));
