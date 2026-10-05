#!/usr/bin/env node
/**
 * P3-4b-rest-2 截图：分享按钮 + 微信二维码展开态 + 分类总览页，4 套主题。
 *
 * 用法：node scripts/screenshots/rest2.mjs [输出目录]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, listThemes } from '../lib/themes.mjs';
import { buildThemes } from '../lib/build-theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'workspace/tmp');

// 写一份「带分类 + 开分享」的演示配置进 examples/themes-demo，然后逐主题构建。
const SITE = path.join(ROOT, 'examples/themes-demo');
const configFile = path.join(SITE, 'emeeek.config.js');
const original = fs.readFileSync(configFile, 'utf8');
const patched = original.includes('share:')
  ? original.replace(/share:\s*\{[\s\S]*?\},/, "share: { enabled: true, platforms: ['twitter', 'weibo', 'wechat', 'copy'], position: 'both' },")
  : original.replace('export default {', "export default {\n  share: { enabled: true, platforms: ['twitter', 'weibo', 'wechat', 'copy'], position: 'both' },");
fs.writeFileSync(configFile, patched);

let dist;
try {
  dist = buildThemes(listThemes());
} finally {
  fs.writeFileSync(configFile, original);
}

const themepkg = Object.fromEntries(listThemes().map((t) => [t, path.join(ROOT, 'packages', `theme-${t}`)]));
const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-rest2-shot-')), 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ dist, themepkg }));
const r = spawnSync('python3', [path.join(HERE, 'rest2.py'), cfg, OUT], { encoding: 'utf8', cwd: ROOT });
if (r.status !== 0) { process.stderr.write(r.stderr || r.stdout); process.exit(1); }
console.log(`▸ 截图已生成到 ${OUT}`);
console.log(r.stdout.trim());
