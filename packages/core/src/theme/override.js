/**
 * 自定义配置覆盖链（P3-1b-3b）。
 *
 * 四层，从低到高：
 *   1. 主题 theme.json 的 config 默认值
 *   2. emeeek.config.js 的 theme.colors / typography / layout / features
 *   3. 运行时用户偏好（Studio 面板 / 站点 localStorage）—— 走同一条覆盖链
 *
 * 这个模块只做「把用户覆盖值按主题声明的描述符校验并规范化」这一件事，
 * 生成 CSS 变量仍交给 vars.js —— 覆盖链与变量映射是两个正交的关注点。
 *
 * 安全前提（S2-3b 标准 + Inkstone 教训）：
 *   · 所有值都必须能对上主题声明的描述符（type/min/max/options）
 *   · 颜色只接受 #RRGGBB 等字面量，字体串过字符白名单
 *   · 未知的配置键被丢弃并记录，不让拼写错误静默生效
 *   · customCSS / customHead / customFooter 不进这条链（它们有各自的消毒器）
 */

import { cssColorValue, cssFontValue } from './values.js';

/**
 * 按主题描述符规范化一份覆盖值。
 *
 * @param {object} meta    主题 meta（提供 config 描述符）
 * @param {object} overrides  { colors: {...}, typography: {...}, layout: {...}, features: {...} }
 * @returns {{ values: object, applied: string[], rejected: {key: string, reason: string}[] }}
 *   values   扁平点号路径 → 规范化后的值
 *   applied  实际生效的键（给 UI 回显「改了哪些」）
 *   rejected 被拒的键与原因（拼错、越界、类型不符）—— 不静默
 */
export function normalizeOverrides(meta, overrides = {}) {
  const descriptors = meta?.config ?? {};
  const values = {};
  const applied = [];
  const rejected = [];

  for (const [group, items] of Object.entries(overrides ?? {})) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
    for (const [key, raw] of Object.entries(items)) {
      const desc = descriptors[group]?.[key];
      if (!desc) {
        rejected.push({ key: `${group}.${key}`, reason: `主题「${meta?.name ?? '?'}」没有声明这个配置项` });
        continue;
      }
      const normalized = normalizeOne(desc, raw);
      if (normalized === undefined) {
        rejected.push({ key: `${group}.${key}`, reason: `值「${String(raw)}」不符合 ${desc.type} 类型${numberRange(desc)}` });
        continue;
      }
      values[`${group}.${key}`] = normalized;
      applied.push(`${group}.${key}`);
    }
  }
  return { values, applied, rejected };
}

function numberRange(desc) {
  if (desc.type !== 'number') return '';
  return `（范围 ${desc.min}–${desc.max}）`;
}

/** 单个值按描述符规范化；不能接受时返回 undefined。 */
function normalizeOne(desc, raw) {
  switch (desc.type) {
    case 'color': return cssColorValue(raw) ?? undefined;
    case 'font': return cssFontValue(raw) ?? undefined;
    // 数字保持裸数字：加单位（px 等）是变量生成期的事，覆盖链不该替它决定。
    // 越界时夹紧 —— 与 vars.js 的最终夹紧一致，UI 上「拖到超范围」得到的是边界值。
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) return undefined;
      const min = typeof desc.min === 'number' ? desc.min : -Infinity;
      const max = typeof desc.max === 'number' ? desc.max : Infinity;
      return Math.min(max, Math.max(min, num));
    }
    case 'boolean': return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'select': return desc.options?.includes(raw) ? raw : undefined;
    case 'string': return typeof raw === 'string' ? raw : undefined;
    default: return undefined;
  }
}

/**
 * 合并两份覆盖：`base` 是站点级（emeeek.config.js），`top` 是运行时（localStorage / 面板）。
 * 运行时优先 —— 用户在页面上的即时选择应该盖过配置文件。
 */
const CONFIG_GROUPS = ['colors', 'typography', 'layout', 'features'];

export function mergeOverrides(base = {}, top = {}) {
  const out = {};
  // 只认四个配置分组。theme 对象里还有 name/darkMode/customCSS 等同级键，
  // 不筛掉的话它们会被当成「配置分组」，然后每一个字符都报一条「没声明这个项」。
  for (const group of CONFIG_GROUPS) {
    const merged = { ...(base?.[group] ?? {}), ...(top?.[group] ?? {}) };
    if (Object.keys(merged).length) out[group] = merged;
  }
  return out;
}
