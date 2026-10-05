import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
import { buildAnalyticsScripts, validateAnalyticsConfig } from '../analytics/providers.js';
import { renderProbeTag } from '../analytics/probe.js';
import { buildStatsView, hasSectionData } from '../stats/index.js';
import { buildShareView, SHARE_CLIENT } from '../share/index.js';
import { partitionPosts, validatePosts } from '../workflow/index.js';

/**
 * 构建主流程。这是一个纯函数式的管线：
 *   load → normalize → render markdown → transform → render template → write
 * 每一步只接收上一步的产物，插件通过生命周期钩子插入，不改变管线形状。
 */
export async function build({ cwd = process.cwd(), configPath, onProgress } = {}) {
  const started = Date.now();
  /**
   * 全站共用的「现在」。
   *
   * 单独抽一个变量而不是各处 new Date()：统计页的运行天数、热力图的终点、
   * sitemap 的 lastmod 判据都读它。如果各处自己取时间，跨零点的那次构建
   * 会出现「热力图到 3 号，但运行天数算到 2 号」这种自相矛盾的产物。
   */
  const buildNow = new Date();
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

  /**
   * 分析片段只算一次，全站共用。
   *
   * `analytics.enabled !== true` 时这里得到的就是两个空串 —— 全站
   * 零 script。校验失败会抛错（而不是注入一个半残的脚本）：
   * 一个「配了但不生效」的分析比报错难查得多。
   */
  const analytics = validateAndBuildAnalytics(config);

  logger.step(`内容源：${config.content.source}${resolved ? ` · 配置：${path.relative(cwd, resolved)}` : ' · 使用默认配置'}`);

  // ── 1. 读取内容 ────────────────────────────────────────────────
  const rawPosts = await loadPosts(cwd, config);
  /**
   * 草稿与定时发布的**唯一判定点**（见 workflow/index.js）。
   *
   * 之前这里是 `rawPosts.filter(p => !p.draft)` —— 草稿被排除，
   * 但「发布时间在未来」的文章会被当成已发布**直接上线**。
   * 那是「定时发布」最危险的失败形态：你以为它在等，其实它已经发了。
   *
   * 现在两种情况共用同一个 partitionPosts，命令行（emeek drafts）
   * 与产物读到的是同一份判定，不可能分叉。
   */
  const { published, drafts, scheduled } = partitionPosts(rawPosts, {
    now: buildNow,
    schedule: config.workflow?.schedule ?? {},
  });
  logger.info(`读取 ${rawPosts.length} 篇内容（${drafts.length} 篇草稿、${scheduled.length} 篇待定时发布已跳过）`);

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
  for (const post of published) {
    post.url = urlFor(post);
    // 绝对地址。分享链接必须是绝对的 —— 社交平台是在**它自己的域名**下
    // 抓这个链接的，相对地址抓取直接失败。SEO 那里也会重新算一遍 canonical，
    // 但分享是**构建期**就要用到的，不能等到 applySeo。
    post.canonical = `${config.site.url}${post.url}`;
  }

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
      // 阅读时长口径由 config.reading.wordsPerMinute 决定（默认 400 字/分钟，
      // 与 AI 模块的阅读时长估算同一口径）。之前这里用的是 excerpt.js 的
      // 默认值 300 —— 于是同一篇文章的「预计阅读时间」在页面上和 AI 分析里
      // 是两个数字。两处口径必须来自一处。
      readingTime: readingTime(text, { wpm: Number(config.reading?.wordsPerMinute ?? 400) }),
      dateFormatted: formatDate(post.date, config.site.language),
      updatedFormatted: formatDate(post.updated, config.site.language),
      url: post.url,
      // 评论数：只来自 Issues 源（local 源没有）。null 与 0 分开 ——
      // 主题据此决定「显示 0」还是「根本不显示这一项」。
      commentCount: post.interactions?.comments ?? null,
    };
    posts.push(enriched);
    bar.tick();
  }
  bar.done();

  await hooks.run('onContentLoad', { config, posts, site: siteData });
  computeBacklinks(posts);

  // ── 3.5 内容校验（P3-4b-rest D2）─────────────────────────────
  //
  // 放在这里而不是写盘前：校验要看到**渲染后的文章**（内链检查需要知道
  // 解析出的链接），但不需要等页面渲染完。早一点发现问题，日志里离
  // 出错的文件更近。
  const validation = runContentValidation({ config, cwd, posts, drafts, scheduled, rawPosts });
  if (validation) posts.validation = validation;

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
  // 统计页开关。放在 common() 之前 —— 导航项要读它，而 common() 是闭包。
  const statsEnabled = config.analytics?.statsPage?.enabled === true;

  let commentsScriptCache = null;
  const commentsScript = async () => {
    if (commentsScriptCache === null) commentsScriptCache = await loadCommentsClient();
    return commentsScriptCache;
  };
  const common = () => ({
    site: siteData,
    config,
    nav: buildNav(config, tags, categories),
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
    // 分析脚本。默认**两段都是空字符串** —— 这是「默认零追踪」在模板层的落点：
    // 主题无条件输出 {{{ analyticsHead }}} / {{{ analyticsFooter }}}，
    // 关掉时它们就是空的，产物里连一个 script 标签都不会多。
    analyticsHead: analytics.head,
    analyticsFooter: analytics.footer,
    analyticsEnabled: config.analytics?.enabled === true,
    analyticsProvider: analytics.provider,
    // 统计页入口。默认 null —— 主题的导航 partial 据此决定要不要渲染那一项。
    statsUrl: statsEnabled ? (config.analytics?.statsPage?.path ?? '/stats/') : null,
    // 社交分享。默认 null —— 只有文章页会填。理由同 reading：
    // 让「非文章页 include 了 share partial」表现成「不渲染」而不是崩溃。
    shareView: null,
    shareScript: '',
    // 阅读统计显示的开关。主题据此决定是否渲染徽章 —— 判据放在引擎，
    // 4 套主题不会各自解释「showComments 是什么意思」。
    readingDisplay: config.reading ?? {},
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
    // 分享视图：引擎算好（链接拼接 + UTM + 平台可用性），主题只摆放。
    const shareView = buildShareView(post, config);
    if (shareView?.unknown?.length) {
      logger.warn(`share.platforms 里有未知平台：${shareView.unknown.join(' / ')}（会被忽略，请检查拼写）`);
    }
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
        // 社交分享（P3-4b-rest C）。null 表示这一页不出分享按钮 ——
        // 主题据此整块不渲染，而不是渲染一排空链接。
        shareView: shareView,
        // 只有真的需要浏览器端的分享按钮（微信二维码 / 复制链接）才带脚本。
        // 一个只有 <a> 分享按钮的页面不该背这段 QR 编码器。
        shareScript: shareView && shareView.needsClient ? SHARE_CLIENT : '',
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
  /**
   * 分类总览页。
   *
   * 与标签总览页**共用同一个布局**（tags.html）——两者的页面形态完全一样
   * （一组名字 + 数量 + 链接），分叉成两个布局只会得到两份迟早漂移的模板。
   * 差异只有「title 是分类」与「href 指向 /categories/」。
   *
   * 之前没有这一页：分类条目在面包屑里指向 /tags.html（「据实」，
   * 因为那时没有 /categories.html）。现在有了，面包屑也跟着改（见 buildBreadcrumbs）。
   */
  pages.push({
    layout: 'tags',
    strict: true,
    path: '/categories.html',
    data: { ...common(), type: 'website', seoKind: 'collection', title: '分类', description: '按分类浏览文章', canonical: `${config.site.url}/categories.html`, tags: categories.sort((a, b) => b.count - a.count) },
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

  // 统计页（P3-4b-rest B）。**在这里 push 而不是渲染完之后补**：
  // sitemap 的条目来自 `rendered`，PWA 的缓存指纹也算 `rendered` ——
  // 补在后面意味着统计页不在 sitemap 里、也不进 SW 缓存，
  // 而这两种缺失都不会报错，只会让统计页「莫名其妙搜不到 / 离线打不开」。
  // 我第一版就是补在后面，被 sitemap 断言抓出来了。
  const statsPage = buildStatsPage({ config, sorted, siteData, now: buildNow, base: common() });
  if (statsPage) pages.push(statsPage);

  // 布局渲染 + 插件钩子
  const rendered = [];
  for (const page of pages) {
    applySeo(page.data, { site: siteData, config, seo });
    const html = renderLayout(theme, page.layout, page.data, { strict: page.strict === true });
    rendered.push({ ...page, html });
  }
  if (statsPage) {
    logger.info(`统计页：${statsPage.rendered.length} 个区块（${statsPage.path_}）`);
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
    scheduled: scheduled.map((post) => ({ title: post.title, slug: post.slug, date: post.date })),
    titles: sorted.map((post) => post.title),
  };

  const stats = {
    elapsed: Date.now() - started,
    searchIndex: searchIndexStats,
    posts: sorted.length,
    pages: rendered.length,
    drafts: drafts.length,
    scheduled: scheduled.length,
    validation,
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
    // 评论数：只来自 Issues 源。null 与 0 分开 —— 主题据此决定
    // 「显示 0 条评论」还是「不显示这一项」（见 config.reading.showComments）。
    commentCount: post.commentCount ?? post.interactions?.comments ?? null,
    updated: post.updated,
    updatedFormatted: post.updatedFormatted,
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
    crumbs.push({ name: '分类', url: `${site.url}/categories.html` });
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
  if (page.data.type === 'website' && ['归档', '标签', '分类'].includes(title)) return SITEMAP_POLICY.taxonomy;
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

/**
 * 分析脚本的构建期入口。
 *
 * 单独抽出来是为了让「关掉时到底注入了什么」成为**可单独测试**的一件事：
 * 直接调这个函数断言返回两个空串，比构建一整个站点再看产物快得多，
 * 而且失败时的信息也更清楚。
 */
export function validateAndBuildAnalytics(config = {}) {
  const analytics = config.analytics ?? {};
  if (analytics.enabled !== true) {
    // 零追踪：连配置都不看。一个关掉的功能不该因为配置里留了半截参数而报错。
    return { head: '', footer: '', provider: null, origin: null };
  }
  const { errors, warnings } = validateAnalyticsConfig(analytics);
  for (const warning of warnings) logger.warn(`${warning.path}: ${warning.message}`);
  if (errors.length) {
    throw new Error(`分析配置校验失败：\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`);
  }
  const built = buildAnalyticsScripts(analytics, {
    buildProbe: (cfg) => {
      const endpoint = cfg?.endpoint;
      if (!endpoint) throw new Error('analytics.builtin.endpoint 未配置，无法开启 PV 记录');
      return renderProbeTag({ endpoint, retentionDays: cfg.retentionDays });
    },
  });
  if (built.origin) logger.info(`分析：${built.provider} · 数据发往 ${built.origin}`);
  else if (built.provider) logger.info(`分析：${built.provider}（站内，不发往第三方）`);
  return built;
}

/**
 * 构建期内容校验（P3-4b-rest D2）。
 *
 * 三件事决定它的行为，都在配置里：
 *   workflow.validate = off   → 完全不跑
 *                     = warn  → 逐条告警，构建继续（默认）
 *                     = error → 有问题就让构建失败
 *
 * `knownFiles` 由**项目目录**扫描得到（内容目录 + assets），不是「渲染器认为
 * 有哪些图」—— 后者拿不到「文件到底在不在」这个事实。拿不到时就跳过这项检查，
 * 而不是凭猜报警。
 */
function runContentValidation({ config, cwd, posts, drafts, scheduled, rawPosts }) {
  const mode = config.workflow?.validate ?? 'warn';
  if (mode === 'off') return null;

  const source = config.content?.source ?? 'local';
  // knownFiles 只在本地源时可用（远程源的文件不在磁盘上）。
  // 扫描是同步的：校验要在渲染之前出结果，而它只读目录名，很快。
  const knownFiles = source === 'github-issues' ? null : scanKnownFiles(cwd, config);
  const urlSet = new Set(posts.map((p) => p.url).filter(Boolean));

  const { issues, counts } = validatePosts(posts, {
    checks: config.workflow?.checks ?? [],
    knownFiles,
    urlSet,
    source,
  });

  if (!issues.length) {
    logger.info(`内容校验：${posts.length} 篇全部通过`);
    return { mode, issues: [], counts };
  }

  const limit = Number(config.workflow?.maxReport ?? 20);
  logger.warn(`内容校验：${counts.error} 个错误、${counts.warn} 个警告`);
  for (const item of issues.slice(0, limit)) {
    const tag = item.severity === 'error' ? '✗' : '!';
    logger.raw(`  ${tag} [${item.rule}] ${item.file} · ${item.message}`);
    logger.raw(`      → ${item.fix}`);
  }
  if (issues.length > limit) logger.dim(`  …还有 ${issues.length - limit} 条，完整清单见 .emeek/workflow-report.json`);

  const report = { mode, issues, counts, drafts: drafts.length, scheduled: scheduled.length, total: rawPosts.length };
  if (mode === 'error' && counts.error > 0) {
    throw new Error(
      `内容校验失败（workflow.validate = error）：${counts.error} 个错误。`
      + '\n逐条修掉后再构建，或把 workflow.validate 改成 warn。',
    );
  }
  return report;
}

/**
 * 项目里「确实存在」的文件集合（以 / 开头）。
 *
 * 只扫内容目录与 assets —— 全仓库扫描会把 node_modules（几万个文件）
 * 拖进来，而校验只关心「这篇 Markdown 引用的图在不在」。
 */
function scanKnownFiles(cwd, config) {
  const set = new Set();
  const roots = [...(config.content?.localDirs ?? ['posts']), 'assets', 'public', 'static'];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fsSync.readdirSync(path.resolve(cwd, dir), { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else set.add(rel);
    }
  };
  for (const root of roots) walk(root, '');
  return set;
}

/**
 * 统计页。
 *
 * 返回 null 表示这一页不存在 —— 与「生成了一个空页面」是完全不同的两件事。
 * 关掉时导航里没有入口、sitemap 里没有 URL、产物里没有文件。
 *
 * 互动数据（评论数 / reaction 数）来自 Issues 源的文章自带字段；
 * local 源没有，此时统计页会把评论那一栏显示为「无数据源」而不是 0。
 */
function buildStatsPage({ config, sorted, siteData, now = new Date(), base = {} }) {
  if (config.analytics?.statsPage?.enabled !== true) return null;

  // 从文章里汇总 Issues 互动数据。只有 Issues 源的文章才有这两个字段 ——
  // 一篇都没有时返回 null，让统计层走「无数据源」分支。
  const comments = {};
  let anyInteraction = false;
  for (const post of sorted) {
    const stats = post.interactions;
    if (!stats) continue;
    anyInteraction = true;
    comments[post.slug] = stats;
    if (post.issueNumber != null) comments[String(post.issueNumber)] = stats;
  }

  const view = buildStatsView(sorted, {
    config,
    comments: anyInteraction ? comments : null,
    now,
    timezone: config.site?.timezone ?? 'Asia/Shanghai',
    // 标签 URL 由引擎算好再传进去 —— 统计页自己拼 /tags/<name>.html 会与
    // 标签页实际的 slugify 规则（大小写、空格、非字母数字）对不上，
    // 表现成统计页上的标签链 404，而标签总览页上是好的。
    tagUrl: base.tagUrl,
  });
  if (!view.rendered.length) return null;

  const path = view.path;
  const pagePath = path.endsWith('/') ? `${path}index.html` : path;
  return {
    layout: 'stats',
    strict: true,
    path: pagePath,
    path_: path,
    rendered: view.rendered,
    data: {
      // 非文章页仍然需要全套公共数据（site / config / nav / seo / jsonld）。
      // 直接展开 base 而不是手写一份 —— 手写的那份一定会漏掉后来新加的字段，
      // 而漏掉的表现是「某个页面少了一块」，不会有任何报错。
      ...base,
      type: 'website',
      seoKind: 'webpage',
      title: '站点统计',
      description: `${siteData.title} 的内容统计 —— 数据全部在构建期从内容推断，零追踪、零 Cookie`,
      canonical: `${siteData.url}${path}`,
      statsView: view,
    },
  };
}

/**
 * 导航。
 *
 * 统计页的入口**只在它真的存在时**出现 —— 一个点进去 404 的「统计」
 * 比没有这一项更糟。所以判据是 statsPage.enabled，不是「有没有配 path」。
 * 默认关闭也是刻意的：绝大多数个人博客不想把「这个站只有 3 篇文章」
 * 摆在导航栏上。
 */
function buildNav(config, tags, categories = []) {
  const nav = [
    { title: '首页', url: '/' },
    { title: '归档', url: '/archive.html' },
    { title: '标签', url: '/tags.html' },
    // 分类入口只在**真的有分类**时出现 —— 一个点进去空无一物的「分类」
    // 比没有这一项更像坏了。判据是 categories 数组，不是配置开关：
    // 有没有分类是内容决定的，不该让用户去配。
    ...(categories.length ? [{ title: '分类', url: '/categories.html' }] : []),
    { title: '关于', url: '/about.html' },
  ];
  if (config.analytics?.statsPage?.enabled === true && config.analytics?.statsPage?.nav !== false) {
    nav.push({ title: '统计', url: config.analytics.statsPage.path ?? '/stats/' });
  }
  return nav;
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
