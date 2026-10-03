#!/usr/bin/env node
/**
 * 按主题构建演示站 —— 四个脚本共用的「构建一段」。
 *
 * 之前每个脚本各写一份 withTheme(name, fn)：读 emeeek.config.js、
 * 用正则把 theme.name 替换掉、构建、把 dist 改名成 .dist-<theme>、再复原。
 * 四份拷贝迟早会分叉，而它们的分叉不报错，只是结果对不上。
 *
 * 正则替换本身是脆的（`theme:\s*\{[^}]*\}` 要求一行内闭合），但它是刻意的：
 * examples/themes-demo 的 config 由本仓库维护，形状已知。真要改形状，
 * 改这一处即可。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './themes.mjs';

export const DEMO = path.join(ROOT, 'examples/themes-demo');

/**
 * 构建一套主题，产物改名为 `<DEMO>/.dist-<theme>` 并返回该目录。
 * @param {string} theme
 * @returns {string} 产物目录（绝对路径）
 */
export function buildTheme(theme) {
  const configFile = path.join(DEMO, 'emeeek.config.js');
  const original = fs.readFileSync(configFile, 'utf8');
  // 模式不存在才是错误；「替换后文本相同」（本来就指这套主题）是正常情况。
  if (!/theme:\s*\{[^}]*\}/.test(original)) {
    throw new Error(`没能在 examples/themes-demo/emeeek.config.js 里找到 theme.name，无法切到「${theme}」`);
  }
  const patched = original.replace(/theme:\s*\{[^}]*\}/, `theme: { name: '${theme}', darkMode: 'auto' }`);
  fs.writeFileSync(configFile, patched);
  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', DEMO], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`构建 ${theme} 失败：\n${result.stderr || result.stdout}`);
  } finally {
    fs.writeFileSync(configFile, original);
  }
  const target = path.join(DEMO, `.dist-${theme}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(DEMO, 'dist'), target);
  return target;
}

/** 依次构建多套主题，返回 { theme: distDir }。 */
export function buildThemes(themes) {
  const dist = {};
  for (const theme of themes) dist[theme] = buildTheme(theme);
  return dist;
}
