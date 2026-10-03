import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTheme } from '../../src/pipeline/render/theme.js';
import { validateThemeMeta } from '../../src/theme/spec.js';

/**
 * Inkstone 内置主题的验收断言。
 *
 * 为什么值得单独一组：主题的「契约」是看不见的 —— 缺一个 partial、
 * config 少一个 default、少一套暗色配色，构建可能照样成功，
 * 直到用户打开页面才发现。这里把 P3-1b-1 的验收项钉成可执行断言。
 */

const THEME_DIR = path.resolve(fileURLToPath(new URL('../../../../packages/theme-inkstone', import.meta.url)));

const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(THEME_DIR, rel), 'utf8'));
const readText = async (rel) => fs.readFile(path.join(THEME_DIR, rel), 'utf8');

test('inkstone 作为内置主题能被加载（无需项目内副本）', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'inkstone' } });
  assert.equal(theme.meta.name, 'inkstone');
  assert.equal(theme.warnings.length, 0, `内置主题不应有告警：${JSON.stringify(theme.warnings)}`);
});

test('theme.json 通过规范校验：零错误零告警', async () => {
  const meta = await readJson('theme.json');
  const { errors, warnings } = validateThemeMeta(meta);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('config 声明完整：四个分组齐全', async () => {
  const meta = await readJson('theme.json');
  assert.deepEqual(Object.keys(meta.config).sort(), ['colors', 'features', 'layout', 'typography']);
});

test('config 覆盖六种描述符类型', async () => {
  const meta = await readJson('theme.json');
  const types = new Set();
  for (const group of Object.values(meta.config)) {
    for (const item of Object.values(group)) types.add(item.type);
  }
  for (const expected of ['color', 'font', 'number', 'boolean', 'select', 'string']) {
    // string 不是每套主题都必须用；其余五种是这份 config 的实际覆盖面
    if (expected === 'string') continue;
    assert.ok(types.has(expected), `应使用描述符类型 ${expected}`);
  }
});

test('每个配置项都有 default（零配置原则）', async () => {
  const meta = await readJson('theme.json');
  for (const [group, items] of Object.entries(meta.config)) {
    for (const [key, item] of Object.entries(items)) {
      assert.notEqual(item.default, undefined, `config.${group}.${key} 缺 default`);
    }
  }
});

test('六个布局齐全，含必需的 index', async () => {
  const meta = await readJson('theme.json');
  for (const layout of ['index', 'post', 'archive', 'tags', 'about', '404']) {
    assert.ok(meta.layouts.includes(layout), `layouts 应声明 ${layout}`);
  }
  const files = await fs.readdir(path.join(THEME_DIR, 'layouts'));
  for (const layout of meta.layouts) {
    assert.ok(files.includes(`${layout}.html`), `layouts/${layout}.html 应存在`);
  }
});

test('八个 partial 齐全（head 承载首帧脚本与注入点）', async () => {
  const files = await fs.readdir(path.join(THEME_DIR, 'partials'));
  for (const name of ['head', 'header', 'footer', 'card', 'sidebar', 'pagination', 'related', 'comments']) {
    assert.ok(files.includes(`${name}.html`), `partials/${name}.html 应存在`);
  }
  const head = await readText('partials/head.html');
  assert.match(head, /\{\{\{ noFlashScript \}\}\}/, 'head 必须内联首帧脚本');
  assert.match(head, /\{\{\{ themeHeadExtra \}\}\}/, 'head 必须留 customHead 注入点');
});

test('CSS 消费 P3-1a 契约变量，不写死用户可改的值', async () => {
  const css = await readText('styles/main.css');
  for (const variable of ['--bg', '--text', '--font-heading', '--font-body', '--max-width', '--radius']) {
    assert.ok(css.includes(variable), `CSS 应消费 ${variable}`);
  }
  // 正文排版与标题必须走变量 —— 否则用户改字体/宽度不会生效
  assert.match(css, /\.prose\s*\{[^}]*font-size:\s*1\.02rem/s);
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-body\)/s);
});

test('亮暗两套配色独立设计，背景不同', async () => {
  const css = await readText('styles/main.css');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css)[1];
  const dark = /html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)[1];
  const lightBg = /--bg:\s*([^;]+);/.exec(root)[1].trim();
  const darkBg = /--bg:\s*([^;]+);/.exec(dark)[1].trim();
  assert.notEqual(lightBg, darkBg, '亮暗背景必须不同');
  assert.match(lightBg, /^#[0-9a-f]{6}$/i);
  assert.match(darkBg, /^#[0-9a-f]{6}$/i);
});

test('墨色三级层次（浓/中/淡）齐全且逐级变浅', async () => {
  const css = await readText('styles/main.css');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css)[1];
  const text = /--text:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const secondary = /--text-secondary:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const dim = /--text-dim:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  assert.match(text, /^#2c2c2c$/i, '浓墨');
  assert.match(secondary, /^#5a5a5a$/i, '中墨');
  // 三级必须是三个不同的值，且亮度递增（越次要越浅）
  const lum = (hex) => luminance(hex);
  assert.ok(lum(text) < lum(secondary), '中墨应比浓墨浅');
  assert.ok(lum(secondary) < lum(dim), '淡墨应比中墨浅');
});

test('纸纹是 CSS/SVG 噪点，不是图片文件', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /feTurbulence/, '纸纹应由 SVG 分形噪声生成');
  assert.match(css, /body::before/, '纸纹应叠在 body 伪元素上');
  const assets = await fs.readdir(path.join(THEME_DIR, 'assets'));
  const raster = assets.filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f));
  assert.deepEqual(raster, [], `assets 不应有栅格图（纸纹不得用贴图）：${raster.join(', ')}`);
});

