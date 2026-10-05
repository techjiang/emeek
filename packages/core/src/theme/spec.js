/**
 * Theme Spec —— 主题规范的单一事实来源。
 *
 * 为什么把「规范」写成代码而不是一份 JSON Schema 文档：
 *   · 文档会漂移，代码不会 —— 校验器与规范在同一处，改一处两处都变
 *   · theme.json 里 config 段的价值在于「声明可配置项」，而可配置项的
 *     类型/范围/默认值必须能被程序读到，否则自定义配置面板只能靠手抄
 *
 * 三个层次，缺一不可：
 *   config         —— 用户可以改什么（颜色/字体/布局/功能开关）
 *   layouts        —— 这套主题实现了哪些页面（缺的页面回退到入口布局）
 *   features       —— 主题声明的能力（暗色模式/语法高亮/数学/图表）
 *
 * 安全前提（维持 Phase 1 / S2-3b 决定）：
 *   主题是「数据 + 模板」，不是可执行代码。这里的字段全是字面量，
 *   没有任何一项能表示「执行一段代码」。customCSS/customHead/customFooter
 *   的注入位置由加载器固定，主题无法自己指定注入点。
 */

/** 一个主题必须实现的布局。缺其它页面时回退到 entryLayout，这几个不行。 */
export const REQUIRED_LAYOUTS = ['index'];

/** 内置主题共享的布局名清单 —— 新主题应该覆盖的「全集」参考。 */
export const STANDARD_LAYOUTS = [
  // `tag` 是「单个标签页」，`tags` 是「标签总览页」—— 两者在管线里是不同页面。
  // `stats` 是统计页（P3-4b-rest B）。它是**引擎 strict 要求**的布局：
  // 主题没提供时构建直接抛错，而不是回退到首页 —— 一个长得像首页、
  // 只是没有统计数据的页面，比报错难查得多。启用了才要求，见 pipeline。
  'index', 'post', 'page', 'archive', 'tag', 'tags', 'category', 'search', 'about', '404', 'stats',
];

/** 主题可声明的能力。未知能力不算错（前向兼容），但会被记录。 */
export const KNOWN_FEATURES = [
  'dark-mode', 'light-mode', 'syntax-highlight', 'math', 'mermaid',
  'toc', 'search', 'search-index', 'reading-progress', 'related-posts',
  'share-buttons', 'sidebar', 'pinned-posts', 'backlinks',
];

/** config 段里允许出现的分组。其它分组会被忽略并告警（防拼写错误静默失效）。 */
export const CONFIG_GROUPS = ['colors', 'typography', 'layout', 'features'];

/**
 * 单个配置项的描述符校验：
 *   type    color | font | number | boolean | select | string
 *   default 必须存在（零配置原则：没有默认值的项等于没有这一项）
 *   number 必须有 min/max（否则自定义面板画不出合理的滑块）
 *   select 必须有非空 options 且 default 在 options 里
 */
export function validateConfigItem(path, item, errors) {
  const where = `config.${path}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    errors.push({ path: where, message: '配置项必须是一个描述对象' });
    return;
  }
  const TYPES = ['color', 'font', 'number', 'boolean', 'select', 'string'];
  if (!TYPES.includes(item.type)) {
    errors.push({ path: where, message: `未知的 type「${item.type}」，只能是 ${TYPES.join(' / ')}` });
    return;
  }
  if (item.default === undefined) {
    errors.push({ path: where, message: '缺少 default —— 零配置原则下每个配置项都必须有默认值' });
    return;
  }
  if (item.type === 'number') {
    if (typeof item.default !== 'number') errors.push({ path: where, message: 'default 必须是数字' });
    if (typeof item.min !== 'number' || typeof item.max !== 'number') {
      errors.push({ path: where, message: 'number 类型必须同时声明 min 与 max' });
    } else if (item.min > item.max) {
      errors.push({ path: where, message: 'min 不能大于 max' });
    }
  }
  if (item.type === 'boolean' && typeof item.default !== 'boolean') {
    errors.push({ path: where, message: 'default 必须是布尔值' });
  }
  if (item.type === 'select') {
    if (!Array.isArray(item.options) || !item.options.length) {
      errors.push({ path: where, message: 'select 类型必须声明非空 options' });
    } else if (!item.options.includes(item.default)) {
      errors.push({ path: where, message: `default「${item.default}」不在 options 里` });
    }
  }
  if ((item.type === 'font' || item.type === 'string' || item.type === 'color') && typeof item.default !== 'string') {
    errors.push({ path: where, message: `default 必须是字符串（${item.type}）` });
  }
  if (item.type === 'color' && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(item.default))) {
    errors.push({ path: where, message: `default 必须是 #RGB / #RRGGBB / #RRGGBBAA 形式的颜色，实际为「${item.default}」` });
  }
}

