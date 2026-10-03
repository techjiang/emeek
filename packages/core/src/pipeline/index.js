import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, resolvePluginSpec } from '../config/loader.js';
import { loadPosts } from './source/index.js';
import { renderMarkdown } from './parse/markdown.js';
import { buildToc, renderToc, addAnchorLinks } from './transform/toc.js';
import { makeExcerpt, readingTime, countWords } from './transform/excerpt.js';
import { buildWikiLinkIndex, resolveWikiLink, computeBacklinks } from './transform/links.js';
import { decorateImages, createImageResolver } from './transform/images.js';
import { extractAboutTitle } from './transform/about.js';
import {
  buildSeoView, renderSeoTags, buildStructuredData, renderJsonLd,
  buildSitemap, buildSitemapIndex, planSitemapShards, SITEMAP_POLICY,
  buildRobots, truncate,
} from './transform/seo.js';
import { buildRss, buildAtom } from '../feed/build.js';
import { buildSearchIndexFile, summarizeIndex } from '../search/site-index.js';
import { loadSearchClient } from '../search/ui/index.js';
import { loadTheme, renderLayout } from './render/theme.js';
import { buildInjections } from '../theme/inject.js';
import { loadPlugins } from '../plugin/loader.js';
import { createHookRunner } from '../plugin/hooks.js';
import { writeOutput } from './render/output.js';
import { logger, progress } from '../util/logger.js';

/**
 * 构建主流程。这是一个纯函数式的管线：
 *   load → normalize → render markdown → transform → render template → write
 * 每一步只接收上一步的产物，插件通过生命周期钩子插入，不改变管线形状。
 */
