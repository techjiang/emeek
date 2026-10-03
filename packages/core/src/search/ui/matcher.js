/**
 * 搜索页客户端的匹配逻辑（纯函数，无 DOM，无 node:）。
 *
 * 这一份是**可测的**：单测直接 import 它，e2e 用它和构建期 runtime
 * 对拍。client.js（DOM 壳）不重复实现匹配 —— 它通过构建期的
 * ui/index.js 把本文件的源码内联进内联脚本。
 *
 * 为什么不复用 core/query.js + tokenizer.js：
 *   tokenizer 依赖 segmenter（400KB 词典），浏览器里内联不起。
 *   所以这里是**精简版**：不做 Viterbi 分词，只用「索引表匹配 + bigram」。
 *   完整分词留在构建期 —— 索引里的 words 表已经是切好的词，
 *   客户端只需要「拿输入去索引表里认词」。
 *
 * 与 core/query.js 的一致性由 tests/search/ui/matcher.test.js 的对拍
 * 用例保证：同一份索引、同一批查询，两边结果必须一致。
 */

/** CJK 相邻二字。 */
export function bigrams(text) {
  const out = [];
  for (const run of String(text ?? '').match(/[\u4e00-\u9fa5\u3040-\u30ff]+/g) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/**
 * 从索引的 words 表里认词（最长优先）。与 core/tokenizer.js 的
 * matchIndexedWords 同语义 —— 那一份的注释解释了为什么需要它。
 */
export function matchIndexedWords(index, text) {
  const table = (index && index.words) || {};
  const lower = String(text ?? '').toLowerCase();
  const matched = [];
  const runs = lower.match(/[\u4e00-\u9fa5\u3040-\u30ff]+|[^\u4e00-\u9fa5\u3040-\u30ff\s]+/g) || [];
  for (const run of runs) {
    if (!/[\u4e00-\u9fa5\u3040-\u30ff]/.test(run)) {
      if (table[run] && !matched.includes(run)) matched.push(run);
      continue;
    }
    let i = 0;
    while (i < run.length) {
      let hit = null;
      for (let len = Math.min(8, run.length - i); len >= 2; len -= 1) {
        const candidate = run.slice(i, i + len);
        if (table[candidate]) { hit = candidate; i += len; break; }
      }
      if (hit) { if (!matched.includes(hit)) matched.push(hit); }
      else i += 1;
    }
  }
  return matched;
}

function postingList(index, table, term) {
  const value = index?.[table]?.[term];
  return Array.isArray(value) ? value : [];
}

function union(a, b) {
  const set = new Set([...a, ...b]);
  return [...set];
}

function intersect(lists) {
  if (!lists.length) return [];
  const sorted = [...lists].sort((a, b) => a.length - b.length);
  const rest = sorted.slice(1).map((l) => new Set(l));
  return sorted[0].filter((id) => rest.every((s) => s.has(id)));
}

function allowDoc(index, id, filters) {
  if (!filters) return true;
  const doc = index.docs[id];
  if (!doc) return false;
  if (filters.category && !(doc.categories ?? []).includes(filters.category)) return false;
  if (filters.tag && !(doc.tags ?? []).includes(filters.tag)) return false;
  if (filters.from && new Date(doc.date) < new Date(filters.from)) return false;
  if (filters.to && new Date(doc.date) > new Date(filters.to)) return false;
  return true;
}

/**
 * 三级查询。语义与 core/query.js 的 search() 一致（见那边的注释）。
 *
 * @returns {{results: Array, level: number, total: number}}
 */
export function runQuery(index, rawQuery, { filters = null, maxResults = 50 } = {}) {
  const text = String(rawQuery ?? '').trim();
  if (!text || !index) return { results: [], level: 0, total: 0 };
  const words = matchIndexedWords(index, text);
  const grams = bigrams(text);
  const allow = (id) => allowDoc(index, id, filters);

  // Level 1：AND(words ∪ titleIndex)
  if (words.length) {
    const lists = words
      .map((w) => union(postingList(index, 'words', w), postingList(index, 'titleIndex', w)))
      .filter((l) => l.length);
    if (lists.length === words.length) {
      const ids = intersect(lists).filter(allow);
      if (ids.length) return finish(index, ids, text, 1, maxResults);
    }
  }

  // Level 2：OR(words + bigrams)
  const hits = new Map();
  const bump = (id, weight) => hits.set(id, (hits.get(id) ?? 0) + weight);
  for (const w of words) {
    for (const id of postingList(index, 'words', w)) if (allow(id)) bump(id, 3);
    for (const id of postingList(index, 'titleIndex', w)) if (allow(id)) bump(id, 2);
  }
  for (const g of grams) {
    for (const id of postingList(index, 'bigrams', g)) if (allow(id)) bump(id, 1);
  }
  if (hits.size) {
    const ids = [...hits.keys()].sort((a, b) => hits.get(b) - hits.get(a));
    return finish(index, ids, text, 2, maxResults);
  }

  // Level 3：子串兜底
  const needles = words.filter((w) => w.length >= 2);
  if (needles.length) {
    const ids = [];
    index.docs.forEach((doc, i) => {
      if (!allow(i)) return;
      const hay = `${doc.title} ${doc.excerpt} ${(doc.terms ?? []).join(' ')}`.toLowerCase();
      if (needles.some((n) => hay.includes(n))) ids.push(i);
    });
    if (ids.length) return finish(index, ids, text, 3, maxResults);
  }
  return { results: [], level: 0, total: 0 };
}

function finish(index, ids, query, level, maxResults) {
  const needles = [...matchIndexedWords(index, query), ...bigrams(query)];
  const results = ids.slice(0, maxResults).map((id) => {
    const doc = index.docs[id];
    return {
      id: doc.id,
      title: doc.title,
      url: doc.url,
      tags: doc.tags ?? [],
      categories: doc.categories ?? [],
      date: doc.date,
      excerpt: doc.excerpt,
      matched: needles.filter((n) => `${doc.title} ${doc.excerpt}`.toLowerCase().includes(n.toLowerCase())),
    };
  });
  return { results, level, total: ids.length };
}

/** 输入联想：标题 / 标签 / 分类里的子串匹配，最多 limit 条。 */
export function collectSuggestions(index, input, { limit = 8 } = {}) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text || !index) return [];
  const seen = new Set();
  const out = [];
  for (const doc of index.docs) {
    for (const candidate of [doc.title, ...(doc.tags ?? []), ...(doc.categories ?? [])]) {
      const value = String(candidate ?? '');
      if (!value || seen.has(value) || !value.toLowerCase().includes(text)) continue;
      seen.add(value);
      out.push({ value, type: candidate === doc.title ? 'title' : 'tag' });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
