/**
 * 社交分享平台注册表（P3-4b-rest C）。
 *
 * ── 为什么这里只有「拼 URL」这一件事 ──
 *
 * 分享按钮的常见做法是引入各家 SDK（Twitter widgets.js、微博 share.js…）。
 * 每个 SDK 都是：一段从**别人域名**加载的脚本、一条对自己页面的读取权限、
 * 一份会随版本漂移的 DOM 注入。而它们提供的全部能力，就是把
 * `https://twitter.com/intent/tweet?url=...` 塞进一个 <a href>。
 *
 * 所以 Emeek 的分享按钮是**纯 <a> 标签**：零第三方 JS，零第三方请求，
 * 不加载任何 SDK。每个平台只是「一个把标题与地址拼进查询串的函数」。
 *
 * 这样做的第二个好处：它是**纯函数**，可以在构建期算好并断言。
 * SDK 方案里「分享链接对不对」只能靠人肉点一遍。
 *
 * ── UTM 参数 ──
 *
 * 分享出去的地址会带 utm_source / utm_medium —— 目的是让站点自己的分析
 * 能区分「从社交平台来的」与「直接访问」。注意这是**拼在分享链接里**，
 * 不影响站内自己的 URL（站点不需要给自己加 UTM）。
 */

/**
 * 平台描述符。
 *
 *   id      配置里写的名字（share.platforms 数组里用）
 *   label   按钮上的字
 *   intent  是否跳转到外部站点（复制链接与微信不走跳转）
 *   build   纯函数：(ctx) => URL 或 null
 *
 * `build` 返回 null 表示「这个平台在当前参数下不可用」——例如微博需要
 * 标题、有些平台不接受带 UTM 的地址。调用方据此**整条不渲染**按钮，
 * 而不是渲染一个 href 为空串、点了没反应的按钮。
 */
export const SHARE_PLATFORMS = [
  {
    id: 'twitter',
    label: 'Twitter',
    intent: true,
    build: ({ url, title }) => `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(title)}`,
  },
  {
    id: 'weibo',
    label: '微博',
    intent: true,
    // 微博的 title 参数是必填的：不填时分享出去的卡片没有标题。
    build: ({ url, title }) => `https://service.weibo.com/share/share.php?url=${enc(url)}&title=${enc(title)}`,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    intent: true,
    build: ({ url, title }) => `https://t.me/share/url?url=${enc(url)}&text=${enc(title)}`,
  },
  {
    id: 'reddit',
    label: 'Reddit',
    intent: true,
    build: ({ url, title }) => `https://reddit.com/submit?url=${enc(url)}&title=${enc(title)}`,
  },
  {
    id: 'hackernews',
    label: 'Hacker News',
    intent: true,
    build: ({ url, title }) => `https://news.ycombinator.com/submitlink?u=${enc(url)}&t=${enc(title)}`,
  },
  {
    id: 'email',
    label: '邮件',
    intent: true,
    // mailto 走系统邮件客户端。body 里放标题 + 地址而不是正文 ——
    // 正文可能很长，多数邮件客户端会对超长 mailto 截断，截断位置不确定。
    build: ({ url, title }) => `mailto:?subject=${enc(title)}&body=${enc(url)}`,
  },
  {
    id: 'wechat',
    label: '微信',
    // 微信没有 web 分享端点（这是产品决定，不是我们没想到）。
    // 唯一可用的方式是「扫码」：按钮点击后在本地画出当前地址的二维码。
    intent: false,
    build: () => null,
  },
  {
    id: 'copy',
    label: '复制链接',
    intent: false,
    build: () => null,
  },
];

export const PLATFORM_IDS = SHARE_PLATFORMS.map((p) => p.id);

const BY_ID = new Map(SHARE_PLATFORMS.map((p) => [p.id, p]));

export function getPlatform(id) {
  return BY_ID.get(id) ?? null;
}

/** 与 encodeURIComponent 的区别：空格编成 %20 而不是 +，多数平台两边都认，但 %20 更稳。 */
function enc(value) {
  return encodeURIComponent(String(value ?? ''));
}

/**
 * 给分享地址拼 UTM。
 *
 * 只在**本来就是绝对地址**时拼。相对地址拼 UTM 之后再交给社交平台，
 * 平台抓到的会是一个 404 —— 而「分享出去的链接打不开」是分享功能
 * 唯一真正致命的错误。所以这里对相对地址直接原样返回，
 * 由 buildShareView 决定要不要警告。
 */
export function appendUtm(url, { source = 'emeek', medium = 'social', campaign = null } = {}) {
  const text = String(url ?? '');
  if (!/^https?:\/\//i.test(text)) return text;
  const u = new URL(text);
  if (source) u.searchParams.set('utm_source', source);
  if (medium) u.searchParams.set('utm_medium', medium);
  if (campaign) u.searchParams.set('utm_campaign', campaign);
  // 保留已有查询串（URL 会自己处理），但去掉 hash 后的重复查询不会发生。
  return u.toString();
}

/**
 * 一个平台一项的完整定义。
 *
 * 返回 { id, label, href, intent, needsQr, needsClipboard }，
 * href 为 null 且 needsQr/needsClipboard 也为假时表示这个平台在当前
 * 参数下不可用 —— 调用方据此跳过它。
 */
export function buildShareItem(id, ctx = {}) {
  const platform = getPlatform(id);
  if (!platform) return null;
  const href = platform.build(ctx);
  return {
    id,
    label: platform.label,
    href,
    // 外部跳转才加 target=_blank + rel=noopener：站内锚点（复制/二维码）
    // 不需要，加了反而会让「复制」这种按钮变成新标签页。
    external: Boolean(href) && platform.intent,
    wechat: id === 'wechat',
    copy: id === 'copy',
  };
}

/**
 * 解析 `share.platforms` 配置。
 *
 * 未知名字**不静默丢弃**：返回 { items, unknown }，由调用方决定告警。
 * 静默丢弃的代价是「我配了 reddit，但它没出现」，而用户会以为是
 * 主题没做这个样式，于是去改主题 —— 错的方向。
 */
export function resolvePlatforms(platforms) {
  const list = Array.isArray(platforms) && platforms.length ? platforms : ['copy'];
  const items = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of list) {
    const id = String(raw).trim();
    if (!id) continue;
    if (seen.has(id)) continue; // 重复配置去重，不报错（无害）
    seen.add(id);
    if (!getPlatform(id)) { unknown.push(id); continue; }
    items.push(id);
  }
  return { items, unknown };
}
