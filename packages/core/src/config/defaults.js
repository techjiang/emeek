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
    /**
     * 社交分享（P3-4b-rest C）。**默认关闭。**
     *
     * 与 analytics 同一哲学：分享按钮会在页面上占一块，
     * 而「要不要让别人分享我的文章」是作者的偏好，不是引擎该替他决定的。
     *
     * platforms  要出现哪些平台。可选：twitter / weibo / telegram / reddit /
     *            hackernews / email / wechat / copy。未知名字会被忽略并告警
     *            （不静默 —— 「我配了但没出现」会把人引去改主题）。
     *                wechat 与 copy 不需要跳转：前者在本地画二维码，后者用剪贴板。
     * position   bottom（文章底部）| sidebar（侧栏浮动）| both。
     *            默认 bottom：侧栏浮动在手机上会遮内容，不该是默认。
     * utm_*      拼进分享地址的 UTM 参数，让站点分析能区分「社交来的」与「直接访问」。
     *            设成 null 则不拼该参数。注意这只影响**分享出去的**地址，
     *            站内自己的 URL 不带 UTM。
     */
    share: {
      enabled: false,
      platforms: ['twitter', 'weibo', 'copy'],
      position: 'bottom',
      utm_source: 'emeek',
      utm_medium: 'social',
      utm_campaign: null,
      label: '分享',
    },
    /**
     * 阅读统计显示（P3-4b-rest D1）。
     *
     * showTime     阅读时间徽章（字数 / wordsPerMinute）
     * showDate     发布日期（以及有 updated 时的更新日期）
     * showComments 评论数徽章。**只在有数据源时显示**：local 源没有评论数，
     *              此时不显示而不是显示 0（0 会被读成「没人评论」）。
     * wordsPerMinute 中文按 400 字/分钟（与 AI 模块的阅读时长估算同一口径）。
     */
    reading: {
      showTime: true,
      showDate: true,
      showComments: true,
      wordsPerMinute: 400,
    },
    /**
     * 内容工作流（P3-4b-rest D2）。
     *
     * validate   构建时内容校验。warn（默认）只告警不阻塞；error 让构建失败；
     *            off 关闭。默认 warn 的理由：校验是新加的一道关，
     *            在用户还没调好内容前让它阻塞构建是越界 —— 但问题必须被说出来。
     * checks     要跑哪些检查。空数组 = 全部。
     *            title / date / links / markdown / taxonomy / internal-links
     * schedule   定时发布。enabled 时，date 在未来的文章不进产物（构建期过滤），
     *            CI 定时重建后自动出现。这与「草稿」是两条路：
     *            草稿要手动改，定时发布到点自动上。
     *            graceHours 是**推迟**小时数：date + graceHours 才算到点。
     *            默认 0。设 1~2 可以躲开时钟偏差与 CI 调度的抖动
     *            （定时任务每小时跑时，整点那几秒的偏差会让文章白等一小时）。
     */
    workflow: {
      validate: 'warn',
      checks: [],
      schedule: { enabled: true, graceHours: 0 },
    },
    /**
     * 部署配置。
     *
     * 默认 target 是 github-pages —— 它与 Gmeek 的「Issues 即 CMS」一脉相承：
     * 仓库既是内容源也是托管地。其它平台通过 `emeeek deploy --target` 覆盖。
     */
    deploy: {
      target: 'github-pages',
      customDomain: '',
      // 自定义域名就绪前先不做在线验证，避免每次部署都因 DNS 未生效而红。
      verify: true,
      // 部署后验证的关键路径；留空则用平台默认（首页 / sitemap / RSS）。
      probes: [],
      /**
       * 多源站：同一份产物推到多处，DNS 层做故障转移。
       * role: primary 是主站；其余为镜像，主站不健康时接管。
       * 配合 `emeek accelerate --fanout` 做幂等推送。
       */
      origins: [
        { id: 'github-pages', role: 'primary' },
        { id: 'vercel', role: 'mirror' },
      ],
      healthInterval: '5m',
    },
    /**
     * 全球加速（P3-4b-accel）。默认全开 —— 指纹与预压缩对任何托管都有益，
     * 且不依赖任何外部服务。CDN 相关的项配了 provider 才生效。
     *
     * 注意：这里**永远不放凭据**。API Key 从环境变量或
     * ~/.emeek/credentials 读（见 accel/credentials.js）。
     */
    cdn: {
      enabled: true,
      provider: null,          // cloudflare | aliyun | tencent | custom
      fingerprint: { enabled: true },
      compression: { enabled: true },
      server: true,            // 生成 nginx/Caddy 片段
      cacheRules: {
        static: { ttl: '30d', immutable: true },
        html: { ttl: '5m', staleWhileRevalidate: '1h' },
      },
      china: { enabled: false, provider: null, domain: '', icp: false },
    },
    /**
     * 分析（P3-4b-rest A）。**默认关闭，且关闭时产物里零 script**。
     *
     * 这不是「默认关掉一个功能」，是 Emeek 的价值观：
     * 用户选择 Emeek 是因为它干净 —— 默认开追踪就是背叛。
     *
     * 打开后有两条互不冲突的路：
     *   · 内置（provider: 'builtin'）—— 数据全部在**构建期**从内容推断，
     *     产物里没有任何统计脚本。互动数字（评论 / reaction）来自 Issues 元数据。
     *   · 第三方（plausible / umami / goatcounter）—— 用户显式点名才注入，
     *     且注入的 script 域必须与配置一致（有测试钉住）。
     *   · custom —— 用户塞自己的代码。会破坏「零第三方请求」承诺，
     *     文档与 doctor 都会警告。
     *
     * builtin.trackPageViews 是唯一一处「内置也会发请求」的能力，
     * 它需要一个**用户自托管**的 endpoint。Emeek 不提供收集服务。
     *
     * 这里没有任何「默认 provider」的陷阱：默认值就是 'builtin'，
     * 而 builtin 的 build() 返回空字符串 —— 打开了也什么都不发。
     */
    analytics: {
      enabled: false,
      provider: 'builtin',           // builtin | plausible | umami | goatcounter | custom
      plausible: {
        domain: '',
        scriptSrc: 'https://plausible.io/js/script.js',
      },
      umami: {
        websiteId: '',
        scriptSrc: '',
      },
      goatcounter: {
        code: '',
        scriptSrc: 'https://gc.zgo.at/count.js',
      },
      custom: {
        headScript: '',
        footerScript: '',
      },
      builtin: {
        // 自托管 PV 记录。需要 endpoint；不开时连探针都不生成。
        trackPageViews: false,
        endpoint: '',
        retentionDays: 90,
        excludeAdmin: true,
      },
      /**
       * 统计页（/stats/）。默认**关**。
       *
       * 与 analytics.enabled 分开的理由：统计页展示的是「内容事实」
       * （多少篇、什么时候写的），与「要不要追踪访客」是两件事。
       * 有人想要统计页但不想开任何分析，也有人开分析但不想要公开页面。
       * 把它们绑在一个开关上，两种人都得不到自己想要的。
       */
      statsPage: {
        enabled: false,
        path: '/stats/',
        nav: true,
        sections: ['totals', 'frequency', 'top', 'tags', 'heatmap'],
      },
    },
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
