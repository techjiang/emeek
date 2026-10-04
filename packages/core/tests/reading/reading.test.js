import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadingNav, renderReadingToc, renderReadingProgress, READING_CLIENT, TOC_MIN_ITEMS,
} from '../../src/reading/index.js';

const toc = (n, levels = 2) => Array.from({ length: n }, (_, i) => ({ level: levels, id: `h${i}`, text: `标题 ${i}` }));

// ── 落位决策 ────────────────────────────────────────────────────
test('章节太少不给目录 —— 目录比它索引的内容还长的时候是负担', () => {
  const nav = buildReadingNav({ toc: toc(2), hasSidebar: true });
  assert.equal(nav.placement, 'none');
  assert.equal(renderReadingToc(nav), '');
  assert.equal(TOC_MIN_ITEMS, 3);
});

test('阈值边界：刚好 3 节给目录', () => {
  assert.equal(buildReadingNav({ toc: toc(3), hasSidebar: true }).placement, 'sidebar');
});

test('有侧栏时放侧栏（正文上方不重复）', () => {
  assert.equal(buildReadingNav({ toc: toc(5), hasSidebar: true }).placement, 'sidebar');
});

test('没有侧栏时放正文上方', () => {
  assert.equal(buildReadingNav({ toc: toc(5), hasSidebar: false }).placement, 'inline');
});

test('placement 只有三个取值（不是布尔组合）', () => {
  for (const hasSidebar of [true, false]) {
    for (const n of [1, 3, 10]) {
      assert.ok(['none', 'sidebar', 'inline'].includes(buildReadingNav({ toc: toc(n), hasSidebar }).placement));
    }
  }
});

test('nested 只在真的有多级时才是 true（全是 h2 时缩进是噪音）', () => {
  assert.equal(buildReadingNav({ toc: toc(5, 2), hasSidebar: true }).nested, false);
  const mixed = [{ level: 2, id: 'a', text: 'A' }, { level: 3, id: 'b', text: 'B' }, { level: 2, id: 'c', text: 'C' }];
  assert.equal(buildReadingNav({ toc: mixed, hasSidebar: true }).nested, true);
});

test('空标题被过滤（目录里出现空白条目看起来像渲染坏了）', () => {
  const nav = buildReadingNav({
    toc: [{ level: 2, id: 'a', text: 'A' }, { level: 2, id: 'b', text: '   ' }, { level: 2, id: 'c', text: 'C' }, { level: 2, id: 'd', text: 'D' }],
    hasSidebar: false,
  });
  assert.equal(nav.items.length, 3);
  assert.ok(!nav.items.some((i) => !i.text.trim()));
});

test('缺 id 的条目不参与（点了跳不过去）', () => {
  const nav = buildReadingNav({
    toc: [{ level: 2, text: 'A' }, { level: 2, id: 'b', text: 'B' }, { level: 2, id: 'c', text: 'C' }, { level: 2, id: 'd', text: 'D' }],
    hasSidebar: false,
  });
  assert.equal(nav.items.length, 3);
});

// ── 进度条 ──────────────────────────────────────────────────────
test('进度条与目录同阈值（短文章不需要进度条）', () => {
  assert.equal(buildReadingNav({ toc: toc(2), hasSidebar: true }).showProgress, false);
  assert.equal(buildReadingNav({ toc: toc(5), hasSidebar: true }).showProgress, true);
  assert.equal(renderReadingProgress(buildReadingNav({ toc: toc(2), hasSidebar: true })), '');
});

test('进度条是装饰（aria-hidden），语义不靠它', () => {
  const html = renderReadingProgress(buildReadingNav({ toc: toc(5), hasSidebar: true }));
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /data-reading-bar/);
});

// ── 目录骨架 ────────────────────────────────────────────────────
test('目录用有序列表（章节是有顺序的，屏幕阅读器会念出「共 N 项」）', () => {
  const html = renderReadingToc(buildReadingNav({ toc: toc(4), hasSidebar: false }));
  assert.match(html, /<ol class="toc-list">/);
  assert.match(html, /<\/ol>/);
});

test('每个目录项带 data-heading（浏览器端的接缝是显式属性，不是从 href 抠）', () => {
  const html = renderReadingToc(buildReadingNav({ toc: toc(4), hasSidebar: false }));
  assert.equal((html.match(/data-heading=/g) ?? []).length, 4);
});

test('目录带 aria-labelledby，标题有 id', () => {
  const html = renderReadingToc(buildReadingNav({ toc: toc(4), hasSidebar: false }));
  assert.match(html, /aria-labelledby="toc-title"/);
  assert.match(html, /id="toc-title"/);
});

test('标题里的 HTML 被转义（标题来自文章内容）', () => {
  const html = renderReadingToc(buildReadingNav({
    toc: [{ level: 2, id: 'a', text: '<img onerror=x>' }, { level: 2, id: 'b', text: 'B' }, { level: 2, id: 'c', text: 'C' }],
    hasSidebar: false,
  }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('id 里的引号被转义（属性注入）', () => {
  const html = renderReadingToc(buildReadingNav({
    toc: [{ level: 2, id: 'a" onload="x', text: 'A' }, { level: 2, id: 'b', text: 'B' }, { level: 2, id: 'c', text: 'C' }],
    hasSidebar: false,
  }));
  assert.doesNotMatch(html, /onload="x/);
});

// ── 客户端脚本 ──────────────────────────────────────────────────
test('客户端覆盖两种目录落位（只写一个会让另一种落位下高亮完全不工作）', () => {
  // 这个 bug 真实发生过：脚本只选 .toc-list，而 4 套主题的默认落位是
  // .sidebar-toc，于是滚到哪都不亮，页面上看不出任何异常。
  assert.match(READING_CLIENT, /\.toc-list a\[data-heading\]/);
  assert.match(READING_CLIENT, /\.sidebar-toc a\[data-heading\]/);
});

test('客户端等 DOM 就绪再跑（脚本在侧栏目录之前执行，直接跑会拿到空集）', () => {
  assert.match(READING_CLIENT, /document\.readyState === 'loading'/);
  assert.match(READING_CLIENT, /DOMContentLoaded/);
});

test('当前章节用「顺序判定」而不是「窄带命中」', () => {
  // 窄带 Observer 在章节稀疏时会一次都不命中（两个标题之间有 300~500px，
  // 而窄带只有视口的 20%）。所以必须有「最后一个过线的标题」这个循环。
  assert.match(READING_CLIENT, /getBoundingClientRect\(\)\.top <= line/);
  assert.match(READING_CLIENT, /window\.innerHeight \* 0\.3/);
});

test('进度条重算走 rAF 合帧（滚动一次几十个事件，每次都算布局会卡）', () => {
  assert.match(READING_CLIENT, /requestAnimationFrame/);
});

test('高亮时设 aria-current="location"（不是 aria-selected，那是选项卡的）', () => {
  assert.match(READING_CLIENT, /aria-current', 'location'/);
});

test('一个都没过线时高亮第一节（目录一项都不亮看起来像坏了）', () => {
  assert.match(READING_CLIENT, /activate\(found \|\| \(headings\[0\]/);
});

test('首次立即算一次（从锚点链接进来时不该等第一次滚动）', () => {
  assert.match(READING_CLIENT, /updateCurrent\(\);\s*$/m);
});

test('脚本里不含反引号（会被模板字符串提前截断 —— 这个坑踩过一次）', () => {
  assert.doesNotMatch(READING_CLIENT, /`/);
});
