import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, resolvePluginSpec } from '../config/loader.js';
import { loadPosts } from './source/index.js';
import { renderMarkdown } from './parse/markdown.js';
import { buildToc, renderToc, addAnchorLinks } from './transform/toc.js';
import { makeExcerpt, readingTime, countWords } from './transform/excerpt.js';
import { buildWikiLinkIndex, resolveWikiLink, computeBacklinks } from './transform/links.js';
import { decorateImages, createImageResolver } from './transform/images.js';
import { buildJsonLd, renderHeadMeta, buildSitemap, buildRss, buildRobots, buildSearchIndex } from './transform/seo.js';
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

  // ── 5. 渲染页面 ────────────────────────────────────────────────
  const pages = [];
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
    searchIndexUrl: config.search?.enabled ? '/search-index.json' : null,
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
      path: index === 0 ? '/index.html' : `/page/${index + 1}.html`,
      data: {
        ...common(),
        type: 'home',
        title: null,
        description: config.site.description,
        canonical: index === 0 ? `${config.site.url}/` : `${config.site.url}${url}`,
        posts: slice.map(toCard),
        pagination: { current: index + 1, total: pageCount, prev: index > 0 ? (index === 1 ? '/' : `/page/${index}.html`) : null, next: index + 1 < pageCount ? `/page/${index + 2}.html` : null },
        pinned: index === 0 ? sorted.filter((p) => p.pinned).map(toCard) : [],
      },
    });
  }

  for (const post of sorted) {
    pages.push({
      layout: 'post',
      path: post.url,
      data: {
        ...common(),
        type: 'article',
        title: post.title,
        description: post.description,
        image: post.cover,
        lang: post.lang,
        canonical: `${config.site.url}${post.url}`,
        post,
        related: findRelated(post, sorted),
        jsonLd: JSON.stringify(buildJsonLd({ site: siteData, post, url: `${config.site.url}${post.url}` })),
      },
    });
  }

  pages.push({
    layout: 'archive',
    path: '/archive.html',
    data: { ...common(), type: 'website', title: '归档', description: '全部文章按时间排列', canonical: `${config.site.url}/archive.html`, groups: groupByYear(sorted) },
  });
  pages.push({
    layout: 'tags',
    path: '/tags.html',
    data: { ...common(), type: 'website', title: '标签', description: '按标签浏览文章', canonical: `${config.site.url}/tags.html`, tags: tags.sort((a, b) => b.count - a.count) },
  });
  pages.push({
    layout: 'about',
    path: '/about.html',
    data: { ...common(), type: 'website', title: '关于', description: `${config.site.title} 的关于页`, canonical: `${config.site.url}/about.html`, content: await renderAbout(cwd, config) },
  });
  pages.push({
    layout: '404',
    path: '/404.html',
    data: { ...common(), type: 'website', title: '页面不存在', canonical: `${config.site.url}/404.html`, description: '找不到这个页面' },
  });

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
        data: { ...common(), type: 'website', title: definition.title ?? null, description: definition.description ?? '', canonical: `${siteData.url}${definition.path}`, ...definition.data },
      });
    }
  }

  // 布局渲染 + 插件钩子
  const rendered = [];
  for (const page of pages) {
    // headMeta 依赖 title/description/canonical，只能在页面数据齐备后生成。
    page.data.headMeta = renderHeadMeta({
      site: siteData,
      page: { title: page.data.title, description: page.data.description, type: page.data.type, image: page.data.image, lang: page.data.lang },
      canonical: page.data.canonical,
    });
    const html = renderLayout(theme, page.layout, page.data);
    rendered.push({ ...page, html });
  }
  await hooks.run('onBeforeRender', { config, pages: rendered, posts, site: siteData });

  // ── 6. 附加文件 ────────────────────────────────────────────────
  const extraFiles = [];
  if (config.seo?.sitemap !== false) {
    extraFiles.push({
      path: '/sitemap.xml',
      content: buildSitemap(siteData, [
        { url: `${siteData.url}/`, priority: '1.0', changefreq: 'daily' },
        ...sorted.map((p) => ({ url: `${siteData.url}${p.url}`, lastmod: p.updated?.slice(0, 10) })),
        { url: `${siteData.url}/archive.html`, priority: '0.5' },
        { url: `${siteData.url}/tags.html`, priority: '0.5' },
      ]),
    });
  }
  if (config.feed?.enabled !== false) {
    extraFiles.push({ path: '/rss.xml', content: buildRss(siteData, sorted, { limit: config.feed?.limit ?? 20 }) });
  }
  if (config.seo?.robots !== false) {
    extraFiles.push({ path: '/robots.txt', content: buildRobots(siteData) });
  }
  if (config.search?.enabled) {
    extraFiles.push({ path: '/search-index.json', content: JSON.stringify(buildSearchIndex(sorted)) });
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
      return renderMarkdown(raw, { allowHtml: false, resolveImage: (u) => u, resolveLink: (u) => u, headingIds: new Map() });
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
