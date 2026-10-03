import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 4 套主题首页「版面结构」的差异断言（P3-1b-3）。
 *
 * 为什么单开一组断言：真浏览器 e2e（scripts/e2e/theme.mjs）已经验了
 * 「两两结构不同」，但 e2e 要起 Chromium —— 本地跑一次几十秒，
 * 而「Minimal 又变回网格了」这种回归应该在毫秒级的单测里就被逮住。
 *
 * 这里断言的是**源码里的结构声明**（模板用的容器 class + CSS 的 display/columns），
 * 是 e2e 判据在上游的投影：结构写对了，渲染出来才可能不同。
 * 两层各守一半 —— 单测快而脆（认 class 名），e2e 稳而慢（认计算样式）。
 */

const REPO = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const THEMES = ['aurora', 'minimal', 'inkstone', 'magazine'];

const readTheme = async (theme, rel) =>
  fs.readFile(path.join(REPO, 'packages', `theme-${theme}`, rel), 'utf8');

/** 取出 CSS 里 `selector { ... }` 的第一个块体（不处理嵌套，够用）。 */
function blockOf(css, selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const match = re.exec(css);
  assert.ok(match, `CSS 应存在块：${selector}`);
  return match[1];
}

/** 从 index.html 的 post-grid 类名判断列表容器类型。 */
const listContainer = (html) => {
  if (/class="post-grid"/.test(html)) return 'grid';
  if (/class="post-list"/.test(html)) return 'list';
  if (/class="lead-grid"/.test(html)) return 'lead';
  return 'unknown';
};

// ── 每套主题的结构身份 ────────────────────────────────────────

test('Minimal 首页是单栏流式（.post-grid 不再是网格）', async () => {
  const css = await readTheme('minimal', 'styles/main.css');
  const html = await readTheme('minimal', 'layouts/index.html');
  const grid = blockOf(css, '.post-grid');
  assert.match(grid, /display:\s*block/, 'Minimal 的 .post-grid 应改为块级流式');
  assert.doesNotMatch(grid, /grid-template-columns/, '单栏不应再有网格列定义');
  // 列表容器用 post-list（单栏），而不是网格
  assert.equal(listContainer(html), 'list', 'Minimal 首页列表应使用 .post-list');
});

test('Minimal 单栏化没有改动颜色/字体/排版风格', async () => {
  const css = await readTheme('minimal', 'styles/main.css');
  // 只改了布局：这几个「风格锚点」必须原样保留。
  assert.match(css, /--radius:\s*8px/, 'Minimal 的圆角风格（8px）不应被顺手改掉');
  assert.match(css, /--font-sans:\s*ui-sans-serif/i, 'Minimal 的无衬线字体不应被改');
});

test('Aurora 首页仍是多栏网格（与 Minimal 单栏形成对照）', async () => {
  const css = await readTheme('aurora', 'styles/main.css');
  const grid = blockOf(css, '.post-grid');
  assert.match(grid, /display:\s*grid/);
  assert.match(grid, /grid-template-columns/);
});

test('Inkstone 首页是两栏（正文 + 侧栏），不是单栏也不是网格', async () => {
  const css = await readTheme('inkstone', 'styles/main.css');
  const html = await readTheme('inkstone', 'layouts/index.html');
  assert.match(html, /index-aside|include "index-aside"/, '首页应包含侧栏列');
  const layout = blockOf(css, '.index-layout');
  assert.match(layout, /display:\s*grid/, '两栏版面用 grid 声明');
  // 宽屏下必须是两列 —— 单列的话就和 Minimal 撞了
  assert.match(css, /\.index-layout\s*\{[^}]*grid-template-columns:[^;]*1fr\)[^;]*12rem/,
    '宽屏 .index-layout 应为「正文 + 侧栏」两列');
  // 首页文章区仍是单栏流式（两栏是「正文/侧栏」，不是「文章两列」）
  const list = blockOf(css, '.post-list');
  assert.match(list, /display:\s*block/);
});

test('Magazine 首页是三级权重的多栏网格（含封面头条）', async () => {
  const css = await readTheme('magazine', 'styles/main.css');
  const html = await readTheme('magazine', 'layouts/index.html');
  assert.match(html, /lead-grid/, 'Magazine 首页应有封面区（lead-grid）');
  assert.match(html, /card-lead/, '封面区应使用横向头条卡');
  const grid = blockOf(css, '.post-grid');
  assert.match(grid, /display:\s*grid/);
  const lead = blockOf(css, '.lead-grid');
  assert.match(lead, /grid-template-columns/);
});

