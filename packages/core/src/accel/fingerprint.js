import crypto from 'node:crypto';
import path from 'node:path';

/**
 * 资源指纹（content hash）。
 *
 * 这是长缓存的前提：没有指纹就不能对静态资源设 immutable ——
 * 文件变了但 URL 没变，浏览器/CDN 会继续发旧版本。
 *
 * 规则：内容变 → 指纹变；内容不变 → 指纹不变。
 * 因此哈希只吃「内容字节」+「扩展名」，不含时间戳、路径、构建序号。
 */

const HASH_LENGTH = 8;
const DEFAULT_ASSETS = ['css', 'js', 'svg', 'woff2', 'woff', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'];

/**
 * 对一份内容算指纹。同一份内容永远得到同一个值 —— 幂等是这块的全部意义。
 * @param {Buffer|string} content
 * @param {string} ext 扩展名（带不带点都行）
 */
export function contentHash(content, ext = '') {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext;
  const h = crypto.createHash('sha256');
  h.update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
  // 扩展名参与哈希：同名同内容但类型不同时不应共用 URL。
  h.update(`\u0000${normalized}`);
  return h.digest('hex').slice(0, HASH_LENGTH);
}

/**
 * 把一个路径变成带指纹的路径。
 *   /assets/theme.css  →  /assets/theme.a1b2c3d4.css
 *   theme.css          →  theme.a1b2c3d4.css
 */
export function fingerprintPath(filePath, content) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}.${contentHash(content, ext)}${ext}`;
}

/**
 * 判定一个资源是否需要指纹。
 * HTML 与数据文件（sitemap/rss/json）不指纹：它们的 URL 是稳定入口，
 * 变了要能立即被看见，靠 CDN 短缓存/不缓存解决而不是靠改 URL。
 *
 * 默认不指纹 .html —— 见上；也不指纹无扩展名文件。
 */
export function shouldFingerprint(filePath, extensions = DEFAULT_ASSETS) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!ext) return false;
  return extensions.includes(ext);
}

/**
 * 为一组静态资源建立指纹映射，并把产出写回。
 *
 * @param {Array<{path: string, content: Buffer|string}>} assets 逻辑路径 + 内容
 * @param {object} options
 * @param {string[]} options.extensions 需要指纹的扩展名
 * @param {boolean}  options.enabled 关闭时退化为恒等映射（仍是映射，调用方无需分支）
 * @returns {{ map: Map<string,string>, assets: Array<{path:string,originalPath:string,fingerprint:string,content:Buffer|string}> }}
 */
export function buildAssetMap(assets, { extensions = DEFAULT_ASSETS, enabled = true, stable = new Set() } = {}) {
  const map = new Map();
  const out = [];
  for (const asset of assets) {
    const logical = normalizePath(asset.path);
    // stable 里的路径保持原样：它们的 URL 会出现在 HTML 之外（front-matter、
    // RSS、搜索索引），那些位置不经过引用改写，改文件名就是制造 404。
    const fp = enabled && !stable.has(logical) && shouldFingerprint(logical, extensions);
    if (!fp) {
      map.set(logical, logical);
      out.push({ path: logical, originalPath: logical, fingerprint: null, content: asset.content });
      continue;
    }
    const fingerprinted = fingerprintPath(logical, asset.content);
    map.set(logical, fingerprinted);
    out.push({
      path: fingerprinted,
      originalPath: logical,
      fingerprint: contentHash(asset.content, path.extname(logical)),
      content: asset.content,
    });
  }
  return { map, assets: out };
}

/**
 * 用指纹映射重写 HTML 中的资源引用。
 *
 * 只改「明确指向已指纹资源」的引用：
 *   - href/src/srcset 的值
 *   - 形如 /assets/theme.css 的绝对路径
 * 未命中映射的 URL 原样保留（外链、数据 URL、CDN 域名都不该被动）。
 */
export function rewriteHtmlReferences(html, map) {
  if (!map || map.size === 0) return html;
  const lookup = (url) => {
    if (!url) return url;
    const [pathPart, ...rest] = String(url).split(/(?=[?#])/);
    const mapped = map.get(pathPart);
    if (!mapped || mapped === pathPart) return null;
    return [mapped, ...rest].join('');
  };

  let out = String(html).replace(
    /\b(href|src)=("|')([^"']+)\2/g,
    (match, attr, quote, value) => {
      const next = lookup(value);
      return next ? `${attr}=${quote}${next}${quote}` : match;
    }
  );
  // srcset="a.png 1x, b.png 2x"
  out = out.replace(/\bsrcset=("|')([^"']+)\1/g, (match, quote, value) => {
    let changed = false;
    const next = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const [url, ...descriptor] = trimmed.split(/\s+/);
        const mapped = lookup(url);
        if (mapped) changed = true;
        return [mapped ?? url, ...descriptor].join(' ');
      })
      .join(', ');
    return changed ? `srcset=${quote}${next}${quote}` : match;
  });
  return out;
}

/** URL 是否指向站点本地资源（用于判断是否需要改写/预压缩）。 */
export function isLocalUrl(url) {
  if (!url) return false;
  const value = String(url).trim();
  if (/^(data:|blob:|mailto:|tel:|#|\/\/)/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false; // 带协议的外链
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || !value.includes('/');
}

function normalizePath(p) {
  return String(p).startsWith('/') ? String(p) : `/${p}`;
}

export const FINGERPRINT_EXTENSIONS = DEFAULT_ASSETS;
