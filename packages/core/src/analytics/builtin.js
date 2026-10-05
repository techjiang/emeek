/**
 * 内置极简分析：**全部在构建期算出来**。
 *
 * 这是 Emeek 相对其它静态博客引擎的基因优势 —— 内容本来就在 GitHub 上，
 * 所以「有多少篇、什么时候写的、哪些标签多、哪篇讨论热」这些问题的答案
 * 已经躺在内容里了，不需要任何运行时依赖，也不需要把访客的 IP 抄下来。
 *
 * 三条边界必须说清（否则这张报表就是在编）：
 *
 *   1. **没有 PV。** 浏览量是运行时事实，构建期造不出来。
 *      函数不返回 pv 字段 —— 而不是返回 0。区别在于：0 会被渲染成
 *      「浏览 0」，读者以为站点没人看；缺失会被渲染成「本项无数据源」。
 *   2. **评论数 / reaction 数只在 Issues 源下存在。** local 源的文章
 *      没有这两个数字，聚合时按「有数据的文章」算，并如实标注样本量。
 *   3. **来源 Top 10 完全不存在。** 那需要 referer，只有服务端才有。
 *
 * 所有函数都是纯函数（posts 数组进，数据出来），因此可以直接断言，
 * 也可以在编辑器/CLI 里复用。
 */

/** 本地日期的 YYYY-MM-DD。刻意不用 toISOString —— 那是 UTC，跨时区会差一天。 */
export function toDayKey(date, timezone = 'Asia/Shanghai') {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // Intl 的 en-CA 输出恰好是 YYYY-MM-DD，比自己拼 padStart 少一处出错机会。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * 月度发文频率。**补零**：没有文章的月份也要出现，否则柱状图的 x 轴
 * 会被压缩成「只有有文章的月份」，看起来像是每月都在发。
 * 这是「图好看」与「图诚实」的交点 —— 补零既是美观也是诚实。
 */
export function monthlyFrequency(posts = [], { months = 12, now = new Date(), timezone = 'Asia/Shanghai' } = {}) {
  const buckets = new Map();
  const anchor = new Date(now);
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, 0);
  }
  for (const post of posts) {
    const day = toDayKey(post.date, timezone);
    if (!day) continue;
    const key = day.slice(0, 7);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  const max = Math.max(1, ...buckets.values());
  return [...buckets.entries()].map(([key, count]) => ({
    key,
    label: `${Number(key.slice(5))}月`,
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5)),
    count,
    ratio: count / max,
  }));
}

/**
 * 热门文章 Top N。
 *
 * 排序依据按**有没有互动数据**分两种，不是拍脑袋：
 *   有 issues 数据 → 评论数 + reactions，讨论热度
 *   没有           → 字数（读者投入时间的代理量）
 * 并把依据写进返回值的 `metric`，让页面能如实标注「按 X 排序」。
 * 一个不写排序依据的「热门」榜单是在骗人。
 */
export function topPosts(posts = [], { limit = 10, comments = null } = {}) {
  const hasInteractions = comments && typeof comments === 'object'
    && Object.values(comments).some((v) => v && (v.comments || v.reactions));

  const scored = posts.map((post) => {
    const stat = hasInteractions ? (comments[post.slug] ?? comments[String(post.issueNumber ?? '')] ?? {}) : {};
    const commentCount = Number(stat.comments ?? 0) || 0;
    const reactionCount = Number(stat.reactions ?? 0) || 0;
    return {
      title: post.title,
      url: post.url,
      date: post.date,
      slug: post.slug,
      comments: hasInteractions ? commentCount : null,
      reactions: hasInteractions ? reactionCount : null,
      wordCount: Number(post.wordCount ?? 0) || 0,
      score: hasInteractions ? commentCount * 3 + reactionCount : Number(post.wordCount ?? 0) || 0,
    };
  });

  scored.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return {
    metric: hasInteractions ? 'comments' : 'length',
    items: scored.slice(0, limit),
  };
}