export async function build({ cwd = process.cwd(), configPath, onProgress } = {}) {
  const started = Date.now();
  const { config, errors, warnings, configPath: resolved } = await loadConfig(cwd);
  if (configPath) process.env.EMEEEK_CONFIG = configPath;

  if (errors.length) {
    const message = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`配置校验失败：\n${message}`);
  }
  for (const warning of warnings) logger.warn(`${warning.path}: ${warning.message}`);

  const plugins = await loadPlugins(config, cwd);
  const hooks = createHookRunner(plugins);

  logger.step(`内容源：${config.content.source}${resolved ? ` · 配置：${path.relative(cwd, resolved)}` : ' · 使用默认配置'}`);

  // ── 1. 读取内容 ────────────────────────────────────────────────
  const rawPosts = await loadPosts(cwd, config);
  const published = rawPosts.filter((p) => !p.draft);
  const drafts = rawPosts.filter((p) => p.draft);
  logger.info(`读取 ${rawPosts.length} 篇内容（${drafts.length} 篇草稿已跳过）`);

  const theme = await loadTheme(cwd, config);
  logger.info(`主题：${theme.meta.name} v${theme.meta.version ?? '0.0.0'}`);
  for (const warning of theme.warnings ?? []) {
    logger.warn(`theme.json ${warning.path}: ${warning.message}`);
  }

  // 主题注入片段：变量块 / 自定义 CSS / 自定义 head·footer / 首帧防闪烁脚本。
  // 安全过滤在这一步完成（见 theme/inject.js），模板只负责摆放，不负责清洗。
  const injections = buildInjections(theme, config.theme ?? {});
  // 变量 + 自定义 CSS 必须写在内联主题 CSS 之后，所以挂到 theme 上，
  // 由 output.js 在 `</head>` 前统一落位（见 inlineCriticalCss）。
  theme.__varsOverride = injections.headStyle ? `\n${injections.headStyle}` : '';

  // ── 2. 预处理：先定 URL 与 wiki 链接索引，正文渲染时需要用到 ──
  const urlFor = (post) => `/${config.postPath ?? 'posts'}/${post.slug}.html`;
  for (const post of published) post.url = urlFor(post);

  const wikiIndex = buildWikiLinkIndex(published, { urlPattern: (post) => post.url });
  const siteData = { ...config.site };
  const imageResolver = createImageResolver({ baseUrl: config.site.url, assetBase: '/assets' });

  // ── 3. 渲染 Markdown + 内容级转换 ──────────────────────────────
  const posts = [];
  const bar = progress('解析文章', published.length);
  for (const post of published) {
    const headingIds = new Map();
    const html = renderMarkdown(post.raw, {
      allowHtml: config.content.allowHtml === true,
      resolveImage: imageResolver,
      resolveLink: (url) => url,
      headingIds,
      wikiLink: (target, alias) => resolveWikiLink(wikiIndex, target, alias),
    });

    // 顺序有意义：先抽目录再插锚点按钮，否则目录文字会带上锚点的 “#”。
    const decorated = decorateImages(html, { lazy: config.perf?.lazyLoading !== false });
    const toc = buildToc(decorated, { minLevel: 2, maxLevel: config.theme?.tocMaxLevel ?? 3 });
    const withAnchors = addAnchorLinks(decorated);
    const text = post.raw;

    const enriched = {
      ...post,
      html: withAnchors,
      toc,
      tocHtml: renderToc(toc, '目录'),
      description: post.description ?? makeExcerpt(withAnchors),
      wordCount: countWords(text),
      readingTime: readingTime(text),
      dateFormatted: formatDate(post.date, config.site.language),
      updatedFormatted: formatDate(post.updated, config.site.language),
      url: post.url,
    };
    posts.push(enriched);
    bar.tick();
  }
  bar.done();

  await hooks.run('onContentLoad', { config, posts, site: siteData });
  computeBacklinks(posts);

  // ── 4. 排序、分组 ──────────────────────────────────────────────
  const sorted = [...posts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.date) - new Date(a.date);
  });

  const tags = groupBy(sorted.flatMap((post) => post.tags.map((tag) => ({ tag, post }))));
  const categories = groupBy(sorted.flatMap((post) => post.categories.map((cat) => ({ tag: cat, post }))));
  for (const tag of [...tags, ...categories]) tag.url = `/tags/${encodeURIComponent(tag.slug)}.html`;

  // 标签链接必须在模板里可解析：标签名（原样）→ URL。
  // 否则 partial 只能拿原始标签名拼 URL，会与 slugify 后的文件名对不上。
  const tagUrlMap = new Map([...tags, ...categories].map((tag) => [tag.name, tag.url]));
  const tagUrl = (name) => tagUrlMap.get(name) ?? `/tags/${encodeURIComponent(slugifyTag(name))}.html`;
  for (const post of sorted) {
    post.tagLinks = post.tags.map((tag) => ({ name: tag, url: tagUrl(tag) }));
  }

  // 搜索索引要在生成搜索页之前算好 —— 页面要么内联它、要么指向它的 URL。
  // 顺序反了会得到一个「搜索页引用了一个还未生成的变量」的构建错误。
  const extraFiles = [];
  let searchIndexStats = null;
  let searchIndexContent = null;
  if (config.search?.enabled) {
    // 体积预算在这里守住：超预算默认抛错（构建失败），而不是发一个
    // 巨大的索引给每个访客。允许配置里显式放宽（见 config.search.gzipBudget）。
    const result = buildSearchIndexFile(sorted, {
      gzipBudget: config.search.gzipBudget ?? undefined,
      indexUrl: config.search.indexPath ?? '/search-index.json',
      onBudgetExceeded: config.search.allowOverBudget
        ? (info) => logger.warn(`搜索索引超出预算：gzip ${(info.gzip / 1024).toFixed(1)}KB > ${(info.budget / 1024).toFixed(1)}KB`)
        : undefined,
    });
    extraFiles.push({ path: result.path, content: result.content });
    searchIndexContent = result.content;
    searchIndexStats = result.stats;
    logger.info(`搜索索引：${summarizeIndex(result.stats)}`);
  }

  // ── 5. 渲染页面 ────────────────────────────────────────────────
  const pages = [];
  /**
   * 面包屑：所有非首页都从「首页」起算。爬虫靠它理解站点层级，
   * 搜索结果里也会显示成 example.com › 标签 › 主题 而不是一串裸 URL。
   */
  const homeCrumb = { name: config.site.title, url: `${config.site.url}/` };
  const seo = {
    homeCrumb,
    // 封面图兜底：文章没写 cover 时用站点级 og 图。
    // 刻意**不给默认值**：没有真实图片时输出一个空 og:image，
    // 社交平台会抓到一张白图 —— 比「没有图」更难看。
    defaultImage: config.seo?.defaultImage ?? null,
  };

  const common = () => ({
    site: siteData,
    config,
    nav: buildNav(config, tags),
    allTags: tags.sort((a, b) => b.count - a.count),
    allCategories: categories.sort((a, b) => b.count - a.count),
    year: new Date().getFullYear(),
    themeCSS: inlineStyles(theme),
    themeJS: inlineScripts(theme),
    themeName: theme.meta.name,
    themeFeatureAttrs: theme.featureAttrs,
    themeHeadExtra: injections.headExtra,
    themeFooterExtra: injections.footerExtra,
    themeSwitcherStyle: injections.switcher?.style ?? '',
    themeSwitcher: injections.switcher?.html ?? '',
    themeSwitcherScript: injections.switcher?.script ?? '',
    noFlashScript: injections.noFlash,
    searchIndexUrl: config.search?.enabled ? (config.search.indexPath ?? '/search-index.json') : null,
    // 搜索页地址。header 的搜索入口指向它，而不是再开一个内联面板 ——
    // 两套搜索必然会分叉（内联那份只能做子串 AND，且要自己 fetch 索引）。
    searchPageUrl: config.search?.enabled ? (config.search.pagePath ?? '/search/') : null,
    // 搜索页数据（仅 search 布局用）。索引小就内联，省一次请求；
    // 超过阈值走外链 —— 把几百 KB 的 JSON 塞进每个页面的 <script> 里
    // 会让所有页面都变大，那正是「搜索是增强」不该有的代价。
    // head 里的 feed discovery：<link rel="alternate"> 让浏览器/阅读器
    // 自动发现订阅地址。少了它，读者只能靠猜 /rss.xml。
    feedLinks: config.feed?.enabled !== false
      ? [
        { href: '/rss.xml', type: 'application/rss+xml', title: `${config.site.title} · RSS` },
        { href: '/atom.xml', type: 'application/atom+xml', title: `${config.site.title} · Atom` },
      ]
      : [],
    searchInlineIndex: null,
    searchScript: null,
    searchFacets: null,
    tagUrl,
    headMeta: '',
  });

  // 首页（含分页）
  const perPage = config.site.perPage ?? 10;
  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  for (let index = 0; index < pageCount; index += 1) {
    const slice = sorted.slice(index * perPage, (index + 1) * perPage);
    const url = index === 0 ? '/index.html' : `/page/${index + 1}.html`;
    pages.push({
      layout: 'index',
      strict: true,
      path: index === 0 ? '/index.html' : `/page/${index + 1}.html`,
      data: {
        ...common(),
        type: 'home',
        seoKind: 'blog',
        title: null,
        description: config.site.description,
        canonical: index === 0 ? `${config.site.url}/` : `${config.site.url}${url}`,
        posts: slice.map(toCard),
        // rel=prev/next 的 href 必须是绝对地址：相对地址在分页目录下会解析错。
        seoPrev: index > 0 ? `${config.site.url}${index === 1 ? '/' : `/page/${index}.html`}` : null,
        seoNext: index + 1 < pageCount ? `${config.site.url}/page/${index + 2}.html` : null,
        pagination: { current: index + 1, total: pageCount, prev: index > 0 ? (index === 1 ? '/' : `/page/${index}.html`) : null, next: index + 1 < pageCount ? `/page/${index + 2}.html` : null },
        pinned: index === 0 ? sorted.filter((p) => p.pinned).map(toCard) : [],
      },
    });
  }

  for (const post of sorted) {
    pages.push({
      layout: 'post',
      strict: true,
      path: post.url,
      data: {
        ...common(),
        type: 'article',
        seoKind: 'blogpost',
        title: post.title,
        description: post.description,
        image: post.cover,
        lang: post.lang,
        author: post.author ?? siteData.author,
        publishedTime: post.date,
        modifiedTime: post.updated ?? post.date,
        articleTags: post.tags,
        canonical: `${config.site.url}${post.url}`,
        post,
        related: findRelated(post, sorted),
      },
    });
  }

  pages.push({
    layout: 'archive',
    strict: true,
    path: '/archive.html',
    data: { ...common(), type: 'website', seoKind: 'collection', title: '归档', description: '全部文章按时间排列', canonical: `${config.site.url}/archive.html`, groups: groupByYear(sorted) },
  });
  pages.push({
    layout: 'tags',
    strict: true,
    path: '/tags.html',
    data: { ...common(), type: 'website', seoKind: 'collection', title: '标签', description: '按标签浏览文章', canonical: `${config.site.url}/tags.html`, tags: tags.sort((a, b) => b.count - a.count) },
  });
  // 关于页：正文里的 h1 提成页面主标题，避免「布局 h1 + 正文 h1」一页两个。
  const about = extractAboutTitle(await renderAbout(cwd, config), '关于');
  pages.push({
    layout: 'about',
    strict: true,
    path: '/about.html',
    data: {
      ...common(),
      type: 'website',
      seoKind: 'about',
      title: about.title,
      description: `${config.site.title} 的关于页`,
      canonical: `${config.site.url}/about.html`,
      content: about.html,
      aboutTitle: about.title,
      aboutTitleSource: about.titleSource,
    },
  });
  pages.push({
    layout: '404',
    strict: true,
    path: '/404.html',
    data: { ...common(), type: 'website', seoKind: 'webpage', title: '页面不存在', canonical: `${config.site.url}/404.html`, description: '找不到这个页面', noindex: true },
  });

  // 搜索页。索引已在上一步算好 —— 这里只决定「内联还是外链」。
  if (config.search?.enabled) {
    const searchPath = config.search.pagePath ?? '/search/';
    const inlineLimit = config.search.inlineLimit ?? 64 * 1024;
    const canInline = searchIndexContent && searchIndexStats && searchIndexStats.raw <= inlineLimit;
    pages.push({
      layout: 'search',
      strict: true,
      path: searchPath.endsWith('/') ? `${searchPath}index.html` : searchPath,
      data: {
        ...common(),
        type: 'website',
        seoKind: 'webpage',
        title: '搜索',
        description: `在 ${config.site.title} 中搜索`,
        canonical: `${config.site.url}${searchPath}`,
        searchInlineIndex: canInline ? searchIndexContent : null,
        searchScript: await loadSearchClient(),
        searchFacets: {
          categories: categories.map((c) => ({ value: c.name, count: c.count })).sort((a, b) => b.count - a.count),
          tags: tags.map((t) => ({ value: t.name, count: t.count })).sort((a, b) => b.count - a.count),
        },
      },
    });
  }

  pages.push(...renderTaxonomyPages('tag', tags, config, common(), wikiIndex, imageResolver));
  pages.push(...renderTaxonomyPages('category', categories, config, common(), wikiIndex, imageResolver));

  // 插件注册的额外页面：复用主题已有布局，只提供数据。
  for (const plugin of plugins) {
    for (const definition of plugin.pages ?? []) {
      if (!definition?.path || !definition?.layout) {
        logger.warn(`插件「${plugin.name}」声明了缺少 path 或 layout 的页面，已跳过`);
        continue;
      }
      pages.push({
        layout: definition.layout,
        path: definition.path,
        plugin: plugin.name,
        data: { ...common(), type: 'website', seoKind: 'webpage', title: definition.title ?? null, description: definition.description ?? '', canonical: `${siteData.url}${definition.path}`, ...definition.data },
      });
    }
  }

  // 布局渲染 + 插件钩子
  const rendered = [];
  for (const page of pages) {
    applySeo(page.data, { site: siteData, config, seo });
    const html = renderLayout(theme, page.layout, page.data, { strict: page.strict === true });
    rendered.push({ ...page, html });
  }
  await hooks.run('onBeforeRender', { config, pages: rendered, posts, site: siteData });

  // ── 6. 附加文件 ────────────────────────────────────────────────
  //
  // sitemap 的条目**必须来自实际产出的页面**，不能用模板重新拼一遍路径。
  // 之前是后者：标签页/分类页/搜索页/分页全都不在里面，于是搜索引擎
  // 只能靠链接爬 —— 而孤立的标签页几乎没有入链。
  // 现在直接读 rendered（已排除 noindex 页面）。
  if (config.seo?.sitemap !== false) {
    // 站点最新一次内容变更。首页/归档/标签这些聚合页的 lastmod 用它，
    // 而不是构建时间 —— 构建时间会让每次 CI 重建都把整份 sitemap 的
    // lastmod 刷新一遍，搜索引擎会开始忽略这个字段。
    const latestUpdate = sorted.reduce((acc, post) => {
      const value = (post.updated ?? post.date ?? '').slice(0, 10);
      return value > acc ? value : acc;
    }, '');

    const sitemapEntries = rendered
      .filter((page) => !page.data.noindex)
      .map((page) => ({
        url: page.data.canonical,
        lastmod: (page.data.modifiedTime ?? page.data.post?.updated ?? page.data.post?.date)?.slice(0, 10)
          ?? (page.data.type === 'home' || page.data.seoKind === 'collection' ? latestUpdate || null : null),
        ...sitemapPolicyFor(page),
      }))
      // 同一 canonical 只留一条：分页首页的 canonical 指向 /，会与首页重复。
      .filter((entry, index, all) => all.findIndex((e) => e.url === entry.url) === index);

    const shards = planSitemapShards(sitemapEntries);
    if (shards) {
      // > 50000 条：sitemaps.org 硬限制。拆成 index + 分片，
      // 否则整份 sitemap 会被搜索引擎直接判为无效（不是「只收前 5 万条」）。
      for (const shard of shards) extraFiles.push({ path: shard.path, content: buildSitemap(siteData, shard.entries) });
      extraFiles.push({ path: '/sitemap.xml', content: buildSitemapIndex(siteData, shards) });
      logger.info(`Sitemap：${sitemapEntries.length} 条 URL，拆成 ${shards.length} 个分片`);
    } else {
      extraFiles.push({ path: '/sitemap.xml', content: buildSitemap(siteData, sitemapEntries) });
      logger.info(`Sitemap：${sitemapEntries.length} 条 URL`);
    }
  }
  if (config.feed?.enabled !== false) {
    const feedOptions = {
      limit: config.feed?.limit ?? 20,
      // fullContent 默认关：整站正文塞进 feed 会让文件巨大，
      // 而多数阅读器本来也只显示摘要。要全文就显式开。
      fullContent: config.feed?.fullContent === true,
      categories: config.feed?.categories ?? [],
    };
    extraFiles.push({ path: '/rss.xml', content: buildRss(siteData, sorted, feedOptions) });
    extraFiles.push({ path: '/atom.xml', content: buildAtom(siteData, sorted, feedOptions) });
    const kept = sorted.filter((p) => !feedOptions.categories.length
      || (p.categories ?? []).some((c) => feedOptions.categories.map((x) => String(x).toLowerCase()).includes(String(c).toLowerCase())));
    logger.info(`Feed：RSS + Atom · ${Math.min(kept.length, feedOptions.limit)} 条${feedOptions.fullContent ? '（含全文）' : ''}`);
  }
  if (config.seo?.robots !== false) {
    // config.seo.robots 可以是 false（整份不产出）、true/undefined（默认规则），
    // 或一个对象（额外 Disallow / 自定义规则）。默认规则里的搜索页屏蔽不可取消。
    const robotsConfig = typeof config.seo.robots === 'object' && config.seo.robots !== null ? config.seo.robots : {};
    extraFiles.push({ path: '/robots.txt', content: buildRobots(siteData, robotsConfig) });
  }
  // ── 7. 写盘 ────────────────────────────────────────────────────
  const outDir = path.resolve(cwd, config.output?.dir ?? 'dist');
  const manifest = await writeOutput({
    outDir,
    pages: rendered,
    extraFiles,
    theme,
    config,
    cwd,
    onProgress: (current, total) => onProgress?.(current, total),
  });

  const context = { config, cwd, outDir };
  await hooks.run('onBuildComplete', context);
  await hooks.run('onAfterRender', context);

  /**
   * 站点索引：编辑器（Emeek Studio）用它做 [[ 补全与双向链接解析。
   *
   * 为什么要从这里给，而不是编辑器自己扫一遍帖子目录：
   * 编辑器眼里的「有哪些文章」必须与构建期一致，否则补全出来的标题
   * 在构建时会变成「未找到文章」。索引只能由构建方产出。
   */
  const siteIndex = {
    posts: sorted.map((post) => ({
      title: post.title,
      slug: post.slug,
      url: post.url,
      date: post.date,
      tags: post.tags,
      categories: post.categories,
      description: post.description,
      draft: false,
    })),
    drafts: drafts.map((post) => ({ title: post.title, slug: post.slug, draft: true })),
    titles: sorted.map((post) => post.title),
  };

  const stats = {
    elapsed: Date.now() - started,
    searchIndex: searchIndexStats,
    posts: sorted.length,
    pages: rendered.length,
    drafts: drafts.length,
    tags: tags.length,
    outDir,
    manifest,
    siteIndex,
  };
  return stats;
}