// ── 4 套主题两两结构不同 ──────────────────────────────────────

test('4 套主题的列表容器类型两两不同组合（网格/单栏/两栏/多栏）', async () => {
  const structure = {};
  for (const theme of THEMES) {
    const html = await readTheme(theme, 'layouts/index.html');
    const css = await readTheme(theme, 'styles/main.css');
    structure[theme] = {
      container: listContainer(html),
      hasAside: /index-aside|include "sidebar"/.test(html) && theme === 'inkstone',
      hasLead: /card-lead|lead-grid/.test(html),
    };
  }

  // 至少三套主题的「列表容器类型 + 特征」组合互不相同 ——
  // 用 JSON 指纹避免手写一堆两两比较。
  const fingerprints = new Map();
  for (const theme of THEMES) {
    const fp = JSON.stringify(structure[theme]);
    fingerprints.set(theme, fp);
  }
  const unique = new Set(fingerprints.values());
  assert.ok(unique.size >= 3, `4 套主题的版面结构应至少有 3 种，实际 ${unique.size} 种：${JSON.stringify(structure)}`);

  // 逐对断言：任意两套不能在「容器类型 + 侧栏 + 封面」三项上完全一致。
  for (let i = 0; i < THEMES.length; i += 1) {
    for (let j = i + 1; j < THEMES.length; j += 1) {
      const a = THEMES[i];
      const b = THEMES[j];
      assert.notEqual(fingerprints.get(a), fingerprints.get(b),
        `${a} 与 ${b} 的版面结构完全一致，读者分不出这是两套主题`);
    }
  }
});

test('没有哪两套主题同时是「单栏 + 无侧栏 + 无封面」（否则结构撞车）', async () => {
  for (const theme of THEMES) {
    const html = await readTheme(theme, 'layouts/index.html');
    const isPlainList = listContainer(html) === 'list' && !/index-aside/.test(html) && !/card-lead/.test(html);
    if (isPlainList) {
      // 只允许 Minimal 一处；Inkstone 也是 post-list，但它有 index-aside，不在这一档
      assert.equal(theme, 'minimal', `${theme} 也是「纯单栏」——与 Minimal 结构重复`);
    }
  }
});

// ── 布局结构快照（与 e2e 的 layout_signature 同一套判据） ──────

test('layout_signature 能从结构快照里挑出差异维度', async () => {
  // e2e 的“两两可辨”依赖一个函数：把渲染快照压成可比较的签名。
  // 这里直接测那个函数 —— 它错了，e2e 会“通过”但什么都没比。
  const { layout_signature } = await import(
    path.join(REPO, 'scripts/e2e/theme_signature.mjs')
  );
  const grid = layout_signature({
    mainDisplay: 'block', mainCols: 'none', mainFlex: 'row', mainChildCount: 3,
    listDisplay: 'grid', listCols: '511px 511px', listFlex: 'row',
    cardCount: 4, allCardsEqualWidth: true, hasLeadCard: false, hasHero: true, hasSectionNumber: false,
  });
  const single = layout_signature({
    mainDisplay: 'block', mainCols: 'none', mainFlex: 'row', mainChildCount: 3,
    listDisplay: 'block', listCols: 'none', listFlex: 'row',
    cardCount: 4, allCardsEqualWidth: true, hasLeadCard: false, hasHero: false, hasSectionNumber: false,
  });
  assert.equal(grid['list-columns'], 2, '两列网格应数出 2 列');
  assert.equal(single['list-columns'], 0, '单栏没有网格列');
  assert.notDeepEqual(grid, single, '网格与单栏的签名必须不同');
});

test('layout_signature 对列数解析正确（none / 单列 / 多列）', async () => {
  const { layout_signature } = await import(
    path.join(REPO, 'scripts/e2e/theme_signature.mjs')
  );
  const cols = (v) => layout_signature({ mainCols: v, mainDisplay: 'grid' })['main-columns'];
  assert.equal(cols('none'), 0);
  assert.equal(cols('928px'), 1);
  assert.equal(cols('928px 192px'), 2);
  assert.equal(cols('330px 330px 330px'), 3);
});
