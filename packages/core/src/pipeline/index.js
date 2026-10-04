import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, resolvePluginSpec } from '../config/loader.js';
import { loadPosts } from './source/index.js';
import { renderMarkdown } from './parse/markdown.js';
import { buildToc, renderToc, addAnchorLinks } from './transform/toc.js';
import { buildReadingNav, renderReadingToc, renderReadingProgress, READING_CLIENT } from '../reading/index.js';
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
import { resolveCommentTarget, renderCommentsShell } from '../comments/index.js';
import { loadCommentsClient } from '../comments/ui.js';
import { buildManifest, ICON_SIZES } from './pwa/manifest.js';
import { buildServiceWorker, cacheVersion, cacheName } from './pwa/service-worker.js';
import { buildOfflinePage, buildRegisterScript, buildInstallPrompt, buildDisplayModeScript } from './pwa/offline.js';
import { loadSearchClient } from '../search/ui/index.js';
import { loadTheme, renderLayout } from './render/theme.js';
import { buildInjections } from '../theme/inject.js';
import { planPrefetch, collectPreconnect, isHintable, renderResourceHints } from './transform/hints.js';
import { decorateResponsive, buildSrcset } from './transform/responsive.js';
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
  // 显式 configPath 直接交给 loadConfig 解析，**不写进 process.env**。
  // 写 env 的代价是进程级全局状态在测试之间泄漏：一个用例设过 EMEEEK_CONFIG
  // 之后，后续所有用例都会被它劫持，且症状是「配置看起来没生效」而非报错。
  const { config, errors, warnings, configPath: resolved } = await loadConfig(cwd, { configPath });

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
  // 变量 + 自定义 CSS 是「内联 CSS 之后、</head> 之前」的一块。
  // 顺序理由见 output.js 的 planStyles —— 两者选择器都是同权重的 :root。
  theme.__varsOverride = injections.headStyle ?? '';

  // ── 2. 预处理：先定 URL 与 wiki 链接索引，正文渲染时需要用到 ──
  const urlFor = (post) => `/${config.postPath ?? 'posts'}/${post.slug}.html`;
  for (const post of published) post.url = urlFor(post);

  const wikiIndex = buildWikiLinkIndex(published, { urlPattern: (post) => post.url });
  const siteData = { ...config.site };
  const imageResolver = createImageResolver({ baseUrl: config.site.url, assetBase: '/assets' });

  /**
   * 主题的长期版面事实，只算一次。
   *
   * 为什么要读布局源码而不是读 theme.json 的 `sidebar` 配置项：
   * 那个配置项是**用户可覆盖的开关**（用户可以关掉侧边栏），
   * 而我们要知道的是「布局里到底有没有 include sidebar 的位置」——
   * 用户关掉侧边栏时，那片空间仍然存在（只是空的），目录不该因此
   * 从侧栏跑到正文上方。
   *
   * 读源码做判据看起来粗糙，但它是**布局的事实**，不是我们的猜测；
   * 而且判据（有没有 include "sidebar"）是可枚举的、不会随主题改版漂移。
   */
  const postLayoutSource = theme.layouts.get('post')?.source ?? '';
  const layoutFacts = {
    hasSidebar: /include\s+["']sidebar["']/.test(postLayoutSource),
    // 主题是否**已经**自己渲染了目录（老主题在正文上方塞了 tocHtml）。
    // 这种主题不该再拿到一份目录 —— 那就是重复渲染。
    rendersOwnToc: /tocHtml/.test(postLayoutSource),
  };

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
    const decorated = decorateImages(html, {
      lazy: config.perf?.lazyLoading !== false,
      // 响应式图片默认关：没有候选集时生成 srcset 就是编造地址。
      // 候选集来自 config.perf.imageVariants（作者声明「这些尺寸确实存在」）。
      responsive: config.perf?.responsiveImages === true,
      variantsBySrc: config.perf?.imageVariants ?? {},
    });
    const toc = buildToc(decorated, { minLevel: 2, maxLevel: config.theme?.tocMaxLevel ?? 3 });
    const withAnchors = addAnchorLinks(decorated);
    const text = post.raw;

    /**
     * 长文导航的落位。
     *
     * P3-3c 之前这里有真实的重复渲染：`tocHtml`（Phase 1 的产物）
     * 被塞在正文上方，而 P3-1 加的侧边栏又从 `toc` 重新渲染了一份 ——
     * 同一份目录在 3 套主题的长文页上出现两次，内容与锚点完全一样。
     *
     * 现在由 buildReadingNav 决定**放一处**：
     *   · 布局有侧栏位置 → 放侧栏（正文上方不再重复）
     *   · 布局没有侧栏、但它自己写了 tocHtml → 保持原样（主题自治）
     *   · 布局没有侧栏也没有 tocHtml → 引擎给正文上方那一份
     */
    const reading = buildReadingNav({
      toc,
      hasSidebar: layoutFacts.hasSidebar,
      minItems: Number(config.theme?.tocMinItems ?? 3),
    });

    const enriched = {
      ...post,
      html: withAnchors,
      toc,
      readingNav: reading,
      readingTocHtml: reading.placement === 'inline' ? renderReadingToc(reading) : '',
      readingProgressHtml: renderReadingProgress(reading),
      // 保留 tocHtml 给「自己会渲染目录」的主题（向后兼容，但只在
      // 主题真的会用它时才产出内容）。
      tocHtml: layoutFacts.rendersOwnToc ? renderToc(toc, '目录') : '',
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

  // 评论客户端脚本只算一次（构建期缓存），但只挂到真的有评论区的页面上 ——
  // 7.6KB 内联到每个页面上是纯浪费（首页、归档、标签页都没有评论区）。
  let commentsScriptCache = null;
  const commentsScript = async () => {
    if (commentsScriptCache === null) commentsScriptCache = await loadCommentsClient();
    return commentsScriptCache;
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
    // 资源提示由引擎统一算（理由见 transform/hints.js）。默认空数组，
    // 由 applySeo 之后、渲染之前按页填上 —— 只有文章页才会真的预取。
    prefetch: [],
    // PWA 开关与地址。主题只负责把这几行摆进 head 与 body 末尾。
    pwa: pwaHeadData(config),
    // 评论客户端脚本。默认空 —— 只有文章页（真的有评论区的那几个）才会填。
    commentsScript: '',
    // 长文导航。默认空 —— 只有文章页会填。给一个空对象而不是 undefined，
    // 让「非文章页 include 了 reading partial」这种模板错误表现成
    // 「什么都不渲染」而不是构建崩溃。
    readingScript: '',
    readingProgressHtml: '',
    readingTocHtml: '',
    readingNav: { items: [], placement: 'none', nested: false, showProgress: false },
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

  for (const index in sorted) {
    const post = sorted[index];
    const related = findRelated(post, sorted);
    // 「读完之后最可能去哪」的两条猜法：同一话题里更新的一篇（newer），
    // 以及标签重合度最高的几篇（related）。预取只在这两者上做 ——
    // 全站乱预取等于替读者下载他没打算看的页。
    const newer = sorted.slice(0, Number(index)).reverse().find((p) => p.tags.some((t) => post.tags.includes(t)))?.url ?? null;
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
        related,
        prefetch: config.perf?.prefetch === false
          ? []
          : planPrefetch({ layout: 'post', related, newer }),
        // 评论区：外壳在构建期渲染（无 JS 读者也要有一句可读的话 +
        // 一个去 GitHub 的链接），内容在运行时由同一份 normalize 填。
        // 数据属性是浏览器端唯一的接缝。
        // 长文导航脚本。只给**真的需要**它的页面 —— 短文章既没有目录
        // 也没有进度条，塞一段什么都不干的脚本是纯浪费。
        readingScript: post.readingNav.showProgress || post.readingNav.placement !== 'none' ? READING_CLIENT : '',
        readingProgressHtml: post.readingProgressHtml,
        readingTocHtml: post.readingTocHtml,
        // 侧边栏 partial 读的是页面级的 readingNav（与 SEO 视图同一形状：
        // 引擎算好的视图对象，主题只读不拼）。
        readingNav: post.readingNav,
        // post 里有 issueNumber（github-issues 源自带，local 源可由
        // front-matter 的 `issue:` 指定）。两者都没有时 resolveCommentTarget
        // 返回 null —— 页面**完全不渲染评论区**，而不是渲染一个空壳。
        commentsHtml: renderCommentsShell(resolveCommentTarget({ config, post })),
        commentsScript: resolveCommentTarget({ config, post }) ? await commentsScript() : '',
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
  // ── 6.5 PWA 产物 ───────────────────────────────────────────────
  //
  // 顺序要紧：manifest / sw.js 的地址要先进 common() 才能被模板引用，
  // 而 sw.js 的缓存指纹又要等**全部产物**（含 sitemap 等 extraFiles）算完。
  // 所以分两步：先把声明放进页面数据，产物最后统一追加到 extraFiles。
  const pwaFiles = config.pwa?.enabled === true
    ? buildPwaArtifacts({ config, siteData, sorted, rendered, extraFiles, theme })
    : null;
  if (pwaFiles) extraFiles.push(...pwaFiles.files);

  // ── 7. 写盘 ────────────────────────────────────────────────────
  const outDir = path.resolve(cwd, config.output?.dir ?? 'dist');
  const manifest = await writeOutput({
    outDir,
    pages: rendered,
    extraFiles,
    theme,
    config,
    cwd,
    posts: sorted,
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
  applyHints(data, { site, config });
}

/**
 * 资源提示（preconnect / prefetch）也由引擎统一算，理由同 SEO —— 4 套主题
 * 各写一份一定会漂移，而漂移的表现是「页面照常工作，只是慢了一个 RTT」。
 *
 * 这里只处理**逐页不同**的那部分（prefetch）。preconnect 是站点级的，
 * 由 output.js 在写盘时统一注入 —— 它不随页面变化，没必要每个页面算一遍。
 */
function applyHints(data, { site, config }) {
  if (config.perf?.prefetch === false) {
    data.prefetch = [];
    return;
  }
  data.prefetch = Array.isArray(data.prefetch) ? data.prefetch.filter(isHintable) : [];
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

/**
 * PWA 在页面侧的声明数据（manifest 链接 + 注册脚本 + 安装提示）。
 *
 * 全部由引擎给，主题只摆放 —— 理由同 SEO：4 套主题各写一份注册脚本，
 * 迟早有一份写成 `/sw.js`（子路径部署下就是 404），而 Service Worker
 * 注册失败**不会影响页面外观**，只会让人以为「PWA 功能就是这样」。
 */
function pwaHeadData(config) {
  if (config.pwa?.enabled !== true) return null;
  const basePath = config.site?.basePath ?? '';
  return {
    manifestUrl: `${basePath}/manifest.webmanifest`,
    themeColor: config.pwa?.themeColor ?? '#ffffff',
    // 注册脚本放在 body 末尾执行；install 提示只在显式打开时才注入。
    registerScript: buildRegisterScript({ basePath, swPath: '/sw.js' }),
    displayModeScript: buildDisplayModeScript(),
    installScript: config.pwa?.installPrompt === true ? buildInstallPrompt({ basePath }) : '',
  };
}

/**
 * PWA 产物：manifest.webmanifest / sw.js / offline.html。
 *
 * 三个文件互相引用（sw 的缓存名包含全部产物的指纹，manifest 的 start_url
 * 带 basePath），所以必须在**所有页面渲染完之后**才能生成 —— 这是它
 * 放在写盘前一步的原因。
 *
 * `precache` 只放「离线时真的想看的东西」：首页 + 离线页 + 若干篇文章。
 * 把全部页面都塞进去会让第一次访问就下载整个站点，而 SW 的 install
 * 是**在首屏之后**跑的 —— 那等于给每个访客偷偷加一次全站下载。
 */
function buildPwaArtifacts({ config, siteData, sorted, rendered, extraFiles, theme }) {
  const basePath = siteData.basePath ?? config.site?.basePath ?? '';
  const offlinePath = config.pwa?.offlinePath ?? '/offline.html';
  // 预缓存的文章数：默认 5。上限的理由见上面注释，不是随手写的。
  const precachePosts = sorted.slice(0, Number(config.pwa?.precachePosts ?? 5));

  const offlinePage = buildOfflinePage({
    site: siteData,
    basePath,
    offlinePath,
    cachedPosts: precachePosts.map((post) => ({ title: post.title, url: post.url })),
  });

  const files = [
    { path: offlinePath, content: offlinePage },
    {
      path: '/manifest.webmanifest',
      content: JSON.stringify(buildManifest({
        site: siteData,
        basePath,
        icons: pickIcons(config.pwa?.icons ?? {}, theme),
        themeColor: config.pwa?.themeColor ?? '#ffffff',
        backgroundColor: config.pwa?.backgroundColor ?? '#ffffff',
        display: config.pwa?.display ?? 'standalone',
      }), null, 2),
    },
  ];

  // SW 的缓存指纹必须包含**它自己之外的全部产物** —— 包括站点页面、
  // sitemap、feed、离线页、manifest。少算一类，那类文件变更时
  // 缓存名不变，读者就永远拿到旧的。
  const fingerprint = cacheVersion([
    ...rendered.map((page) => ({ path: page.path, bytes: page.html.length, hash: hashString(page.html) })),
    ...files.map((f) => ({ path: f.path, bytes: f.content.length, hash: hashString(f.content) })),
    ...extraFiles.map((f) => ({ path: f.path, bytes: String(f.content).length, hash: hashString(String(f.content)) })),
  ]);

  const precache = [
    '/',
    offlinePath,
    '/manifest.webmanifest',
    ...precachePosts.map((post) => post.url),
  ];

  files.push({
    path: '/sw.js',
    content: buildServiceWorker({ version: fingerprint, precache, offlineUrl: offlinePath, basePath }),
  });

  logger.info(`PWA：manifest + sw.js（缓存 ${cacheName(fingerprint)}）+ ${offlinePath}，预缓存 ${precache.length} 个地址`);
  return { files, fingerprint };
}

/**
 * 从项目/主题的图标里挑出**确实存在**的档位。
 *
 * 只声明存在的图标是硬要求：manifest 里的每个图标都会被下载并在安装时校验，
 * 缺一个就是「安装失败」——而失败信息在浏览器控制台里很不显眼，
 * 表现成「PWA 功能好像没做」。
 */
function pickIcons(configured, theme) {
  const out = {};
  for (const size of ICON_SIZES) {
    const value = configured?.[String(size)] ?? configured?.[size];
    if (value) out[String(size)] = value;
  }
  if (configured?.maskable) out.maskable = configured.maskable;
  return out;
}

/** 内容指纹。与 SW 里的 FNV-1a 同一算法族，但这里只用来做缓存名，不参与校验。 */
function hashString(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
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
