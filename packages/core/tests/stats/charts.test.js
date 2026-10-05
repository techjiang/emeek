import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  barChart, lineChart, pieChart, heatmapChart, wordCloud, rankedBars, esc,
} from '../../src/stats/charts.js';

/** 所有图表都必须守住的四条纪律。 */
const CHART_RULES = [
  ['barChart', () => barChart([{ label: '1月', count: 1, year: 2025 }])],
  ['lineChart', () => lineChart([{ label: 'a', value: 1 }, { label: 'b', value: 2 }])],
  ['pieChart', () => pieChart([{ name: 'a', count: 1 }, { name: 'b', count: 2 }])],
  ['heatmapChart', () => heatmapChart({
    weeks: [[{ date: '2025-01-01', count: 1, level: 1, weekday: 0 }]],
    total: 1, activeDays: 1, start: '2025-01-01', end: '2025-01-01',
  })],
  ['wordCloud', () => wordCloud([{ name: 'a', count: 2 }, { name: 'b', count: 1 }])],
];

describe('图表纪律（四条）', () => {
  for (const [name, make] of CHART_RULES) {
    test(`${name}：确定性 —— 同输入同字节（产物幂等的前提）`, () => {
      assert.equal(make(), make());
    });

    test(`${name}：无外部引用（不引脚本、不引外部资源）`, () => {
      const svg = make();
      assert.ok(!/<script/.test(svg), '图表里不得有脚本');
      assert.ok(!/xlink:href|href="http/.test(svg), '不得引用外部资源');
      assert.ok(!/@import|url\(http/.test(svg), '不得引入外部 CSS');
    });

    test(`${name}：有 role=img 与 aria-label（屏幕阅读器可读）`, () => {
      const svg = make();
      assert.match(svg, /role="img"/);
      assert.match(svg, /aria-label="[^"]+"/);
      assert.match(svg, /<title>/);
      assert.match(svg, /<desc>/);
    });

    test(`${name}：viewBox 存在（响应式靠它，不靠媒体查询）`, () => {
      assert.match(make(), /viewBox="[^"]+"/);
    });
  }
});

describe('★ 不编数据：空数据返回空字符串，而不是全 0 的图', () => {
  test('barChart 空数组 → 空串', () => {
    assert.equal(barChart([]), '');
    assert.equal(barChart(null), '');
    assert.equal(barChart(undefined), '');
  });

  test('lineChart 少于两点 → 空串（一点画不出线，两点才能）', () => {
    assert.equal(lineChart([]), '');
    assert.equal(lineChart([{ label: 'a', value: 1 }]), '');
  });

  test('pieChart 只有一项 → 空串（整圆读不出分布，是误导）', () => {
    assert.equal(pieChart([{ name: 'a', count: 5 }]), '');
    assert.equal(pieChart([]), '');
  });

  test('pieChart 全部 count 为 0 → 空串（不能画一个「都是 0」的环）', () => {
    assert.equal(pieChart([{ name: 'a', count: 0 }, { name: 'b', count: 0 }]), '');
  });

  test('heatmapChart 空 weeks → 空串', () => {
    assert.equal(heatmapChart({ weeks: [] }), '');
    assert.equal(heatmapChart(null), '');
  });

  test('wordCloud 空 → 空串', () => {
    assert.equal(wordCloud([]), '');
  });

  test('rankedBars 空 → 空串', () => {
    assert.equal(rankedBars([]), '');
  });
});

describe('柱状图', () => {
  const series = [
    { key: '2025-01', label: '1月', year: 2025, count: 0, ratio: 0 },
    { key: '2025-02', label: '2月', year: 2025, count: 3, ratio: 1 },
    { key: '2025-03', label: '3月', year: 2025, count: 1, ratio: 0.333 },
  ];

  test('每个月一根柱子（补零的月份也要有位置）', () => {
    const svg = barChart(series);
    assert.equal((svg.match(/<g class="chart-bar">/g) ?? []).length, 3);
  });

  test('0 篇的月份给 bar-empty 类，并在 <title> 里如实说 0 篇', () => {
    const svg = barChart(series);
    assert.match(svg, /bar-empty/);
    assert.match(svg, /2025年1月：0 篇/);
  });

  test('有值的柱子高度大于底座（2px）', () => {
    const svg = barChart(series);
    const heights = [...svg.matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(heights.some((h) => h > 2), '至少有一根是真的柱子');
  });

  test('每根柱子都带 count 数据属性（便于 e2e 断言）', () => {
    const svg = barChart(series);
    assert.equal((svg.match(/data-count="/g) ?? []).length, 3);
  });
});

describe('折线图', () => {
  test('路径只有一个 M，其余全是 L（一条连续线）', () => {
    const svg = lineChart([{ label: 'a', value: 1 }, { label: 'b', value: 3 }, { label: 'c', value: 2 }]);
    const d = /class="chart-stroke"[^>]* d="([^"]+)"/.exec(svg) ?? /d="([^"]+)" class="chart-stroke"/.exec(svg);
    assert.ok(d, '必须有一条描边路径');
    assert.equal((d[1].match(/M/g) ?? []).length, 1);
    assert.equal((d[1].match(/L/g) ?? []).length, 2);
  });

  test('面积路径以 Z 闭合（面积填充不能漏底）', () => {
    const svg = lineChart([{ label: 'a', value: 1 }, { label: 'b', value: 3 }]);
    const area = /class="chart-area"[^>]* d="([^"]+)"/.exec(svg) ?? /d="([^"]+)" class="chart-area"/.exec(svg);
    assert.ok(area, '必须有面积路径');
    assert.match(area[1], /Z$/);
  });

  test('坐标不含 NaN（零值也要落在轴上）', () => {
    const svg = lineChart([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]);
    assert.ok(!/NaN/.test(svg), 'NaN 坐标会让整条线消失，且不报错');
  });
});

describe('环形图', () => {
  test('扇区数与条目数一致', () => {
    const svg = pieChart([{ name: 'a', count: 5 }, { name: 'b', count: 3 }, { name: 'c', count: 2 }]);
    assert.equal((svg.match(/class="slice slice-/g) ?? []).length, 3);
  });

  test('每个扇区的 <title> 里有名称、数量与百分比', () => {
    const svg = pieChart([{ name: '甲', count: 3 }, { name: '乙', count: 1 }]);
    assert.match(svg, /甲：3 篇（75%）/);
    assert.match(svg, /乙：1 篇（25%）/);
  });

  test('接近 100% 的那一项用 <circle> 而不是退化的弧', () => {
    const svg = pieChart([{ name: 'a', count: 1000000 }, { name: 'b', count: 1 }]);
    assert.match(svg, /<circle[^>]*class="slice slice-0"/);
  });

  test('中心数字是标签引用总次数', () => {
    const svg = pieChart([{ name: 'a', count: 30 }, { name: 'b', count: 12 }]);
    assert.match(svg, /class="chart-center-value">42</);
  });

  test('中心标签可定制（默认「次引用」而不是含糊的「合计」）', () => {
    assert.match(pieChart([{ name: 'a', count: 1 }, { name: 'b', count: 1 }]), /次引用/);
    const custom = pieChart([{ name: 'a', count: 1 }, { name: 'b', count: 1 }], { centerLabel: '发文' });
    assert.match(custom, />发文</);
  });
});

describe('热力图', () => {
  const heat = {
    weeks: [
      [{ date: '2025-01-01', count: 0, level: 0, weekday: 0 }, { date: '2025-01-02', count: 2, level: 2, weekday: 1 }],
      [{ date: '2025-01-05', count: 5, level: 4, weekday: 0 }],
    ],
    total: 7, activeDays: 2, start: '2025-01-01', end: '2025-01-05',
  };

  test('每格都带 date 与 count 数据属性', () => {
    const svg = heatmapChart(heat);
    assert.equal((svg.match(/data-date="/g) ?? []).length, 3);
    assert.equal((svg.match(/data-count="/g) ?? []).length, 3);
  });

  test('level 落在 0~4 且写进 class（配色靠它）', () => {
    const svg = heatmapChart(heat);
    for (const level of [0, 2, 4]) assert.match(svg, new RegExp(`heat heat-${level}`));
  });

  test('desc 里如实写出区间与总数', () => {
    const svg = heatmapChart(heat);
    assert.match(svg, /2025-01-01 至 2025-01-05/);
    assert.match(svg, /共 7 篇/);
    assert.match(svg, /2 天有更新/);
  });

  test('形状按周分列：同一列的格子 x 相同、y 递增', () => {
    const svg = heatmapChart(heat);
    const cells = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.equal(cells[0][0], cells[1][0], '同一周两格的 x 必须相同');
    assert.ok(cells[1][1] > cells[0][1], '同一周内 y 递增（行 = 星期）');
  });
});

describe('词云', () => {
  const tags = [
    { name: 'Emeek', count: 12 }, { name: '主题', count: 8 }, { name: '性能', count: 3 }, { name: 'a', count: 1 },
  ];

  test('字号随权重单调不减（排序正确）', () => {
    const svg = wordCloud(tags);
    const parsed = [...svg.matchAll(/font-size="(\d+)"[^>]*data-count="(\d+)"/g)]
      .map((m) => ({ size: Number(m[1]), count: Number(m[2]) }));
    assert.ok(parsed.length >= 3, '应至少渲染 3 个词');
    for (let i = 1; i < parsed.length; i += 1) {
      assert.ok(parsed[i - 1].size >= parsed[i].size, '字号必须随 count 单调不减');
    }
  });

  test('★ font-size 走 SVG 属性而不是内联 px（内联 px 不参与 viewBox 缩放，会叠加放大）', () => {
    const svg = wordCloud(tags);
    assert.match(svg, /font-size="\d+"/);
    assert.ok(!/style="font-size/.test(svg), '内联 style 的 px 会让词云在宽屏上被放大数倍');
  });

  test('★ viewBox 宽度收窄到实际占用宽度（否则 3 个词被拉成巨字）', () => {
    const few = wordCloud([{ name: 'a', count: 1 }, { name: 'b', count: 1 }]);
    const many = wordCloud(Array.from({ length: 30 }, (_, i) => ({ name: `tag${i}`, count: 30 - i })));
    const widthOf = (svg) => Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
    assert.ok(widthOf(few) < 720, '少量词时 viewBox 不该仍是最宽的 720');
    assert.ok(widthOf(few) <= widthOf(many));
  });

  test('上限 max 生效（词太多时不无限变高）', () => {
    const svg = wordCloud(Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, count: 1 })), { max: 5 });
    assert.equal((svg.match(/data-tag="/g) ?? []).length, 5);
  });

  test('权重同时编码在字号与不透明度上（只靠字号在黑白下分不出）', () => {
    assert.match(wordCloud(tags), /fill-opacity="/);
  });
});

describe('排行榜', () => {
  const items = [
    { title: '第一', url: '/a', value: 100 },
    { title: '第二', url: '/b', value: 50 },
  ];

  test('有 url 的项渲染成 <a>（排行榜点不动很别扭）', () => {
    assert.match(rankedBars(items, { label: '榜' }), /<a class="rank-link" href="\/a">/);
  });

  test('没有 url 的项退化成 <span>（不给死链接）', () => {
    assert.match(rankedBars([{ title: 'x', value: 1 }], { label: '榜' }), /<span class="rank-link">/);
  });

  test('顺序就是传入顺序（排序是调用方的责任，图表不重排）', () => {
    const svg = rankedBars(items, { label: '榜' });
    assert.ok(svg.indexOf('第一') < svg.indexOf('第二'));
  });

  test('条宽由 --ratio 驱动（构建期算好，不靠 JS 量元素）', () => {
    const svg = rankedBars(items, { label: '榜' });
    assert.match(svg, /--ratio:1/);
    assert.match(svg, /--ratio:0.5/);
    assert.ok(!/<script/.test(svg));
  });

  test('showRank=false 时不渲染序号', () => {
    assert.ok(!/rank-index/.test(rankedBars(items, { label: '榜', showRank: false })));
    assert.match(rankedBars(items, { label: '榜', showRank: true }), /rank-index/);
  });

  test('★ 数值与单位各只出现一次（不得在 value 与 meta 里重复）', () => {
    const svg = rankedBars([{ title: 'a', url: '/a', value: 36, valueSuffix: ' 字' }], { label: '榜' });
    assert.equal((svg.match(/36/g) ?? []).length, 1, '数值只出现一次');
    // 单位也要只出现一次。实测踩过：把 suffix 拼两遍时，
    // 只查「36 出现几次」的断言仍然是绿的 —— 重复的是单位，不是数字。
    // 所以断言必须落在**整个 rank-value 的文本**上。
    const value = /<span class="rank-value">([^<]*)<\/span>/.exec(svg)[1];
    assert.equal(value, '36 字', `排行数值文本应为「36 字」，实际「${value}」`);
  });

  test('项级 valueSuffix 覆盖函数级（逐项单位不同的场景）', () => {
    const svg = rankedBars([
      { title: 'a', value: 3, valueSuffix: ' 评论' },
      { title: 'b', value: 5 },
    ], { label: '榜', valueSuffix: ' 次' });
    assert.match(svg, /3 评论/);
    assert.match(svg, /5 次/, '没有项级 suffix 时用函数级的');
  });

  test('空 meta 不产生空 span（会多出一个间隙）', () => {
    const svg = rankedBars([{ title: 'a', value: 1, meta: '' }], { label: '榜' });
    assert.ok(!/<span class="rank-meta"><\/span>/.test(svg));
  });
});

describe('转义', () => {
  test('esc 覆盖五个 HTML 危险字符', () => {
    assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  test('★ 标题里的 HTML 被转义（标签名来自用户内容）', () => {
    const svg = barChart([{ label: '<img src=x onerror=alert(1)>', count: 1, year: 2025 }]);
    assert.ok(!/<img /.test(svg), '标签名里的 HTML 必须被转义');
    assert.match(svg, /&lt;img/);
  });

  test('★ 排行榜标题里的 HTML 被转义', () => {
    const svg = rankedBars([{ title: '</span><script>alert(1)</script>', value: 1 }], { label: '榜' });
    assert.ok(!/<script>alert/.test(svg));
    assert.match(svg, /&lt;\/span&gt;/);
  });

  test('★ 词云的标签名被转义', () => {
    const svg = wordCloud([{ name: '"><x>', count: 1 }, { name: 'b', count: 1 }]);
    assert.ok(!/<x>/.test(svg));
    assert.match(svg, /&quot;&gt;&lt;x&gt;/);
  });
});
