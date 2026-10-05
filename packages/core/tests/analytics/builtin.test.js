import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyFrequency, topPosts, tagDistribution, dailyHeatmap,
  computeStreak, writingFrequency, buildBuiltinStats, toDayKey,
} from '../../src/analytics/builtin.js';

function post(overrides = {}) {
  return { title: 'T', slug: 't', url: '/posts/t.html', date: '2025-01-15', tags: [], categories: [], wordCount: 100, ...overrides };
}

const NOW = new Date('2025-06-15T00:00:00Z');

describe('月度发文频率', () => {
  test('补零：没有文章的月份也在（否则 x 轴被压扁，看起来每月都在发）', () => {
    const series = monthlyFrequency([post({ date: '2025-06-01' })], { months: 12, now: NOW });
    assert.equal(series.length, 12);
    assert.equal(series[series.length - 1].count, 1, '最后一格是本月');
    assert.equal(series.filter((m) => m.count === 0).length, 11, '其余月份必须是 0 而不是缺席');
    assert.deepEqual(series.map((m) => m.key), [
      '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12',
      '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
    ]);
  });

  test('窗口之外的文章不计入，也不会让窗口变形', () => {
    const series = monthlyFrequency(
      [post({ date: '2020-01-01' }), post({ date: '2025-06-01' })],
      { months: 3, now: NOW },
    );
    assert.deepEqual(series.map((m) => m.count), [0, 0, 1]);
  });

  test('ratio 归一到最大值为 1（图表高度直接用它）', () => {
    const series = monthlyFrequency([
      post({ date: '2025-05-01' }), post({ date: '2025-05-02' }), post({ date: '2025-06-01' }),
    ], { months: 3, now: NOW });
    assert.equal(Math.max(...series.map((m) => m.ratio)), 1);
    assert.equal(series[0].ratio, 0, '4 月没有文章');
    assert.equal(series[1].ratio, 1, '5 月两篇 → 满格');
    assert.equal(series[2].ratio, 0.5, '6 月一篇 → 半格');
  });

  test('全空的输入不产生 NaN（max 兜底为 1）', () => {
    const series = monthlyFrequency([], { months: 3, now: NOW });
    assert.ok(series.every((m) => m.ratio === 0));
  });
});

describe('热门文章', () => {
  test('有 issues 数据时按「评论 ×3 + reaction」排，并如实报告 metric', () => {
    const posts = [post({ slug: 'a', comments: 1 }), post({ slug: 'b' }), post({ slug: 'c' })];
    const { metric, items } = topPosts(posts, {
      comments: { a: { comments: 1, reactions: 0 }, b: { comments: 5, reactions: 2 }, c: { comments: 0, reactions: 0 } },
    });
    assert.equal(metric, 'comments');
    assert.equal(items[0].slug, 'b', '5×3+2 = 17 应排第一');
    assert.equal(items[0].score, 17);
    assert.equal(items[1].slug, 'a');
    assert.equal(items[0].comments, 5, '评论数要如实带出来，不只是排序用');
    assert.equal(items[0].reactions, 2);
  });

  test('没有 issues 数据时退化为按字数排，metric 写 length', () => {
    const { metric, items } = topPosts([
      post({ slug: 'a', wordCount: 10 }), post({ slug: 'b', wordCount: 900 }),
    ]);
    assert.equal(metric, 'length');
    assert.equal(items[0].slug, 'b');
    // 没有数据源时 comments 必须是 null，不能是 0 —— 0 会被读成「确实是 0 条评论」。
    assert.equal(items[0].comments, null);
    assert.equal(items[0].reactions, null);
  });

  test('limit 生效，且不改动入参数组', () => {
    const posts = Array.from({ length: 20 }, (_, i) => post({ slug: `p${i}`, wordCount: i }));
    const snapshot = JSON.parse(JSON.stringify(posts));
    const { items } = topPosts(posts, { limit: 3 });
    assert.equal(items.length, 3);
    assert.deepEqual(posts, snapshot, 'topPosts 不得就地排序入参');
  });

  test('空 comments 对象不被当成「有互动数据」', () => {
    const { metric } = topPosts([post()], { comments: {} });
    assert.equal(metric, 'length');
  });
});

