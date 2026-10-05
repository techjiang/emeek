/**
 * 统计页图表：**纯 SVG，构建期算好坐标**。
 *
 * 为什么不用图表库、也不在客户端画：
 *   1. 统计页是「门面」。一个需要 30KB JS 才能显示柱子的门面，
 *      与 Emeek「零依赖、零追踪」的承诺自相矛盾。
 *   2. 图表的数据是构建期就算完的（builtin.js），坐标自然也该在这一步定下来。
 *      把数据序列化进 HTML 再让客户端算一遍，多出来的 JS 换不到任何东西。
 *   3. 没有 JS 的 SVG 对爬虫/阅读器/打印都是可读的 —— <title>/<desc> 里
 *      写着真实数值，屏幕阅读器能念出来。canvas 做不到这一点。
 *
 * 几个贯穿所有图表的硬规则：
 *   · **不编数据。** 数据为空时返回空字符串，由页面决定显示「无数据」还是
 *     整块不渲染。绝不给一个全 0 的图 —— 那看起来像「有数据，只是都是 0」。
 *   · **确定性。** 同一份输入永远产出同一份字节（无时间戳、无随机 id）。
 *     否则产物幂等测试会红，而且每次构建的 diff 都会变。
 *   · **无外部引用。** 颜色全部用 CSS 变量（currentColor / var(--accent)），
 *     主题换色不需要重算图表。
 *   · viewBox + preserveAspectRatio 做响应式：图表自己缩放，不靠媒体查询。
 */

/** SVG 属性/文本转义。图表标签来自文章标题与标签名 —— 都是用户内容。 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 保留 n 位小数并去掉尾随 0 —— 让产物字节稳定。 */
function n(value, digits = 2) {
  const rounded = Number(value).toFixed(digits);
  return rounded.replace(/\.?0+$/, '') || '0';
}

/**
 * 柱状图（月度发文频率）。
 *
 * 空数据 → 返回空字符串。**不画一根 0 高的柱子** ——
 * 那在视觉上是「这个月发了 0 篇」，而实际上可能是「根本没有数据」。
 */
export function barChart(series = [], { width = 720, height = 200, label = '发文频率' } = {}) {
  if (!Array.isArray(series) || !series.length) return '';
  const padX = 8;
  const padTop = 16;
  const padBottom = 28;
  const plotH = height - padTop - padBottom;
  const slot = (width - padX * 2) / series.length;
  const barW = Math.max(2, Math.min(28, slot * 0.6));
  const max = Math.max(1, ...series.map((s) => Number(s.count) || 0));

  const bars = series.map((item, i) => {
    const count = Number(item.count) || 0;
    // 有数据但为 0 的月份画一条 2px 的底座，与「没有这一列」区分开。
    const h = count === 0 ? 2 : Math.max(2, (count / max) * plotH);
    const x = padX + slot * i + (slot - barW) / 2;
    const y = padTop + plotH - h;
    const title = `${esc(item.year ?? '')}年${esc(item.label ?? '')}：${count} 篇`;
    return `<g class="chart-bar"><title>${title}</title>`
      + `<rect x="${n(x)}" y="${n(y)}" width="${n(barW)}" height="${n(h)}" rx="2" `
      + `class="bar${count ? '' : ' bar-empty'}" data-count="${count}"></rect>`
      + (count ? `<text x="${n(x + barW / 2)}" y="${n(y - 4)}" text-anchor="middle" class="chart-value">${count}</text>` : '')
      + `<text x="${n(x + barW / 2)}" y="${height - padBottom + 16}" text-anchor="middle" class="chart-label">${esc(item.label ?? '')}</text>`
      + '</g>';
  }).join('');

  const total = series.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
  return `<svg class="chart chart-bars" viewBox="0 0 ${width} ${height}" role="img" `
    + `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(label)}">`
    + `<title>${esc(label)}</title><desc>近 ${series.length} 个月共 ${total} 篇</desc>`
    + `<line x1="${padX}" y1="${padTop + plotH}" x2="${width - padX}" y2="${padTop + plotH}" class="chart-axis"></line>`
    + bars
    + '</svg>';
}

