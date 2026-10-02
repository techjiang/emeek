import { slugify } from '../parse/markdown.js';
import { sanitizeUrl } from '../parse/sanitize-url.js';

/**
 * 双向链接解析器：把 [[标题]] 映射到真实文章 URL，并记录反向引用。
 * 未命中的链接保持原样（渲染为不可点击的 span），不做「自动创建页面」这类隐式行为。
 */
export function buildWikiLinkIndex(posts, { urlPattern = (post) => `/posts/${post.slug}.html` } = {}) {
  const byTitle = new Map();
  const bySlug = new Map();
  for (const post of posts) {
    byTitle.set(normalize(post.title), post);
    byTitle.set(normalize(post.slug), post);
    bySlug.set(post.slug, post);
  }
  return { byTitle, bySlug, urlPattern };
}

export function resolveWikiLink(index, target, alias) {
  const post = index.byTitle.get(normalize(target));
  const label = alias || target;
  const text = escapeHtml(label);
  if (!post) return `<span class="wiki-link wiki-link--missing" title="未找到文章：${escapeHtml(target)}">${text}</span>`;
  // wiki 链接的目标 URL 来自站点索引，看起来可信 —— 但索引本身也是内容驱动的
  // （前端可自定义 urlPattern），所以和普通链接走同一道消毒，不搞例外。
  const href = sanitizeUrl(index.urlPattern(post));
  if (href === null) return `<span class="wiki-link wiki-link--missing">${text}</span>`;
  return `<a class="wiki-link" href="${escapeHtml(href)}" data-post="${escapeHtml(post.slug)}">${text}</a>`;
}

export const normalize = (text) => String(text).trim().toLowerCase().replace(/\s+/g, ' ');

/** 统计每篇文章被 [[双向链接]] 引用的次数，供文末「被引用 N 次」展示。 */
export function computeBacklinks(posts) {
  const counts = new Map();
  const sources = new Map();
  for (const post of posts) {
    const refs = extractWikiTargets(post.raw);
    for (const target of refs) {
      const key = normalize(target);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!sources.has(key)) sources.set(key, []);
      sources.get(key).push(post.slug);
    }
  }
  for (const post of posts) {
    // 标题与 slug 常常归一化到同一个 key（如「B」与「b」），先用 Set 去重再求和，
    // 否则同一篇文章会被计两次。
    const keys = [...new Set([normalize(post.title), normalize(post.slug)])];
    post.backlinks = keys.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
    post.backlinkSources = [...new Set(keys.flatMap((key) => sources.get(key) ?? []))].filter((s) => s !== post.slug);
  }
  return posts;
}

export function extractWikiTargets(raw) {
  // 代码块与行内代码里的 [[...]] 是示例文本，不是真链接；统计反向引用时必须排除，
  // 否则「用 [[标题]] 写链接」这句话本身就会被算作一次引用。
  const stripped = String(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const targets = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(stripped))) targets.push(match[1].trim());
  return targets;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export { slugify };