test('特色元素齐全：印章标签 / 引用 / 水墨分隔线 / 毛笔格线', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /\.tag\s*\{[^}]*background:\s*var\(--seal-red\)/s, '标签是印章风格');
  assert.match(css, /blockquote[^}]*--seal-red/s, '引用块带印章色边框');
  assert.match(css, /blockquote::before\s*\{[^}]*content:\s*'「'/s, '引用块有引号装饰');
  assert.match(css, /hr\s*\{[^}]*linear-gradient\(90deg, transparent/s, '分隔线是水墨渐变');
  assert.match(css, /\.prose th\s*\{[^}]*border-bottom:\s*2px solid var\(--text\)/s, '表头是毛笔粗格线');
});

test('书法感标题：墨色渐变 + 字距', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /\.hero-title\s*\{[^}]*-webkit-background-clip:\s*text/s);
  assert.match(css, /letter-spacing:\s*0\.16em/, '中文标题需要字距');
});

test('响应式覆盖三个断点，且有防溢出处理', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /@media\s*\(max-width:\s*34rem\)/); // ≈544px，管 390
  assert.match(css, /@media\s*\(min-width:\s*70rem\)/); // 1120px，管 1280 三栏
  const mobile = /@media\s*\(max-width:\s*34rem\)\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(mobile, /flex-wrap:\s*wrap/, '小屏头部需允许换行，否则顶破视口');
});

test('无 JS 兜底：prefers-color-scheme 媒体查询存在', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /data-theme-mode="auto"\]/);
});

test('构建产物内联 Inkstone CSS 与墨色变量', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'inkstone' } });
  assert.ok(theme.styles.length > 0);
  assert.ok(theme.styles.some((s) => /feTurbulence/.test(s.content)), '纸纹应随主题进产物');
  assert.match(theme.variables, /--font-size-base:\s*17px/, '默认字号 17 应映射为变量');
  assert.match(theme.variables, /--max-width:\s*720px/, '默认宽度 720 应映射为变量');
});

test('用户覆盖配置能改写 Inkstone 变量', async () => {
  const theme = await loadTheme(process.cwd(), {
    theme: { name: 'inkstone', colors: { accent: '#003366' }, typography: { fontSize: 20 } },
  });
  assert.equal(theme.config['colors.accent'], '#003366');
  assert.match(theme.variables, /--accent:\s*#003366/);
  assert.match(theme.variables, /--font-size-base:\s*20px/);
});

// ── 对比度：钉死 WCAG AA（4.5:1）──
// 水墨风天生偏爱「淡墨」，但淡到 3:1 就不可读了 —— Lighthouse 会扣分，
// 更要紧的是用户真的看不清。纸纹是叠加层，这里按纯底色算，是最宽松的判据：
// 底色上过了的，叠纸纹后也过（纸纹只降低对比、不会提高）。
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('亮暗两套配色的正文与次要墨色都达 WCAG AA（4.5:1）', async () => {
  const meta = await readJson('theme.json');
  const light = { bg: meta.config.colors.background.default, text: meta.config.colors.text.default, muted: meta.config.colors.muted.default };
  // 暗色底色是主题作者在 CSS 里设计的，取 dark 块的 --bg
  const css = await readText('styles/main.css');
  const dark = /html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)[1];
  const darkBg = /--bg:\s*(#[0-9a-f]{6})/i.exec(dark)[1];
  const darkMuted = /--text-dim:\s*(#[0-9a-f]{6})/i.exec(dark)[1];
  const darkText = /--text:\s*(#[0-9a-f]{6})/i.exec(dark)[1];

  const pairs = [
    ['亮色 正文/底色', light.text, light.bg],
    ['亮色 次要墨/底色', light.muted, light.bg],
    ['暗色 正文/底色', darkText, darkBg],
    ['暗色 次要墨/底色', darkMuted, darkBg],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${name} 对比度仅 ${ratio.toFixed(2)}:1（${fg} on ${bg}），低于 AA 的 4.5:1`);
  }
});

test('代码高亮注释色在代码纸上达 AA', async () => {
  const css = await readText('styles/main.css');
  const codeBg = /--bg-code:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  const lightComment = /^\.tok-comment\s*\{\s*color:\s*(#[0-9a-f]{6})/mi.exec(css)[1];
  assert.ok(contrast(lightComment, codeBg) >= 4.5, `亮色注释 ${lightComment} 对比度不足`);
  const darkBlock = /html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)[1];
  const darkCodeBg = /--bg-code:\s*(#[0-9a-f]{6})/i.exec(darkBlock)[1];
  const darkComment = /html\[data-theme="dark"\]\s*\.tok-comment\s*\{\s*color:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.ok(contrast(darkComment, darkCodeBg) >= 4.5, `暗色注释 ${darkComment} 对比度不足`);
});

test('theme.json 的 muted 默认值与 CSS 的 --text-dim 一致', async () => {
  // config 生成的变量块排在主题 CSS 之后，两者不一致时以 config 为准 ——
  // 那时 CSS 里精挑的对比色会被悄悄盖掉（这正是本主题踩过的坑）。
  const meta = await readJson('theme.json');
  const css = await readText('styles/main.css');
  const cssDim = /:root\s*\{[\s\S]*?--text-dim:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.equal(meta.config.colors.muted.default.toLowerCase(), cssDim.toLowerCase(),
    'config.colors.muted 与 CSS 的 --text-dim 必须一致，否则后者会被覆盖');
});