/** 折线图（累计篇数）。带面积填充，用同一个 path，不用渐变避免主题差异。 */
export function lineChart(points = [], { width = 720, height = 180, label = '累计发文' } = {}) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const padX = 8;
  const padTop = 14;
  const padBottom = 26;
  const plotH = height - padTop - padBottom;
  const max = Math.max(1, ...points.map((p) => Number(p.value) || 0));
  const step = (width - padX * 2) / (points.length - 1);

  const coords = points.map((p, i) => [padX + step * i, padTop + plotH - ((Number(p.value) || 0) / max) * plotH]);
  const path = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)},${n(y)}`).join(' ');
  const area = `${path} L${n(coords[coords.length - 1][0])},${padTop + plotH} L${n(coords[0][0])},${padTop + plotH} Z`;
  const last = coords[coords.length - 1];

  const labels = points.map((p, i) => (i % Math.ceil(points.length / 6) === 0
    ? `<text x="${n(padX + step * i)}" y="${height - padBottom + 16}" text-anchor="middle" class="chart-label">${esc(p.label ?? '')}</text>`
    : '')).join('');

  return `<svg class="chart chart-line" viewBox="0 0 ${width} ${height}" role="img" `
    + `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(label)}">`
    + `<title>${esc(label)}</title><desc>共 ${points[points.length - 1].value} 篇</desc>`
    + `<path d="${area}" class="chart-area"></path><path d="${path}" class="chart-stroke"></path>`
    + `<circle cx="${n(last[0])}" cy="${n(last[1])}" r="3" class="chart-dot"></circle>`
    + `<line x1="${padX}" y1="${padTop + plotH}" x2="${width - padX}" y2="${padTop + plotH}" class="chart-axis"></line>`
    + labels
    + '</svg>';
}

/**
 * 饼图 / 环形图（标签分布 Top N + 「其它」）。
 *
 * 扇区从 12 点方向顺时针排。占比 < 0.5% 的扇区在视觉上只是一条线，
 * 所以调用方应先把长尾归到「其它」（extraLabel），这个函数不替它决定。
 *
 * 只画一个圆的那一份（也就是 100%）时不画饼 —— 一个整圆读不出任何信息，
 * 却会让人以为「分布均匀」。返回空字符串，让页面显示有序列表。
 */
