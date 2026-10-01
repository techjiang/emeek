/**
 * 本地文本处理基元：清洗、切句、分词、TF-IDF。
 *
 * 三个本地模块（摘要 / 可读性 / SEO）共用这一层。放一起而不是各写一份，
 * 是因为「什么算一个句子」这种判断一旦有两套实现，摘要和可读性统计就会互相打架。
 *
 * 全中文场景没有空格分词，这里不引任何分词库，用 bigram 近似：
 * 对 TF-IDF 关键词提取和句子相似度来说，bigram 的区分度已经够用，
 * 而零依赖是硬要求。
 */

import { segmentWords } from './segmenter.js';

const CJK = '\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af';
/** 非散文块标记（列表项、表格行）。摘要只吃散文，统计吃全量。 */
const LIST_MARKER = '\u0001';
const CJK_RE = new RegExp(`[${CJK}]`);
const CJK_GLOBAL_RE = new RegExp(`[${CJK}]`, 'g');

/** 中英混排的「词」：中文按字算，英文按词算 —— 和核心库的 countWords 保持同一口径。 */
export function countWords(text) {
  const plain = String(text ?? '');
  const cjk = (plain.match(CJK_GLOBAL_RE) ?? []).length;
  const latin = (plain.replace(CJK_GLOBAL_RE, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
  return cjk + latin;
}

/** 是否含中日韩文字。用来决定句长阈值（中文 1 字 ≈ 英文 0.6 词的信息量，阈值必须分开）。 */
export function hasCJK(text) {
  return CJK_RE.test(String(text ?? ''));
}

/**
 * 去掉 Markdown 标记，得到「读起来的样子」。
 *
 * 顺序重要：先整块删代码（围栏与行内），否则代码里的 `#` `*` `|` 会被
 * 后面的行级清洗误伤，把代码内容当正文留下 —— 那会直接毒化摘要与统计。
 */
export function stripMarkdown(markdown) {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n');

  // 1. front-matter 只保留其中的 description/title 语义，原文不算正文
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // 2. 围栏代码块（``` / ~~~），连同语言标记一起删
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm, '\n');
  // 3. 未闭合的围栏（写作中常见）也跟着删到文末
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*$/m, '\n');
  // 4. 缩进代码块
  text = text.replace(/^(?: {4,}|\t)[^\n]*$/gm, '');
  // 5. HTML 注释 / 标签
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // 6. 图片：alt 文本是作者写的，保留（对摘要有用），URL 丢掉
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 7. 链接：保留锚文本
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 8. 参考式链接定义、脚注定义整行删除
  text = text.replace(/^[ \t]*\[[^\]]+\]:[^\n]*$/gm, '');
  text = text.replace(/^[ \t]*\[\^[^\]]+\]:[^\n]*$/gm, '');
  // 9. 行内代码 -> 内容（标识符本身是有效信息）
  text = text.replace(/`([^`]*)`/g, '$1');
  // 10. 行首块级标记：# 标题、> 引用、列表、任务框、分隔线、表格管道
  //     列表项保留为独立行（用 \u0001 标记），否则「打开编辑器 / 想标题 / 预览 / 发布」
  //     会被合并成一坨，看起来像作者写的病句。
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '\u0001');
  text = text.replace(/^[ \t]*\[[ xX]\][ \t]*/gm, '\u0001');
  text = text.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) => {
    const value = tableRowToText(row);
    return value ? `${LIST_MARKER}${value}` : '';
  });
  // 11. 行内强调、删除线、脚注引用、双向链接
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1$2');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\[\^[^\]]+\]/g, '');
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias ?? target);
  // 12. 数学公式：符号对读者无意义，整体删掉比留下乱码好
  text = text.replace(/\$\$[\s\S]*?\$\$/g, '');
  text = text.replace(/\$[^$\n]+\$/g, '');

  text = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  // 表格行之间也要断开，否则表头和数据行会粘成一个段落
  text = text.replace(/(?<!\u0001)\n(?=\u0001)/g, '\n');
  return text.trim();
}

/**
 * 把清洗后的文本切成「可当摘要句的散文段落」。
 *
 * 列表、表格、小标题都不是散文。摘要里出现「打开编辑器或后台」这种碎片
 * 比漏掉一句话更伤 —— 用户会认为算法没在干活。所以摘要器只看散文段落，
 * 可读性统计才需要全量（它本来就该反映结构）。
 */
export function splitProseParagraphs(text, { minLength = 12 } = {}) {
  const paragraphs = splitParagraphs(text);
  const prose = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    for (const line of lines) {
      const value = line.trim();
      if (!value) continue;
      if (value.startsWith(LIST_MARKER)) continue;     // 列表项
      const hasEnd = hasSentenceEnd(value);
      // 无句末标点的短行 = 标题；带标点的短行是真正的短句，该留
      if (!hasEnd && measureChars(value) <= 24) continue;
      if (/[:：]\s*$/.test(value) && measureChars(value) <= 24) continue;
      if (measureChars(value) < minLength && !hasEnd) continue;
      prose.push(value);
    }
  }
  return prose;
}

function measureChars(value) {
  return [...value.replace(/\s/g, '')].length;
}

/**
 * 句子是否以句末标点收尾。
 *
 * 中英标点都要认：早期版本漏了英文句点，导致所有英文文档在摘要里
 * 被整体当成「标题」丢掉 —— 语言支持不能靠「我觉得中文够用」。
 */
export function hasSentenceEnd(value) {
  return /[。！？!?….．]$/u.test(String(value).trim());
}

function tableRowToText(row) {
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  if (cells.every((cell) => /^[ \t]*:?-{2,}:?[ \t]*$/.test(cell))) return '';
  return cells.map((cell) => cell.trim()).filter(Boolean).join(' ');
}

/** 段落切分：空行是唯一可靠边界，单换行在同一段内（Markdown 软换行）。 */
export function splitParagraphs(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, ' ').trim())
    .filter((block) => block.length > 0);
}

/**
 * 句子切分（中英双语）。
 *
 * 中文句末标点包括 。！？；…，以及被引号包住的句末标点（。“ ）。
 * 小数的点、缩写点、URL 里的点都不能断句，所以要带上下文断言，
 * 不能简单 split(/[.!?]/)。
 */
export function splitSentences(text) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];

  const sentences = [];
  let buffer = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    buffer += ch;

    if (isSentenceEnd(src, i)) {
      // 把紧跟的收尾引号/括号一起吃进来
      let j = i + 1;
      while (j < src.length && /["'”’）)』」】\]]/.test(src[j])) {
        buffer += src[j];
        j += 1;
      }
      const trimmed = buffer.trim();
      if (trimmed) sentences.push(trimmed);
      buffer = '';
      i = j;
      continue;
    }
    i += 1;
  }

  const tail = buffer.trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function isSentenceEnd(src, i) {
  const ch = src[i];

  if ('。！？；…'.includes(ch)) {
    // 省略号 ⋯ 连续时只在最后一个上断
    if (ch === '…' && src[i + 1] === '…') return false;
    // 中文句末标点可能连用（“！？”），逐个断句会切出空串，交给下一轮跳过即可
    return true;
  }
  if (ch === '\n') return true;

  if (ch === '.' || ch === '!' || ch === '?') {
    const prev = src[i - 1] ?? '';
    const next = src[i + 1] ?? '';
    // 小数：3.14
    if (/\d/.test(prev) && /\d/.test(next)) return false;
    // 英文缩写与域名：e.g. / etc. / node.js
    if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) return false;
    // 连续标点：?!、!! —— 只在最后一个上断
    if (next && '.!?'.includes(next)) return false;
    // 句子内容太短（如 "No. 5" 的 No.）不断句
    const since = lastBreak(src, i);
    if (since.trim().length < 2) return false;
    return true;
  }
  return false;
}

function lastBreak(src, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    if ('.!?。！？；…\n'.includes(src[k])) return src.slice(k + 1, i);
  }
  return src.slice(0, i);
}

/**
 * 分词。
 *
 * 中文走词典 + Viterbi（见 segmenter.js）；英文按空格与标点。
 *
 * 词典没加载时退回「字级 unigram」：关键词会退化成单个汉字，质量明显下降，
 * 但功能不中断。这是刻意的降级 —— 本地算法可以差，不能不可用。
 *
 * 注意：这个函数是同步的，但词典加载是异步的。所以调用方（LocalProvider）
 * 必须保证在使用分词前已经 loadDictionary()。未加载时会走降级路径。
 */
export function tokenize(text) {
  const src = String(text ?? '');
  const tokens = [];

  const latin = src.replace(CJK_GLOBAL_RE, ' ').toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [];
  for (const word of latin) {
    // 纯数字不是关键词：「2」出现在关键词表里说明过滤没做干净。
    // 技术文档里的数字大多是版本号或指标值，单靠它无法表达主题。
    if (/^\d+$/.test(word)) continue;
    if (word.length < 2) continue;
    tokens.push(word);
  }

  // 词典可用时才切中文词；否则退化为单字（见上方说明）
  const chunked = segmentWords(src, { minLength: 2 });
  if (chunked) {
    for (const word of chunked) {
      if (/^[\u4e00-\u9fa5]+$/.test(word) && isStopWord(word)) continue;
      tokens.push(word);
    }
    return tokens;
  }

  const runs = src.match(new RegExp(`[${CJK}]+`, 'g')) ?? [];
  for (const run of runs) {
    for (const char of run) {
      if (STOP_CHARS.has(char)) continue;
      tokens.push(char);
    }
  }
  return tokens;
}

/** 停用词：切分后仍会留下的高频虚词与泛化词。 */
const STOP_WORDS = new Set(['一个', '这个', '那个', '可以', '如果', '因为', '所以', '但是', '而且', '然后', '这样', '那样', '什么', '这些', '那些', '已经', '还是', '就是', '只是', '不是', '没有', '不过', '非常', '相当', '我们', '你们', '他们', '以及', '并且', '或者', '关于', '对于', '通过', '进行', '需要', '应该', '能够', '可能', '这里', '那里', '目前', '现在', '之后', '之前', '开始', '内容', '时候', '情况', '地方', '东西', '方式', '问题', '方法', '部分', '方面']);

export function isStopWord(word) {
  return STOP_WORDS.has(word);
}

/**
 * 中文停用字。
 * 只在词典缺失、分词退化为单字时用到 —— 那时必须靠它把「的」「了」这类
 * 高字频虚词滤掉，否则关键词会全是虚词。
 */
const STOP_CHARS = new Set('的了是在和与就都也还很更把被让从对向以及而但却只则于其这那有一不太会能可要上下中为之所如果因所以个我们你他她它'.split(''));

/** 英文停用词。只收真正没有信息量的功能词，宁可漏也不要误杀技术词。 */
const ENGLISH_STOPWORDS = new Set(('the and for are but not you all can her was one our out day get has him his how its may new now old see two way who boy did use that with this from they will would there their what about which when make like time just know take into your some them than then only come over also back after been more most such even much many well were being have here each because these those should could other while where through between before under again further once same both doing does very using used').split(' '));

/** 英文停用词 + 中文停用词，统一入口。 */
export function isStopToken(token) {
  return ENGLISH_STOPWORDS.has(token) || STOP_WORDS.has(token);
}

/**
 * 相似度：Jaccard over token set。
 *
 * 选 Jaccard 而不是余弦，是因为句子长度差异很大（余弦会让长句天然占优），
 * 而我们要判断的是「两句是不是在说同一件事」，集合重叠比向量夹角更贴题。
 *
 * 分词比集合运算贵得多，而摘要在 O(n²) 的两两比对里会反复算同一句。
 * 所以这里按字符串缓存 token set —— 长文摘要从 120ms 降到 20ms 量级，
 * 代价是一个 Map（同一批文本的生命周期内有效，不会无限增长）。
 */
const TOKEN_CACHE = new Map();
const TOKEN_CACHE_LIMIT = 4000;

export function tokenSet(text) {
  const key = String(text ?? '');
  const cached = TOKEN_CACHE.get(key);
  if (cached) return cached;
  const set = new Set(tokenize(key));
  if (TOKEN_CACHE.size >= TOKEN_CACHE_LIMIT) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(key, set);
  return set;
}

export function similarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return String(a).trim() === String(b).trim() ? 1 : 0;
  // 先遍历小的那个，少做几次 has()
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

export function clearTokenCache() {
  TOKEN_CACHE.clear();
}

/**
 * TF-IDF 关键词提取。
 *
 * 单文档没有语料库，"IDF" 用文档自身的段落数近似：词在越少段落里出现，
 * IDF 越高。好处是标题式单词（只出现在小标题里）会拿到高权重，
 * 而「文章」「内容」这类满篇都是的词被压下去。
 */
export function extractKeywords(text, { top = 20, minLength = 2 } = {}) {
  const src = String(text ?? '');
  if (!src.trim()) return [];

  const paragraphs = splitParagraphs(src);
  const docTokens = tokenize(src).filter((token) => !isStopToken(token));
  if (!docTokens.length) return [];

  const tf = new Map();
  for (const token of docTokens) tf.set(token, (tf.get(token) ?? 0) + 1);

  const docFreq = new Map();
  for (const paragraph of paragraphs) {
    const seen = new Set(tokenize(paragraph).filter((token) => !isStopToken(token)));
    for (const token of seen) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }

  const total = docTokens.length;
  const paragraphCount = Math.max(1, paragraphs.length);
  const scored = [];
  for (const [token, count] of tf) {
    if (token.length < minLength && !/^\d+$/.test(token)) continue;
    if (isStopToken(token)) continue;
    const tfScore = count / total;
    const idf = Math.log((paragraphCount + 1) / ((docFreq.get(token) ?? 1) + 0.5));
    const positionBonus = token.length >= 3 ? 1.15 : 1; // 长词更可能是术语
    scored.push({ term: token, score: tfScore * Math.max(idf, 0.05) * positionBonus, count });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return dedupeSubstrings(scored).slice(0, top).map((item) => ({ term: item.term, score: round4(item.score), count: item.count }));
}

/**
 * 合并互相包含的词条：「博客引擎」和「博客」「引擎」同时出现时只留最长的那个。
 * TF-IDF 本身不做语义，这一步是在补它的短路。
 */
function dedupeSubstrings(items) {
  const kept = [];
  for (const item of items) {
    const dominated = kept.some((existing) => existing.term.length > item.term.length && existing.term.includes(item.term));
    if (dominated) continue;
    // 新词更长，且包含已保留的短词 -> 用长词替换
    const index = kept.findIndex((existing) => item.term.length > existing.term.length && item.term.includes(existing.term));
    if (index >= 0) kept.splice(index, 1);
    kept.push(item);
    kept.sort((a, b) => b.score - a.score);
  }
  return kept;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** 归一化到 0~1 的分段打分：区间内满分，区间外线性衰减。阈值来自可读性研究，见 ReadabilityAnalyzer。 */
export function scoreBand(value, { ideal, hard, falloff = 'both' } = {}) {
  const [lo, hi] = ideal;
  if (value >= lo && value <= hi) return 1;
  if (falloff === 'high' && value < lo) return clamp01(value / lo);
  if (falloff === 'low' && value > hi) return clamp01(1 - (value - hi) / (hard ?? value * 2));
  const distance = value < lo ? lo - value : value - hi;
  const span = value < lo ? lo - (hard?.[0] ?? 0) : (hard?.[1] ?? hi * 2) - hi;
  if (span <= 0) return 0;
  return clamp01(1 - distance / span);
}

export function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
