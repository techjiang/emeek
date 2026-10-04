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
    /**
     * 性能配置。
     *
     * 每一项默认都打开「安全的那一侧」：
     *  lazyLoading  首屏之外的图片懒加载。关掉只会在长文里多下几张图，没有场景需要关。
     *  criticalCSS  主题 CSS 内联进 <head>。超过 criticalCssLimit 的那几份走外链。
     *  prefetch     预取下一篇可能读的文章（只做文章页）。
     *               关掉它的场景是「多页部署、流量敏感」—— 预取会让 PV 之外的带宽上升。
     *  preconnect   站内 origin 的预连接。自托管单域时几乎无效，但无害。
     *  responsiveImages
     *               响应式图片。默认 **关** —— 它需要项目自己提供候选集
     *               （见 imageVariants），没有候选集时生成 srcset 就是编造地址。
     *               打开它必须同时给 imageVariants，否则构建会警告并跳过。
     *  imageVariants
     *               已知的图片候选宽度：{ '/assets/cover.png': [{ width: 400 }, { width: 800 }] }。
     *               只写你**确实生成了**的尺寸，srcset 里出现的每个地址都会被请求。
     *  criticalCssLimit
     *               单个 CSS 文件的内联上限（字节）。超过就走外链。
     */
    perf: {
      lazyLoading: true,
      criticalCSS: true,
      criticalCssLimit: 24 * 1024,
      prefetch: true,
      preconnect: true,
      responsiveImages: false,
      imageVariants: {},
    },
    /**
     * PWA 配置。**默认关闭。**
     *
     * 为什么默认关：Service Worker 是本站里唯一「装上之后还会影响后续访问」
     * 的东西 —— 页面上的 bug 刷新就没了，SW 的 bug 会让读者看到旧页面。
     * 「零配置即可运行」的代价不该是「零配置就给访客装一个 SW」。
     *
     * 打开后产出三样东西：
     *   /manifest.webmanifest  应用身份（名称 / 图标 / start_url）
     *   /sw.js                 离线缓存（导航 network-first，静态资源 SWR）
     *   /offline.html          断网回落页
     *
     * icons        项目自己提供的图标地址表：{ "192": "/assets/i192.png", "512": "...", maskable: "..." }。
     *              只声明**确实存在**的档位 —— manifest 里的每个图标都会在安装时被校验。
     * precachePosts 预缓存的文章篇数。默认 5。全站预缓存 = 给每个访客加一次全站下载。
     * offlinePath  离线页地址。
     * installPrompt 安装提示横幅。默认关 —— 第一次访问就弹安装横幅是最常被抱怨的 Web 行为。
     */
    pwa: {
      enabled: false,
      themeColor: '#ffffff',
      backgroundColor: '#ffffff',
      display: 'standalone',
      icons: {},
      precachePosts: 5,
      offlinePath: '/offline.html',
      installPrompt: false,
    },
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
