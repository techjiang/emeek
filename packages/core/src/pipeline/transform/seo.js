import { escapeHtml, stripTags } from './toc.js';

export function buildJsonLd({ site, post, url }) {
  if (post) {
    return {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      author: { '@type': 'Person', name: post.author ?? site.author },
      publisher: { '@type': 'Organization', name: site.title },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      keywords: post.tags?.join(', '),
      inLanguage: post.lang ?? site.language,
    };
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: site.title,
    description: site.description,
    url,
    author: { '@type': 'Person', name: site.author },
    inLanguage: site.language,
  };
}

export function renderHeadMeta({ site, page, canonical }) {
  const title = page.title ? `${page.title} · ${site.title}` : site.title;
  const description = truncate(page.description || site.description, 200);
  const lines = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta name="generator" content="Emeek" />`,
  ];
  const og = [
    ['og:type', page.type ?? 'website'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', canonical],
    ['og:site_name', site.title],
    ['og:locale', String(page.lang ?? site.language).replace('-', '_')],
  ];
  if (page.image) og.push(['og:image', absolutize(site.url, page.image)]);
  for (const [property, content] of og) {
    lines.push(`<meta property="${property}" content="${escapeHtml(content)}" />`);
  }
  lines.push(`<meta name="twitter:card" content="${page.image ? 'summary_large_image' : 'summary'}" />`);
  lines.push(`<meta name="twitter:title" content="${escapeHtml(title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escapeHtml(description)}" />`);
  if (page.image) lines.push(`<meta name="twitter:image" content="${escapeHtml(absolutize(site.url, page.image))}" />`);
  return lines.join('\n    ');
}

export function renderHreflang(site, alternates = []) {
  if (!alternates.length) return '';
  return alternates.map((alt) =>
    `<link rel="alternate" hreflang="${escapeHtml(alt.lang)}" href="${escapeHtml(alt.url)}" />`).join('\n    ');
}

export function buildSitemap(site, entries) {
  const urls = entries.map((entry) => {
    const parts = [
      `    <loc>${escapeHtml(entry.url)}</loc>`,
      entry.lastmod ? `    <lastmod>${entry.lastmod}</lastmod>` : '',
      `    <changefreq>${entry.changefreq ?? 'weekly'}</changefreq>`,
      `    <priority>${entry.priority ?? '0.6'}</priority>`,
    ].filter(Boolean).join('\n');
    return `  <url>\n${parts}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * RSS 的 lastBuildDate。
 *
 * 关键：**不取当前时间**。取当前时间会让每次构建的 rss.xml 都不一样，
 * 于是「产物未变 → 跳过推送」的幂等判据永远为假，多源站每次全量重推、
 * CDN 每次全量刷新、缓存全部失效。这个日期应该表达「内容最后更新于」，
 * 而不是「我什么时候编的」。
 */
function latestDate(posts = []) {
  let newest = null;
  for (const post of posts) {
    const t = new Date(post.updated ?? post.date).getTime();
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return new Date(newest ?? 0).toUTCString();
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
    <lastBuildDate>${latestDate(posts)}</lastBuildDate>
    <atom:link href="${escapeHtml(site.url)}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

export function buildRobots(site, { allowAll = true } = {}) {
  return [
    'User-agent: *',
    allowAll ? 'Allow: /' : 'Disallow: /',
    `Sitemap: ${site.url}/sitemap.xml`,
    '',
  ].join('\n');
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
  const value = stripTags(String(text ?? ''));
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function absolutize(base, url) {
  if (/^https?:/i.test(url)) return url;
  return `${String(base).replace(/\/+$/, '')}/${String(url).replace(/^\/+/, '')}`;
}
