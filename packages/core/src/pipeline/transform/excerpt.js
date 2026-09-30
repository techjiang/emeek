import { stripTags } from './toc.js';

/** 中英混排的分词：中文按字算，英文按词算，都比按字符数截断更接近「阅读长度」。 */
export function countWords(text) {
  const plain = stripTags(String(text));
  const cjk = (plain.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) ?? []).length;
  const words = (plain.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + words;
}

export function readingTime(text, { wpm = 300 } = {}) {
  return Math.max(1, Math.ceil(countWords(text) / wpm));
}

/**
 * 摘要：优先用 front-matter 的 description，否则取正文第一个段落。
 * 按字符截断而非按词，因为中文没有词边界。
 */
export function makeExcerpt(html, limit = 160) {
  const paragraphs = String(html).split(/<\/p>|<br\s*\/?>|\n{2,}/);
  let text = '';
  for (const block of paragraphs) {
    if (/<(?:pre|div class="code-block"|table|blockquote)/.test(block)) continue;
    const candidate = stripTags(block);
    if (candidate.length < 10) continue;
    text = candidate;
    break;
  }
  if (!text) text = stripTags(html).slice(0, limit);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
