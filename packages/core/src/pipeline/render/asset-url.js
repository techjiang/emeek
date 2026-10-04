/**
 * 主题 CSS 里的资源引用改写。
 *
 * 为什么需要它：无 JS 的静态站点里，**唯一的渲染会变慢的地方就是 CSS**。
 * 关键 CSS 内联进 `<head>` 时，里面的 `url(font.woff2)` 仍然是相对主题
 * 目录的路径；外链 CSS 又必须保持相对路径不变 —— 两种落位需要不同的
 * 地址前缀。把这件事交给每个主题自己写 `url(/assets/x)` 是不行的：
 * 主题不知道站点部署在哪个 base path 下（自托管常在 /blog/ 下）。
 *
 * 所以：CSS 由构建期内联时走这里的改写，路径一律**绝对化**到站点根。
 * 绝对路径 + base 前缀的组合由调用方给，主题不参与。
 *
 * 刻意不做的三件事：
 *  1. **不重写 data: / http(s):// / // 开头的地址** —— 它们本来就不该动。
 *  2. **不解析 CSS 语法** —— 只处理 `url(...)` 与 `@import`，用正则。
 *     完整的 CSS 解析要引入 postcss，核心包零依赖是硬约束；而我们要改的
 *     形状是可枚举的（url 函数、单/双引号、无引号三种）。
 *  3. **不动 `#anchor` 与 `data:` 之外的非文件 scheme**（`var(--x)` 不会
 *     出现在 url() 里，出现了也原样保留）。
 */

/** 改写一段 CSS 里所有资源引用。 */
export function rewriteCssUrls(css, { base = '' } = {}) {
  const prefix = base.replace(/\/+$/, '');
  if (!prefix) return String(css);
  let out = String(css);
  // @import "x.css" / @import url(x.css)：先处理，避免 url() 规则先吃掉它。
  out = out.replace(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (full, quote, href) => {
    const mapped = mapHref(href, prefix);
    return mapped === href ? full : `@import url(${quote}${mapped}${quote})`;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/g, (full, quote, href) => {
    const mapped = mapHref(href, prefix);
    return mapped === href ? full : `@import ${quote}${mapped}${quote}`;
  });
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (full, quote, href) => {
    const mapped = mapHref(href, prefix);
    return mapped === href ? full : `url(${quote}${mapped}${quote})`;
  });
  return out;
}

/** 单个地址的映射规则；不该动就原样返回（调用方据此判断是否重写）。 */
export function mapHref(href, prefix) {
  const value = String(href ?? '').trim();
  if (!value) return href;
  // data: / blob: / http(s):// / 协议相对 // / 已有绝对路径 / 纯锚点 / 纯 query
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/#?|#|\?)/i.test(value)) return href;
  const normalized = value.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized) return href;
  return `${prefix}/${normalized}`;
}

/**
 * 关键 CSS 的提取。
 *
 * 真正的「关键 CSS」需要知道首屏用了哪些选择器 —— 那要靠无头浏览器跑一遍
 * （Puppeteer 的 coverage API）。构建期没有浏览器，硬做只能靠启发式：
 * 按选择器名字猜「这条规则是不是首屏的」。
 *
 * 我们不做那个猜测。理由：猜错的表现是**首屏样式缺失**（页面上方一块
 * 无样式的内容闪一下），这比多内联几 KB 糟糕得多；而这里的主题 CSS
 * 本来就小于一个 RTT 的收益阈值（24KB），内联整份反而更快
 * （一个 RTT ≈ 100ms，多传 20KB ≈ 在 4G 上 40ms）。
 *
 * 所以 `criticalCSS` 这个开关的语义是「把主题 CSS 内联进 head」，
 * 而不是「只内联首屏那部分」。**名字与行为必须一致**，所以这里返回的
 * 判断依据是体积，不是选择器。想缩小首屏体积应该去拆 CSS 文件，
 * 而不是在构建期假装能算出关键路径。
 */
export const CRITICAL_CSS_LIMIT = 24 * 1024;

/**
 * 把样式表分成「内联」与「外链」两部分。
 *
 * ── 判据是**总量**，不是单文件 ──
 *
 * 最初的实现是「单个文件超限就外链那一个」。它有一个明显的漏洞：
 * 3 个 20KB 的文件谁都没超限，内联总量却是 60KB —— 而首屏 HTML
 * 的膨胀来自总量，不是来自某一个文件。实测抓到了这个洞：
 * Inkstone（29.9KB）、Magazine（39.9KB）总内联量远超阈值却全部通过。
 *
 * 所以现在按累计字节判断。但**顺序不能按文件名**：按字母序是
 * comments → main → search，于是超限时被踢出去的是**排在后面的**
 * ——Magazine 上就变成「首屏真正要的 main.css 走外链，而只在搜索页
 * 才用得到的 search.css 被内联」。那与「关键 CSS」的目的正好相反：
 * 首屏多一个 RTT，换来的是一个用不到的样式表提前到位。
 *
 * 判据改为**按用途优先级**：
 *   1. main.*  —— 首屏奠基样式，必须在
 *   2. 其余（comments / 主题自定义等）—— 首屏可能用到
 *   3. search.* —— 只有搜索页需要，最后才考虑
 *
 * 同一优先级内保持传入顺序（稳定）。
 */
export function splitCriticalStyles(styles, { limit = CRITICAL_CSS_LIMIT } = {}) {
  const priority = (style) => {
    const name = String(style.name ?? '');
    if (/^main\./.test(name)) return 0;
    if (/^search\./.test(name)) return 2;
    return 1;
  };
  const ordered = styles
    .map((style, index) => ({ style, index }))
    .sort((a, b) => priority(a.style) - priority(b.style) || a.index - b.index)
    .map((entry) => entry.style);

  const inline = [];
  const external = [];
  let used = 0;
  for (const style of ordered) {
    const bytes = Buffer.byteLength(style.content);
    if (used + bytes > limit) external.push({ ...style, bytes });
    else {
      inline.push({ ...style, bytes });
      used += bytes;
    }
  }
  return { inline, external, inlineBytes: used };
}
