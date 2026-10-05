import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../src/pipeline/index.js';
import { buildStatsView, hasSectionData, STATS_SECTIONS } from '../../src/stats/index.js';

async function site(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-stats-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

const read = (dir, rel) => fs.readFile(path.join(dir, 'dist', rel), 'utf8');

function cfg(extra = '') {
  return `export default {
    site: { title: '统计站', description: 'D', url: 'https://s.example.com', author: 'A', language: 'zh-CN' },
    content: { source: 'local', localDirs: ['posts'] },
    ${extra}
  };`;
}

/** 抓出真正渲染出来的图表 svg 的类名（不是 CSS 里的类名 —— 那个永远在）。 */
function svgClasses(html) {
  return [...html.matchAll(/<svg class="chart chart-([a-z]+)"/g)].map((m) => `chart-${m[1]}`);
}

const post = (n, date) => `---\ntitle: 第 ${n} 篇\ndate: ${date}\ntags: [Emeek, 标签${n % 3}]\n---\n\n# 第 ${n} 篇\n\n正文内容，用来让字数统计有意义。\n\n## 小节\n\n更多内容。\n`;

const THREE_POSTS = {
  'posts/2025-01-15-a.md': post(1, '2025-01-15'),
  'posts/2025-02-15-b.md': post(2, '2025-02-15'),
  'posts/2025-03-15-c.md': post(3, '2025-03-15'),
};

describe('★ 统计页默认关闭', () => {
  test('不配 statsPage 时，产物里根本没有 /stats/ 目录', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), ...THREE_POSTS });
    await build({ cwd: dir });
    await assert.rejects(
      () => fs.access(path.join(dir, 'dist/stats/index.html')),
      /ENOENT/,
      '默认关闭时不该产出统计页',
    );
  });

  test('默认关闭时导航里没有「统计」入口（点了会 404 的入口比没有更糟）', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.ok(!/>统计</.test(html), '导航不该出现统计入口');
    assert.ok(!html.includes('/stats/'));
  });

  test('默认关闭时 sitemap 里没有 /stats/', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), ...THREE_POSTS });
    await build({ cwd: dir });
    assert.ok(!(await read(dir, 'sitemap.xml')).includes('/stats/'));
  });
});

describe('统计页开启后', () => {
  const enabled = cfg("analytics: { enabled: false, statsPage: { enabled: true } },");

  test('产出 dist/stats/index.html', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.match(html, /<title>站点统计/);
  });

  test('导航与 sitemap 里都有入口', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    assert.match(await read(dir, 'index.html'), /href="\/stats\/"/);
    assert.match(await read(dir, 'sitemap.xml'), /\/stats\//);
  });

  test('nav: false 时统计页存在但导航里没有入口', async () => {
    const dir = await site({
      'emeeek.config.js': cfg("analytics: { enabled: false, statsPage: { enabled: true, nav: false } },"),
      ...THREE_POSTS,
    });
    await build({ cwd: dir });
    await assert.doesNotReject(() => fs.access(path.join(dir, 'dist/stats/index.html')));
    assert.ok(!(await read(dir, 'index.html')).includes('href="/stats/"'), 'nav:false 时不该有入口');
  });

  test('自定义路径生效（path 配置）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg("analytics: { enabled: false, statsPage: { enabled: true, path: '/about/stats/' } },"),
      ...THREE_POSTS,
    });
    await build({ cwd: dir });
    await assert.doesNotReject(() => fs.access(path.join(dir, 'dist/about/stats/index.html')));
  });
});

