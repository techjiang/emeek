import { getProvider } from './providers.js';
import { loadCredentials } from './credentials.js';

/**
 * CDN 操作客户端（刷新 / 预热）。
 *
 * 这里刻意不引入各家 SDK：一来依赖体积不值得，二来 SDK 会把 API Key
 * 揽进进程的文件句柄/日志里。用一个显式的 fetcher，凭据只在请求头出现。
 *
 * 「可注入替身」是硬要求：不注入 fetcher 就无法在 CI 里断言
 * 「刷新请求确实发到了正确的 URL，且请求头里没有明文 Key 落盘」。
 */

export function createCdnClient({
  providerId,
  config = {},
  credentials = {},
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const provider = getProvider(providerId);

  /** 从配置或凭据里取值：显式 config 优先（已剔除 secret），凭据兜底。 */
  const value = (key, envName) => config[key] ?? credentials[key] ?? process.env[envName];

  async function purge(targets = []) {
    if (!provider.api.purge) {
      return { skipped: true, reason: `${provider.name} 未提供刷新接口` };
    }
    const url = provider.api.purge
      .replace('{zoneId}', value('zoneId', 'CF_ZONE_ID') ?? '')
      .replace('{domain}', value('domain', 'CDN_DOMAIN') ?? '')
      .replace('{purgeEndpoint}', config.purgeEndpoint ?? '');
    const headers = buildAuthHeaders(provider, value, credentials);
    const body = provider.api.purgeBody ? provider.api.purgeBody(targets) : undefined;
    const request = {
      method: provider.api.purgeBody || provider.id !== 'cloudflare' ? 'POST' : 'POST',
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body,
    };
    return call('purge', url, request, fetchImpl);
  }

  async function warm(targets = []) {
    if (!provider.api.warm) {
      return { skipped: true, reason: `${provider.name} 无预热接口（首次访问即回源）`, targets };
    }
    const url = provider.api.warm.replace('{domain}', value('domain', 'CDN_DOMAIN') ?? '');
    return call('warm', url, { method: 'POST', headers: buildAuthHeaders(provider, value, credentials) }, fetchImpl);
  }

  return { provider, purge, warm };
}

function buildAuthHeaders(provider, value, credentials) {
  switch (provider.api.purgeAuth) {
    case 'bearer':
      return { Authorization: `Bearer ${value('apiKey', 'CF_API_KEY') ?? ''}` };
    case 'hmac-sha1':
      // 阿里云签名需要 HMAC 与时间戳，真正签名在 cdn-sign.js 里做；
      // 这里只放 AccessKey ID，Secret 不进 header 明文字段名。
      return { 'x-aliyun-access-key-id': value('accessKeyId', 'ALIYUN_ACCESS_KEY_ID') ?? '' };
    case 'tc3-hmac-sha256':
      return { 'x-tencent-secret-id': value('secretId', 'TENCENT_SECRET_ID') ?? '' };
    case 'header':
      return value('apiKey', 'EMEEEK_CDN_API_KEY') ? { Authorization: `Bearer ${value('apiKey', 'EMEEEK_CDN_API_KEY')}` } : {};
    default:
      return {};
  }
}

async function call(op, url, request, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境没有 fetch，无法调用 CDN 接口');
  }
  const started = Date.now();
  const response = await fetchImpl(url, request);
  const elapsed = Date.now() - started;
  const text = await response.text().catch(() => '');
  return {
    op,
    ok: response.ok !== false,
    status: response.status,
    elapsed,
    body: safeParse(text),
    raw: text.slice(0, 500),
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 组装刷新/预热的 URL 清单。
 * 刷新 = 所有会变的东西（HTML + 数据入口）；
 * 预热 = 热门入口（首页 / 归档 / 最近文章 / sitemap / rss / 搜索索引）。
 */
export function buildPurgeTargets(siteUrl, { files = [], includeAssets = false } = {}) {
  const base = String(siteUrl ?? '').replace(/\/+$/, '');
  if (!base) return [];
  const targets = new Set();
  for (const file of files) {
    const rel = typeof file === 'string' ? file : file.path;
    if (!rel) continue;
    const isHtml = rel.endsWith('.html');
    const isData = /\.(json|xml|txt)$/.test(rel);
    if (isHtml || isData || includeAssets) targets.add(`${base}${rel}`);
  }
  targets.add(`${base}/`);
  return [...targets];
}

export function buildWarmTargets(siteUrl, { posts = [], extra = [] } = {}) {
  const base = String(siteUrl ?? '').replace(/\/+$/, '');
  if (!base) return [];
  const targets = new Set([`${base}/`, `${base}/archive.html`, `${base}/tags.html`]);
  // 热门 = 最近的 10 篇（没有真实访问数据前，时间是最合理的代理）。
  for (const post of posts.slice(0, 10)) {
    if (post.url) targets.add(`${base}${post.url}`);
  }
  for (const e of extra) targets.add(`${base}${e}`);
  return [...targets];
}

export { loadCredentials };