/** 标签分布（含量）。返回全部，排序后的 —— 词云需要权重，列表需要顺序。 */
export function tagDistribution(posts = []) {
  const map = new Map();
  for (const post of posts) {
    for (const tag of post.tags ?? []) {
      const key = String(tag);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  const items = [...map.entries()].map(([name, count]) => ({ name, count }));
  items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const max = Math.max(1, ...items.map((i) => i.count));
  return items.map((item) => ({ ...item, ratio: item.count / max }));
}

/**
 * 365 天发文热力图。
 *
 * 返回的是**按周分列**的网格（GitHub 贡献图那种形状），不是一维数组 ——
 * 因为「按周分列」是二维渲染的输入形状，让渲染端去数第几天是周几，
 * 等于把日历知识分散到四套主题里，四份里一定有一份算错。
 *
 * 起始日对齐到周日，保证第一列是完整的周。
 */
export function dailyHeatmap(posts = [], { days = 365, now = new Date(), timezone = 'Asia/Shanghai' } = {}) {
  const counts = new Map();
  for (const post of posts) {
    const day = toDayKey(post.date, timezone);
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const todayKey = toDayKey(now, timezone);
  const today = new Date(`${todayKey}T00:00:00Z`);
  const cells = [];
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  // 对齐到周日：getUTCDay() 返回 0 就是周日。
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const cursor = new Date(start);
  while (cursor <= today) {
    const key = cursor.toISOString().slice(0, 10);
    const count = counts.get(key) ?? 0;
    cells.push({ date: key, count, level: heatLevel(count), weekday: cursor.getUTCDay() });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const total = cells.reduce((sum, c) => sum + c.count, 0);
  const activeDays = cells.filter((c) => c.count > 0).length;
  return {
    weeks,
    total,
    activeDays,
    max: Math.max(0, ...cells.map((c) => c.count)),
    start: cells[0]?.date ?? null,
    end: todayKey,
  };
}

/** 热力等级：0 表示没有，1~4 按密度分档。阈值写死，保证 4 套主题同一份数据同一张图。 */
function heatLevel(count) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

/**
 * 连续写作天数（streak）。以「最后一个有文章的日期」为终点往回数 ——
 * 而不是以今天为终点：以今天为终点的话，一个作者昨天发了文但今天还没写，
 * streak 会显示 0，那是在惩罚「今天还没到写作时间」。
 */
export function computeStreak(posts = [], { timezone = 'Asia/Shanghai' } = {}) {
  const days = [...new Set(posts.map((p) => toDayKey(p.date, timezone)).filter(Boolean))].sort();
  if (!days.length) return { current: 0, longest: 0, lastDay: null };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    const prev = new Date(`${days[i - 1]}T00:00:00Z`);
    const curr = new Date(`${days[i]}T00:00:00Z`);
    const gap = Math.round((curr - prev) / 86400000);
    run = gap === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // 末尾那一段就是当前 streak。
  let current = 1;
  for (let i = days.length - 1; i > 0; i -= 1) {
    const prev = new Date(`${days[i - 1]}T00:00:00Z`);
    const curr = new Date(`${days[i]}T00:00:00Z`);
    if (Math.round((curr - prev) / 86400000) !== 1) break;
    current += 1;
  }
  return { current, longest, lastDay: days[days.length - 1] };
}

/** 写作频率：平均间隔天数 + 每月均篇数。没有文章时返回 null 而不是 NaN/Infinity。 */
export function writingFrequency(posts = []) {
  if (posts.length < 2) return { avgGapDays: null, perMonth: posts.length ? null : 0, span: null };
  const times = posts.map((p) => new Date(p.date).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  if (times.length < 2) return { avgGapDays: null, perMonth: null, span: null };
  const spanDays = Math.round((times[times.length - 1] - times[0]) / 86400000);
  const avgGapDays = spanDays / (times.length - 1);
  return {
    avgGapDays: Math.round(avgGapDays * 10) / 10,
    perMonth: spanDays > 0 ? Math.round((times.length / (spanDays / 30)) * 10) / 10 : times.length,
    span: { from: toDayKey(new Date(times[0])), to: toDayKey(new Date(times[times.length - 1])), days: spanDays },
  };
}

/**
 * 汇总。
 *
 * `sources` 是这张报表诚实性的关键：它如实列出每个区块的数据来源，
 * 以及哪些区块因为**没有数据源**而缺失。页面上「数据来源」那一行
 * 直接读它 —— 报表要说清自己是谁算的。
 */
export function buildBuiltinStats(posts = [], {
  comments = null,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  months = 12,
  heatmapDays = 365,
  topLimit = 10,
  retentionDays = null,
} = {}) {
  const sorted = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date));
  const hasInteractions = Boolean(comments) && Object.keys(comments).length > 0;

  const dates = sorted.map((p) => toDayKey(p.date, timezone)).filter(Boolean).sort();
  const firstDay = dates[0] ?? null;
  const lastDay = dates[dates.length - 1] ?? null;
  const runningDays = firstDay
    ? Math.max(1, Math.round((new Date(`${toDayKey(now, timezone)}T00:00:00Z`) - new Date(`${firstDay}T00:00:00Z`)) / 86400000) + 1)
    : 0;

  return {
    totals: {
      posts: sorted.length,
      // 评论/浏览的可获得性如实标注：null 表示「没有数据源」，0 表示「有数据源，是 0」。
      comments: hasInteractions
        ? Object.values(comments).reduce((sum, v) => sum + (Number(v?.comments ?? 0) || 0), 0)
        : null,
      pv: null, // 构建期永远算不出 PV —— 见本文件顶部第 1 条边界。
      runningDays,
      words: sorted.reduce((sum, p) => sum + (Number(p.wordCount ?? 0) || 0), 0),
      tags: new Set(sorted.flatMap((p) => p.tags ?? [])).size,
    },
    frequency: monthlyFrequency(sorted, { months, now, timezone }),
    top: topPosts(sorted, { limit: topLimit, comments }),
    tags: tagDistribution(sorted),
    heatmap: dailyHeatmap(sorted, { days: heatmapDays, now, timezone }),
    streak: computeStreak(sorted, { timezone }),
    writing: writingFrequency(sorted),
    range: { from: firstDay, to: lastDay },
    generatedAt: toDayKey(now, timezone),
    retentionDays,
    sources: {
      '文章数 / 字数 / 标签': '构建期内容',
      '发文频率 / 热力图 / 连续天数': '构建期内容',
      '评论数 / reaction 数': hasInteractions ? 'GitHub Issues 元数据' : null,
      '浏览量（PV）': null,
      '访问来源': null,
    },
  };
}
