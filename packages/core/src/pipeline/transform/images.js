/**
 * 图片处理：地址归一化 + 懒加载 + alt 兜底 + 首屏优先级提示。
 *
 * 重编码为 WebP 需要 sharp 这类原生依赖，属于 Phase 4「极致性能」的范围，
 * 这里留出 processImage 钩子，但默认实现是恒等变换，不假装已经做了压缩。
 * 没有做的事就不写进产物 —— 假的 `srcset` 比没有 srcset 更糟，
 * 浏览器会真的去请求那些并不存在的尺寸。
 */
export function createImageResolver({ baseUrl = '', assetBase = '' } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  return (url) => {
    const value = String(url).trim();
    if (/^(?:https?:|data:|mailto:|#)/i.test(value)) return value;
    if (value.startsWith('/')) {
      if (assetBase && value.startsWith(assetBase)) return `${root}${value}`;
      return `${root}${value}`;
    }
    return `${root}/${value.replace(/^\.\//, '')}`;
  };
}

/** 首屏图片数量：第一张图按 eager + fetchpriority=high 处理，其余懒加载。 */
export const EAGER_IMAGE_COUNT = 1;

/**
 * 给 `<img>` 补属性。
 *
 * 三件事：
 *  1. **首屏图不能被懒加载**。`loading="lazy"` 用在前 1~2 张图上，
 *     会让「最快内容绘制」反而变慢 —— LCP 图片通常就是首屏那张。
 *     所以第一张图给 `eager` + `fetchpriority="high"`，其余 lazy。
 *  2. **alt 兜底不能是空字符串**。空 alt 让图片对屏幕阅读器与图片搜索
 *     完全消失。没有 alt 时从文件名/父级链接文字提取一个可读的兜底
 *     （见 `deriveAlt`），并附 `data-alt-inferred` 标记，便于 SEO 自检
 *     区分「作者写了 alt」与「引擎猜的 alt」。
 *  3. `decoding="async"` 让图片解码不阻塞主线程。
 */
export function decorateImages(html, { lazy = true, eagerCount = EAGER_IMAGE_COUNT, responsive = false, variantsBySrc = {}, dimensionsBySrc = {} } = {}) {
  let index = 0;
  return html.replace(/<img\b([^>]*?)\/?>/g, (full, attrs) => {
    const isEager = index < eagerCount;
    index += 1;
    let next = attrs;

    // 响应式属性**在最前面**处理：它可能要补 width/height/srcset，
    // 而 alt 兜底与 loading 判断都在后面，互不干扰但顺序要固定（产物可复现）。
    if (responsive || Object.keys(dimensionsBySrc).length) {
      next = decorateResponsive(next, { responsive, variantsBySrc, dimensionsBySrc });
    }

    if (!/\bdecoding=/.test(next)) next += ' decoding="async"';

    // `loading` 必须**改写**而不是「没有才补」。
    // Markdown 渲染器一律先写上 loading="lazy"（它不知道哪张是首屏图），
    // 于是首屏图会同时拿到 loading="lazy" 与 fetchpriority="high" ——
    // 两个属性互相矛盾，浏览器按 lazy 处理，**LCP 反而更慢**。
    // 这个组合曾经真实存在于产物里，而且看起来「属性都齐了」。
    const desiredLoading = isEager ? 'eager' : (lazy ? 'lazy' : null);
    if (desiredLoading) {
      next = /\bloading="/.test(next)
        ? next.replace(/\bloading="[^"]*"/, `loading="${desiredLoading}"`)
        : `${next} loading="${desiredLoading}"`;
    }

    if (isEager && !/\bfetchpriority=/.test(next)) next += ' fetchpriority="high"';

    // `alt` 同理：Markdown 渲染器对 `![](...)` 会写出 `alt=""`，
    // 而空 alt 让图片对屏幕阅读器与图片搜索**完全消失**。
    // 只判断「有没有 alt 属性」会把这个空串当成「作者写过了」，兜底永远不触发。
    const altMatch = /\balt="([^"]*)"/.exec(next);
    const hasRealAlt = altMatch && altMatch[1].trim() !== '';
    if (!hasRealAlt) {
      const derived = deriveAlt(next);
      // 作者写了空 alt 也算「作者的决定」吗？不算 —— `![]()` 的空 alt 通常是
      // 忘了写，极少是「这是装饰图，故意留空」。装饰图的正确写法是
      // `role="presentation"`，而不是一个裸的空 alt。所以这里一律替换，
      // 并用 data-alt-inferred 标出「这是引擎推的，不是作者写的」。
      next = altMatch
        ? next.replace(/\balt="[^"]*"/, `alt="${escapeAttr(derived)}"`)
        : `${next} alt="${escapeAttr(derived)}"`;
      next += ' data-alt-inferred="true"';
    }
    return `<img${next} />`;
  });
}

import { decorateResponsive } from './responsive.js';

/**
 * 从图片地址推一个可读的 alt。
 *
 * 为什么要有兜底：alt 是图片搜索的唯一入口，也是屏幕阅读器用户的唯一信息来源。
 * 但**推导出来的 alt 不等于作者写的 alt** —— 所以调用方会用
 * `data-alt-inferred` 把它标出来，SEO 自检会把它算成「待补」而非「已填」。
 * 悄悄替作者编一个 alt 并通过自己的检查，是自欺。
 */
export function deriveAlt(attrs) {
  const src = (/\bsrc="([^"]*)"/.exec(attrs) ?? [])[1] ?? '';
  const filename = decodeURIComponent(src.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '');
  if (!filename) return '';
  return filename
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeAttr(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}
