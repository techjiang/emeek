import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTheme } from '../../src/pipeline/render/theme.js';
import { validateThemeMeta } from '../../src/theme/spec.js';

/**
 * Magazine 内置主题的验收断言（P3-1b-2）。
 *
 * 与 inkstone.test.js 同一套思路：主题的「契约」是看不见的 ——
 * 缺一个 partial、config 与 CSS 不一致、某级文字压到 4.4:1，
 * 构建都会照常成功，直到有人打开页面。这里把验收项钉成可执行断言。
 *
 * Magazine 的额外风险是「多栏网格 + 分类色带」这类结构尺寸，
 * 所以除了配色，还断言版面的**结构**确实存在（三级权重、色带映射、章节数字）。
 */

const THEME_DIR = path.resolve(fileURLToPath(new URL('../../../../packages/theme-magazine', import.meta.url)));

const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(THEME_DIR, rel), 'utf8'));
const readText = async (rel) => fs.readFile(path.join(THEME_DIR, rel), 'utf8');

/** 取出 CSS 里 `selector { ... }` 的第一个块体（不处理嵌套，够用）。 */
const blockOf = (css, selector) => {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const m = re.exec(css);
  assert.ok(m, `CSS 应存在块：${selector}`);
  return m[1];
};

// ── 装载与规范 ────────────────────────────────────────────────

test('magazine 作为内置主题能被加载（无需项目内副本）', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'magazine' } });
  assert.equal(theme.meta.name, 'magazine');
  assert.equal(theme.warnings.length, 0, `内置主题不应有告警：${JSON.stringify(theme.warnings)}`);
});

test('theme.json 通过规范校验：零错误零告警', async () => {
  const meta = await readJson('theme.json');
  const { errors, warnings } = validateThemeMeta(meta);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('config 声明完整：四个分组齐全，每项都有 default', async () => {
  const meta = await readJson('theme.json');
  assert.deepEqual(Object.keys(meta.config).sort(), ['colors', 'features', 'layout', 'typography']);
  for (const [group, items] of Object.entries(meta.config)) {
    for (const [key, item] of Object.entries(items)) {
      assert.notEqual(item.default, undefined, `config.${group}.${key} 缺 default`);
    }
  }
});

test('六个布局齐全，含必需的 index', async () => {
  const meta = await readJson('theme.json');
  const files = await fs.readdir(path.join(THEME_DIR, 'layouts'));
  for (const layout of ['index', 'post', 'archive', 'tags', 'about', '404']) {
    assert.ok(meta.layouts.includes(layout), `layouts 应声明 ${layout}`);
    assert.ok(files.includes(`${layout}.html`), `layouts/${layout}.html 应存在`);
  }
});

test('partial 齐全，head 承载首帧脚本与注入点', async () => {
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
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-body\)/s);
});

// ── 差异点 ≥5：结构本身就是主题的一部分 ────────────────────────

test('Hero 区：渐变舞台 + 噪点纹理 + 底部压暗（全 CSS，不贴图）', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /\.hero\s*\{[^}]*background:[^;]*linear-gradient/s, 'Hero 需要渐变底');
  assert.match(css, /feTurbulence/, '噪点应由 SVG 分形噪声生成');
  assert.match(css, /\.hero::after\s*\{[^}]*linear-gradient\([^)]*transparent/s, 'Hero 底部需要压暗，保证白字可读');
  assert.match(css, /\.hero-title\s*\{[^}]*color:\s*#fff/s, 'Hero 标题是压在深底上的白字');
});

test('Pull Quote：大引号由伪元素生成，且与正文引用块区分', async () => {
  const css = await readText('styles/main.css');
  // 引号写作 CSS 转义 \201C（左双引号）—— 断言转义与直写两种形态都接受
  assert.match(css, /\.pull-quote::before\s*\{[^}]*content:\s*'(?:\\201C|“)/s, 'Pull Quote 需要大引号装饰');
  assert.match(css, /\.pull-quote(?::before)?\s*\{[^}]*var\(--accent\)/s, 'Pull Quote 用强调色');
});

test('分类色带：border-top 元素 + data-category 映射', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /\.post-card\s*\{[^}]*border-top:[^;]*var\(--cat-color/s, '卡片顶部色带应消费 --cat-color');
  for (const slug of ['tech', 'life', 'reading', 'travel']) {
    assert.match(css, new RegExp(`\\.post-card\\[data-category="${slug}"\\]`), `缺少分类 ${slug} 的颜色映射`);
  }
});

