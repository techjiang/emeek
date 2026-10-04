/**
 * 缓存策略：把「一个文件该怎么被缓存」变成纯函数。
 *
 * 三类文件的缓存语义截然不同，混用就是灾难：
 *   - 带指纹的静态资源：immutable，缓存一年。文件名即版本号。
 *   - HTML：短缓存 + stale-while-revalidate。用户能尽快看到新文章，
 *     同时 CDN 回源失败时还能顶一会儿。
 *   - 数据入口（search-index.json / sitemap / rss）：不缓存或极短。
 *     它们是「稳定 URL、内容会变」的代表，缓存久了用户搜不到新内容。
 */

export const CACHE_CLASS = {
  /** 内容哈希在文件名里，可以永久缓存。 */
  IMMUTABLE: 'immutable',
  /** 页面：短缓存 + 后台回源校验。 */
  HTML: 'html',
  /** 会变的稳定入口：搜索索引、sitemap、rss。 */
  DATA: 'data',
  /** 完全不该被中间层缓存的（如 API、凭据相关）。 */
  NO_STORE: 'no-store',
};

const DEFAULT_POLICY = {
  [CACHE_CLASS.IMMUTABLE]: {
    'Cache-Control': 'public, max-age=31536000, immutable',
  },
  [CACHE_CLASS.HTML]: {
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
  },
  [CACHE_CLASS.DATA]: {
    'Cache-Control': 'public, max-age=60, must-revalidate',
  },
  [CACHE_CLASS.NO_STORE]: {
    'Cache-Control': 'no-store',
  },
};

const DATA_FILES = new Set([
  'search-index.json',
  'sitemap.xml',
  'rss.xml',
  'robots.txt',
  'atom.xml',
  'feed.xml',
]);

/**
 * 判定文件属于哪一类缓存语义。
 * @param {string} filePath 产物内的逻辑路径
 * @param {object} options
 * @param {boolean} options.fingerprinted 文件名是否带内容指纹
 */
export function classifyCache(filePath, { fingerprinted = false } = {}) {
  const clean = String(filePath).split(/[?#]/)[0];
  const name = clean.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  if (fingerprinted) return CACHE_CLASS.IMMUTABLE;
  if (ext === 'html' || ext === 'htm') return CACHE_CLASS.HTML;
  if (DATA_FILES.has(name)) return CACHE_CLASS.DATA;
  if (['json', 'xml', 'txt'].includes(ext)) return CACHE_CLASS.DATA;
  // 未指纹的 css/js/图片：内容会变且 URL 不变，只能短缓存。
  // 这正是「没有指纹就不能 immutable」在缓存头上的体现。
  if (['css', 'js', 'svg', 'woff2', 'woff', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'].includes(ext)) {
    return CACHE_CLASS.HTML;
  }
  return CACHE_CLASS.HTML;
}

/**
 * 计算某个文件应返回的缓存头。
 * @returns {Record<string,string>}
 */
export function cacheHeaders(filePath, { fingerprinted = false, etag, policy = {} } = {}) {
  const cls = classifyCache(filePath, { fingerprinted });
  const merged = { ...DEFAULT_POLICY[cls], ...(policy[cls] ?? {}) };
  const headers = { ...merged };
  if (etag) headers.ETag = `"${etag}"`;
  return headers;
}

/**
 * 从一批产物算出「路径 → 缓存头」表，供生成 nginx/caddy/cloudflare 配置。
 * @param {Array<{path: string, fingerprint?: string|null}>} files
 */
export function buildHeaderManifest(files, { policy } = {}) {
  const rules = new Map();
  for (const file of files) {
    const headers = cacheHeaders(file.path, {
      fingerprinted: Boolean(file.fingerprint),
      etag: file.fingerprint ?? undefined,
      policy,
    });
    const cls = classifyCache(file.path, { fingerprinted: Boolean(file.fingerprint) });
    const key = `${cls}:${headers['Cache-Control']}`;
    if (!rules.has(key)) rules.set(key, { class: cls, match: [], headers });
    rules.get(key).match.push(file.path);
  }
  return [...rules.values()];
}

export { DEFAULT_POLICY };