/**
 * 校验一份 theme.json。返回 { errors, warnings }，不抛错 ——
 * 调用方决定「是拒绝加载还是只告警」，因为用户自己写的主题容错度该高一些，
 * 而内置主题应当零告警。
 */
export function validateThemeMeta(meta) {
  const errors = [];
  const warnings = [];

  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { errors: [{ path: '', message: 'theme.json 必须是一个对象' }], warnings };
  }
  if (!meta.name || typeof meta.name !== 'string') {
    errors.push({ path: 'name', message: '缺少主题名 name' });
  }
  if (meta.version && !/^\d+\.\d+\.\d+$/.test(meta.version)) {
    warnings.push({ path: 'version', message: '版本号建议用 semver（x.y.z）' });
  }
  if (meta.compatible && !/^[<>=^~]*\s*\d+\.\d+\.\d+/.test(String(meta.compatible))) {
    warnings.push({ path: 'compatible', message: 'compatible 建议写成 semver 范围，如 ">=1.0.0"' });
  }

  // layouts 是「声明」。真正的落地检查由加载器做（layouts/<entry>.html 必须存在），
  // 所以这里只在声明了 layouts 时校验其内容，未声明不算错。
  if (meta.layouts !== undefined) {
    if (!Array.isArray(meta.layouts)) {
      errors.push({ path: 'layouts', message: 'layouts 必须是数组' });
    } else {
      for (const required of REQUIRED_LAYOUTS) {
        if (!meta.layouts.includes(required)) {
          errors.push({ path: 'layouts', message: `声明了 layouts 就必须包含 ${required}` });
        }
      }
      for (const name of meta.layouts) {
        if (!STANDARD_LAYOUTS.includes(name)) {
          warnings.push({ path: 'layouts', message: `「${name}」不在标准布局清单里（不阻塞，但工具链可能不认识它）` });
        }
      }
    }
  }

  if (meta.features !== undefined) {
    if (!Array.isArray(meta.features)) errors.push({ path: 'features', message: 'features 必须是数组' });
    else for (const feature of meta.features) {
      if (!KNOWN_FEATURES.includes(feature)) warnings.push({ path: 'features', message: `未知能力「${feature}」` });
    }
  }

  if (meta.config !== undefined) {
    if (!meta.config || typeof meta.config !== 'object' || Array.isArray(meta.config)) {
      errors.push({ path: 'config', message: 'config 必须是对象' });
    } else {
      for (const [group, items] of Object.entries(meta.config)) {
        if (!CONFIG_GROUPS.includes(group)) {
          warnings.push({ path: `config.${group}`, message: `未知配置分组「${group}」—— 是拼写错误吗？` });
          continue;
        }
        if (!items || typeof items !== 'object' || Array.isArray(items)) {
          errors.push({ path: `config.${group}`, message: '配置分组必须是对象' });
          continue;
        }
        for (const [key, item] of Object.entries(items)) {
          validateConfigItem(`${group}.${key}`, item, errors);
        }
      }
    }
  }
  return { errors, warnings };
}

/**
 * 把主题声明的 config 默认值摊平成「扁平点号路径 → 值」。
 * 加载器用它把主题默认值喂给 CSS 变量生成器，无需再遍历一次。
 */
export function flattenThemeDefaults(meta) {
  const out = {};
  for (const [group, items] of Object.entries(meta?.config ?? {})) {
    if (!items || typeof items !== 'object') continue;
    for (const [key, item] of Object.entries(items)) {
      if (item && item.default !== undefined) out[`${group}.${key}`] = item.default;
    }
  }
  return out;
}
