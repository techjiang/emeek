/**
 * 所有配置项都有默认值，零配置即可运行 —— 这是继承自 Gmeek 的核心哲学。
 */
export function defaultConfig() {
  return {
    site: {
      title: '我的知识宇宙',
      description: 'Emeek 驱动的个人博客',
      url: 'https://example.com',
      author: 'Anonymous',
      avatar: '',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
    },
    content: {
      source: 'local', // local | github-issues | hybrid
      repo: '',
      labels: { publish: 'publish', draft: 'draft', pin: 'pin' },
      categories: {},
      localDirs: ['posts'],
      /**
       * 允许正文里的原始 HTML 原样输出。默认关闭。
       *
       * 打开它等于把「内容作者的 HTML」直接写进站点 —— 而内容可能来自别人
       * 提的 Issue、别人发的 .md。所以打开时仍然会做一轮 sanitizeHtml
       * （剥 <script>/<iframe>/on* 等），见 pipeline/parse/sanitize-html.js。
       * 不存在「完全不过滤的原样输出」这个选项。
       */
      allowHtml: false,
    },
    theme: {
      /**
       * 只放「与具体主题无关」的开关。颜色与字体**刻意不给默认值** ——
       * 它们由所选主题的 theme.json config 提供。
       * 若在这里写死一套颜色，它会在合并时盖掉主题自己的默认值：
       * 加载 aurora 却拿到 minimal 的黑白配色，且看不出是谁改的。
       * 用户要覆盖就写 theme.colors（见 docs/themes.md）。
       */
      name: 'minimal',
      darkMode: 'auto',
      customCSS: '',
      customHead: '',
      customFooter: '',
      /**
       * 运行时主题切换按钮（P3-1b-3b feature F）。默认关闭。
       *
       * themes 里每项 { name, label, url } 的 url 必须是真实存在的另一套主题产物
       * （例如同仓库多主题部署时各自的路径）。没有 url 的主题会以「仅此站」灰态
       * 列出，而不是给一个点了没反应的链接。
       */
      switcher: null,
    },
    /**
     * 搜索配置。
     *
     * gzipBudget  索引 gzip 后的字节上限。超了默认让构建失败 ——
     *             索引跟着页面下载，发一个几 MB 的索引给每个访客
     *             与「搜索是增强」自相矛盾。要放宽就同时设 allowOverBudget。
     * indexPath   索引发布路径。
     * suggest     输入联想条数上限。
     * fuzzy       对 ≥4 字 CJK 词元做编辑距离 1 展开。
     */
    search: {
      enabled: true,
      fuzzy: true,
      maxResults: 10,
      suggest: 8,
      indexPath: '/search-index.json',
      gzipBudget: 512000,
      allowOverBudget: false,
      /** 搜索页路径。目录形式（/search/）比 /search.html 更适合带查询参数。 */
      pagePath: '/search/',
      /** 索引内联上限（字节）。超过就走外链，避免所有页面都变胖。 */
      inlineLimit: 65536,
    },
    /**
     * SEO 配置。
     *
     * sitemap / robots / openGraph / structuredData / canonical
     *             各自的总开关。关掉任何一项都会让对应产物消失 ——
     *             但**默认全开**，因为「被搜索引擎找到」是博客的默认期待。
     * defaultImage 站点级社交卡片兜底图（文章没写 cover 时用它）。
     *             不设时文章页不输出 og:image —— 空 og:image 会让
     *             部分平台抓到一张白图，比没有更糟。
     * robots      false 整份不产出；对象形式支持 { disable, custom } 追加规则。
     * authorUrl   作者主页（结构化数据里的 author.url）。
     */
    seo: {
      sitemap: true,
      robots: true,
      openGraph: true,
      structuredData: true,
      canonical: true,
      defaultImage: null,
      authorUrl: null,
    },
    /**
     * Feed 配置。
     *
     * fullContent  false 时只发摘要（阅读器列表页用），true 时发正文全文。
     *              全文会让 feed 体积大很多 —— 对「订阅」是好事，
     *              对带宽不一定是。默认关。
     * categories   只要这些分类的文章（空数组 = 全部）。
     */
    feed: { enabled: true, limit: 20, fullContent: false, categories: [] },
    perf: { lazyLoading: true, criticalCSS: true },
    plugins: [],
    deploy: { target: 'github-pages', customDomain: '' },
  };
}

/** 深合并用户配置到默认配置上；数组整体替换而非逐项合并。 */
export function mergeConfig(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (!isPlainObject(base)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    out[key] = key in base ? mergeConfig(base[key], value) : value;
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
