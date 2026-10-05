/**
 * 统计页（/stats/）—— 构建期生成，**纯 HTML + SVG，零 JavaScript**。
 *
 * 三件事在这里被决定，且全部是可断言的：
 *
 *   1. **数据从哪来。** 全部来自 builtin.js（构建期推断）或用户注入的
 *      运行时报表。没有任何数据时，对应区块**整块不渲染** ——
 *      不是渲染一个全 0 的图。见 docs/analytics.md 的诚实性一节。
 *   2. **图表怎么画。** 全部走 charts.js 的纯函数 → SVG 字符串。
 *      数据为空时那个函数返回空字符串，页面据此跳过整个 section。
 *   3. **数据来源怎么标。** 页脚必须逐项列出「这一块是谁算的」，
 *      算不出来的（PV / 来源）也要列出来并说明为什么没有。
 *      一张不写来源的统计表，读者无法判断它是不是编的。
 *
 * 与主题的关系：这个模块只产出**数据视图**（sections + svg 字符串），
 * 主题负责 HTML 外壳与样式。4 套主题因此可以长得完全不同，
 * 而「哪个数字是哪个数字」不会分叉。
 */

import {
  buildBuiltinStats, monthlyFrequency, tagDistribution, dailyHeatmap,
} from '../analytics/builtin.js';
import {
  barChart, lineChart, pieChart, heatmapChart, wordCloud, rankedBars,
} from './charts.js';

/** 统计页可用的区块。配置里写错的名字会被忽略并告警（不静默）。 */
export const STATS_SECTIONS = [
  'totals',     // 顶部数字卡片
  'frequency',  // 月度发文柱状图 + 累计折线
  'top',        // 热门文章排行
  'tags',       // 标签分布（环形图 + 词云 + 列表）
  'heatmap',    // 365 天热力图
  'sources',    // 数据来源说明（不可关闭 —— 它是这一页的诚实性保证）
];

/** 区块里「没有数据就整块消失」的判据，写在一处，页面与测试读同一份。 */
export function hasSectionData(name, stats) {
  if (!stats) return false;
  switch (name) {
    case 'totals': return stats.totals.posts > 0 || stats.totals.comments != null;
    case 'frequency': return stats.frequency.some((m) => m.count > 0);
    case 'top': return stats.top.items.length > 0;
    case 'tags': return stats.tags.length > 0;
    case 'heatmap': return stats.heatmap.total > 0;
    case 'sources': return true;
    default: return false;
  }
}

/**
 * 组装统计页视图。
 *
 * @param {object[]} posts    构建期文章（含 wordCount / url / tags）
 * @param {object}   options
 *   config       站点配置（读 analytics.statsPage.sections）
 *   comments     Issues 互动数据（可空 —— 空时评论数如实显示为「无数据源」）
 *   runtime      运行时 PV 报表（可空，形状 { items: [{path, views}], total }）
 *   now          构建时刻（测试注入用，保证确定性）
 *   timezone
 */
