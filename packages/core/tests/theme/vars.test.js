import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThemeConfig, buildThemeVariables, buildFeatureAttributes, COLOR_VARS } from '../../src/theme/vars.js';

const META = {
  config: {
    colors: {
      primary: { type: 'color', default: '#6366f1', label: '主色' },
      accent: { type: 'color', default: '#8b5cf6' },
      background: { type: 'color', default: '#0f0f23' },
    },
    typography: {
      fontSize: { type: 'number', default: 16, min: 12, max: 24 },
      lineHeight: { type: 'number', default: 1.75, min: 1.2, max: 2.2 },
      bodyFont: { type: 'font', default: 'Noto Sans SC' },
    },
    layout: {
      maxWidth: { type: 'number', default: 800, min: 600, max: 1200 },
      sidebar: { type: 'boolean', default: true },
      toc: { type: 'boolean', default: true },
    },
    features: {
      darkMode: { type: 'select', options: ['auto', 'light', 'dark', 'toggle'], default: 'auto' },
      math: { type: 'boolean', default: true },
    },
  },
};

test('未覆盖时全部取主题默认值', () => {
  const v = resolveThemeConfig(META, {});
  assert.equal(v['colors.primary'], '#6366f1');
  assert.equal(v['typography.fontSize'], 16);
  assert.equal(v['layout.maxWidth'], 800);
});

test('用户覆盖优先于主题默认', () => {
  const v = resolveThemeConfig(META, { colors: { primary: '#ff6b6b' }, typography: { fontSize: 18 } });
  assert.equal(v['colors.primary'], '#ff6b6b');
  assert.equal(v['typography.fontSize'], 18);
  assert.equal(v['colors.accent'], '#8b5cf6', '未覆盖的项保持默认');
});

test('legacy 的 theme.fonts / theme.colors 形状仍被接受（S2 兼容）', () => {
  const v = resolveThemeConfig(META, { colors: { primary: '#abc' }, fonts: { sans: 'Inter', mono: 'Fira Code' } });
  assert.equal(v['typography.bodyFont'], 'Inter');
  assert.equal(v['typography.codeFont'], 'Fira Code');
});

test('生成变量块并映射到约定的变量名', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, {}));
  assert.match(css, /--primary: #6366f1;/);
  assert.match(css, /--bg: #0f0f23;/, 'background 映射到 --bg');
  assert.match(css, /--font-size-base: 16px;/);
  assert.match(css, /--max-width: 800px;/);
  assert.match(css, /^:root \{/);
});

test('number 超范围被夹到 min/max', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, { typography: { fontSize: 999 } }));
  assert.match(css, /--font-size-base: 24px;/);
  const css2 = buildThemeVariables(META, resolveThemeConfig(META, { layout: { maxWidth: 1 } }));
  assert.match(css2, /--max-width: 600px;/);
});

test('非法颜色被丢弃，不写进 CSS', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, { colors: { primary: 'red; } body{display:none' } }));
  assert.doesNotMatch(css, /primary/);
});

test('命名色与 rgb()/hsl() 允许通过', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, { colors: { primary: 'rebeccapurple', accent: 'rgb(1 2 3)' } }));
  assert.match(css, /--primary: rebeccapurple;/);
  assert.match(css, /--accent: rgb\(1 2 3\);/);
});

test('布尔开关映射为 0/1 变量', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, { layout: { sidebar: false } }));
  assert.match(css, /--show-sidebar: 0;/);
});

test('feature 属性生成', () => {
  const attrs = buildFeatureAttributes({ 'features.math': true, 'features.mermaid': true, 'features.share': false });
  assert.match(attrs, /data-feature-math/);
  assert.match(attrs, /data-feature-mermaid/);
  assert.doesNotMatch(attrs, /data-feature-share/);
});

test('COLOR_VARS 覆盖规范里的五个核心色', () => {
  for (const key of ['primary', 'accent', 'background', 'text', 'muted']) {
    assert.ok(COLOR_VARS[key], `${key} 应有变量映射`);
  }
});

test('空配置不生成空块', () => {
  assert.equal(buildThemeVariables({ config: {} }, {}), '');
});

// ── 补充分支 ──
test('legacy headingFont 与 tocMaxLevel 覆盖被接受', () => {
  const v = resolveThemeConfig(META, { fonts: { heading: 'Playfair Display' }, tocMaxLevel: 4 });
  assert.equal(v['typography.headingFont'], 'Playfair Display');
  assert.equal(v['layout.tocMaxLevel'], 4);
});

test('lineHeight 映射为无单位数值', () => {
  const css = buildThemeVariables(META, resolveThemeConfig(META, { typography: { lineHeight: 1.9 } }));
  assert.match(css, /--line-height-base: 1\.9;/);
});

test('未声明 type 的 typography 项按数字/字体兜底', () => {
  const meta = { config: { typography: { mystery: { default: 'Inter' }, weight: { default: 400 } } } };
  const css = buildThemeVariables(meta, resolveThemeConfig(meta, {}));
  assert.match(css, /--weight: 400;/);
  assert.match(css, /--mystery: Inter;/);
});

test('layout 的 footer 开关映射为 --show-footer', () => {
  const meta = { config: { layout: { footer: { type: 'boolean', default: false } } } };
  const css = buildThemeVariables(meta, resolveThemeConfig(meta, {}));
  assert.match(css, /--show-footer: 0;/);
});

test('layout 的 radius / gap 映射', () => {
  const meta = { config: { layout: { radius: { type: 'number', default: 14, min: 0, max: 40 }, gap: { type: 'number', default: 32, min: 0, max: 80 } } } };
  const css = buildThemeVariables(meta, resolveThemeConfig(meta, {}));
  assert.match(css, /--radius: 14px;/);
  assert.match(css, /--section-gap: 32px;/);
});

test('未识别的 typography 数值超范围被夹紧', () => {
  const meta = { config: { typography: { scale: { type: 'number', default: 1, min: 1, max: 2 } } } };
  const css = buildThemeVariables(meta, resolveThemeConfig(meta, { typography: { scale: 9 } }));
  assert.match(css, /--type-scale: 2;/);
});
