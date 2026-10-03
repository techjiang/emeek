import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateThemeMeta, flattenThemeDefaults, STANDARD_LAYOUTS } from '../../src/theme/spec.js';

const goodItem = { type: 'color', default: '#6366f1', label: '主色' };

test('合法 theme.json 无错无警', () => {
  const { errors, warnings } = validateThemeMeta({
    name: 'aurora', version: '1.0.0', layouts: [...STANDARD_LAYOUTS],
    config: { colors: { primary: goodItem } },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('缺少 name 报错', () => {
  const { errors } = validateThemeMeta({ layouts: ['index'] });
  assert.ok(errors.some((e) => e.path === 'name'));
});

test('非对象直接拒绝', () => {
  assert.equal(validateThemeMeta(null).errors.length, 1);
  assert.equal(validateThemeMeta([]).errors.length, 1);
});

test('声明 layouts 却不含 index 报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', layouts: ['post'] });
  assert.ok(errors.some((e) => /必须包含 index/.test(e.message)));
});

test('未声明 layouts 不算错（落地检查交给加载器）', () => {
  assert.deepEqual(validateThemeMeta({ name: 'x' }).errors, []);
});

test('非标准布局只告警不报错', () => {
  const { errors, warnings } = validateThemeMeta({ name: 'x', layouts: ['index', 'sitemap'] });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /sitemap/.test(w.message)));
});

test('未知 feature 只告警', () => {
  const { errors, warnings } = validateThemeMeta({ name: 'x', features: ['dark-mode', 'teleport'] });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /teleport/.test(w.message)));
});

test('未知配置分组告警 —— 拼写错误不该静默失效', () => {
  const { warnings } = validateThemeMeta({ name: 'x', config: { colour: { primary: goodItem } } });
  assert.ok(warnings.some((w) => /colour/.test(w.message)));
});

test('配置项缺 default 报错 —— 零配置原则', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { colors: { primary: { type: 'color' } } } });
  assert.ok(errors.some((e) => /default/.test(e.message)));
});

test('number 类型缺 min/max 报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { typography: { fontSize: { type: 'number', default: 16 } } } });
  assert.ok(errors.some((e) => /min 与 max/.test(e.message)));
});

test('select 的 default 必须在 options 里', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { features: { darkMode: { type: 'select', options: ['auto', 'light'], default: 'dark' } } } });
  assert.ok(errors.some((e) => /不在 options/.test(e.message)));
});

test('color default 必须像颜色', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { colors: { primary: { type: 'color', default: 'red;}' } } } });
  assert.ok(errors.some((e) => /#RGB/.test(e.message)));
});

test('未知 type 报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { colors: { primary: { type: 'gradient', default: 'x' } } } });
  assert.ok(errors.some((e) => /type/.test(e.message)));
});

test('boolean default 必须布尔', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { layout: { sidebar: { type: 'boolean', default: 'yes' } } } });
  assert.ok(errors.some((e) => /布尔/.test(e.message)));
});

test('flattenThemeDefaults 摊平点号路径', () => {
  const flat = flattenThemeDefaults({ config: { colors: { primary: { default: '#111' } }, layout: { maxWidth: { default: 800 } } } });
  assert.deepEqual(flat, { 'colors.primary': '#111', 'layout.maxWidth': 800 });
});

// ── 补充分支：非对象描述符、边界范围、select 空 options、版本告警 ──
test('配置项不是对象时报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { colors: { primary: 'not-an-object' } } });
  assert.ok(errors.some((e) => /描述对象/.test(e.message)));
});

test('number 的 min 大于 max 报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { typography: { fontSize: { type: 'number', default: 16, min: 30, max: 10 } } } });
  assert.ok(errors.some((e) => /min 不能大于 max/.test(e.message)));
});

test('number 的 default 不是数字报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { typography: { fontSize: { type: 'number', default: '16', min: 1, max: 2 } } } });
  assert.ok(errors.some((e) => /default 必须是数字/.test(e.message)));
});

test('select 缺少 options 报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { features: { darkMode: { type: 'select', default: 'auto', options: [] } } } });
  assert.ok(errors.some((e) => /非空 options/.test(e.message)));
});

test('font 的 default 不是字符串报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { typography: { bodyFont: { type: 'font', default: 42 } } } });
  assert.ok(errors.some((e) => /必须是字符串/.test(e.message)));
});

test('版本号非 semver 只告警', () => {
  const { errors, warnings } = validateThemeMeta({ name: 'x', version: 'v1' });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.path === 'version'));
});

test('compatible 非范围只告警', () => {
  const { warnings } = validateThemeMeta({ name: 'x', compatible: 'latest' });
  assert.ok(warnings.some((w) => w.path === 'compatible'));
});

test('config 不是对象报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: [] });
  assert.ok(errors.some((e) => e.path === 'config'));
});

test('配置分组不是对象报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', config: { colors: 'nope' } });
  assert.ok(errors.some((e) => /配置分组必须是对象/.test(e.message)));
});

test('features 不是数组报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', features: 'dark' });
  assert.ok(errors.some((e) => e.path === 'features'));
});

test('layouts 不是数组报错', () => {
  const { errors } = validateThemeMeta({ name: 'x', layouts: 'index' });
  assert.ok(errors.some((e) => /必须数组|必须是数组/.test(e.message)));
});

test('flattenThemeDefaults 忽略非对象分组', () => {
  const flat = flattenThemeDefaults({ config: { colors: 'bad', layout: { maxWidth: { default: 800 } } } });
  assert.deepEqual(flat, { 'layout.maxWidth': 800 });
});
