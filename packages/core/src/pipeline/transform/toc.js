import { slugify } from '../parse/markdown.js';

/**
 * 从已渲染的 HTML 里抽目录。走 HTML 而不是 Markdown 源，是为了让锚点 id
 * 与渲染器实际生成的一致 —— 两处各算一次必然会漂移。
 */
export function buildToc(html, { maxLevel = 3, minLevel = 2 } = {}) {
  const items = [];
  const regex = /<h([1-6])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let match;
  while ((match = regex.exec(html))) {
    const level = Number(match[1]);
    if (level < minLevel || level > maxLevel) continue;
    items.push({ level, id: match[2], text: stripTags(match[3]) });
  }
  return items;
}

export function renderToc(toc, title = '目录') {
  if (!toc.length) return '';
  const links = toc.map((item) =>
    `<li class="toc-level-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join('\n');
  return `<nav class="toc" aria-label="${escapeHtml(title)}">\n<p class="toc-title">${escapeHtml(title)}</p>\n<ul>\n${links}\n</ul>\n</nav>`;
}

/** 给每个 h2/h3 追加一个可复制的锚点按钮，方便文内跳转分享。 */
export function addAnchorLinks(html) {
  return html.replace(/(<h([1-6])\s+id="([^"]+)"[^>]*>)([\s\S]*?)(<\/h\2>)/g,
    (_, open, _level, id, inner, close) =>
      `${open}${inner}<a class="anchor" href="#${id}" aria-label="锚点链接">#</a>${close}`);
}

export function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export { slugify };
