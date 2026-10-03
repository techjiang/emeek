#!/usr/bin/env node
/**
 * 主题截图编排：Node 负责构建（复用 CLI），Python 负责渲染（真 Chromium）。
 *
 * 为什么拆成两段：构建是 Node 的事，浏览器是 Python/Playwright 的事。
 * 仓库里 e2e 也是这个分工（*.mjs 编排 + *.py 驱动浏览器），不引入 Node 侧
 * 的浏览器依赖，避免多装一套 Chromium。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DEMO = path.join(ROOT, 'examples/themes-demo');
const OUT = path.join(ROOT, 'docs/assets/themes');

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TARGETS = requested.length ? requested : ['aurora', 'minimal', 'inkstone', 'magazine'];

function withTheme(name, fn) {
  const file = path.join(DEMO, 'emeeek.config.js');
  const original = fs.readFileSync(file, 'utf8');
  const patched = original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${name}', darkMode: 'auto' }`);
  fs.writeFileSync(file, patched);
  try { return fn(); } finally { fs.writeFileSync(file, original); }
}

const dist = {};
for (const theme of TARGETS) {
  withTheme(theme, () => {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', DEMO,
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`构建 ${theme} 失败：\n${result.stderr}`);
    const target = path.join(DEMO, `.dist-${theme}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(DEMO, 'dist'), target);
    dist[theme] = target;
  });
}

const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-shot-')), 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ dist, out: OUT, root: ROOT, targets: TARGETS }));
const result = spawnSync('python3', [path.join(HERE, 'capture.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) { process.stderr.write(result.stderr || ''); process.exit(1); }
const summary = JSON.parse(result.stdout.trim().split('\n').pop());
console.log(`\n▸ 截图完成：${summary.count} 张`);
for (const row of summary.manifest) console.log(`  ${row.file}`);
