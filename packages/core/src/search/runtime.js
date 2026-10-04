/**
 * 浏览器搜索运行时。
 *
 * 约束：这个模块（以及它 import 的一切）不能有**顶层** node: 依赖。
 *   segmenter 里确实有 node:fs / node:zlib，但都在函数体内惰性取的，
 *   浏览器打包器扫不到顶层 specifier，因此不会炸。这里要保持同样的纪律：
 *   本文件只 import 纯逻辑模块，任何需要 node 的东西都放在构建期那侧
 *   （site-index.js）或者惰性 await import。
 *
 * 职责只有三件：
 *   1. 取索引（fetch + parseIndex 校验）
 *   2. 拿查询词元（analyze）
 *   3. 执行查询并生成摘要（search + makeSnippet）
 * 不负责渲染 —— 高亮 / 卡片 / 空态都是 UI 层的事，运行时不该知道 DOM。
 */

import { analyze, matchIndexedWords } from './tokenizer.js';
import { search as runSearch, DEFAULT_MAX_RESULTS } from './query.js';
import { parseIndex } from './indexer.js';
import { makeSnippet } from './plain-text.js';

/**
 * 创建一个搜索会话。
 *
 * @param {object} options
 *   indexUrl     索引地址，默认 /search-index.json
 *   fetchImpl    自定义 fetch（测试注入）
 *   index        直接传入索引对象（跳过 fetch，测试用）
 *   maxResults   默认返回条数
 *   fuzzy        是否启用模糊
 *   onWarning    (error) => void，取索引失败时回调，不抛
 * @returns {Promise<object>} 会话对象
 */
export async function createSearchSession({
  indexUrl = '/search-index.json',
  fetchImpl,
  index: providedIndex,
  maxResults = DEFAULT_MAX_RESULTS,
  fuzzy = true,
  onWarning = () => {},
} = {}) {
  let index = providedIndex ?? null;
  if (!index) {
    const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) {
      onWarning(new Error('没有可用的 fetch，搜索不可用'));
      return deadSession(onWarning);
    }
    try {
      const response = await doFetch(indexUrl);
      if (!response?.ok) throw new Error(`索引请求失败：${response?.status ?? '无响应'}`);
      const json = await response.text();
      index = parseIndex(json);
      if (!index) throw new Error('索引结构不匹配（版本或字段缺失），已停用搜索');
    } catch (error) {
      // 搜索是增强，不是依赖。取不到索引就返回一个「什么都搜不到」的
      // 会话，而不是让整页脚本崩掉。
      onWarning(error);
      return deadSession(onWarning);
    }
  }

  const ready = Boolean(index);
  const categories = collectFacet(index, 'categories');
  const tags = collectFacet(index, 'tags');

  return {
    ready,
    index,
    /** 过滤器的可选项，UI 直接拿去渲染下拉框。 */
    facets: { categories, tags },
    /**
     * 执行一次查询。
     *
     * @param {string} query 用户输入原文
     * @param {object} [options] { filters, maxResults, fuzzy }
     * @returns {{results, level, total}}
     *   results[i] = { id, title, url, tags, date, excerpt, offset, matched }
     */
    query(query, options = {}) {
      const text = String(query ?? '').trim();
      if (!text) return { results: [], level: 0, total: 0 };
      const terms = analyze(text);
      // 索引感知的精确词：不依赖词典，直接从索引 words 表里认词。
      // 词典未就绪时（前端首次打开），这一步是精确检索的唯一来源 ——
      // 否则 words 表里的「博客」永远匹配不上（analyze 切不出它）。
      // 与 analyze 的结果并集，不是替换：analyze 在有词典时给出的词
      // 也在索引里（同一套规则切的），两边一致。
      const indexed = matchIndexedWords(index, text);
      for (const word of indexed.matched) {
        if (!terms.words.includes(word)) terms.words.push(word);
      }
      // phrase 让 query.js 能做「整串命中」奖励。这里传原始输入，
      // 而不是拼接 bigram —— bigram 拼不回原串。
      terms.phrase = text.toLowerCase();
      const outcome = runSearch(index, terms, {
        maxResults: options.maxResults ?? maxResults,
        fuzzy: options.fuzzy ?? fuzzy,
        filters: options.filters ?? {},
      });
      const results = outcome.results.map((entry) => decorate(index, entry, terms, text));
      return { results, level: outcome.level, total: outcome.total };
    },
    /**
     * 输入联想。从标题 + 标签 + 分类里找包含输入的子串。
     *
     * 不走倒排表：联想要的是「用户可能想搜的词」，那是索引里已有的
     * 完整词元，而子串匹配恰好表达「前缀 / 半截输入」。用倒排表做联想
     * 会返回一堆文章而不是词，那不是联想该给的东西。
     */
    suggest(input, { limit = 8 } = {}) {
      const text = String(input ?? '').trim().toLowerCase();
      if (!text) return [];
      const seen = new Set();
      const out = [];
      for (const doc of index.docs) {
        for (const candidate of [doc.title, ...(doc.tags ?? []), ...(doc.categories ?? [])]) {
          const value = String(candidate ?? '');
          if (!value || seen.has(value)) continue;
          if (!value.toLowerCase().includes(text)) continue;
          seen.add(value);
          out.push({ value, type: candidate === doc.title ? 'title' : 'tag' });
          if (out.length >= limit) return out;
        }
      }
      return out;
    },
  };
}

/** 取索引失败时的空会话：所有接口都在，只是永远返回空。 */
function deadSession(onWarning) {
  return {
    ready: false,
    index: null,
    facets: { categories: [], tags: [] },
    query: () => ({ results: [], level: 0, total: 0 }),
    suggest: () => [],
    warn: onWarning,
  };
}

/** 把倒排表的 doc 下标变成 UI 能直接用的结果对象。 */
function decorate(index, entry, terms, rawQuery) {
  const doc = index.docs[entry.doc];
  const needles = [...terms.words, ...terms.bigrams];
  const snippet = makeSnippet(doc.excerpt, needles);
  return {
    id: doc.id,
    title: doc.title,
    url: doc.url,
    tags: doc.tags ?? [],
    categories: doc.categories ?? [],
    date: doc.date,
    // 摘要可能来自 excerpt（索引里存的正文开头）。真正的「命中处摘要」
    // 需要完整正文，而正文故意没进索引（体积）。所以这里给的是
    // 「开头摘要 + 命中词位置」，UI 用 <mark> 标出命中的词。
    excerpt: snippet.excerpt,
    offset: snippet.offset,
    matched: dedupeMatched(needles, `${doc.title} ${doc.excerpt}`),
    score: entry.score,
    query: rawQuery,
  };
}

function dedupeMatched(needles, haystack) {
  const lower = String(haystack).toLowerCase();
  return [...new Set(needles.filter((n) => n && lower.includes(n.toLowerCase())))];
}

/** 收集某个 facet 的全部取值，按出现次数降序（UI 默认排序更合理）。 */
function collectFacet(index, field) {
  const counts = new Map();
  for (const doc of index.docs) {
    for (const value of doc[field] ?? []) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([value, count]) => ({ value, count }));
}
