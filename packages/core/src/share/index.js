/**
 * 社交分享（P3-4b-rest C）—— 构建期算好，运行时零第三方依赖。
 *
 * ── 为什么分享归「引擎」而不是「主题」──
 *
 * 4 套主题各写一份分享链接拼接，结果一定是四份略有差异的实现
 * （有的忘了编码标题、有的把 UTM 拼错位置、有的加了 target 忘了 rel）。
 * 而这些差异**不会让任何测试变红** —— 只有真去点分享的人才会发现
 * 「分享到微博时标题是乱码」。
 *
 * 所以链接拼接、UTM、平台可用性判断全部在这里；
 * 主题只负责把 `shareView` 渲染成按钮，并按自己的设计写样式。
 *
 * ── 微信二维码 ──
 *
 * 微信没有 web 分享端点，唯一可行的是扫码。而二维码需要编码算法。
 * 不引第三方 QR 库（那会破「零外部请求」），所以编码器自己写
 * （见 qr.js，纯函数、可单测），渲染在浏览器端用 Canvas 画
 * （见 client.js）。构建期只决定「要不要出这个按钮」。
 */

import { resolvePlatforms, buildShareItem, appendUtm, PLATFORM_IDS } from './platforms.js';

export { SHARE_PLATFORMS, PLATFORM_IDS, getPlatform, appendUtm, buildShareItem, resolvePlatforms } from './platforms.js';
export { encodeQr, qrMatrix, QR_CAPACITY } from './qr.js';

/** 分享位置。bottom = 文章底部；sidebar = 侧栏浮动；both = 两处都放。 */
export const SHARE_POSITIONS = ['bottom', 'sidebar', 'both'];

/**
 * 组装一篇文章的分享视图。
 *
 * @param {object} post   构建期文章（需要 title 与 canonical）
 * @param {object} config 站点配置（读 share.*）
 * @returns {object|null} null 表示这一页不出分享按钮
 */
export function buildShareView(post = {}, config = {}) {
  const share = config.share ?? {};
  // 默认**关闭**：分享按钮会在页面上占一块，而「要不要让别人分享我的文章」
  // 是作者的偏好，不是引擎该替他决定的。默认为关与 analytics 同一哲学。
  if (share.enabled !== true) return null;

  const rawUrl = post.url ?? post.canonical ?? null;
  const absolute = /^https?:\/\//i.test(String(rawUrl ?? ''));
  // 分享地址必须是绝对地址 —— 社交平台是在**它自己的域名**下抓这个链接的，
  // 相对地址（/posts/hello.html）会让抓取直接失败。所以这里优先用 canonical，
  // 没有 canonical 才退回 post.url，并且用一个显式标记告诉上层「这个地址
  // 分享出去可能打不开」，而不是悄悄拼一个坏链接。
  const shareUrl = appendUtm(post.canonical ?? post.url ?? '', {
    source: share.utm_source === undefined ? 'emeek' : share.utm_source,
    medium: share.utm_medium === undefined ? 'social' : share.utm_medium,
    campaign: share.utm_campaign ?? null,
  });

  const { items: ids, unknown } = resolvePlatforms(share.platforms);
  const items = ids
    .map((id) => buildShareItem(id, { url: shareUrl, title: post.title ?? '' }))
    .filter(Boolean);

  if (!items.length) return null;

  return {
    items,
    // 位置。默认 bottom —— 侧栏浮动在手机上会遮内容，不该是默认。
    position: SHARE_POSITIONS.includes(share.position) ? share.position : 'bottom',
    // 桌面端是否额外给一个侧边浮动条。
    sidebar: share.position === 'sidebar' || share.position === 'both',
    bottom: share.position === 'bottom' || share.position === 'both' || !share.position,
    /**
     * 分享地址是否真的是绝对地址。false 时页面上会给一句提示
     * （只在 dev 构建里），而不是发一个点开 404 的分享链接。
     */
    absolute,
    url: shareUrl,
    title: post.title ?? '',
    // 是否有需要浏览器端的按钮（微信二维码 / 复制链接）。
    needsClient: items.some((item) => item.wechat || item.copy),
    unknown,
    label: share.label ?? '分享',
  };
}

/** 分享的浏览器端脚本（微信二维码 Canvas 绘制 + 复制链接）。 */
export { SHARE_CLIENT } from './client.js';
