import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFields, flattenValues, fieldControl, toOverrides, stepFor, normalizeColor,
  readPrefs, writePrefs, THEME_PREFS_KEY,
} from '../src/studio/theme-panel.js';

/**
 * 主题配置面板的纯逻辑（P3-1b-3b feature D）。
 *
 * 核心立场：控件类型完全由主题描述符决定，不兜底成文本框 ——
 * 一个 color 项被画成文本框，用户输进去的字符串最终不生效，而面板「看起来能用」。
 */

const META_CONFIG = {
  colors: { primary: { type: 'color', default: '#111111', label: '标题色' } },
  typography: {
    fontSize: { type: 'number', default: 16, min: 12, max: 24, label: '字号' },
    lineHeight: { type: 'number', default: 1.8, min: 1.2, max: 2.2, label: '行高' },
  },
  layout: { sidebar: { type: 'boolean', default: true, label: '侧栏' } },
  features: { darkMode: { type: 'select', options: ['auto', 'light'], default: 'auto', label: '明暗' } },
};

test('describeFields 按固定分组顺序摊平，跳过空分组', () => {
  const groups = describeFields(META_CONFIG);
  assert.deepEqual(groups.map((g) => g.group), ['colors', 'typography', 'layout', 'features']);
  assert.equal(groups[0].fields[0].path, 'colors.primary');
});

test('fieldControl 对每种描述符给出正确的控件类型', () => {
  const fields = flattenValues(describeFields(META_CONFIG), {});
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(fieldControl(byPath['colors.primary']).attrs.type, 'color');
  assert.equal(fieldControl(byPath['typography.fontSize']).attrs.type, 'range');
  assert.equal(fieldControl(byPath['layout.sidebar']).attrs.type, 'checkbox');
  assert.equal(fieldControl(byPath['features.darkMode']).tag, 'select');
});

test('未知描述符类型不兜底成可编辑控件', () => {
  const control = fieldControl({ path: 'x.y', type: 'mystery', value: 'v', label: 'x' });
  assert.equal(control.tag, 'span');
  assert.equal(control.attrs.readonly, true);
});

test('stepFor：字号 0.5、行高 0.05、其余 1', () => {
  assert.equal(stepFor({ key: 'fontSize' }), 0.5);
  assert.equal(stepFor({ key: 'lineHeight' }), 0.05);
  assert.equal(stepFor({ key: 'maxWidth' }), 1);
});

test('normalizeColor 把 #RGB 展开为 #RRGGBB（input[type=color] 的规范形式）', () => {
  assert.equal(normalizeColor('#abc'), '#aabbcc');
  assert.equal(normalizeColor('#AABBCC'), '#aabbcc');
  assert.equal(normalizeColor('rebeccapurple'), '#000000', '非十六进制退到黑色');
});

test('toOverrides 只保留与默认值不同的项', () => {
  const overrides = toOverrides(
    { 'colors.primary': '#ff0000', 'typography.fontSize': 16, 'layout.sidebar': false },
    { 'colors.primary': '#111111', 'typography.fontSize': 16, 'layout.sidebar': true },
  );
  assert.deepEqual(overrides, { colors: { primary: '#ff0000' }, layout: { sidebar: false } });
});

test('readPrefs / writePrefs 往返；损坏数据退到空对象', () => {
  const store = memoryStorage();
  assert.deepEqual(readPrefs(store), {});
  writePrefs(store, { colors: { primary: '#ff0000' } });
  assert.deepEqual(readPrefs(store), { colors: { primary: '#ff0000' } });
  writePrefs(store, {});
  assert.deepEqual(readPrefs(store), {});
  store.setItem(THEME_PREFS_KEY, '{ broken json');
  assert.deepEqual(readPrefs(store), {});
});

test('writePrefs 在存储抛错时不抛出（隐私模式）', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => writePrefs(throwing, { colors: { primary: '#fff' } }));
  assert.deepEqual(readPrefs(throwing), {});
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