test('章节数字：压在标题后的版面纹理，但仍过大字 AA 线（3:1）', async () => {
  const css = await readText('styles/main.css');
  const num = blockOf(css, '.section-number');
  assert.match(num, /position:\s*absolute/, '章节数字应绝对定位叠在标题后');
  assert.match(num, /user-select:\s*none/, '装饰数字不该被选中，否则复制正文会带上它');
  assert.match(num, /z-index:\s*0/, '它是背景层，标题必须在它之上');

  // 曾经用 1.2:1 的浅灰 —— 桌面端 85px 时它是团看不清的脏点，
  // Lighthouse 也会按「大号文字」判它不合格。取大字 AA 线 3:1：
  // 视觉上仍是安静的纹理，但存在得理直气壮。
  const root = blockOf(css, ':root');
  const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const numeral = /--numeral:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const ratio = contrast(numeral, bg);
  assert.ok(ratio >= 3, `亮色章节数字仅 ${ratio.toFixed(2)}:1，大字 AA 线是 3:1`);
  assert.ok(ratio < 6, `章节数字 ${ratio.toFixed(2)}:1 过重了，会与标题抢读`);

  const dark = await darkBlock();
  assert.ok(contrast(/--numeral:\s*(#[0-9a-f]{6})/i.exec(dark)[1], /--bg:\s*(#[0-9a-f]{6})/i.exec(dark)[1]) >= 3,
    '暗色章节数字也要过 3:1');
});

test('装饰数字与「数字内容」分开着色：可读的走 --numeral-text', async () => {
  // --numeral 对比度只有 1.2:1 —— 它只能用在 aria-hidden 的装饰上。
  // 一旦被拿去染「真的会被读到的字」（归档年份、404），就是可读性 bug：
  // Lighthouse 的 color-contrast 会抓到，视力差的人更会。
  const css = await readText('styles/main.css');
  const index = await readText('layouts/index.html');
  const archive = await readText('layouts/archive.html');
  const notFound = await readText('layouts/404.html');

  // 装饰数字必须自带 aria-hidden，否则辅助技术会把「01」念出来
  const numbers = index.match(/<span class="section-number"[^>]*>/g) ?? [];
  assert.ok(numbers.length > 0, '首页应有章节数字');
  for (const tag of numbers) assert.match(tag, /aria-hidden="true"/, `章节数字应 aria-hidden：${tag}`);

  // 内容数字用可读色，不用装饰色
  assert.match(archive, /<h2>\{\{ group\.year \}\}<\/h2>/, '归档年份是内容');
  assert.match(notFound, /class="error-code"/, '404 数字是内容');
  const yearH2 = blockOf(css, '.archive-year h2');
  const errCode = blockOf(css, '.error-code');
  assert.match(yearH2, /color:\s*var\(--numeral-text\)/, '归档年份必须用可读的 --numeral-text');
  assert.match(errCode, /color:\s*var\(--numeral-text\)/, '404 数字必须用可读的 --numeral-text');
});

test('三级视觉权重：头条横排大卡 + 侧栏竖卡 + 普通网格', async () => {
  const index = await readText('layouts/index.html');
  const css = await readText('styles/main.css');
  assert.match(index, /posts\s*\|\s*slice:\s*0,\s*1/, '头条单独取一篇');
  assert.match(index, /posts\s*\|\s*slice:\s*1,\s*2/, '侧栏取第二篇');
  assert.match(index, /posts\s*\|\s*slice:\s*2/, '其余进网格');
  assert.match(css, /\.post-card--wide\s+\.post-card-link\s*\{[^}]*flex-direction:\s*row/s,
    '头条是横排（图左文右），不是「更大的竖卡」');
  const leadGrid = blockOf(css, '.lead-grid');
  assert.match(leadGrid, /grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(0,\s*1fr\)/,
    '封面区需要「大卡 : 侧栏」的 2:1 两列栅格');
});

test('卡片网格：多栏，且窄屏降为单栏', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /\.post-grid\s*\{[^}]*repeat\(auto-fill, minmax/s, '网格用 auto-fill 自适应栏数');
});

test('零栅格文件：装饰全部由 CSS/SVG 生成', async () => {
  const assets = await fs.readdir(path.join(THEME_DIR, 'assets'));
  const raster = assets.filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f));
  assert.deepEqual(raster, [], `assets 不应有栅格图：${raster.join(', ')}`);
});