export function pieChart(items = [], { size = 220, thickness = 46, label = '标签分布', centerLabel = '次引用' } = {}) {
  if (!Array.isArray(items) || items.length < 2) return '';
  const total = items.reduce((sum, i) => sum + (Number(i.count) || 0), 0);
  if (total <= 0) return '';

  const r = size / 2;
  const inner = r - thickness;
  const cx = r;
  const cy = r;
  let angle = -Math.PI / 2; // 12 点方向起

  const slices = items.map((item, i) => {
    const frac = (Number(item.count) || 0) / total;
    const sweep = frac * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    // 整圆用一个 <circle> —— 两个半圆路径在 sweep=2π 时会退化成同一点。
    if (frac >= 0.9999) {
      return `<circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" class="slice slice-0" `
        + `stroke-width="${thickness}"><title>${esc(item.name)}：${item.count}</title></circle>`;
    }
    const x0 = cx + Math.cos(a0) * r;
    const y0 = cy + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r;
    const y1 = cy + Math.sin(a1) * r;
    const xi1 = cx + Math.cos(a1) * inner;
    const yi1 = cy + Math.sin(a1) * inner;
    const xi0 = cx + Math.cos(a0) * inner;
    const yi0 = cy + Math.sin(a0) * inner;
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M${n(x0)},${n(y0)} A${r},${r} 0 ${large} 1 ${n(x1)},${n(y1)} L${n(xi1)},${n(yi1)} `
      + `A${inner},${inner} 0 ${large} 0 ${n(xi0)},${n(yi0)} Z`;
    const pct = Math.round(frac * 1000) / 10;
    return `<path d="${d}" class="slice slice-${i % 8}" data-name="${esc(item.name)}">`
      + `<title>${esc(item.name)}：${item.count} 篇（${pct}%）</title></path>`;
  }).join('');

  return `<svg class="chart chart-pie" viewBox="0 0 ${size} ${size}" role="img" `
    + `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(label)}">`
    + `<title>${esc(label)}</title><desc>共 ${items.length} 个分类，合计 ${total} 次出现</desc>`
    + `<g transform="rotate(-90 ${cx} ${cy})">${slices}</g>`
    + `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="chart-center-value">${total}</text>`
    + `<text x="${cx}" y="${cy + 16}" text-anchor="middle" class="chart-center-label">${esc(centerLabel)}</text>`
    + '</svg>';
}

/**
 * 发文热力图（365 天）。
 *
 * 列 = 周，行 = 星期。格子尺寸在构建期定死，用 viewBox 缩放 ——
 * 手机上一屏能看到整年（格子小到看不清数字，但形状可读，
 * 而那正是热力图的主要用途：看密度，不看具体哪天）。
 */
export function heatmapChart(heatmap, { cell = 11, gap = 3, label = '发文热力图', monthsLabel = true } = {}) {
  if (!heatmap || !Array.isArray(heatmap.weeks) || !heatmap.weeks.length) return '';
  const weeks = heatmap.weeks.length;
  const width = weeks * (cell + gap);
  const height = 7 * (cell + gap) + (monthsLabel ? 16 : 0);
  const offsetY = monthsLabel ? 16 : 0;

  const cells = heatmap.weeks.flatMap((week, col) => week.map((day, row) => {
    const x = col * (cell + gap);
    const y = offsetY + row * (cell + gap);
    const title = `${esc(day.date)}：${day.count} 篇`;
    return `<rect x="${n(x)}" y="${n(y)}" width="${cell}" height="${cell}" rx="2" `
      + `class="heat heat-${day.level}" data-date="${esc(day.date)}" data-count="${day.count}"><title>${title}</title></rect>`;
  })).join('');

  // 月份标在「该月第一次出现的列」上。用 1 号所在的列算，而不是第一列 ——
  // 不然一年的第一个月标签会贴在最左边，与实际位置差半格。
  const monthMarks = [];
  let lastMonth = null;
  heatmap.weeks.forEach((week, col) => {
    const first = week[0]?.date;
    if (!first) return;
    const month = first.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      monthMarks.push(`<text x="${n(col * (cell + gap))}" y="10" class="chart-label">${Number(month.slice(5))}月</text>`);
    }
  });

  return `<svg class="chart chart-heatmap" viewBox="0 0 ${width} ${height}" role="img" `
    + `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(label)}">`
    + `<title>${esc(label)}</title><desc>${esc(heatmap.start)} 至 ${esc(heatmap.end)}，共 ${heatmap.total} 篇，${heatmap.activeDays} 天有更新</desc>`
    + monthMarks.join('')
    + cells
    + '</svg>';
}

/**
 * 词云（标签）。用「字号 + 不透明度」双重编码权重 ——
 * 只靠字号时，权重差 2 倍的两个标签看起来一样大；
 * 只靠颜色时，在黑白主题下完全没有区分度。
 *
 * 布局不做碰撞检测（那需要真正的布局算法）。这里用「按权重从大到小、
 * 依次流式排布 + 自动换行」—— 结果不如专业词云紧凑，但它是确定性的
 * （同输入同输出），这对产物幂等是硬要求。
 */
