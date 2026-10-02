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
      name: 'minimal',
      darkMode: 'auto',
      customCSS: '',
      customHead: '',
      customFooter: '',
      colors: { primary: '#111827', accent: '#2563eb', background: '#ffffff' },
      fonts: { sans: 'system-ui, -apple-system, sans-serif', mono: 'ui-monospace, monospace' },
    },
    search: { enabled: true, fuzzy: true, maxResults: 10 },
    seo: { sitemap: true, robots: true, openGraph: true, structuredData: true, canonical: true },
    feed: { enabled: true, limit: 20 },
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
