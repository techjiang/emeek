import { VERSION } from '../version.js';

/**
 * RSS 2.0 与 Atom 1.0 生成。
 *
 * 为什么两份都要：
 *   RSS 2.0 是老阅读器的通用语言（Feedly / Inoreader / 各种桌面客户端），
 *   Atom 1.0 是 IETF 标准，对日期、内容类型、多语言的处理更严谨。
 *   只发一份总有人订不上 —— 这不是「多此一举」，是「别让读者挑工具」。
 *
 * 两份由同一份数据生成（feedItems），避免 RSS 与 Atom 的内容不一致 ——
 * 那种不一致用户看不出来（他只用其中一个），但会让「订阅数」对不上。
 *
 * 日期一律输出 RFC 3339 / RFC 822 双格式：
 *   RSS   pubDate 要 RFC 822（toUTCString）
 *   Atom  updated 要 RFC 3339（toISOString）
 *   中文站点常见的问题是只写本地格式（2024年1月1日），验证器直接判不合法。
 */

/** XML 文本转义。比 escapeHtml 严：属性与文本都要，且处理控制字符。 */
export function escapeXml(text) {
  return String(text ?? '')
    // XML 1.0 不允许这些控制字符（除了 \t \n \r）。留在里面会让解析器报错。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 把文章列表整理成 feed 条目（两种格式共用）。
 *
 * @param {object} site
 * @param {Array} posts
 * @param {object} [options]
 *   limit        最多几条，默认 20
 *   fullContent  是否输出正文全文（RSS 的 content:encoded / Atom 的 content）
 *   categories   只要这些分类的文章（空 = 全部）
 *   feedUrl      本 feed 的地址（用于 atom:link / atom:link rel=self）
 * @returns {{items: Array, filtered: number}}
 */
export function feedItems(site, posts = [], { limit = 20, fullContent = false, categories = [], feedUrl } = {}) {
  const wanted = categories.map((c) => String(c).toLowerCase());
  const selected = wanted.length
    ? posts.filter((post) => (post.categories ?? []).some((c) => wanted.includes(String(c).toLowerCase())))
    : posts;

  const items = selected.slice(0, limit).map((post) => {
    const url = `${site.url}${post.url}`;
    const date = new Date(post.date);
    const updated = new Date(post.updated ?? post.date);
    const categories_ = [...(post.categories ?? []), ...(post.tags ?? [])].map(String);
    return {
      title: post.title,
      url,
      guid: url,
      // description 用于 RSS 的 <description>：没有正文时给摘要，
      // 有正文时也给摘要 —— 阅读器列表页只显示这一段。
      summary: post.description ?? '',
      // content 是正文全文。fullContent 关掉时给 null，
      // 阅读器就会只显示 description（省流量，也是很多站长的选择）。
      content: fullContent ? (post.html ?? post.description ?? '') : null,
      published: Number.isNaN(date.getTime()) ? new Date() : date,
      updated: Number.isNaN(updated.getTime()) ? new Date() : updated,
      author: post.author ?? site.author,
      categories: categories_,
      feedUrl,
    };
  });

  return { items, filtered: selected.length };
}

/** RSS 2.0。 */
export function buildRss(site, posts, options = {}) {
  const { limit = 20, fullContent = false, categories = [] } = options;
  const { items } = feedItems(site, posts, options);
  const feedUrl = `${site.url}/rss.xml`;
  const lastBuild = items[0]?.updated ?? new Date();

  const body = items.map((item) => [
    '    <item>',
    `      <title>${escapeXml(item.title)}</title>`,
    `      <link>${escapeXml(item.url)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>`,
    `      <pubDate>${item.published.toUTCString()}</pubDate>`,
    `      <description>${escapeXml(item.summary)}</description>`,
    // content:encoded 需要这个命名空间。只有真的输出全文时才声明 ——
    // 声明了却不用，验证器会提示冗余命名空间。
    ...(item.content ? [`      <content:encoded><![CDATA[${cdataSafe(item.content)}]]></content:encoded>`] : []),
    ...item.categories.map((c) => `      <category>${escapeXml(c)}</category>`),
    ...(item.author ? [`      <author>${escapeXml(item.author)}</author>`] : []),
    '    </item>',
  ].join('\n')).join('\n');

  const ns = item0HasContent(items)
    ? ' xmlns:content="http://purl.org/rss/1.0/modules/content/"'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"${ns}>
  <channel>
    <title>${escapeXml(site.title)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>${escapeXml(site.description)}</description>
    <language>${escapeXml(site.language)}</language>
    <lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>
    <generator>Emeek ${VERSION}</generator>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${body}
  </channel>
</rss>
`;
}

/** Atom 1.0。 */
export function buildAtom(site, posts, options = {}) {
  const { fullContent = false } = options;
  const { items } = feedItems(site, posts, options);
  const feedUrl = `${site.url}/atom.xml`;
  const updated = items[0]?.updated ?? new Date();

  const entries = items.map((item) => [
    '  <entry>',
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link rel="alternate" type="text/html" href="${escapeXml(item.url)}" />`,
    `    <id>${escapeXml(item.guid)}</id>`,
    // Atom 的 updated 必须是 RFC 3339（toISOString 就是这个格式）。
    // 用 toUTCString 会得到 RFC 822，Atom 验证器直接判不合法。
    `    <updated>${item.updated.toISOString()}</updated>`,
    `    <published>${item.published.toISOString()}</published>`,
    `    <summary type="text">${escapeXml(item.summary)}</summary>`,
    ...(item.content ? [`    <content type="html">${escapeXml(item.content)}</content>`] : []),
    ...(item.author ? [`    <author><name>${escapeXml(item.author)}</name></author>`] : []),
    ...item.categories.map((c) => `    <category term="${escapeXml(c)}" />`),
    '  </entry>',
  ].join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(site.title)}</title>
  <subtitle>${escapeXml(site.description)}</subtitle>
  <link rel="alternate" type="text/html" href="${escapeXml(site.url)}" />
  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}" />
  <id>${escapeXml(site.url)}</id>
  <updated>${updated.toISOString()}</updated>
  <generator>Emeek ${VERSION}</generator>
  <author><name>${escapeXml(site.author ?? site.title)}</name></author>
${entries}
</feed>
`;
}

function item0HasContent(items) {
  return items.some((item) => item.content);
}

/**
 * CDATA 里不能出现 `]]>`。
 * 官方做法是拆成 `]]]]><![CDATA[>`。不处理的话，正文里只要出现这个
 * 序列（写代码文档时很常见），整个 feed 就是坏 XML。
 */
function cdataSafe(html) {
  return String(html ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>');
}
