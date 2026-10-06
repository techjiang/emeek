/**
 * 手写轻量校验，避免为一个配置对象引入 JSON Schema 依赖。
 * 每一项返回 [path, message]，由调用方决定抛错还是警告。
 */
const RULES = [
  { path: 'site.title', type: 'string', required: true },
  { path: 'site.url', type: 'string', required: true, check: (v) => /^https?:\/\//.test(v) || '必须是以 http(s):// 开头的完整地址' },
  { path: 'site.language', type: 'string' },
  { path: 'content.source', type: 'string', check: (v) => ['local', 'github-issues', 'hybrid'].includes(v) || '只能是 local / github-issues / hybrid' },
  { path: 'content.repo', type: 'string', check: (v, cfg) => cfg.content.source === 'local' || /^[\w.-]+\/[\w.-]+$/.test(v) || '使用 github-issues 源时必须为 owner/repo 形式' },
  { path: 'content.localDirs', type: 'array' },
  { path: 'theme.name', type: 'string' },
  { path: 'theme.darkMode', type: 'string', check: (v) => ['auto', 'light', 'dark', 'toggle'].includes(v) || '只能是 auto / light / dark / toggle' },
  { path: 'feed.limit', type: 'number', check: (v) => Number.isInteger(v) && v > 0 || '必须是正整数' },
  { path: 'feed.fullContent', type: 'boolean' },
  { path: 'feed.categories', type: 'array' },
  { path: 'search.maxResults', type: 'number', check: (v) => Number.isInteger(v) && v > 0 || '必须是正整数' },
  { path: 'search.suggest', type: 'number', check: (v) => Number.isInteger(v) && v > 0 || '必须是正整数' },
  { path: 'search.gzipBudget', type: 'number', check: (v) => Number.isInteger(v) && v > 0 || '必须是正整数（字节）' },
  { path: 'search.indexPath', type: 'string', check: (v) => v.startsWith('/') || '必须以 / 开头' },
  { path: 'search.pagePath', type: 'string', check: (v) => v.startsWith('/') || '必须以 / 开头' },
  { path: 'search.inlineLimit', type: 'number', check: (v) => Number.isInteger(v) && v >= 0 || '必须是非负整数（字节）' },
  { path: 'seo.sitemap', type: 'boolean' },
  { path: 'seo.robots', check: (v) => typeof v === 'boolean' || (typeof v === 'object' && v !== null) || '只能是布尔值或对象' },
  { path: 'seo.openGraph', type: 'boolean' },
  { path: 'seo.structuredData', type: 'boolean' },
  { path: 'seo.canonical', type: 'boolean' },
  { path: 'perf.lazyLoading', type: 'boolean' },
  { path: 'perf.criticalCSS', type: 'boolean' },
  { path: 'perf.prefetch', type: 'boolean' },
  { path: 'perf.preconnect', type: 'boolean' },
  { path: 'perf.responsiveImages', type: 'boolean' },
  {
    path: 'perf.criticalCssLimit',
    type: 'number',
    check: (v) => (Number.isInteger(v) && v > 0) || '必须是正整数（字节）',
  },
  {
    path: 'perf.imageVariants',
    type: 'object',
    check: (v) => Object.entries(v).every(([src, list]) => {
      if (!Array.isArray(list)) return `「${src}」的候选集必须是数组`;
      return list.every((item) => Number.isFinite(Number(item?.width)) && Number(item.width) > 0)
        || `「${src}」的候选项必须带正数 width（只写你确实生成了的尺寸）`;
    }) || '候选集格式不正确',
  },
  { path: 'pwa.enabled', type: 'boolean' },
  {
    path: 'pwa.display',
    type: 'string',
    check: (v) => ['standalone', 'minimal-ui', 'browser', 'fullscreen'].includes(v)
      || '只能是 standalone / minimal-ui / browser / fullscreen',
  },
  { path: 'pwa.themeColor', type: 'string' },
  { path: 'pwa.backgroundColor', type: 'string' },
  { path: 'pwa.installPrompt', type: 'boolean' },
  {
    path: 'pwa.precachePosts',
    type: 'number',
    check: (v) => (Number.isInteger(v) && v >= 0) || '必须是非负整数（篇）',
  },
  {
    path: 'pwa.offlinePath',
    type: 'string',
    check: (v) => v.startsWith('/') || '必须以 / 开头',
  },
  // 部署目标枚举必须与 deploy/platforms.js 的注册表一致：多一个未注册的名字
  // 只会在真正推送时才炸，那时产物已经在路上了。
  { path: 'deploy.target', type: 'string', check: (v) => ['github-pages', 'vercel', 'netlify', 'cloudflare', 'rsync', 'docker', 'custom'].includes(v) || '不支持的部署目标' },
  { path: 'deploy.customDomain', type: 'string' },
  { path: 'deploy.verify', type: 'boolean' },
  { path: 'deploy.probes', type: 'array' },
  { path: 'plugins', type: 'array' },
  { path: 'cdn.enabled', type: 'boolean' },
  {
    path: 'cdn.provider',
    type: 'string',
    // null 表示「未配置 CDN」——允许，缺失不是错误。
    check: (v) => v === null || v === undefined || ['cloudflare', 'aliyun', 'tencent', 'custom'].includes(v) || '不支持的 CDN 提供商（cloudflare / aliyun / tencent / custom）',
  },
  {
    path: 'cdn.china.enabled',
    type: 'boolean',
  },
  // ── 分析（P3-4b-rest A）───────────────────────────────────────
  //
  // provider 枚举必须与 analytics/providers.js 的注册表一致：
  // 一个未注册的 provider 名字在构建期只是「不注入任何脚本」，
  // 看起来构建成功、页面上也确实没有统计 —— 比报错难查得多。
  { path: 'analytics.enabled', type: 'boolean' },
  {
    path: 'analytics.provider',
    type: 'string',
    check: (v) => ['builtin', 'plausible', 'umami', 'goatcounter', 'custom'].includes(v)
      || '只能是 builtin / plausible / umami / goatcounter / custom',
  },
  { path: 'analytics.builtin.trackPageViews', type: 'boolean' },
  { path: 'analytics.builtin.retentionDays', type: 'number', check: (v) => (Number.isInteger(v) && v > 0) || '必须是正整数（天）' },
  { path: 'analytics.builtin.excludeAdmin', type: 'boolean' },
  {
    path: 'analytics.statsPage.enabled',
    type: 'boolean',
  },
  {
    path: 'analytics.statsPage.path',
    type: 'string',
    check: (v) => v.startsWith('/') || '必须以 / 开头',
  },
  { path: 'analytics.statsPage.nav', type: 'boolean' },
  { path: 'analytics.statsPage.sections', type: 'array' },
  // ── 社交分享（P3-4b-rest C）─────────────────────────────────
  //
  // platform 名字不做枚举校验：未知名字由 core/share 收集并在构建期告警，
  // 在这里报错会让整个构建失败 —— 而一个写错的分享平台名不该阻止发文。
  { path: 'share.enabled', type: 'boolean' },
  { path: 'share.platforms', type: 'array' },
  {
    path: 'share.position',
    type: 'string',
    check: (v) => ['bottom', 'sidebar', 'both'].includes(v) || '只能是 bottom / sidebar / both',
  },
  { path: 'share.utm_source', check: (v) => v === null || typeof v === 'string' || '只能是字符串或 null' },
  { path: 'share.utm_medium', check: (v) => v === null || typeof v === 'string' || '只能是字符串或 null' },
  { path: 'share.utm_campaign', check: (v) => v === null || typeof v === 'string' || '只能是字符串或 null' },
  // ── 阅读统计显示（P3-4b-rest D1）─────────────────────────────
  { path: 'reading.showTime', type: 'boolean' },
  { path: 'reading.showDate', type: 'boolean' },
  { path: 'reading.showComments', type: 'boolean' },
  {
    path: 'reading.wordsPerMinute',
    type: 'number',
    check: (v) => (Number.isInteger(v) && v > 0) || '必须是正整数（字/分钟）',
  },
  // ── 内容工作流（P3-4b-rest D2）───────────────────────────────
  {
    path: 'workflow.validate',
    type: 'string',
    check: (v) => ['off', 'warn', 'error'].includes(v) || '只能是 off / warn / error',
  },
  { path: 'workflow.checks', type: 'array' },
  { path: 'workflow.schedule.enabled', type: 'boolean' },
  {
    path: 'workflow.schedule.graceHours',
    type: 'number',
    check: (v) => (Number.isInteger(v) && v >= 0) || '必须是非负整数（小时）',
  },
];

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  for (const rule of RULES) {
    const value = getPath(config, rule.path);
    if (value === undefined || value === null) {
      if (rule.required) errors.push({ path: rule.path, message: '缺少必填项' });
      continue;
    }
    if (rule.type && !matchesType(value, rule.type)) {
      errors.push({ path: rule.path, message: `类型应为 ${rule.type}，实际为 ${typeof value}` });
      continue;
    }
    if (rule.check) {
      const result = rule.check(value, config);
      if (result !== true) errors.push({ path: rule.path, message: result });
    }
  }

  if (config.site.url.endsWith('/')) warnings.push({ path: 'site.url', message: '结尾斜杠会被自动去掉，建议不写' });
  if (config.content.source !== 'local' && !process.env.GITHUB_TOKEN) {
    warnings.push({ path: 'content.source', message: '未检测到 GITHUB_TOKEN，读取 Issues 可能触发限流' });
  }
  return { errors, warnings };
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  return typeof value === type;
}

export function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
