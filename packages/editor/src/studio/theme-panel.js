/**
 * 主题配置面板的纯逻辑（P3-1b-3b feature D）。
 *
 * 拆出来的理由与其它 client 逻辑一致：把「怎么把描述符画成控件」与
 * 「怎么操作 DOM」分开 —— 前者可以在没有浏览器的测试里断言，
 * 后者只有几行赋值。
 *
 * 一条约束贯穿全文：**控件类型完全由主题声明的描述符决定**。
 * 面板不猜、不兜底成「文本框」—— 一个 color 项被画成文本框，
 * 用户输进去的红色字符串最终不会生效，而面板看起来「能用」。
 */

/** localStorage 键：运行时偏好。与站点的 emeeek-theme 分开命名，互不干扰。 */
export const THEME_PREFS_KEY = 'emeeek:theme-prefs';

/** 把描述符摊成一份有序字段清单：分组 → 字段。 */
export function describeFields(config = {}) {
  const order = ['colors', 'typography', 'layout', 'features'];
  const groups = [];
  for (const groupName of order) {
    const items = config[groupName];
    if (!items || typeof items !== 'object') continue;
    const fields = Object.entries(items).map(([key, desc]) => ({
      group: groupName,
      key,
      path: `${groupName}.${key}`,
      type: desc.type,
      label: desc.label ?? key,
      default: desc.default,
      min: desc.min,
      max: desc.max,
      options: desc.options,
    }));
    if (fields.length) groups.push({ group: groupName, fields });
  }
  return groups;
}

/**
 * 把「点号路径 → 值」摊成本面板需要的嵌套覆盖对象。
 * 只保留与默认值不同的项 —— 存进 localStorage 的应该只是「用户改了什么」，
 * 而不是一整份快照（否则主题升级后，旧快照会把新默认值全部盖住）。
 */
export function toOverrides(values = {}, defaults = {}) {
  const out = {};
  for (const [path, value] of Object.entries(values)) {
    if (defaults[path] !== undefined && String(defaults[path]) === String(value)) continue;
    const [group, key] = path.split('.');
    if (!key) continue;
    (out[group] ??= {})[key] = value;
  }
  return out;
}

/** 把描述符 + 值数组化，供 UI 直接 map。 */
export function flattenValues(groups = [], values = {}) {
  const rows = [];
  for (const group of groups) {
    for (const field of group.fields) {
      rows.push({ ...field, value: values[field.path] ?? field.default });
    }
  }
  return rows;
}

/**
 * 生成一个字段的 DOM 描述（不碰 DOM，只是数据）。
 * 返回 { tag, attrs } —— UI 层照此创建元素。
 */
export function fieldControl(field) {
  const base = { 'data-path': field.path, 'data-type': field.type };
  switch (field.type) {
    case 'color':
      return { tag: 'input', attrs: { ...base, type: 'color', value: normalizeColor(field.value) } };
    case 'number':
      return { tag: 'input', attrs: { ...base, type: 'range', min: field.min, max: field.max, step: stepFor(field), value: field.value } };
    case 'boolean':
      return { tag: 'input', attrs: { ...base, type: 'checkbox', checked: Boolean(field.value) } };
    case 'select':
      return { tag: 'select', attrs: base, options: field.options ?? [], value: field.value };
    case 'font':
    case 'string':
      return { tag: 'input', attrs: { ...base, type: 'text', value: String(field.value ?? '') } };
    default:
      // 未知类型：不兜底成可编辑控件（那会给出「能改」的错误承诺），
      // 渲染成只读行，由 UI 层显示为纯文本。
      return { tag: 'span', attrs: { ...base, readonly: true, value: String(field.value ?? '') } };
  }
}

/** 数字项的步长：字号用 0.5，行高用 0.05，其余用 1。 */
export function stepFor(field) {
  if (field.key === 'lineHeight') return 0.05;
  if (field.key === 'fontSize') return 0.5;
  return 1;
}

/** #RGB → #RRGGBB（input[type=color] 只认后者的规范形式）。 */
export function normalizeColor(value) {
  const raw = String(value ?? '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  // 非十六进制（命名色 / rgb()）无法喂给 color input，退到黑色并保留原值由 UI 提示
  return '#000000';
}

/**
 * 把本地存储的偏好读出来。损坏/被清掉都退到空对象 ——
 * 面板记不住偏好是小事，打不开面板是大事。
 */
export function readPrefs(storage) {
  try {
    const raw = storage?.getItem?.(THEME_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writePrefs(storage, overrides) {
  try {
    if (!overrides || !Object.keys(overrides).length) storage?.removeItem?.(THEME_PREFS_KEY);
    else storage?.setItem?.(THEME_PREFS_KEY, JSON.stringify(overrides));
  } catch { /* 隐私模式下写不了，不影响本次会话 */ }
}