export function wordCloud(items = [], { width = 720, lineHeight = 40, minSize = 11, maxSize = 26, max = 40 } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const list = items.slice(0, max);
  const maxCount = Math.max(1, ...list.map((i) => Number(i.count) || 0));
  const rows = [];
  let row = [];
  let rowWidth = 0;

  for (const item of list) {
    const ratio = (Number(item.count) || 0) / maxCount;
    const size = Math.round(minSize + ratio * (maxSize - minSize));
    // 中文按全角估宽（size ≈ 字宽），英文按 0.55 估 —— 都是估算，
    // 目的是换行位置大致对，不需要精确排版。
    const chars = [...String(item.name)];
    const textWidth = chars.reduce((sum, ch) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55), 0);
    const wordWidth = textWidth + 20;
    if (rowWidth + wordWidth > width && row.length) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push({ ...item, size, ratio, textWidth });
    rowWidth += wordWidth;
  }
  if (row.length) rows.push(row);

  const parts = rows.map((items2, rowIndex) => {
    const y = lineHeight * rowIndex + lineHeight * 0.75;
    let x = 0;
    return items2.map((item) => {
      // font-size 走 SVG 属性（无单位 = 用户单位）而不是内联 style 的 px：
      // 内联 px 不参与 viewBox 缩放，于是 SVG 缩放与字号各算一次，
      // 实测结果是词云在宽屏上被放大到整页高度。
      const el = `<text x="${n(x)}" y="${n(y)}" class="cloud-word" `
        + `font-size="${item.size}" fill-opacity="${n(0.45 + item.ratio * 0.55)}" `
        + `data-tag="${esc(item.name)}" data-count="${item.count}">${esc(item.name)}</text>`;
      x += item.textWidth + 20;
      return el;
    }).join('');
  }).join('');

  const height = rows.length * lineHeight;
  // viewBox 宽度按**实际用到的宽度**收窄，而不是永远 720。
  //
  // 这是一个真实的渲染 bug 的修复：`.stats-chart svg { width: 100% }` 会把
  // viewBox 放大到容器宽度。只有 3 个词时它们本来只占 200 单位，却因为
  // viewBox 是 720 而被拉成 1.6 倍 —— 词云在宽屏上变成 48px 的巨字。
  // 收窄 viewBox 之后，缩放比回到 ≈1，字号就是设计的字号。
  const usedWidth = Math.round(Math.min(width, Math.max(1, ...rows.map((r) => r.reduce((sum, i) => sum + i.textWidth + 20, 0)))));
  // width/height 属性给的是**固有尺寸**：CSS 的 `svg { width: 100% }`
  // 会把它拉到容器宽度，1 个用户单位就变成 >1px，字号跟着被放大。
  // 词云是唯一一个「不该拉伸」的图表（拉伸 = 改字号 = 改信息量），
  // 所以给它显式的固有宽度，主题 CSS 里对 .chart-cloud 用 max-width 而不是 width。
  return `<svg class="chart chart-cloud" width="${usedWidth}" height="${height}" `
    + `viewBox="0 0 ${usedWidth} ${height}" role="img" `
    + `preserveAspectRatio="xMinYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="标签云">`
    + `<title>标签云</title><desc>共 ${list.length} 个标签</desc>`
    + parts
    + '</svg>';
}

/**
 * 水平条形榜（热门文章 / 来源）。
 *
 * 排行榜刻意**不用**饼图：饼图在「前两名差 1%」时读不出排序，
 * 而排行榜的全部价值就是排序。条形图的长度是线性可比的。
 *
 * 每一项是一个 <a>（如果给了 url）—— 排行榜点不动是很别扭的。
 */
export function rankedBars(items = [], {
  max = 10, label = '排行', valueSuffix = '', showRank = true, decimals = 0,
} = {}) {
  // valueSuffix 支持两个位置：函数选项（整榜统一，如 ' 次'）与
  // 单项字段 `item.valueSuffix`（逐项不同，如「36 字 / 3 评论」）。
  // 只支持前者时，调用方在项上写的 valueSuffix 会被静默丢掉 ——
  // 表现是「配了单位但页面上没有单位」，非常难查。
  if (!Array.isArray(items) || !items.length) return '';
  const list = items.slice(0, max);
  const maxValue = Math.max(1, ...list.map((i) => Number(i.value) || 0));
  const rows = list.map((item, i) => {
    const value = Number(item.value) || 0;
    const ratio = value / maxValue;
    // 项级 valueSuffix 优先于函数级 —— 越具体的覆盖越通用的。
    const suffix = item.valueSuffix !== undefined ? item.valueSuffix : valueSuffix;
    const inner = `<span class="rank-bar" style="--ratio:${n(ratio, 4)}" aria-hidden="true"></span>`
      + `<span class="rank-value">${n(value, decimals)}${esc(suffix)}</span>`;
    const body = `<span class="rank-title">${esc(item.title)}</span>${inner}`;
    return `<li class="rank-item">`
      + (showRank ? `<span class="rank-index" aria-hidden="true">${i + 1}</span>` : '')
      + (item.url ? `<a class="rank-link" href="${esc(item.url)}">${body}</a>` : `<span class="rank-link">${body}</span>`)
      + (item.meta ? `<span class="rank-meta">${esc(item.meta)}</span>` : '')
      + '</li>';
  }).join('');
  return `<ol class="rank-list" aria-label="${esc(label)}">${rows}</ol>`;
}
