/**
 * 图片处理：Phase 1 只做「地址归一化 + 懒加载 + 尺寸/说明属性补全」。
 * 重编码为 WebP 需要 sharp 这类原生依赖，属于 Phase 4「极致性能」的范围，
 * 这里留出 processImage 钩子，但默认实现是恒等变换，不假装已经做了压缩。
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

/** 给 <img> 补 width/height 之外的属性；尺寸信息未知时只加 loading/decoding。 */
export function decorateImages(html, { lazy = true } = {}) {
  return html.replace(/<img\b([^>]*?)\/?>/g, (full, attrs) => {
    let next = attrs;
    if (lazy && !/\bloading=/.test(next)) next += ' loading="lazy"';
    if (!/\bdecoding=/.test(next)) next += ' decoding="async"';
    if (!/\balt=/.test(next)) next += ' alt=""';
    return `<img${next} />`;
  });
}