/**
 * 卡片数据的稳定形状。
 *
 * `category` / `leadCategory` 是给主题**做样式钩子**的两个字段，不是新概念：
 *   category      分类的原始展示名（「设计」）
 *   leadCategory  分类的 slug（「设计」→ `设置` 同款规则），可直接进 HTML 属性
 * 之前主题想按分类上色只能自己在模板里 slugify —— 模板里没有那个函数，
 * 于是「分类色带」这类需求就退化成「所有卡片同一个颜色」。字段放在这里，
 * 主题只需要 `data-category="{{ post.leadCategory }}"`。
 * 没有分类时给 `default`：CSS 的 `[data-category="..."]` 覆盖不到空串，
 * 留空会让「有分类」和「无分类」的卡片意外撞成同一套样式。
 */
function toCard(post) {
  return {
    title: post.title,
    url: post.url,
    date: post.date,
    dateFormatted: post.dateFormatted,
    description: post.description,
    tags: post.tags,
    tagLinks: post.tagLinks ?? post.tags.map((t) => ({ name: t, url: `/tags/${encodeURIComponent(slugifyTag(t))}.html` })),
    categories: post.categories,
    category: post.categories?.[0] ?? null,
    leadCategory: post.categories?.[0] ? slugifyTag(post.categories[0]) : 'default',
    readingTime: post.readingTime,
    wordCount: post.wordCount,
    pinned: post.pinned,
    cover: post.cover,
    slug: post.slug,
  };
}