// ── 响应式与兜底 ──────────────────────────────────────────────

test('响应式覆盖移动断点，且小屏头部可换行', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /@media\s*\(max-width:\s*3[0-9]rem\)/, '需要小屏断点（管 390px）');
  assert.match(css, /@media\s*\(max-width:\s*60rem\)/, '需要中屏断点（管 1120px 以下）');
  const mobile = /@media\s*\(max-width:\s*3[0-9]rem\)\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(mobile, /grid-template-columns:\s*1fr/, '小屏网格应降为单栏');
});

test('无 JS 兜底：prefers-color-scheme 媒体查询存在', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /data-theme-mode="auto"\]/);
});

test('打印样式存在：杂志是会被打印的东西', async () => {
  const css = await readText('styles/main.css');
  assert.match(css, /@media\s*print/);
});

// ── 构建产物 ──────────────────────────────────────────────────

test('构建产物内联 Magazine CSS 与变量', async () => {
  const theme = await loadTheme(process.cwd(), { theme: { name: 'magazine' } });
  assert.ok(theme.styles.length > 0);
  assert.ok(theme.styles.some((s) => /\.section-number/.test(s.content)), '章节数字应随主题进产物');
  assert.match(theme.variables, /--font-size-base:\s*17px/);
  assert.match(theme.variables, /--max-width:\s*1120px/);
});

