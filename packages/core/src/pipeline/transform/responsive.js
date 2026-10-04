/**
 * 响应式图片的**诚实版本**。
 *
 * 任务书要求「图片自动 WebP + 响应式 srcset」。编码这件事需要 sharp / libvips
 * 这类原生依赖，核心包零依赖的约束下做不了 —— 所以这里做的不是编码，而是
 * 两件真的能提升 LCP、且**不会说谎**的事：
 *
 *   1. **已知原始尺寸时补 `width` / `height`** —— 这是 CLS 最大的一块来源。
 *      没有尺寸的图在加载完成时会把正文往下顶一次；有尺寸但 CSS 没写
 *      `height: auto` 时图像会被压扁。两个属性一起给，浏览器就能在图片
 *      到达之前把位置预留好，CLS 直接归零。
 *
 *   2. **只在作者声明的候选集里生成 `srcset`** —— 候选来自 front-matter
 *      或配置，不是我们猜的。`/x-800.webp` 这种「猜出来」的地址如果不存在，
 *      浏览器会真的去请求并拿到 404：假 srcset 比没有 srcset 更糟，
 *      它把「一张图能显示」换成了「可能一张都显示不出来」。
 *
 * 所以 `responsiveImages: false`（默认）时这一层完全不介入，图片原样输出。
 * 打开它需要项目自己提供候选集：写配置文件里的 `perf.imageVariants`。
 *
 * 这就是「不做的事就不写进产物」—— 与 images.js 里那句注释同一条规矩。
 */

/** 从 src 里拆出「目录 / 文件名 / 扩展名」，便于按候选宽度重命名。 */
export function splitVariant(src, width) {
  const value = String(src);
  const dot = value.lastIndexOf('.');
  const slash = value.lastIndexOf('/');
  if (dot <= slash) return `${value}-${width}`;
  return `${value.slice(0, dot)}-${width}${value.slice(dot)}`;
}

/**
 * 按候选集把一张图变成 `srcset`。
 *
 * @param {string} src             原图地址（同时作为 srcset 的兜底项）
 * @param {Array<{width:number,url?:string,type?:string}>} variants 候选
 * @returns {string} srcset 属性值；候选为空时返回空串（调用方不写这个属性）
 */
export function buildSrcset(src, variants = []) {
  const entries = [];
  for (const variant of variants) {
    const width = Number(variant?.width);
    if (!Number.isFinite(width) || width <= 0) continue;
    const url = variant.url ?? splitVariant(src, width);
    entries.push(`${url} ${width}w`);
  }
  // 原图本身也算一个候选：没有它时，浏览器可能选出一个比原始文件更大的
  // 「候选」（如果作者把 variants 写成了放大版）。重复宽度要去重。
  const seen = new Set(entries.map((e) => e.split(' ')[1]));
  const original = detectWidth(src);
  if (original && !seen.has(`${original}w`)) entries.push(`${src} ${original}w`);
  if (!entries.length) return '';
  return entries.join(', ');
}

/**
 * 从文件名里认宽度（`photo-1600.webp` → 1600，`@2x` → 不认）。
 *
 * 刻意只认「结尾数字」这一种形态：更激进的猜测（比如从 800x600 里取第一段）
 * 会在 `2024-01-15-why.md` 这类文件名上误判成 2024 宽。宁可少认几个，
 * 也不要在 srcset 里写出一个假的宽度描述符 —— 描述符错了，浏览器
 * 会按错误的比例选图，选出来的图要么模糊要么过大。
 */
export function detectWidth(src) {
  const m = /[-_/](\d{2,5})(?=\.[a-z0-9]+$)/i.exec(String(src));
  if (!m) return null;
  const width = Number(m[1]);
  return width >= 16 && width <= 8192 ? width : null;
}

/**
 * 给一批图片属性补 `width` / `height` / `srcset` / `sizes`。
 *
 * `sizes` 只有给了 srcset 才有意义 —— 浏览器靠它决定选哪个候选。
 * 不给 sizes 时默认按 `100vw` 处理，那对正文里的图通常偏大，
 * 于是移动端会选一个没必要的大图。所以只要生成了 srcset，就一定给 sizes。
 */
export function decorateResponsive(attrs, { variantsBySrc = {}, sizes = '(max-width: 800px) 100vw, 800px', dimensionsBySrc = {}, responsive = false } = {}) {
  let next = attrs;
  const src = (/\bsrc="([^"]*)"/.exec(next) ?? [])[1] ?? '';
  if (!src) return next;

  const width = dimensionsBySrc[src]?.width;
  const height = dimensionsBySrc[src]?.height;
  if (Number.isFinite(width) && Number.isFinite(height)) {
    if (!/\bwidth=/.test(next)) next += ` width="${width}"`;
    if (!/\bheight=/.test(next)) next += ` height="${height}"`;
    // 有 width/height 但没有对应 CSS 时，图片会被拉伸成属性尺寸。
    // 这条内联样式是**必要的**，不是「顺手加的样式」。
    if (!/\bstyle=/.test(next)) next += ' style="height:auto"';
  }

  if (!responsive) return next;

  const variants = variantsBySrc[src] ?? [];
  const srcset = buildSrcset(src, variants);
  if (srcset && !/\bsrcset=/.test(next)) {
    next += ` srcset="${escapeAttr(srcset)}"`;
    if (!/\bsizes=/.test(next)) next += ` sizes="${escapeAttr(sizes)}"`;
  }
  return next;
}

function escapeAttr(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}
