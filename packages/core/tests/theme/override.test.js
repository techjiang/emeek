import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOverrides, mergeOverrides } from '../../src/theme/override.js';

/**
 * 自定义配置覆盖链（P3-1b-3b）。
 *
 * 覆盖链的价值在于「用户改的值真的生效」，而它的风险在于「改错了却不说」。
 * 所以这里两类断言各占一半：合法值被规范化接受，非法值被**明确拒绝**（不是静默丢弃）。
 */

const META = {
  name: 'demo',
  config: {
    colors: {
      primary: { type: 'color', default: '#111111' },
      accent: { type: 'color', default: '#2563eb' },
    },
    typography: {
      fontSize: { type: 'number', default: 16, min: 12, max: 24 },
      headingFont: { type: 'font', default: 'Inter' },
    },
    layout: {
      sidebar: { type: 'boolean', default: true },
      maxWidth: { type: 'number', default: 736, min: 600, max: 1200 },
    },
    features: {
      darkMode: { type: 'select', options: ['auto', 'light', 'dark', 'toggle'], default: 'auto' },
    },
  },
};

test('合法覆盖被接受并规范化', () => {
  const { values, applied, rejected } = normalizeOverrides(META, {
    colors: { primary: '#ff0000' },
    typography: { fontSize: 20 },
    layout: { sidebar: false, maxWidth: 800 },
    features: { darkMode: 'toggle' },
  });
  assert.deepEqual(rejected, []);
  assert.equal(values['colors.primary'], '#ff0000');
  assert.equal(values['typography.fontSize'], 20);
  assert.equal(values['layout.sidebar'], false);
  assert.equal(values['features.darkMode'], 'toggle');
  assert.deepEqual(applied.sort(), ['colors.primary', 'features.darkMode', 'layout.maxWidth', 'layout.sidebar', 'typography.fontSize']);
});

test('数字越界被夹紧到边界（不拒绝，但也不放行）', () => {
  const { values } = normalizeOverrides(META, { typography: { fontSize: 999 } });
  assert.equal(values['typography.fontSize'], 24, '超过 max 应夹到 max');
  const low = normalizeOverrides(META, { typography: { fontSize: 2 } });
  assert.equal(low.values['typography.fontSize'], 12, '低于 min 应夹到 min');
});

test('拼错的配置键被拒绝并说明原因（不静默）', () => {
  const { rejected, values } = normalizeOverrides(META, { colors: { primry: '#fff' } });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /没有声明这个配置项/);
  assert.equal(values['colors.primry'], undefined);
});

test('非法颜色被拒绝（闭合注入/命名色边界）', () => {
  for (const bad of ['red; } html { color: #000', 'url(x)', '#12345', 'javascript:alert(1)']) {
    const { rejected } = normalizeOverrides(META, { colors: { primary: bad } });
    assert.equal(rejected.length, 1, `应拒绝颜色「${bad}」`);
  }
  for (const ok of ['#abc', '#AABBCC', '#aabbccdd', 'rebeccapurple', 'rgb(1, 2, 3)']) {
    const { rejected } = normalizeOverrides(META, { colors: { primary: ok } });
    assert.equal(rejected.length, 0, `应接受颜色「${ok}」`);
  }
});

test('enum 只接受 options 内的值', () => {
  assert.equal(normalizeOverrides(META, { features: { darkMode: 'bogus' } }).rejected.length, 1);
  assert.equal(normalizeOverrides(META, { features: { darkMode: 'dark' } }).values['features.darkMode'], 'dark');
});

test('字体串过滤危险字符', () => {
  assert.equal(normalizeOverrides(META, { typography: { headingFont: 'Inter; } body { display:none' } }).rejected.length, 1);
  assert.equal(normalizeOverrides(META, { typography: { headingFont: 'Noto Serif SC, serif' } }).values['typography.headingFont'], 'Noto Serif SC, serif');
});

test('mergeOverrides 只合并四个配置分组，跳过 name/darkMode 等同级键', () => {
  const merged = mergeOverrides(
    { name: 'aurora', darkMode: 'auto', colors: { primary: '#111111' }, customCSS: 'x' },
    { colors: { accent: '#222222' }, layout: { sidebar: false } },
  );
  assert.deepEqual(Object.keys(merged).sort(), ['colors', 'layout']);
  assert.equal(merged.colors.primary, '#111111');
  assert.equal(merged.colors.accent, '#222222');
  assert.equal(merged.layout.sidebar, false);
});

test('运行时覆盖优先于站点级覆盖', () => {
  const merged = mergeOverrides({ colors: { primary: '#111111' } }, { colors: { primary: '#ff0000' } });
  assert.equal(merged.colors.primary, '#ff0000');
});

test('buildThemeVariables 消费覆盖链的结果：颜色/字号写入 CSS 变量', async () => {
  const { buildThemeVariables } = await import('../../src/theme/vars.js');
  const { values } = normalizeOverrides(META, { colors: { primary: '#00ff00' }, typography: { fontSize: 18 } });
  const flat = {};
  for (const [key, value] of Object.entries(values)) {
    const [group, name] = key.split('.');
    flat[`${group}.${name}`] = value;
  }
  const css = buildThemeVariables(META, flat);
  assert.match(css, /--primary: #00ff00;/);
  assert.match(css, /--font-size-base: 18px;/);
});
