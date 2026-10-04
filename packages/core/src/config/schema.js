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
  { path: 'search.maxResults', type: 'number', check: (v) => Number.isInteger(v) && v > 0 || '必须是正整数' },
  { path: 'deploy.target', type: 'string', check: (v) => ['github-pages', 'vercel', 'netlify', 'cloudflare', 'rsync', 'docker', 'custom'].includes(v) || '不支持的部署目标' },
  { path: 'deploy.customDomain', type: 'string' },
  { path: 'deploy.verify', type: 'boolean' },
  { path: 'deploy.probes', type: 'array' },
  { path: 'plugins', type: 'array' },
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
