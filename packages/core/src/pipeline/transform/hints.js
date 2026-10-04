/**
 * 资源提示（resource hints）与预加载规划。
 *
 * 为什么这一层必须存在，而不是「每个主题自己在 head.html 里写几行 link」：
 * 4 套主题各写一份 `<link rel="preload">` 一定会漂移，而**漂移的表现是
 * 没有表现** —— 漏了一条 preload，页面照常工作，只是白等一个 RTT。
 * 这类退化只有 Lighthouse 的 LCP 数字会变，没人能从页面上看出来。
 *
 * 所以和 SEO 一样：由引擎算出「这一页该提示什么」，主题只负责摆放。
 *
 * ── 什么时候**不**该预加载 ──
 * preload 是最容易被滥用的提示：它把资源提前推进网络队列，优先级高于
 * 浏览器自己的判断。滥用它等于替浏览器做错决定。这里的规则是：
 *
 *   1. **同源、路径以 / 开头**的站内资源才提示 —— 外链预加载等于替第三方
 *      提前发起请求，还会连带把第三方域名的连接提前建立起来（隐私问题）。
 *   2. **只提示本页真的会用到的资源**。列一堆「可能有用」的 URL，
 *      浏览器就要为每个没用的预加载付一次请求。
 *   3. **`onload` 之前不制造额外请求**。prefetch 的是**下一页**（读者还没
 *      决定要不要去），所以它只在下一条可能的路径上出现，且用 prefetch
 *      而不是 preload —— 前者是「空闲时再去拿」，后者是「现在就抢带宽」。
 *
 * ── 与 `seo.js` 的分工 ──
 * seo.js 管「页面说了自己是什么」（meta / JSON-LD / canonical）。
 * 这里管「页面提前告诉浏览器去拿什么」。两者都不该由主题决定。
 */

/**
 * 默认的预取策略。
 *
 * 三条上限都是刻意的，不是随手写的数字：
 *  - `maxPrefetch` 3：一篇长文的「下一批」读者真正点开的通常是最新一篇或
 *    上一篇。给出 3 条是留点余地；给 10 条会让每个访客在空闲时下载 10 个页面。
 *  - 首屏之外的页面不预取：归档页 / 标签总览页是「浏览入口」，
 *    它们的下一跳高度不确定，预取等于替访客猜。文章页的下一跳则相当确定。
 *  - 不预取分类 / 标签页：那是「筛选」而不是「继续读」。
 */
export const PREFETCH_POLICY = Object.freeze({
  maxPrefetch: 3,
  layouts: ['post'],
});

/**
 * 决定一个 URL 能不能作为资源提示的目标。
 *
 * 拒绝集是**白名单反写**：只放行站内绝对路径。这样新出现的一类 URL
 * （比如将来加了 `/api/`）默认是「不提示」，而不是默认「提示」。
 * 默认放行的资源提示，迟早会有人在里面塞一个第三方埋点。
 */
export function isHintable(url) {
  const value = String(url ?? '').trim();
  if (!value) return false;
  // 必须是以单个 / 开头的站内路径。`//host/x` 是协议相对地址，属于外链。
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  // 带 hash 的锚点不是资源；带 query 的可以是（但站内资源通常没有）。
  if (value.startsWith('/#')) return false;
  return true;
}

/**
 * 生成跨页预连接的 `origin` 列表。
 *
 * 为什么会有「跨页」这个需求：站点的 canonical 主机与部署主机可能不是同一个
 * （自定义域名 + Pages 默认域名）。读者先打开任意一页都会建立连接，但
 * **预连接是每页各算一次**，所以这里只按 origin 输出，由调用方决定挂在哪。
 *
 * 只接受 http(s) 且必须与站点自身 origin 不同 —— 把自身 origin 写进
 * preconnect 是纯浪费（DNS/TLS 已经在用了），且 Lighthouse 会判它无效。
 */
export function collectPreconnect(urls, { siteUrl = '' } = {}) {
  const siteOrigin = originOf(siteUrl);
  const seen = new Set();
  for (const url of urls) {
    const origin = originOf(url);
    if (!origin) continue;
    if (origin === siteOrigin) continue;
    seen.add(origin);
  }
  return [...seen];
}

/** 取 origin；非 http(s) 或解析失败返回空串（而不是抛错）。 */
export function originOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * 渲染资源提示标签。
 *
 * 顺序有讲究：preconnect / dns-prefetch 必须排在会用到该连接的东西之前。
 * 这里统一在 `</head>` 前输出，对同域资源足够；跨域资源目前只有站点自身，
 * 所以不做更复杂的位置安排。
 */
export function renderResourceHints({ preconnect = [], prefetch = [], stylesheets = [] } = {}) {
  const lines = [];
  for (const origin of preconnect) {
    lines.push(`<link rel="preconnect" href="${escapeAttr(origin)}" crossorigin />`);
  }
  for (const href of stylesheets.filter(isHintable)) {
    // 外链样式表要提早在 head 中出现，但**不要**用 rel=preload as=style ——
    // 那会让同一个样式表被下载两次（preload 一次、<link rel=stylesheet> 一次）
    // 而第二次命中缓存的前提是服务器给了正确的缓存头。静态托管通常给了，
    // 但这不是我们能在构建期保证的事。所以这里只做「提前声明」。
    lines.push(`<link rel="stylesheet" href="${escapeAttr(href)}" />`);
  }
  for (const href of prefetch.filter(isHintable)) {
    lines.push(`<link rel="prefetch" href="${escapeAttr(href)}" as="document" />`);
  }
  return lines.join('\n');
}

/**
 * 规划一页要预取的「下一页」。
 *
 * 返回绝对站内路径（`/posts/x.html`）。排序即是优先级：
 * 同主题命中多的在前，其次按时间倒序 —— 读者的下一步大概率是
 * 「这个话题里最新的一篇」，而不是「这个话题里最旧的」。
 */
export function planPrefetch({ layout, related = [], newer = null, policy = PREFETCH_POLICY } = {}) {
  if (!policy.layouts.includes(layout)) return [];
  const candidates = [];
  const push = (url) => {
    if (!isHintable(url)) return;
    if (!candidates.includes(url)) candidates.push(url);
  };
  // 上一篇/更新的一篇优先：它最接近「读者读完之后会去的地方」。
  if (newer) push(newer);
  for (const item of related) push(typeof item === 'string' ? item : item?.url);
  return candidates.slice(0, policy.maxPrefetch);
}

function escapeAttr(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}
