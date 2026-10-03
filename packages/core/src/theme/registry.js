/**
 * 内置主题注册表（构建期 / CLI 用）。
 *
 * 与 scripts/lib/themes.mjs 的关系：那个给仓库内的验收脚本用（只扫内置主题），
 * 这个给 CLI `emeeek theme list` 用 —— 除了内置主题，还要能看见用户项目里
 * `themes/` 下的自定义主题。两者都坚持「扫磁盘、读 theme.json」，
 * 只是扫描范围不同。
 *
 * 为什么不复用 BUILTIN_THEMES 那个常量数组：常量会漂移。
 * 真正的事实来源是 packages/theme-<name>/theme.json。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 从 packages/core/src/theme/ 往上四级到仓库根，再进 packages/。
const PACKAGES_DIR = path.resolve(fileURLToPath(new URL('../../../../packages', import.meta.url)));

/**
 * 列出内置主题。
 * @returns {Promise<{name: string, dir: string, meta: object}[]>}
 */
export async function listBuiltinThemes() {
  return scanThemeDirs(PACKAGES_DIR, (entry) => entry.startsWith('theme-'));
}

/**
 * 列出某项目可见的全部主题：项目内 themes/ + packages/theme-* + 内置。
 * 同名时项目内的优先（与加载器的解析顺序一致）。
 */
export async function listAvailableThemes(cwd = process.cwd()) {
  const project = await scanThemeDirs(path.join(cwd, 'themes'), () => true, { stripPrefix: false });
  const projectPackages = await scanThemeDirs(path.join(cwd, 'packages'), (e) => e.startsWith('theme-'));
  const builtin = await listBuiltinThemes();

  const byName = new Map();
  // 内置先放，项目内后放 —— 后放的覆盖同名的（项目内优先）。
  for (const theme of [...builtin, ...projectPackages, ...project]) byName.set(theme.name, theme);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanThemeDirs(root, accept, { stripPrefix = true } = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!accept(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
    } catch {
      continue; // 缺 theme.json 或 JSON 坏了：不当主题看，交给加载器报错
    }
    const name = typeof meta.name === 'string' && meta.name
      ? meta.name
      : (stripPrefix ? entry.name.replace(/^theme-/, '') : entry.name);
    out.push({ name, dir, meta });
  }
  return out;
}
