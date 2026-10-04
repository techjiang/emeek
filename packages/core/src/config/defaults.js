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
    search: { enabled: true, fuzzy: true, maxResults: 10 },
    seo: { sitemap: true, robots: true, openGraph: true, structuredData: true, canonical: true },
    feed: { enabled: true, limit: 20 },
    perf: { lazyLoading: true, criticalCSS: true },
    plugins: [],
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