describe('标签分布', () => {
  test('按出现次数降序，ratio 归一到 1', () => {
    const items = tagDistribution([
      post({ tags: ['a', 'b'] }), post({ tags: ['a'] }), post({ tags: ['a'] }),
    ]);
    assert.deepEqual(items.map((i) => [i.name, i.count]), [['a', 3], ['b', 1]]);
    assert.equal(items[0].ratio, 1);
    assert.equal(items[1].ratio, 1 / 3);
  });

  test('同数量的标签按名字排序 —— 顺序必须确定，否则产物不幂等', () => {
    const a = tagDistribution([post({ tags: ['z', 'a'] })]);
    const b = tagDistribution([post({ tags: ['a', 'z'] })]);
    assert.deepEqual(a.map((i) => i.name), b.map((i) => i.name));
    assert.deepEqual(a.map((i) => i.name), ['a', 'z']);
  });

  test('没有标签时返回空数组而不是 null', () => {
    assert.deepEqual(tagDistribution([post()]), []);
  });
});

describe('发文热力图', () => {
  test('按周分列（不是一维数组），每列最多 7 天', () => {
    const heat = dailyHeatmap([post({ date: '2025-06-01' })], { days: 30, now: NOW });
    assert.ok(Array.isArray(heat.weeks));
    assert.ok(heat.weeks.every((w) => w.length <= 7), '一列不该超过 7 天');
    assert.ok(heat.weeks.every((w) => w.every((d) => d.weekday >= 0 && d.weekday <= 6)));
  });

  test('第一列对齐到周日（保证列 = 周的形状成立）', () => {
    const heat = dailyHeatmap([], { days: 30, now: NOW });
    assert.equal(heat.weeks[0][0].weekday, 0, '第一格的星期必须是周日');
  });

  test('终点是今天，count 与 level 都在', () => {
    const heat = dailyHeatmap([post({ date: '2025-06-15' })], { days: 30, now: NOW });
    const all = heat.weeks.flat();
    assert.equal(all[all.length - 1].date, '2025-06-15');
    assert.ok(all.every((d) => typeof d.count === 'number' && typeof d.level === 'number'));
  });

  test('level 是 0~4 的分档（图表配色按它取）', () => {
    const posts = [
      post({ date: '2025-06-01' }),
      post({ date: '2025-06-02' }), post({ date: '2025-06-02' }),
      post({ date: '2025-06-03' }), post({ date: '2025-06-03' }), post({ date: '2025-06-03' }),
      ...Array.from({ length: 5 }, () => post({ date: '2025-06-04' })),
    ];
    const all = dailyHeatmap(posts, { days: 30, now: NOW }).weeks.flat();
    const byDate = Object.fromEntries(all.map((d) => [d.date, d]));
    assert.equal(byDate['2025-06-01'].level, 1);
    assert.equal(byDate['2025-06-02'].level, 2);
    assert.equal(byDate['2025-06-03'].level, 3);
    assert.equal(byDate['2025-06-04'].level, 4);
    assert.equal(byDate['2025-06-05'].level, 0);
  });

  test('total 与 activeDays 与格子一致', () => {
    const heat = dailyHeatmap([
      post({ date: '2025-06-01' }), post({ date: '2025-06-01' }), post({ date: '2025-06-05' }),
    ], { days: 30, now: NOW });
    assert.equal(heat.total, 3);
    assert.equal(heat.activeDays, 2);
    assert.equal(heat.max, 2);
  });
});

describe('连续写作天数', () => {
  test('以最后一个有文章的日期为终点，不以今天为终点', () => {
    // 昨天今天都写 → 2；但「今天还没写」不该惩罚作者。
    const streak = computeStreak([post({ date: '2025-06-13' }), post({ date: '2025-06-14' })]);
    assert.equal(streak.current, 2, '6-13 与 6-14 连着，当前 streak 是 2');
    assert.equal(streak.lastDay, '2025-06-14');
  });

  test('最长 streak 与当前 streak 都算对', () => {
    const posts = [
      post({ date: '2025-01-01' }), post({ date: '2025-01-02' }), post({ date: '2025-01-03' }),
      post({ date: '2025-03-01' }), post({ date: '2025-03-02' }),
    ];
    const streak = computeStreak(posts);
    assert.equal(streak.longest, 3);
    assert.equal(streak.current, 2);
  });

  test('同一天多篇只算一天（去重）', () => {
    const streak = computeStreak([post({ date: '2025-06-01' }), post({ date: '2025-06-01' })]);
    assert.equal(streak.current, 1);
  });

  test('没有文章时是 0 而不是 NaN', () => {
    const streak = computeStreak([]);
    assert.equal(streak.current, 0);
    assert.equal(streak.longest, 0);
    assert.equal(streak.lastDay, null);
  });

  test('只有一篇时 current = longest = 1', () => {
    const streak = computeStreak([post({ date: '2025-06-01' })]);
    assert.deepEqual([streak.current, streak.longest], [1, 1]);
  });
});

