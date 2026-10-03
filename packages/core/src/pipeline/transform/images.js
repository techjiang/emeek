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
export function decorateImages(html, { lazy = true, eagerCount = EAGER_IMAGE_COUNT } = {}) {
  let index = 0;
  return html.replace(/<img\b([^>]*?)\/?>/g, (full, attrs) => {
    const isEager = index < eagerCount;
    index += 1;
    let next = attrs;

    if (!/\bdecoding=/.test(next)) next += ' decoding="async"';
    if (isEager) {
      // 首屏图：显式声明不懒加载，并抬高抓取优先级。
      if (!/\bloading=/.test(next)) next += ' loading="eager"';
      if (!/\bfetchpriority=/.test(next)) next += ' fetchpriority="high"';
    } else if (lazy && !/\bloading=/.test(next)) {
      next += ' loading="lazy"';
    }

    if (!/\balt=/.test(next)) {
      const derived = deriveAlt(next);
      next += ` alt="${escapeAttr(derived)}" data-alt-inferred="true"`;
    }
    return `<img${next} />`;
  });
}

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