describe('★ 统计页零 JavaScript', () => {
  const enabled = cfg("analytics: { enabled: false, statsPage: { enabled: true } },");

  test('统计页里没有任何分析/图表脚本（只有主题原有的 3 个）', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    const inline = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    // no-flash + 主题脚本 + JSON-LD，没有第四个。
    assert.ok(inline.length <= 4, `统计页 script 数 ${inline.length}，超出预期`);

    // 判据是「有没有外部脚本引用与 canvas API」，不是「页面上有没有这几个字母」。
    // 用裸字符串匹配会被 CSS 里的十六进制色骗到：#0a7d3a 里就含 "d3"，
    // 于是「禁止 d3」这条断言会永远红（我第一版就是这么写错的）。
    assert.ok(!/<script[^>]+src=/i.test(html), '不得引入任何外部脚本（图表库一律排除）');
    assert.ok(!/<canvas|getContext\s*\(/.test(html), '不得用 canvas —— 无 JS 时它是空的');
    for (const lib of ['echarts', 'Chart.min', 'd3v', 'plotly']) {
      assert.ok(!html.includes(lib), `不得引入图表库 ${lib}`);
    }
  });

  test('图表全是内联 SVG（不是 canvas、不是外部图片）', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.ok((html.match(/<svg /g) ?? []).length >= 4, '至少 4 张图');
    assert.ok(!/<canvas/.test(html), '不得用 canvas —— 无 JS 时它是空的');
    assert.ok(!/<img[^>]*src="[^"]*\.png/.test(html), '图表不得是外部位图');
  });
});

describe('★ 诚实性：没有数据源的区块不渲染猜测值', () => {
  const enabled = cfg("analytics: { enabled: false, statsPage: { enabled: true } },");

  test('local 源没有评论数据时，「评论」显示 — 而不是 0', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.match(html, /data-key="comments"[\s\S]{0,200}?—/, '评论值必须是 —（缺失），不是 0');
    assert.match(html, /无数据源/, '必须明说「无数据源」');
  });

  test('数据来源里逐项列出「没有数据源」的那几项（不假装它们不存在）', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    for (const name of ['浏览量（PV）', '访问来源', '评论数 / reaction 数']) {
      assert.ok(html.includes(name), `数据来源里缺「${name}」`);
    }
  });

  test('★ 没有 PV 数据源时，整块不渲染（而不是画一个全 0 的浏览量榜）', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.ok(!html.includes('浏览量排行'), '没有 PV 数据时不该有「浏览量排行」标题');
    assert.ok(!html.includes('id="stats-pv"'));
    // 而且不能是「标题没了但图还在」的状态。
    assert.ok(!/>浏览量</.test(html));
  });

  test('热门文章榜单明说排序依据（不写依据的「热门」是在骗人）', async () => {
    const dir = await site({ 'emeeek.config.js': enabled, ...THREE_POSTS });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.match(html, /按\S+排序/, '必须写出排序依据');
    assert.match(html, /按字数排序/, 'local 源没有互动数据 → 按字数');
  });
});

describe('sections 配置', () => {
  test('sections 里没写的区块不渲染', async () => {
    const dir = await site({
      'emeeek.config.js': cfg("analytics: { enabled: false, statsPage: { enabled: true, sections: ['totals'] } },"),
      ...THREE_POSTS,
    });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    assert.ok(html.includes('data-key="posts"'), 'totals 应该在');
    const charts = svgClasses(html);
    assert.ok(!charts.includes('chart-bars'), 'frequency 被去掉后不该有柱状图');
    assert.ok(!charts.includes('chart-heatmap'), 'heatmap 被去掉后不该有热力图');
  });

  test('sources 区块不可关闭（它是这一页诚实性的落点）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg("analytics: { enabled: false, statsPage: { enabled: true, sections: ['totals'] } },"),
      ...THREE_POSTS,
    });
    await build({ cwd: dir });
    assert.match(await read(dir, 'stats/index.html'), /数据来源/);
  });

  test('空站点：有数据源的头卡片仍然渲染，图表区块整块消失（而不是空图）', async () => {
    const dir = await site({ 'emeeek.config.js': cfg("analytics: { enabled: false, statsPage: { enabled: true } },") });
    await build({ cwd: dir });
    const html = await read(dir, 'stats/index.html');
    // 判据必须是「有没有渲染出来的 <svg>」，不是「字符串里有没有类名」——
    // 类名写在 CSS 里，永远都在，用它做断言会永远绿（我第一版就是这么写的）。
    const charts = svgClasses(html);
    assert.deepEqual(charts, [], `零篇文章不该有任何图表，实际渲染了 ${charts.join('/')}`);
    assert.match(html, /数据来源/, '来源说明始终在');
  });
});

