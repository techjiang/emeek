/**
 * 主题配置 → CSS 自定义属性。
 *
 * 设计前提：
 *   一套主题的「可配置性」和「亮/暗两套配色」是两个正交的维度。
 *   配置项是用户改的（字号、主色、是否显示侧栏），亮暗配色是主题作者
 *   为每个模式独立设计的。所以这里只负责生成**当前模式下**的变量覆盖，
 *   而不是把配置硬编码进主题 CSS。
 *
 * 变量命名与 theme-minimal 既有约定保持一致（--primary / --bg / --text…），
 * 并补充语义层变量（--font-heading / --max-width / --radius…）。
 * 主题 CSS 只消费变量、不消费字面量 —— 这是「换主题只换变量」的落点。
 */

/**
 * 颜色配置项 → CSS 变量名。缺省变量名按 `--<key>` 推导。
 * 显式映射只用于修正历史命名（--bg 而不是 --background）。
 */
export const COLOR_VARS = {
  primary: '--primary',
  accent: '--accent',
  background: '--bg',
  surface: '--bg-soft',
  text: '--text',
  muted: '--text-dim',
  border: '--border',
  code: '--bg-code',
};

export const TYPOGRAPHY_VARS = {
  headingFont: '--font-heading',
  bodyFont: '--font-body',
  codeFont: '--font-mono',
  fontSize: '--font-size-base',
  lineHeight: '--line-height-base',
  scale: '--type-scale',
};

export const LAYOUT_VARS = {
  maxWidth: '--max-width',
  wideWidth: '--max-width-wide',
  radius: '--radius',
  space: '--space',
  gap: '--section-gap',
};

/**
 * 把主题 meta 里声明的 config 默认值 + 用户覆盖值，合并成一份
 * 「配置项点号路径 → 值」的表。用户值优先。
 */
export function resolveThemeConfig(meta, userOverrides = {}) {
  const defaults = {};
  for (const [group, items] of Object.entries(meta?.config ?? {})) {
    if (!items || typeof items !== 'object') continue;
    for (const [key, item] of Object.entries(items)) {
      if (item && item.default !== undefined) defaults[`${group}.${key}`] = item.default;
    }
  }

  // 用户覆盖：支持 { colors: { primary } } 嵌套，也支持 legacy 的
  // theme.colors / theme.fonts 顶层写法（S2 之前的配置形状）。
  const flatOverrides = {};
  for (const group of ['colors', 'typography', 'layout', 'features']) {
    const source = userOverrides?.[group];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && value !== null) flatOverrides[`${group}.${key}`] = value;
      }
    }
  }
  // legacy: theme.colors.primary / theme.fonts.sans
  if (userOverrides?.fonts) {
    if (userOverrides.fonts.sans) flatOverrides['typography.bodyFont'] ??= userOverrides.fonts.sans;
    if (userOverrides.fonts.heading) flatOverrides['typography.headingFont'] ??= userOverrides.fonts.heading;
    if (userOverrides.fonts.mono) flatOverrides['typography.codeFont'] ??= userOverrides.fonts.mono;
  }
  if (userOverrides?.tocMaxLevel !== undefined) {
    flatOverrides['layout.tocMaxLevel'] = userOverrides.tocMaxLevel;
  }

  return { ...defaults, ...flatOverrides };
}

/** CSS 值的安全化：颜色与数字是配置里仅有的两类会被写进声明的值。 */
function cssColor(value) {
  const raw = String(value ?? '').trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  if (/^(?:rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(raw)) return raw;
  // 命名色（rebeccapurple 等）：只允许纯字母，杜绝 `red; } evil {` 这类闭合注入。
  if (/^[a-z]+$/i.test(raw)) return raw;
  return null;
}

function cssNumber(value, { min = -Infinity, max = Infinity, unit = '' } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Math.min(max, Math.max(min, num))}${unit}`;
}

/** 字体串：只允许字母数字、空格、逗号、连字符、下划线、点、引号、CJK。 */
function cssFont(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^[\w\s,'".\-\u4e00-\u9fff]+$/.test(raw)) return null;
  return raw;
}

function cssBoolean(value) {
  return value === true || value === 'true' ? '1' : '0';
}

/**
 * 生成 :root 变量块。
 *
 * @param {object} meta        主题 meta（提供 config 描述符中的 min/max/type）
 * @param {object} values      已合并的「点号路径 → 值」
 * @param {object} options
 * @param {string} options.selector  变量作用域，默认 :root
 * @returns {string} CSS 文本（不含 <style> 标签）
 */
export function buildThemeVariables(meta, values, { selector = ':root' } = {}) {
  const items = meta?.config ?? {};
  const declarations = [];

  const push = (name, cssValue) => {
    if (cssValue !== null && cssValue !== undefined) declarations.push(`  ${name}: ${cssValue};`);
  };

  for (const [key, value] of Object.entries(values ?? {})) {
    const [group, name] = key.split('.');
    const desc = items[group]?.[name] ?? {};
    if (group === 'colors') {
      const varName = COLOR_VARS[name] ?? `--${name}`;
      push(varName, cssColor(value));
    } else if (group === 'typography') {
      const varName = TYPOGRAPHY_VARS[name] ?? `--${name}`;
      if (desc.type === 'font' || name.endsWith('Font')) push(varName, cssFont(value));
      // 何时加 px：只有字号、且是主题声明的 fontSize。行高、缩放比等是无单位数，
      // 一律套 px 会得到 `line-height: 1.75px` 这种废值。未知的 number 保持无单位。
      else if (desc.type === 'number' && name === 'fontSize') push(varName, cssNumber(value, { min: desc.min, max: desc.max, unit: 'px' }));
      else if (desc.type === 'number') push(varName, cssNumber(value, { min: desc.min, max: desc.max }));
      else push(varName, cssNumber(value, { min: desc.min, max: desc.max }) ?? cssFont(value));
    } else if (group === 'layout') {
      const varName = LAYOUT_VARS[name] ?? `--${name}`;
      if (desc.type === 'boolean' && name === 'sidebar') push('--show-sidebar', cssBoolean(value));
      else if (desc.type === 'boolean' && name === 'toc') push('--show-toc', cssBoolean(value));
      else if (desc.type === 'boolean' && name === 'footer') push('--show-footer', cssBoolean(value));
      else if (name === 'maxWidth') push('--max-width', cssNumber(value, { min: desc.min, max: desc.max, unit: 'px' }));
      else if (name === 'radius') push('--radius', cssNumber(value, { min: desc.min, max: desc.max, unit: 'px' }));
      else if (name === 'gap') push('--section-gap', cssNumber(value, { min: desc.min, max: desc.max, unit: 'px' }));
    } else if (group === 'features') {
      // 功能开关以 data 属性形式消费（见 data-features 注入），不生成变量。
      continue;
    }
  }

  if (!declarations.length) return '';
  return `${selector} {\n${declarations.join('\n')}\n}`;
}

/**
 * 功能开关 → 一串 `data-feature-*="1"` 属性，挂在 <html> 上。
 * 用属性而不是 class，是为了避免与主题自身的 class 命名撞车。
 */
export function buildFeatureAttributes(values) {
  const attrs = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    const [group, name] = key.split('.');
    if (group !== 'features') continue;
    if (value === true || value === 'true') attrs.push(`data-feature-${name}`);
  }
  return attrs.join(' ');
}
