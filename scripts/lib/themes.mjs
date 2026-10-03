#!/usr/bin/env node
/**
 * 主题发现（脚本侧的唯一事实来源）。
 *
 * 为什么要有这个模块：P3-1a 把主题名写死在四个脚本里
 * （preview-images.mjs / capture.mjs / lighthouse-themes.mjs / e2e/theme.mjs），
 * 于是加第 5 套主题时，默认跑 `node scripts/screenshots/capture.mjs`
 * 不会带上它 —— 而且不会报错，只是默默少跑一套。
 *
 * 现在一律扫 packages/theme-* 目录，从每个主题的 theme.json 读 name。
 * 「加主题 = 自动出现在所有脚本里」是基础设施该有的形状。
 *
 * 两个刻意的规则：
 *  1. 读 theme.json 的 name，而不是从目录名截 `theme-` 前缀 ——
 *     目录名与 name 可能不一致，name 才是构建器真正认的标识。
 *  2. 只认 packages/ 下的内置主题。用户项目的 themes/ 是另一回事，
 *     这些脚本针对的是本仓库内置主题的验收。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * 列出内置主题名，按目录名排序（= 稳定的展示顺序 aurora/minimal/...）。
 *
 * @param {object} [options]
 * @param {string[]} [options.only] 只要这些主题（用于按参数单跑）；缺省全部。
 * @returns {string[]} 主题名
 */
export function listThemes({ only } = {}) {
  const packagesDir = path.join(ROOT, 'packages');
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('theme-')) continue;
    const metaFile = path.join(packagesDir, entry.name, 'theme.json');
    if (!fs.existsSync(metaFile)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      continue; // 坏掉的 theme.json 由构建器报错，这里不替它抛
    }
    const name = typeof meta.name === 'string' && meta.name ? meta.name : entry.name.replace(/^theme-/, '');
    found.push({ dir: entry.name, name });
  }
  found.sort((a, b) => a.dir.localeCompare(b.dir));
  const names = found.map((t) => t.name);

  if (!only || !only.length) return names;
  const requested = only.filter(Boolean);
  const known = new Set(names);
  for (const name of requested) {
    if (!known.has(name)) {
      throw new Error(`找不到主题「${name}」。可用：${names.join(' / ')}`);
    }
  }
  return requested;
}

/** 解析 CLI/脚本参数：`--theme=x`、`--theme x`、或裸位置参数，都当作主题过滤。 */
export function resolveRequested(argv = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--theme' && argv[i + 1]) { out.push(argv[++i]); continue; }
    if (arg.startsWith('--theme=')) { out.push(arg.slice('--theme='.length)); continue; }
    if (arg.startsWith('-')) continue; // 其它 flag 交给各自的脚本
    out.push(arg);
  }
  return out;
}
