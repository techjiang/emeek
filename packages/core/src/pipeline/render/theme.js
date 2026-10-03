import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './liquid.js';
import { validateThemeMeta } from '../../theme/spec.js';
import { resolveThemeConfig, buildThemeVariables, buildFeatureAttributes } from '../../theme/vars.js';
import { normalizeOverrides, mergeOverrides } from '../../theme/override.js';
import { sanitizeCss, sanitizeInjection, buildNoFlashScript } from '../../theme/inject.js';

// 内置主题随 core 一起分发（monorepo 里就是 packages/theme-*）。
// 走「包目录」而不是写死某个主题名，新增内置主题不需要改这里。
const PACKAGES_DIR = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const BUILTIN_DIR = path.join(PACKAGES_DIR, 'theme-minimal');

/** 已知内置主题名。仅供 CLI `theme list` 与文档引用，解析仍以磁盘为准。 */
export const BUILTIN_THEMES = ['minimal', 'aurora', 'inkstone', 'magazine'];

/**
 * 主题解析顺序：显式路径 > 项目内 themes/<name> > packages/theme-<name> > 内置主题。
 * 内置主题随 core 一起分发，因此「什么都不配」也能构建 —— 零配置原则的落点之一。
 */
export async function loadTheme(cwd, config, options = {}) {
  const candidates = [];
  const themeName = config.theme?.name ?? 'minimal';
  const themeConfig = config.theme ?? {};

  if (themeName.startsWith('.') || themeName.startsWith('/')) {
    candidates.push(path.resolve(cwd, themeName));
  }
  candidates.push(path.resolve(cwd, 'themes', themeName));
  candidates.push(path.resolve(cwd, 'packages', `theme-${themeName}`));
  // 内置：monorepo 的 packages/theme-<name>。BUILTIN_DIR 兜底保证
  // 即使 PACKAGES_DIR 推导失败（打包后目录被裁剪）也能找到 minimal。
  candidates.push(path.join(PACKAGES_DIR, `theme-${themeName}`));
  if (themeName === 'minimal') candidates.push(BUILTIN_DIR);

  const themeConfigRuntime = options.runtime ?? {};
  for (const dir of candidates) {
    if (await exists(path.join(dir, 'theme.json'))) return loadThemeDir(dir, { themeConfig, themeConfigRuntime });
  }
  throw new Error(
    `找不到主题「${themeName}」。已尝试：\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
    '请检查 theme.name，或把主题放到项目的 themes/ 目录下。'
  );
}

async function loadThemeDir(dir, { themeConfig, themeConfigRuntime } = {}) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'theme.json'), 'utf8'));

  // 规范校验：内置/用户主题都在这里过一遍。errors 抛错，warnings 交给调用方。
  const { errors, warnings } = validateThemeMeta(meta);
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
  if (errors.length) {
    const message = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`主题「${meta.name}」的 theme.json 不符合规范：\n${message}`);
  }

  // 配置解析：声明默认值 ← 用户覆盖值。这是「同一主题、不同站点长得不一样」的入口。
  //
  // 先过一遍 normalizeOverrides：把拼错/越界/类型不符的键挑出来记成 warning，
  // 而不是让它们静默失效。`themeConfigRuntime`（运行时偏好）若给了，优先级最高。
  const userOverrides = mergeOverrides(themeConfig ?? {}, themeConfigRuntime ?? {});
  const { values: normalized, rejected } = normalizeOverrides(meta, userOverrides);
  for (const item of rejected) {
    warnings.push({ path: `config.${item.key}`, message: item.reason });
  }
  const config = resolveThemeConfig(meta, { ...(themeConfig ?? {}), ...groupByDot(normalized) });
  const variables = buildThemeVariables(meta, config);

  // 布局缺失时回退到入口布局，让主题可以只实现它关心的页面。
  return {
    dir, meta, layouts, partials, styles, scripts,
    assetsDir: path.join(dir, 'assets'), entry,
    warnings,
    config,
    variables,
    featureAttrs: buildFeatureAttributes(config),
    // 预览图路径：meta.preview 是相对主题根目录的路径（如 "preview.png"）。
    // 只取 basename，避免主题用 "../.." 指到主题目录之外。
    preview: meta.preview ? path.join(dir, path.basename(meta.preview)) : null,
  };
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

/** 扁平点号路径的键值表 → 嵌套覆盖对象。 */
function groupByDot(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat ?? {})) {
    const [group, name] = key.split('.');
    if (!name) continue;
    (out[group] ??= {})[name] = value;
  }
  return out;
}

export { BUILTIN_DIR };