test('用户覆盖配置能改写 Magazine 变量', async () => {
  const theme = await loadTheme(process.cwd(), {
    theme: { name: 'magazine', colors: { accent: '#003366' }, typography: { fontSize: 19 } },
  });
  assert.equal(theme.config['colors.accent'], '#003366');
  assert.match(theme.variables, /--accent:\s*#003366/);
  assert.match(theme.variables, /--font-size-base:\s*19px/);
});

// ── 对比度：钉死 WCAG AA（4.5:1）──────────────────────────────
// 杂志风爱用亮红与浅灰，最容易在这一关翻车。底色取最不利的一层
// （--bg-hero 是 Hero 渐变最亮处），过得了最亮的，也就过得了白底卡片。
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

const darkBlock = async () => blockOf(await readText('styles/main.css'), 'html[data-theme="dark"]');

test('亮暗两套配色的正文与次要色都达 WCAG AA（4.5:1）', async () => {
  const meta = await readJson('theme.json');
  const css = await readText('styles/main.css');
  const root = blockOf(css, ':root');
  // 正文会遇到两种底：纯白纸面，和卡片灰底。取更不利的那个（卡片灰底）来判。
  const surface = /--bg-soft:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const dark = await darkBlock();
  const darkSurface = /--bg-soft:\s*(#[0-9a-f]{6})/i.exec(dark)[1];

  const pairs = [
    ['亮色 正文/卡片底', meta.config.colors.text.default, surface],
    ['亮色 次要色/卡片底', meta.config.colors.muted.default, surface],
    ['亮色 强调色/卡片底', meta.config.colors.accent.default, surface],
    ['暗色 正文/卡片底', /--text:\s*(#[0-9a-f]{6})/i.exec(dark)[1], darkSurface],
    ['暗色 次要色/卡片底', /--text-dim:\s*(#[0-9a-f]{6})/i.exec(dark)[1], darkSurface],
    ['暗色 强调色/卡片底', /--accent:\s*(#[0-9a-f]{6})/i.exec(dark)[1], darkSurface],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${name} 对比度仅 ${ratio.toFixed(2)}:1（${fg} on ${bg}），低于 AA 的 4.5:1`);
  }
});

test('Hero 上的白色标题在最亮一端仍达 AA', async () => {
  const css = await readText('styles/main.css');
  const root = blockOf(css, ':root');
  // Hero 是 --bg-hero → --hero-end 的深色渐变。两端取较亮的一端算，
  // 就是白字的最不利处境（底部压暗层只会让它更好，不参与判据）。
  const a = /--bg-hero:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const b = /--hero-end:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  for (const [name, bg] of [['--bg-hero', a], ['--hero-end', b]]) {
    const ratio = contrast('#ffffff', bg);
    assert.ok(ratio >= 4.5, `Hero 白字在 ${name}(${bg}) 上仅 ${ratio.toFixed(2)}:1`);
  }
});

test('--numeral-text 在纸面上达 AA，--numeral 只作装饰', async () => {
  const css = await readText('styles/main.css');
  const root = blockOf(css, ':root');
  const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const numeralText = /--numeral-text:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  const numeral = /--numeral:\s*(#[0-9a-f]{6})/i.exec(root)[1];
  assert.ok(contrast(numeralText, bg) >= 4.5,
    `--numeral-text 在纸面上仅 ${contrast(numeralText, bg).toFixed(2)}:1，读不了`);
  const dark = await darkBlock();
  const darkBg = /--bg:\s*(#[0-9a-f]{6})/i.exec(dark)[1];
  const darkNumeralText = /--numeral-text:\s*(#[0-9a-f]{6})/i.exec(dark)[1];
  assert.ok(contrast(darkNumeralText, darkBg) >= 4.5,
    `暗色 --numeral-text 仅 ${contrast(darkNumeralText, darkBg).toFixed(2)}:1`);
  // 两档分工明确：装饰档过大字线（3:1），内容档过正文线（4.5:1）
  assert.ok(contrast(numeral, bg) >= 3 && contrast(numeral, bg) < contrast(numeralText, bg),
    `--numeral(${contrast(numeral, bg).toFixed(2)}:1) 应过 3:1 但比 --numeral-text(${contrast(numeralText, bg).toFixed(2)}:1) 更轻`);
});

test('代码高亮注释色在代码纸上达 AA', async () => {
  const css = await readText('styles/main.css');
  const codeBg = /--bg-code:\s*(#[0-9a-f]{6})/i.exec(blockOf(css, ':root'))[1];
  const lightComment = /^\.tok-comment\s*\{\s*color:\s*(#[0-9a-f]{6})/mi.exec(css)[1];
  assert.ok(contrast(lightComment, codeBg) >= 4.5, `亮色注释 ${lightComment} 对比度不足`);
  const dark = await darkBlock();
  const darkCodeBg = /--bg-code:\s*(#[0-9a-f]{6})/i.exec(dark)[1];
  const darkComment = /html\[data-theme="dark"\]\s*\.tok-comment\s*\{\s*color:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.ok(contrast(darkComment, darkCodeBg) >= 4.5, `暗色注释 ${darkComment} 对比度不足`);
});

test('theme.json 的颜色默认值与 CSS 实际值一致', async () => {
  // config 生成的变量块排在主题 CSS 之后，两者不一致时以 config 为准 ——
  // 那时 CSS 里精挑的对比色会被悄悄盖掉（Inkstone 踩过的坑，这里钉死）。
  const meta = await readJson('theme.json');
  const css = await readText('styles/main.css');
  const root = blockOf(css, ':root');
  const expectations = {
    primary: '--primary',
    accent: '--accent',
    background: '--bg',
    surface: '--bg-soft',
    text: '--text',
    muted: '--text-dim',
    border: '--border',
    code: '--bg-code',
  };
  for (const [key, variable] of Object.entries(expectations)) {
    const fromConfig = meta.config.colors[key].default.toLowerCase();
    const fromCss = new RegExp(`${variable}:\\s*(#[0-9a-f]{6})`, 'i').exec(root)[1].toLowerCase();
    assert.equal(fromConfig, fromCss,
      `config.colors.${key}(${fromConfig}) 与 CSS 的 ${variable}(${fromCss}) 必须一致，否则后者会被覆盖`);
  }
});