describe('写作频率', () => {
  test('平均间隔与每月均篇数', () => {
    const freq = writingFrequency([post({ date: '2025-01-01' }), post({ date: '2025-01-31' })]);
    assert.equal(freq.avgGapDays, 30);
    assert.equal(freq.span.days, 30);
    assert.ok(freq.perMonth > 0);
  });

  test('少于两篇时给 null 而不是 Infinity / NaN', () => {
    for (const input of [[], [post()]]) {
      const freq = writingFrequency(input);
      assert.ok(freq.avgGapDays === null, 'avgGapDays 必须可判空');
      assert.ok(!Number.isNaN(freq.avgGapDays));
    }
  });
});

describe('汇总 buildBuiltinStats', () => {
  const posts = [
    post({ slug: 'a', date: '2025-01-15', tags: ['x'], wordCount: 300 }),
    post({ slug: 'b', date: '2025-03-20', tags: ['x', 'y'], wordCount: 500 }),
  ];

  test('totals 里 pv 永远是 null —— 构建期造不出浏览量', () => {
    const { totals } = buildBuiltinStats(posts, { now: NOW });
    assert.equal(totals.pv, null, 'PV 必须是 null（无数据源），不能是 0');
  });

  test('没有 issues 数据时 comments 是 null，有数据时是数字', () => {
    assert.equal(buildBuiltinStats(posts, { now: NOW }).totals.comments, null);
    const withStats = buildBuiltinStats(posts, {
      now: NOW, comments: { a: { comments: 3, reactions: 1 }, b: { comments: 2, reactions: 0 } },
    });
    assert.equal(withStats.totals.comments, 5);
  });

  test('运行天数从最早一篇算到今天（含首尾）', () => {
    const { totals } = buildBuiltinStats(posts, { now: NOW });
    // 2025-01-15 → 2025-06-15 = 151 天间隔 + 1
    assert.equal(totals.runningDays, 152);
  });

  test('sources 逐项说明数据来源；没有的必须是 null 而不是省略', () => {
    const { sources } = buildBuiltinStats(posts, { now: NOW });
    assert.equal(sources['文章数 / 字数 / 标签'], '构建期内容');
    assert.equal(sources['评论数 / reaction 数'], null);
    assert.equal(sources['浏览量（PV）'], null);
    assert.equal(sources['访问来源'], null);
    assert.ok('访问来源' in sources, '没有来源也必须列出来并说明 —— 不能假装这一栏不存在');
  });

  test('有 issues 数据时 sources 如实改口', () => {
    const { sources } = buildBuiltinStats(posts, { now: NOW, comments: { a: { comments: 1 } } });
    assert.equal(sources['评论数 / reaction 数'], 'GitHub Issues 元数据');
  });

  test('空站点不崩，且各字段形状稳定', () => {
    const stats = buildBuiltinStats([], { now: NOW });
    assert.equal(stats.totals.posts, 0);
    assert.equal(stats.totals.runningDays, 0);
    assert.equal(stats.range.from, null);
    assert.equal(stats.streak.current, 0);
    assert.deepEqual(stats.tags, []);
    assert.ok(Array.isArray(stats.frequency));
  });

  test('retentionDays 透传（页脚要显示它）', () => {
    assert.equal(buildBuiltinStats(posts, { now: NOW, retentionDays: 30 }).retentionDays, 30);
  });

  test('确定性：同一份输入（含 now）永远产出同一份结构', () => {
    const a = buildBuiltinStats(posts, { now: NOW });
    const b = buildBuiltinStats(posts, { now: NOW });
    assert.deepEqual(a, b, '含时间戳/随机的统计会让产物不幂等');
  });
});

describe('toDayKey', () => {
  test('输出 YYYY-MM-DD，且按给定时区（不是 UTC）', () => {
    // UTC 是 2025-01-01T16:00Z，上海时间已是 1 月 2 日 0 点。
    assert.equal(toDayKey('2025-01-01T16:00:00Z', 'Asia/Shanghai'), '2025-01-02');
    assert.equal(toDayKey('2025-01-01T16:00:00Z', 'UTC'), '2025-01-01');
  });

  test('非法日期返回 null（而不是 Invalid Date 字符串）', () => {
    assert.equal(toDayKey('不是日期'), null);
    assert.equal(toDayKey(undefined), null);
  });
});
