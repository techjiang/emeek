/**
 * Markdown → 纯文本，以及以命中词为中心截取摘要。
 *
 * 搜索索引要的是「读者能看见的文字」而不是 Markdown 语法。直接把 raw 塞进
 * 倒排表，会把 ``` 围栏、图片路径、链接 URL 全都变成可搜索词元 ——
 * 搜「png」能搜出一堆文章，而页面上根本没有这个词。
 *
 * 这里不追求完美的 Markdown 解析（构建期已经有解析器了，但那产出的是 HTML，
 * 反解析回文本比直接处理 Markdown 更绕）。用一个够用的行级剥离：
 * 宁可多留几个无害字符，也不能把正文内容剥掉。
 */

// 围栏代码块的开始/结束行：``` 或 ~~~，可带语言标注
const FENCE = /^\s*(```|~~~)/;
// 行级结构标记：标题 #、引用 >、列表 - * + 数字.、分割线
const LINE_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;
const HR = /^\s{0,3}(?:[-*_]\s*){3,}$/;
// 行内标记：图片（整段丢弃）、链接（留文字）、代码、强调、删除线、裸 URL、HTML 标签
const INLINE_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const INLINE_CODE = /`{1,3}([^`]*)`{1,3}/g;
const INLINE_EMPHASIS = /(\*\*|__|\*|_|~~)/g;
const INLINE_HTML = /<[^>]+>/g;
const BARE_URL = /https?:\/\/\S+/g;
// front-matter 与模板注释
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const TEMPLATE_COMMENT = /\{#[\s\S]*?#\}/g;
// 表格分隔行：|---|---|
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * 把 Markdown 原文变成可搜索的纯文本。
 *
 * @param {string} raw
 * @returns {string}
 */
export function toPlainText(raw) {
  let text = String(raw ?? '');

  // front-matter 是元数据，不是正文。留在里面会让 title/tags 之外的值
  // 也被搜到（比如 draft: true 能被「true」搜出来）。
  text = text.replace(FRONTMATTER, '');
  text = text.replace(TEMPLATE_COMMENT, '');

  const lines = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    // 代码块内容：读者看得见，但不该参与检索。
    // 搜「function」搜出一堆示例代码，对找文章没有帮助，只稀释相关度。
    if (inFence) continue;
    if (HR.test(line)) continue;
    if (TABLE_DIVIDER.test(line)) continue;
    lines.push(line.replace(LINE_MARKER, ''));
  }

  return collapse(
    lines
      .join('\n')
      .replace(INLINE_IMAGE, '')
      .replace(INLINE_LINK, '$1')
      .replace(INLINE_CODE, '$1')
      .replace(INLINE_HTML, '')
      .replace(BARE_URL, '')
      .replace(INLINE_EMPHASIS, ''),
  );
}

/**
 * 以命中词为中心截取摘要。
 *
 * 有命中词时从它前面 40 个字符开始截，而不是从头截 —— 从头的截图里
 * 常常看不到任何被 <mark> 标记的词，用户会怀疑「为什么给我看这句」。
 * 没有命中词（比如只靠标签命中）时退回从头截。
 *
 * @param {string} plain   纯文本
 * @param {string[]} terms 命中词（原始形态即可，内部做大小写不敏感匹配）
 * @param {object} [options]
 *   limit    摘要目标长度，默认 160
 *   lead     命中词之前保留的上下文字符数，默认 40
 * @returns {{excerpt: string, offset: number, terms: string[]}}
 *   excerpt  截取后的文本（未加省略号，由调用方决定要不要加）
 *   offset   在原文中的起始位置，供前端做「跳到命中处」用
 *   terms    在 excerpt 中出现的命中词
 */
export function makeSnippet(plain, terms = [], { limit = 160, lead = 40 } = {}) {
  const text = String(plain ?? '');
  if (!text) return { excerpt: '', offset: 0, terms: [] };

  const found = locateTerms(text, terms);
  if (!found.length) {
    // 没有命中词：从头截。用 Array.from 按码点切，避免劈开代理对。
    return { excerpt: sliceByCodePoint(text, 0, limit), offset: 0, terms: [] };
  }

  // 取最靠前的那次命中作为中心。取「最靠前」而不是「最相关的」是刻意的：
  // 摘要里的位置应当可解释（就是文章里第一次出现的地方），
  // 挑一个「最有代表性」的出现位置会引入一个说不清的质量判据。
  const anchor = found[0];
  const start = Math.max(0, anchor.index - lead);
  const excerpt = sliceByCodePoint(text, start, limit);
  return {
    excerpt,
    offset: start,
    terms: found.filter((f) => f.index >= start && f.index < start + excerpt.length).map((f) => f.term),
  };
}

/**
 * 找出所有命中词在文本中的位置（大小写不敏感）。
 *
 * @returns {{term: string, index: number}[]} 按出现位置升序
 */
export function locateTerms(text, terms = []) {
  const haystack = String(text ?? '').toLowerCase();
  const found = [];
  for (const term of terms) {
    const needle = String(term ?? '').toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      found.push({ term: String(term), index });
      from = index + 1;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function sliceByCodePoint(text, start, length) {
  // 按码点切片：中文没问题，但 emoji / 生僻字用 slice 会劈开代理对，
  // 产出一个乱码字符 —— 在摘要里格外刺眼。
  const points = Array.from(text);
  return points.slice(start, start + length).join('');
}

function collapse(text) {
  return String(text ?? '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
