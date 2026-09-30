import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './liquid.js';

const BUILTIN_DIR = path.resolve(fileURLToPath(new URL('../../../../theme-minimal/', import.meta.url)));

/**
 * 主题解析顺序：显式路径 > 项目内 themes/<name> > packages/theme-<name> > 内置主题。
 * 内置主题随 core 一起分发，因此「什么都不配」也能构建 —— 零配置原则的落点之一。
 */
export async function loadTheme(cwd, config) {
  const candidates = [];
  const themeName = config.theme?.name ?? 'minimal';

  if (themeName.startsWith('.') || themeName.startsWith('/')) {
    candidates.push(path.resolve(cwd, themeName));
  }
  candidates.push(path.resolve(cwd, 'themes', themeName));
  candidates.push(path.resolve(cwd, 'packages', `theme-${themeName}`));
  if (themeName === 'minimal') candidates.push(BUILTIN_DIR);

  for (const dir of candidates) {
    if (await exists(path.join(dir, 'theme.json'))) return loadThemeDir(dir);
  }
  throw new Error(
    `找不到主题「${themeName}」。已尝试：\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
    '请检查 theme.name，或把主题放到项目的 themes/ 目录下。'
  );
}

async function loadThemeDir(dir) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));
  const layouts = new Map();
  const partials = new Map();
  const styles = [];
  const scripts = [];

  for (const file of await listFiles(path.join(dir, 'layouts'))) {
    if (!file.endsWith('.html')) continue;
    const source = await fs.readFile(file, 'utf8');
    layouts.set(path.basename(file, '.html'), { source, compiled: compile(source), file });
  }
  for (const file of await listFiles(path.join(dir, 'partials'))) {
    if (!file.endsWith('.html')) continue;
    const source = await fs.readFile(file, 'utf8');
    partials.set(path.basename(file, '.html'), { source, compiled: compile(source), file });
  }
  for (const file of await listFiles(path.join(dir, 'styles'))) {
    if (file.endsWith('.css')) styles.push({ name: path.basename(file), content: await fs.readFile(file, 'utf8') });
  }
  for (const file of await listFiles(path.join(dir, 'scripts'))) {
    if (file.endsWith('.js')) scripts.push({ name: path.basename(file), content: await fs.readFile(file, 'utf8') });
  }
  const entry = meta.entryLayout ?? 'index';
  if (!layouts.has(entry)) {
    throw new Error(`主题 ${meta.name} 缺少首页布局 layouts/${entry}.html`);
  }
  // 布局缺失时回退到入口布局，让主题可以只实现它关心的页面。
  return { dir, meta, layouts, partials, styles, scripts, assetsDir: path.join(dir, 'assets'), entry };
}

/**
 * 渲染一个布局。
 *
 * 作用域优先级：partial 的局部变量（循环项）> 页面数据。
 * 反过来的话，{% for post in posts %}{% include "card" %} 里的 post
 * 会取到页面级的同名变量，卡片就永远显示同一篇文章。
 */
export function renderLayout(theme, layoutName, data) {
  const layout = theme.layouts.get(layoutName) ?? theme.layouts.get(theme.entry) ?? theme.layouts.get('index');
  if (!layout) throw new Error(`主题 ${theme.meta.name} 里找不到布局 ${layoutName}`);

  return layout.compiled({
    ...data,
    __render: (name, locals) => renderPartialInto(theme, name, data, locals),
  });
}

function renderPartialInto(theme, name, data, locals) {
  const key = String(name).replace(/['"]/g, '').trim();
  const partial = theme.partials.get(key);
  if (!partial) return `<!-- 缺少 partial: ${key} -->`;
  return partial.compiled({
    ...data,
    ...locals,
    __render: (next, deeper) => renderPartialInto(theme, next, data, { ...locals, ...deeper }),
  });
}

async function listFiles(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return acc;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export { BUILTIN_DIR };
