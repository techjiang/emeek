import { escapeHtml, stripTags } from './toc.js';

/**
 * SEO 全量输出层。
 *
 * 这一层的职责是「让内容被搜索引擎正确理解」：
 * sitemap / robots / canonical / Open Graph / Twitter Card / JSON-LD。
 *
 * 三条自我约束：
 *  1. 所有字段**从真实数据生成**。没有封面图就不输出 og:image，
 *     没有作者就不输出 author —— 编造一个占位值比缺字段更糟，
 *     搜索引擎会拿它当事实。
 *  2. 所有结构化数据走 `JSON.stringify`，不手拼字符串。
 *     手拼的 JSON-LD 在标题带引号时会直接变成语法错误 —— 而这种错误
 *     只有在 Google 富媒体测试里才看得到，本地页面看着完全正常。
 *  3. 输出面向 `<head>`，因此每一段都必须自带转义。
 */

/** 站点/文章数据 → 供 4 套主题共用的 SEO 视图对象。 */
export function buildSeoView({ site, page, canonical, breadcrumbs, prev, next, feed }) {
  const title = page.title ? `${page.title} · ${site.title}` : site.title;
  const description = truncate(page.description || site.description, 200);
  const image = page.image ? absolutize(site.url, page.image) : null;
  const lang = page.lang ?? site.language ?? 'zh-CN';
  return {
    // 基础
    title,
    description,
    canonical,
    language: lang,
    noindex: page.noindex === true,
    // Open Graph
    og: {
      type: page.ogType ?? (page.type === 'article' ? 'article' : 'website'),
      title,
      description,
      url: canonical,
      siteName: site.title,
      locale: String(lang).replace('-', '_'),
      image,
      publishedTime: page.publishedTime ?? null,
      modifiedTime: page.modifiedTime ?? null,
      tags: page.articleTags ?? [],
      author: page.author ?? null,
    },
    // Twitter Card
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
      image,
    },
    // 分页关系
    prev: prev ?? null,
    next: next ?? null,
    // 面包屑（首页不输出）
    breadcrumbs: breadcrumbs ?? [],
    feed: feed ?? [],
  };
}

/**
 * `<head>` 里的 SEO 标签块。内置为 partial `seo` 的默认数据源，
 * 主题也可以直接拿 seoView 自己拼 —— 但那样 4 套主题会长出 4 份实现。
 * 目前 4 套主题统一 include "seo"。
 */
export function renderSeoTags(view) {
  const lines = [
    `<title>${escapeHtml(view.title)}</title>`,
    `<meta name="description" content="${escapeHtml(view.description)}" />`,
    view.canonical ? `<link rel="canonical" href="${escapeHtml(view.canonical)}" />` : '',
    // 404 与其它「不该被收录」的页面必须显式 noindex：
    // 404 页在 sitemap 里已经排除了，但外部链接仍会把爬虫带过来，
    // 而一个被收录的 404 会在搜索结果里变成一个死链接。
    view.noindex ? '<meta name="robots" content="noindex, follow" />' : '',
    `<meta name="generator" content="Emeek" />`,
  ];

  const og = [
    ['og:type', view.og.type],
    ['og:title', view.og.title],
    ['og:description', view.og.description],
    ['og:url', view.og.url],
    ['og:site_name', view.og.siteName],
    ['og:locale', view.og.locale],
  ];
  if (view.og.image) og.push(['og:image', view.og.image]);
  if (view.og.type === 'article') {
    if (view.og.publishedTime) og.push(['article:published_time', view.og.publishedTime]);
    if (view.og.modifiedTime) og.push(['article:modified_time', view.og.modifiedTime]);
    if (view.og.author) og.push(['article:author', view.og.author]);
    for (const tag of view.og.tags) og.push(['article:tag', tag]);
  }
  for (const [property, content] of og) {
    if (content) lines.push(`<meta property="${property}" content="${escapeHtml(content)}" />`);
  }

  lines.push(`<meta name="twitter:card" content="${escapeHtml(view.twitter.card)}" />`);
  lines.push(`<meta name="twitter:title" content="${escapeHtml(view.twitter.title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escapeHtml(view.twitter.description)}" />`);
  if (view.twitter.image) lines.push(`<meta name="twitter:image" content="${escapeHtml(view.twitter.image)}" />`);

  // 分页关系：爬虫靠它把 /page/2 与 /page/1 认成同一组，而不是重复内容。
  if (view.prev) lines.push(`<link rel="prev" href="${escapeHtml(view.prev)}" />`);
  if (view.next) lines.push(`<link rel="next" href="${escapeHtml(view.next)}" />`);

  return lines.filter(Boolean).join('\n    ');
}

