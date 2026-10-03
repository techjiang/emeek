/**
 * 配置值的规范化 —— 变量生成器与覆盖链共用的一份实现。
 *
 * 为什么单独拎出来：vars.js（构建期生成 CSS 变量）与 override.js（运行时
 * 校验用户覆盖）必须对「什么是一个合法颜色/字体/数字」有一致的判断。
 * 两处各写一份，迟早会在某个边界值上分叉，然后表现为「配置面板能改、
 * 但构建时被拒」——最难查的那种不一致。
 *
 * 返回 null 表示「不接受」。调用方按语境决定是报错还是丢弃。
 */

/** 颜色：只接受十六进制、rgb(a)/hsl(a) 与纯字母命名色。 */
export function cssColorValue(value) {
  const raw = String(value ?? '').trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  if (/^(?:rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(raw)) return raw;
  // 命名色：只允许纯字母，杜绝 `red; } evil {` 这类闭合注入。
  if (/^[a-z]+$/i.test(raw)) return raw;
  return null;
}

/** 数字：有限数，按 min/max 夹紧，可带单位。 */
export function cssNumberValue(value, { min = -Infinity, max = Infinity, unit = '' } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Math.min(max, Math.max(min, num))}${unit}`;
}

/** 字体串：字母数字、空格、逗号、连字符、下划线、点、引号、CJK。 */
export function cssFontValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^[\w\s,'".\-\u4e00-\u9fff]+$/.test(raw)) return null;
  return raw;
}

/** 布尔 → '1'/'0'。 */
export function cssBooleanValue(value) {
  return value === true || value === 'true' ? '1' : '0';
}