/** 相关文章：标签重合度降序，再按时间兜底。无权重表，够用且可解释。 */
function findRelated(post, posts, limit = 6) {
  const tags = new Set(post.tags);
  return posts
    .filter((p) => p.slug !== post.slug)
    .map((p) => ({ post: p, score: p.tags.filter((t) => tags.has(t)).length + (p.categories.some((c) => post.categories.includes(c)) ? 1 : 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.post.date) - new Date(a.post.date))
    .slice(0, limit)
    .map((entry) => toCard(entry.post));
}

function groupBy(entries) {
  const map = new Map();
  for (const { tag, post } of entries) {
    const slug = slugifyTag(tag);
    if (!map.has(slug)) map.set(slug, { name: tag, slug, count: 0, posts: [] });
    const group = map.get(slug);
    group.count += 1;
    group.posts.push(toCard(post));
  }
  return [...map.values()];
}

/**
 * 把 SEO 视图挂到页面数据上。4 套主题统一 include "seo" partial，
 * 只读 seoView / jsonLd —— 主题不参与任何 SEO 决策。
 *
 * 为什么由引擎统一生成而不是各主题自己拼：
 * 4 份手写的 JSON-LD 一定会漂移（其中一两份漏掉 dateModified 都很难发现），
 * 而结构化数据错了不会让页面看起来有任何异常。
 */
function applySeo(data, { site, config, seo }) {
  const breadcrumbs = buildBreadcrumbs(data, site, seo);
  const canonical = data.canonical ?? `${site.url}/`;
  const image = data.image ?? seo.defaultImage ?? null;

  const view = buildSeoView({
    site,
    page: {
      title: data.title,
      description: data.description,
      type: data.type,
      image,
      lang: data.lang,
      ogType: data.type === 'home' ? 'website' : undefined,
      publishedTime: data.publishedTime ?? null,
      modifiedTime: data.modifiedTime ?? null,
      articleTags: data.articleTags ?? [],
      author: data.author ?? null,
      authorUrl: config.seo?.authorUrl ?? site.authorUrl ?? null,
      noindex: data.noindex === true,
    },
    canonical,
    breadcrumbs,
    prev: data.seoPrev ?? null,
    next: data.seoNext ?? null,
  });

  data.seoView = view;
  data.breadcrumbs = breadcrumbs;
  data.headMeta = renderSeoTags(view);
  data.jsonLd = config.seo?.structuredData === false
    ? ''
    : renderJsonLd(buildStructuredData({
      kind: data.seoKind ?? 'webpage',
      site,
      url: canonical,
      page: data,
      post: data.post,
      breadcrumbs,
      authorUrl: data.authorUrl ?? config.seo?.authorUrl ?? null,
    }));
}

/** 面包屑：首页 → 中间层 → 当前页。首页自身不给面包屑（一条只有自己的链没有信息）。 */
function buildBreadcrumbs(data, site, seo) {
  if (data.type === 'home' || data.noindex) return [];
  const crumbs = [seo.homeCrumb];
  if (data.type === 'article' && data.post) {
    crumbs.push({ name: '归档', url: `${site.url}/archive.html` });
    crumbs.push({ name: data.title, url: data.canonical });
  } else if (/^标签：/.test(String(data.title ?? ''))) {
    crumbs.push({ name: '标签', url: `${site.url}/tags.html` });
    crumbs.push({ name: data.title, url: data.canonical });
  } else if (/^分类：/.test(String(data.title ?? ''))) {
    // 分类目前与标签共用 /tags.html 总览页。面包屑指向那里是据实 —
    // 编一个并不存在的 /categories.html 会让爬虫多抓一个 404。
    crumbs.push({ name: '分类', url: `${site.url}/tags.html` });
    crumbs.push({ name: data.title, url: data.canonical });
  } else if (data.title) {
    crumbs.push({ name: data.title, url: data.canonical });
  }
  return crumbs;
}

/**
 * sitemap 的 changefreq/priority 策略。判据是「页面类型」而不是路径字符串 ——
 * 路径是可以配置的（搜索页路径就能改），拿路径做判断迟早对不上。
 */
function sitemapPolicyFor(page) {
  if (page.data.type === 'home') return SITEMAP_POLICY.home;
  if (page.data.type === 'article') return SITEMAP_POLICY.post;
  const title = String(page.data.title ?? '');
  if (page.layout === 'tags' && /^(?:标签|分类)：/.test(title)) return SITEMAP_POLICY.taxonomy;
  if (page.data.type === 'website' && ['归档', '标签'].includes(title)) return SITEMAP_POLICY.taxonomy;
  return SITEMAP_POLICY.page;
}

function slugifyTag(text) {
  return String(text).toLowerCase().trim().replace(/[\s\u3000]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '') || encodeURIComponent(text);
}

function groupByYear(posts) {
  const map = new Map();
  for (const post of posts) {
    const year = new Date(post.date).getFullYear();
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(toCard(post));
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([year, items]) => ({ year, posts: items }));
}

function buildNav(config, tags) {
  return [
    { title: '首页', url: '/' },
    { title: '归档', url: '/archive.html' },
    { title: '标签', url: '/tags.html' },
    { title: '关于', url: '/about.html' },
  ];
}

function formatDate(iso, locale) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale || 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function inlineStyles(theme) {
  return theme.styles.map((s) => s.content).join('\n');
}

function inlineScripts(theme) {
  return theme.scripts.map((s) => s.content).join('\n');
}

function renderTaxonomyPages(kind, groups, config, base, wikiIndex, imageResolver) {
  return groups.map((group) => ({
    layout: 'tags',
    path: kind === 'tag' ? `/tags/${encodeURIComponent(group.slug)}.html` : `/categories/${encodeURIComponent(group.slug)}.html`,
    data: {
      ...base,
      type: 'website',
      seoKind: 'collection',
      title: `${kind === 'tag' ? '标签' : '分类'}：${group.name}`,
      description: `包含「${group.name}」的全部文章`,
      canonical: `${config.site.url}/${kind === 'tag' ? 'tags' : 'categories'}/${encodeURIComponent(group.slug)}.html`,
      tags: [group],
      singleGroup: group,
    },
  }));
}

async function renderAbout(cwd, config) {
  const candidates = ['ABOUT.md', 'about.md', 'content/about.md'];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(path.resolve(cwd, candidate), 'utf8');
      // demoteH1: false —— 关于页的正文一级标题不是「正文里的第二个主标题」，
      // 它**就是**这一页的主标题。渲染时降级会让 extractAboutTitle 再也找不到它，
      // 于是页面主标题变成布局里写死的「关于」，而作者写的那句被降成 h2 印在正文里。
      //
      // 这里踩过一次：最初默认降级，测试断言「主标题来自 ABOUT.md」直接红了 ——
      // 红得对。降级是为了防止「一页两个主标题」，而关于页的 h1 是唯一那个。
      return renderMarkdown(raw, {
        allowHtml: false,
        resolveImage: (u) => u,
        resolveLink: (u) => u,
        headingIds: new Map(),
        demoteH1: false,
      });
    } catch { /* 继续找下一个 */ }
  }
  return `<p>还没有写关于页。在项目根目录放一个 <code>ABOUT.md</code> 即可自动出现在这里。</p>`;
}


// 渲染管线的构件对外导出。
// 编辑器（@emeeek/editor）要复现「构建输出」就必须逐步复用这些函数，
// 而不是自己写一套 Markdown 解析 —— 导出的正是这条路径本身。
export { renderMarkdown } from './parse/markdown.js';
export { buildToc, renderToc, addAnchorLinks } from './transform/toc.js';
export { decorateImages, createImageResolver } from './transform/images.js';
export { makeExcerpt, readingTime, countWords } from './transform/excerpt.js';
export { buildWikiLinkIndex, resolveWikiLink } from './transform/links.js';

/** 构建期对单篇 Markdown 做的全部变换（渲染 → 图片 → 锚点）。 */
export function renderArticle(raw, {
  allowHtml = false,
  lazyImages = true,
  headingIds = new Map(),
  wikiLink,
  resolveImage = (url) => url,
} = {}) {
  const html = renderMarkdown(raw, {
    allowHtml,
    resolveImage,
    resolveLink: (url) => url,
    headingIds,
    wikiLink,
  });
  return addAnchorLinks(decorateImages(html, { lazy: lazyImages }));
}