describe('hasSectionData —— 页面与测试读同一份判据', () => {
  const stats = {
    totals: { posts: 3, comments: null },
    frequency: [{ count: 0 }, { count: 2 }],
    top: { items: [{ title: 'a' }] },
    tags: [{ name: 'x', count: 1 }],
    heatmap: { total: 2 },
  };

  test('有数据 → true', () => {
    for (const name of ['totals', 'frequency', 'top', 'tags', 'heatmap', 'sources']) {
      assert.equal(hasSectionData(name, stats), true, `${name} 应判为有数据`);
    }
  });

  test('空数据 → false（区块整块不渲染）', () => {
    const empty = {
      totals: { posts: 0, comments: null },
      frequency: [{ count: 0 }],
      top: { items: [] },
      tags: [],
      heatmap: { total: 0 },
    };
    for (const name of ['totals', 'frequency', 'top', 'tags', 'heatmap']) {
      assert.equal(hasSectionData(name, empty), false, `${name} 在空数据下应判为无数据`);
    }
    assert.equal(hasSectionData('sources', empty), true, 'sources 永远渲染');
  });

  test('未知区块名 → false（不静默当成有数据）', () => {
    assert.equal(hasSectionData('nope', stats), false);
  });

  test('没有 stats 时全部 false 且不抛', () => {
    assert.equal(hasSectionData('totals', null), false);
    assert.equal(hasSectionData('sources', null), false);
  });

  test('STATS_SECTIONS 覆盖全部实现了的区块', () => {
    for (const name of ['totals', 'frequency', 'top', 'tags', 'heatmap', 'sources']) {
      assert.ok(STATS_SECTIONS.includes(name), `${name} 不在 STATS_SECTIONS 里`);
    }
  });
});

describe('buildStatsView 的确定性', () => {
  const posts = [
    { title: 'a', slug: 'a', url: '/posts/a.html', date: '2025-01-01', tags: ['x'], categories: [], wordCount: 100 },
    { title: 'b', slug: 'b', url: '/posts/b.html', date: '2025-02-01', tags: ['x'], categories: [], wordCount: 200 },
  ];
  const NOW = new Date('2025-06-01T00:00:00Z');

  test('同一 now 下两次调用产出同一份视图', () => {
    const a = buildStatsView(posts, { now: NOW });
    const b = buildStatsView(posts, { now: NOW });
    assert.deepEqual(a, b);
  });

  test('tagUrl 由外部注入（不自己拼 slug 规则）', () => {
    const view = buildStatsView(posts, { now: NOW, tagUrl: (n) => `/custom/${n}/` });
    assert.equal(view.sections.tags.items[0].url, '/custom/x/');
  });

  test('默认 tagUrl 兜底存在（直接在编辑器里调用时不崩）', () => {
    const view = buildStatsView(posts, { now: NOW });
    assert.match(view.sections.tags.items[0].url, /^\/tags\//);
  });

  test('运行时 PV 报表喂进来时多出 pv 区块', () => {
    const view = buildStatsView(posts, {
      now: NOW,
      runtime: { items: [{ path: '/posts/a.html', views: 12 }], total: 12 },
    });
    assert.ok(view.rendered.includes('pv'));
    assert.match(view.sections.pv.html, /\/posts\/a\.html/);
  });

  test('空 runtime 不产生 pv 区块', () => {
    const view = buildStatsView(posts, { now: NOW, runtime: { items: [], total: 0 } });
    assert.ok(!view.rendered.includes('pv'));
  });
});
