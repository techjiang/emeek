/**
 * 搜索索引：建索引、序列化、读回。
 *
 * 形态是一个手写的紧凑倒排表，而不是引入 MiniSearch —— 核心包目前是零依赖，
 * 为了搜索破这个例不划算；而且我们要的很多东西（content 进倒排表但不进存储、
 * 三类词元各自的表、gzip 后体积可预算）恰恰是通用库不直接给的。
 *
 * 序列化格式（JSON，无循环引用、无函数，浏览器端 JSON.parse 即可）：
 *
 *   {
 *     version: 3,                       // 结构版本，前端不认就降级
 *     options: { ... },                 // 建索引时的参数，读回时用于一致性校验
 *     docs: [ { id, title, url, tags, date, excerpt, terms } ],
 *     words:   { "<term>": [docIndex, ...] },
 *     bigrams: { ... },
 *     singles: { ... },
 *     titleIndex: { "<term>": [docIndex, ...] }   // 标题/标签命中，用于提权
 *   }
 *
 * 为什么 docs 用数组下标而不是 id 作倒排表的值：
 *   id 是 slug（字符串），每个 posting 都存一遍 slug 会让 100 篇文章的
 *   倒排表膨胀好几倍。下标是连续整数，JSON 里自然更短、gzip 也压得更好。
 */

import { analyze } from './tokenizer.js';
import { toPlainText, makeSnippet } from './plain-text.js';

/**
 * 索引结构版本。
 * 改动序列化形状 / 词元策略时 +1。前端据此判断手上的索引能不能用 ——
 * 比「悄悄用旧结构跑出错误结果」好得多。
 */
export const INDEX_VERSION = 3;

/** 摘要目标长度（码点）。 */
const EXCERPT_LENGTH = 160;

/**
 * 由文章列表建索引。
 *
 * @param {Array} posts 构建期的文章对象（需要 slug/title/url/tags/date/raw）
 * @param {object} [options]
 *   excerptLength  摘要长度，默认 160
 *   maxExcerpt     excerpt 硬上限，防止异常长文本把索引撑爆
 * @returns {object} 可序列化的索引对象
 */
export function buildIndex(posts = [], { excerptLength = EXCERPT_LENGTH } = {}) {
  const docs = [];
  const words = new Map();
  const bigrams = new Map();
  const singles = new Map();
  const titleIndex = new Map();

  posts.forEach((post) => {
    const index = docs.length;
    const body = toPlainText(post.raw ?? post.body ?? '');
    const title = String(post.title ?? '');
    const tags = (post.tags ?? []).map(String);
    const categories = (post.categories ?? []).map(String);

    // 正文分词 → 进倒排表。content 本身不进 docs（见 docs.push）。
    const bodyTerms = analyze(body);
    addPostings(words, bodyTerms.words, index);
    addPostings(bigrams, bodyTerms.bigrams, index);
    addPostings(singles, bodyTerms.singles, index);

    // 标题 / 标签 / 分类单独建一份，命中这些的文档要提权。
    // 单独建而不是并进 words，是因为「命中标题」和「命中正文」在排序里
    // 权重不同，合表之后就再也分不出来了。
    const headText = [title, ...tags, ...categories].join(' ');
    const headTerms = analyze(headText, { dictionary: true });
    addPostings(titleIndex, headTerms.words, index);
    addPostings(titleIndex, headTerms.bigrams, index);

    // 摘要：用正文开头。真正的「命中处摘要」在查询期用 makeSnippet 现算 ——
    // 建索引时还不知道用户会搜什么。
    const plain = body.replace(/\n+/g, ' ').trim();

    docs.push({
      id: post.slug,
      title,
      url: post.url,
      tags,
      categories,
      date: post.date,
      excerpt: sliceText(plain, excerptLength),
      // terms 是「正文里出现过的完整词元集」，查询期做子串兜底时要用。
      // 只存 words 级（词典词/英文/数字），不存 bigram/single：
      // bigram 已能从 words + 正文重建出大部分，全存等于把正文又存了一遍。
      terms: bodyTerms.words,
    });
  });

  return {
    version: INDEX_VERSION,
    options: { excerptLength },
    docs,
    words: freeze(words),
    bigrams: freeze(bigrams),
    singles: freeze(singles),
    titleIndex: freeze(titleIndex),
  };
}

/** 序列化。默认不带缩进 —— 这是给机器读的，缩进只在调试时值钱。 */
export function serializeIndex(index, { pretty = false } = {}) {
  return JSON.stringify(index, null, pretty ? 2 : 0);
}

/**
 * 读回并做结构校验。
 *
 * 校验失败返回 null 而不是抛错：前端拿到坏索引应当降级到「搜索不可用」，
 * 而不是整页崩掉。搜索是增强，不是依赖。
 */
export function parseIndex(json, { expectedVersion = INDEX_VERSION } = {}) {
  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== expectedVersion) return null;
  if (!Array.isArray(parsed.docs)) return null;
  for (const key of ['words', 'bigrams', 'singles', 'titleIndex']) {
    if (!parsed[key] || typeof parsed[key] !== 'object') return null;
  }
  return parsed;
}

/**
 * 索引原始体积（UTF-8 字节）。不含 gzip —— 压缩要用到 node:zlib，
 * 而这个模块是浏览器可用的纯逻辑（runtime 也 import 它）。gzip 体积的
 * 真值在 site-index.js 里量（那里本来就跑在构建期）。
 *
 * @param {string} json
 * @returns {number}
 */
export function measureIndexBytes(json) {
  return new TextEncoder().encode(String(json ?? '')).length;
}

/**
 * 往倒排表追加一个文档下标。
 *
 * 跳过与上一项相同的下标：同一篇文章的标题里可能出现同一个词两次
 * （「主题：主题系统设计」），不去重的话倒排表里会有重复项，
 * 打分时被算两次 —— 那不是「更相关」，是 bug。
 */
function addPostings(table, terms, index) {
  for (const term of terms ?? []) {
    let list = table.get(term);
    if (!list) {
      list = [];
      table.set(term, list);
    }
    if (list[list.length - 1] !== index) list.push(index);
  }
}

/**
 * 把 Map 转成排序后的普通对象。
 *
 * 排序是为了让序列化结果稳定：同样的内容两次构建得到同样的字节。
 * 不排序的话 Map 的插入顺序会随遍历顺序变化，CI 里的产物比对
 * 会一直报假 diff，最后没人再看那个比对。
 */
function freeze(map) {
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

function sliceText(text, limit) {
  const points = Array.from(String(text ?? ''));
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : points.join('');
}