/**
 * 面包屑 JSON-LD（首页 → 中间层 → 当前页）。空数组返回 null。
 *
 * position 必须从 1 连续递增 —— Google 按它判断层级顺序，
 * 跳号会让整条面包屑被丢掉（页面上看起来完全正常）。
 */
export function buildBreadcrumbJsonLd(items) {
  if (!items?.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * 结构化数据。`kind` 决定 @type：
 *   blogpost（文章）/ blog（首页）/ collection（标签·分类·归档）/
 *   about（关于页）/ webpage（其余）
 * 未知形状一律退到 WebPage，而不是硬套一个错的 @type ——
 * 错误的 @type 会让富媒体结果整个失效。
 */
export function buildStructuredData({ kind, site, url, page = {}, post, breadcrumbs, canonical, authorUrl }) {
  const publisher = buildPublisher(site);
  const author = buildAuthor(site, post, authorUrl);
  const crumbs = breadcrumbs?.length ? buildBreadcrumbJsonLd(breadcrumbs) : null;

  let node;
  if (kind === 'blogpost' && post) {
    node = {
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.description,
      ...(post.cover ? { image: absolutize(site.url, post.cover) } : {}),
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      author,
      ...(publisher ? { publisher } : {}),
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      ...(post.tags?.length ? { keywords: post.tags.join(', ') } : {}),
      inLanguage: post.lang ?? site.language,
      ...(post.wordCount ? { wordCount: post.wordCount } : {}),
    };
  } else if (kind === 'blog') {
    node = {
      '@type': 'Blog',
      name: site.title,
      url,
      description: site.description,
      author,
      inLanguage: site.language,
    };
  } else if (kind === 'collection') {
    node = {
      '@type': 'CollectionPage',
      name: page.title ?? site.title,
      url,
      description: page.description ?? site.description,
      isPartOf: { '@type': 'WebSite', name: site.title, url: `${String(site.url).replace(/\/+$/, '')}/` },
    };
  } else if (kind === 'about') {
    node = {
      '@type': 'AboutPage',
      name: page.title ?? '关于',
      url,
      description: page.description ?? site.description,
      ...(publisher ? { publisher } : {}),
    };
  } else {
    node = {
      '@type': 'WebPage',
      name: page.title ?? site.title,
      url,
      description: page.description ?? site.description,
      inLanguage: site.language,
    };
  }

  const graph = [node];
  if (crumbs) graph.push(crumbs);
  // 单项时也走 @graph：形状统一，消费方不用分两种情况解析。
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** 仅当站点声明了作者时才给 author 节点 —— 不编造。 */
function buildAuthor(site, post, authorUrl) {
  const name = post?.author || site?.author || 'Anonymous';
  const url = post?.authorUrl ?? authorUrl ?? site?.authorUrl ?? null;
  return { '@type': 'Person', name, ...(url ? { url } : {}) };
}

/** 站点标题与 logo 都在才有意义。缺 logo 就不给 publisher —— 空 url 会让校验器报错。 */
function buildPublisher(site) {
  if (!site?.title) return null;
  const logo = site.logo ? absolutize(site.url, site.logo) : null;
  return {
    '@type': 'Organization',
    name: site.title,
    ...(logo ? { logo: { '@type': 'ImageObject', url: logo } } : {}),
  };
}

/** JSON-LD 序列化。唯一允许的写法：JSON.stringify。 */
export function renderJsonLd(data) {
  if (!data) return '';
  return `<script type="application/ld+json">${jsonLdSafe(data)}</script>`;
}

/**
 * JSON 内联进 `<script>` 时唯一危险的序列是 `</script`。
 * `<` 转成 \u003c 后既是合法 JSON，也无法提前闭合标签。
 * 顺带处理 U+2028/U+2029（JS 里是换行，JSON 里合法但会打断解析）。
 */
export function jsonLdSafe(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** sitemap 分片阈值：sitemaps.org 规定单文件 ≤ 50000 条 / 50MB。 */
export const SITEMAP_URL_LIMIT = 50000;

/**
 * sitemap.xml。超过 50000 条时产出 sitemap-index.xml + 分片。
 *
 * `changefreq` 与 `priority` 都来自调用方显式给的策略（见 sitemapEntriesFor），
 * 不在这里猜 —— 猜出来的优先级对搜索引擎是噪音。
 */
export function buildSitemap(site, entries) {
  const limited = entries.slice(0, SITEMAP_URL_LIMIT);
  const urls = limited.map((entry) => {
    const parts = [
      entry.lastmod ? `    <lastmod>${escapeHtml(entry.lastmod)}</lastmod>` : '',
      entry.changefreq ? `    <changefreq>${escapeHtml(entry.changefreq)}</changefreq>` : '',
      entry.priority ? `    <priority>${escapeHtml(entry.priority)}</priority>` : '',
      `    <loc>${escapeHtml(entry.url)}</loc>`,
    ].filter(Boolean).join('\n');
    return `  <url>\n${parts}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** 条目数超过上限时需要的分片文件清单（含 path 与切片）。 */
export function planSitemapShards(entries) {
  if (entries.length <= SITEMAP_URL_LIMIT) return null;
  const shards = [];
  for (let i = 0; i < entries.length; i += SITEMAP_URL_LIMIT) {
    shards.push({ path: `/sitemap-${shards.length + 1}.xml`, entries: entries.slice(i, i + SITEMAP_URL_LIMIT) });
  }
  return shards;
}

export function buildSitemapIndex(site, shards) {
  const now = new Date().toISOString();
  const items = shards.map((shard) =>
    `  <sitemap>\n    <loc>${escapeHtml(`${String(site.url).replace(/\/+$/, '')}${shard.path}`)}</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
}

/**
 * 路径 → 优先级/更新频率。集中在这里，是为了让「首页 1.0 / 文章 0.8 /
 * 标签分类 0.6 / 静态页 0.5」这条策略只有一处定义，脚本与测试都从这里读。
 */
export const SITEMAP_POLICY = {
  home: { priority: '1.0', changefreq: 'daily' },
  post: { priority: '0.8', changefreq: 'monthly' },
  taxonomy: { priority: '0.6', changefreq: 'weekly' },
  page: { priority: '0.5', changefreq: 'yearly' },
};

/**
 * robots.txt。
 *
 * 默认屏蔽三类**低价值且注定重复**的 URL：
 *  - /search/     搜索页对爬虫是空壳（内容靠 JS 渲染），收录它只会稀释权重
 *  - /*?q=        查询参数产生无限变体
 *  - /*?page=     分页参数同理
 * 站点可以通过 config.seo.robots 追加规则 —— 但内置屏蔽**不可取消**：
 * 允许收录搜索页会直接产生「重复内容」，那不是可配置的偏好问题。
 */
export function buildRobots(site, config = {}) {
  const base = String(site.url).replace(/\/+$/, '');
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /search/', 'Disallow: /*?q=', 'Disallow: /*?page='];
  const extra = config?.disable ?? [];
  for (const path of extra) lines.push(`Disallow: ${path}`);
  for (const rule of config?.custom ?? []) {
    if (rule?.userAgent) lines.push('', `User-agent: ${rule.userAgent}`, ...(rule.allow ?? []).map((p) => `Allow: ${p}`), ...(rule.disallow ?? []).map((p) => `Disallow: ${p}`));
  }
  lines.push('', `Sitemap: ${base}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

export function buildRss(site, posts, { limit = 20 } = {}) {
  const items = posts.slice(0, limit).map((post) => {
    const url = `${site.url}${post.url}`;
    return [
      '    <item>',
      `      <title>${escapeHtml(post.title)}</title>`,
      `      <link>${escapeHtml(url)}</link>`,
      `      <guid isPermaLink="true">${escapeHtml(url)}</guid>`,
      `      <pubDate>${new Date(post.date).toUTCString()}</pubDate>`,
      `      <description>${escapeHtml(post.description)}</description>`,
      ...(post.tags ?? []).map((tag) => `      <category>${escapeHtml(tag)}</category>`),
      '    </item>',
    ].join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(site.title)}</title>
    <link>${escapeHtml(site.url)}</link>
    <description>${escapeHtml(site.description)}</description>
    <language>${escapeHtml(site.language)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeHtml(site.url)}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

/** 生成静态搜索索引：构建期算好，前端只做查询，避免浏览器端再全量解析一遍正文。 */
export function buildSearchIndex(posts, { maxBody = 2000 } = {}) {
  return posts.map((post) => ({
    id: post.slug,
    title: post.title,
    url: post.url,
    tags: post.tags ?? [],
    date: post.date,
    body: stripTags(post.html ?? '').slice(0, maxBody),
  }));
}

export function truncate(text, limit) {
  const value = stripTags(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function absolutize(base, url) {
  if (/^https?:/i.test(url)) return url;
  return `${String(base).replace(/\/+$/, '')}/${String(url).replace(/^\/+/, '')}`;
}