export function buildStatsView(posts = [], {
  config = {},
  comments = null,
  runtime = null,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  topLimit = 10,
  // 标签 URL 解析器。不给时退化成 /tags/<原样>.html —— 调用方（pipeline）
  // 永远给，所以这个兜底只为「直接在测试/编辑器里用这个函数」而存在。
  tagUrl = (name) => `/tags/${encodeURIComponent(String(name))}.html`,
} = {}) {
  const cfg = config?.analytics?.statsPage ?? {};
  const enabled = cfg.sections ?? STATS_SECTIONS;
  const requested = Array.isArray(enabled) ? enabled : STATS_SECTIONS;

  const stats = buildBuiltinStats(posts, {
    comments,
    now,
    timezone,
    topLimit,
    retentionDays: config?.analytics?.builtin?.retentionDays ?? null,
  });

  const sections = {};
  const rendered = [];

  // ── 顶部数字卡片 ──────────────────────────────────────────────
  if (requested.includes('totals') && hasSectionData('totals', stats)) {
    const t = stats.totals;
    sections.totals = {
      items: [
        { key: 'posts', label: '文章', value: t.posts, unit: '篇' },
        // comments / pv 为 null 时 value 也是 null —— 页面据此显示「—」，
        // 而不是一个看起来像真实数据的 0。
        { key: 'comments', label: '评论', value: t.comments, unit: '条' },
        { key: 'words', label: '字数', value: t.words, unit: '字', format: 'compact' },
        { key: 'running', label: '运行', value: t.runningDays, unit: '天' },
      ],
    };
    rendered.push('totals');
  }

  // ── 发文频率 ──────────────────────────────────────────────────
  if (requested.includes('frequency') && hasSectionData('frequency', stats)) {
    // 累计曲线由月度数据算出来 —— 与柱状图共用同一份输入，
    // 因此「柱子加起来等于折线终点」是结构上成立的，不需要额外断言。
    let acc = 0;
    const cumulative = stats.frequency.map((m) => {
      acc += m.count;
      return { label: m.label, value: acc };
    });
    sections.frequency = {
      months: stats.frequency,
      bars: barChart(stats.frequency, { label: '月度发文量' }),
      line: lineChart(cumulative, { label: '累计发文量' }),
      streak: stats.streak,
      writing: stats.writing,
    };
    rendered.push('frequency');
  }

  // ── 热门文章 ──────────────────────────────────────────────────
  if (requested.includes('top') && hasSectionData('top', stats)) {
    const { metric, items } = stats.top;
    sections.top = {
      // metric 告诉页面「这份榜单是按什么排的」。不写排序依据的
      // 「热门」是在骗人 —— 所以它必须出现在渲染结果里。
      metric,
      metricLabel: metric === 'comments' ? '评论 + reaction' : '字数',
      items,
      // value 是排序依据本身（`--ratio` 条与数字都用它）。
      // meta 只在**排序依据之外**还有信息时才给：字数排序时再标一次
      // 「N 字」就是把同一个数字印两遍。
      html: rankedBars(items.map((item) => ({
        title: item.title,
        url: item.url,
        value: metric === 'comments' ? (item.comments ?? 0) * 3 + (item.reactions ?? 0) : item.wordCount,
        valueSuffix: metric === 'comments' ? '' : ' 字',
        meta: metric === 'comments' ? `${item.comments ?? 0} 评论` : '',
      })), { label: '热门文章', showRank: true }),
    };
    rendered.push('top');
  }

  // ── 标签分布 ──────────────────────────────────────────────────
  if (requested.includes('tags') && hasSectionData('tags', stats)) {
    // 环形图只放前 6 个 + 「其它」：十几个扇区的环形图谁也读不出来，
    // 而长尾归并是「可读」与「完整」的折中，越早做越诚实。
    const head = stats.tags.slice(0, 6);
    const tail = stats.tags.slice(6);
    const pieItems = tail.length
      ? [...head, { name: `其它 ${tail.length} 个`, count: tail.reduce((s, i) => s + i.count, 0) }]
      : head;
    sections.tags = {
      // items 带上 url：主题只负责渲染，不再自己拼链接。
      items: stats.tags.map((tag) => ({ ...tag, url: tagUrl(tag.name) })),
      // 中心数字是「标签被引用的总次数」——不是文章数，措辞必须准确，
      // 否则读者会把它当成文章总数（而文章总数已经在顶部卡片里了）。
      pie: pieChart(pieItems, { label: '标签分布', centerLabel: '次引用' }),
      cloud: wordCloud(stats.tags),
    };
    rendered.push('tags');
  }

  // ── 热力图 ────────────────────────────────────────────────────
  if (requested.includes('heatmap') && hasSectionData('heatmap', stats)) {
    sections.heatmap = {
      ...stats.heatmap,
      svg: heatmapChart(stats.heatmap),
    };
    rendered.push('heatmap');
  }

  // ── 运行时 PV（可选）──────────────────────────────────────────
  //
  // 只有用户自托管了收集端点、并把报表喂进来时才有。没有就整块不要 ——
  // 「浏览量」那一栏在 totals 里保持 null，显示为「—」。
  if (runtime && Array.isArray(runtime.items) && runtime.items.length) {
    sections.pv = {
      total: runtime.total,
      html: rankedBars(runtime.items.map((item) => ({
        title: item.path, value: item.views, meta: '次浏览',
      })), { label: '浏览量排行' }),
    };
    rendered.push('pv');
  }

  // ── 数据来源（不可关闭）───────────────────────────────────────
  //
  // 逐项列出「有数据源」与「没有数据源」。后者是这一页最重要的一半：
  // 读者需要知道「为什么这里没有浏览量」是设计如此，而不是忘了做。
  const sourceRows = Object.entries(stats.sources).map(([name, source]) => ({
    name,
    source: source ?? null,
    available: Boolean(source),
  }));
  sections.sources = { rows: sourceRows };
  rendered.push('sources');

  return {
    enabled: true,
    path: cfg.path ?? '/stats/',
    nav: cfg.nav !== false,
    stats,
    sections,
    rendered,
    generatedAt: stats.generatedAt,
    range: stats.range,
    retentionDays: stats.retentionDays,
  };
}

export { barChart, lineChart, pieChart, heatmapChart, wordCloud, rankedBars } from './charts.js';
export { buildBuiltinStats, monthlyFrequency, tagDistribution, dailyHeatmap };
