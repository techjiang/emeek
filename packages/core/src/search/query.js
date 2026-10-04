/**
 * 查询策略链：精确 AND → 宽 OR → 兜底子串。
 *
 * 为什么要分三级而不是一个打分公式：
 *   中文查询的「精确」与「召回」是冲突的。用户输入「主题系统」时，
 *   他希望的是「同时包含主题和系统的文章」（AND），而不是
 *   「包含主题或包含系统的文章」（OR）—— 后者会把「系统设计」这类
 *   只有一半相关的文章排到前面。
 *   但如果 AND 一个都命中不了（比如用户搜的词库里没有），
 *   直接返回空就是「搜不到 = 内容不存在」这句里最糟的那种失败。
 *   所以要有一条降级链，每一级都明确知道自己在牺牲什么。
 *
 * 三级依次是：
 *   Level 1  AND(words)          高精度。词典词同时命中。
 *   Level 2  OR(words + bigrams) 字面召回。半截词靠 bigram 捞回来。
 *   Level 3  子串扫描             最后手段。上面都空才走，能扫出
 *                                「词库里没有但正文确实含」的情况。
 *
 * 关键约束：AND 只用 words，绝不用 bigrams。
 *   「主题系统」的 bigram 包含「题系」。如果把 bigram 也放进 AND，
 *   就等于要求正文里「主题」和「系统」必须紧挨着写成「题系」——
 *   而正常写法里它们根本不构成那个 bigram，结果是漏掉本该命中的文章。
 */

import { FUZZY_MIN_LENGTH } from './tokenizer.js';

/** 默认返回条数。 */
export const DEFAULT_MAX_RESULTS = 10;

/**
 * 执行查询。
 *
 * @param {object} index     parseIndex 读回的索引
 * @param {{words,bigrams,singles}} terms  查询词元（由 tokenizer.analyze 产出）
 * @param {object} [options]
 *   maxResults  默认 10
 *   fuzzy       是否对 ≥4 字 CJK 词元做编辑距离 1 展开，默认 true
 *   filters     { categories, tags, from, to }，在打分前把候选集缩掉
 * @returns {{results: Array, level: number, total: number}}
 */
export function search(index, terms, {
  maxResults = DEFAULT_MAX_RESULTS,
  fuzzy = true,
  filters = {},
} = {}) {
  const query = normalizeTerms(terms);
  if (!query.all.length) return { results: [], level: 0, total: 0 };

  const allowed = filterDocs(index, filters);

  for (const level of [1, 2, 3]) {
    const results = runLevel(index, query, level, { allowed, fuzzy, maxResults });
    if (results.length) {
      return { results: results.slice(0, maxResults), level, total: results.length };
    }
  }
  return { results: [], level: 0, total: 0 };
}

/**
 * 单级查询。导出是为了让测试能分别钉住每一级的行为 ——
 * 「策略链整体能返回结果」和「第 2 级确实做了 OR」是两件事。
 */
export function runLevel(index, terms, level, { allowed = null, fuzzy = true, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const query = normalizeTerms(terms);
  if (level === 1) return levelAnd(index, query, allowed);
  if (level === 2) return levelOr(index, query, { allowed, maxResults, fuzzy });
  if (level === 3) return levelSubstring(index, query, allowed);
  return [];
}

// ── Level 1：AND(words) ───────────────────────────────────────────
function levelAnd(index, query, allowed) {
  if (!query.words.length) return [];
  // 每个查询词的候选集 = 正文倒排(words) ∪ 标题/标签倒排(titleIndex)。
  //
  // 必须并上 titleIndex：标题里含「博客」而正文不含的文章（很常见的
  // 情况 —— 标题就是关键词，正文在讲别的东西），如果只查 words 表，
  // 它就永远不会被搜到。而「搜得到标题」恰恰是用户在搜索框里最期待的。
  const lists = query.words
    .map((word) => union(
      postingList(index, 'words', word),
      postingList(index, 'titleIndex', word),
    ))
    // 有一个词在任何一张表里都查不到 → 交集必为空。
    // 这不是优化，是语义：AND 要求所有词都命中。
    .filter((list) => list.length);
  if (lists.length !== query.words.length) return [];

  // 从最短的候选集开始求交，交集运算量最小。
  lists.sort((a, b) => a.length - b.length);
  let acc = [...lists[0]];
  for (let i = 1; i < lists.length && acc.length; i += 1) {
    const set = new Set(lists[i]);
    acc = acc.filter((id) => set.has(id));
  }
  return acc
    .filter((d) => allowed === null || allowed.has(d))
    .map((d) => scoreDoc(index, d, query, 1))
    .sort(byScoreThenDate(index));
}

/** 两个 posting list 的并集（去重、保持升序）。 */
function union(a, b) {
  if (!a.length) return [...b];
  if (!b.length) return [...a];
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i += 1; j += 1; }
    else if (a[i] < b[j]) { out.push(a[i]); i += 1; }
    else { out.push(b[j]); j += 1; }
  }
  while (i < a.length) { out.push(a[i]); i += 1; }
  while (j < b.length) { out.push(b[j]); j += 1; }
  return out;
}

// ── Level 2：OR(words + bigrams) ──────────────────────────────────
function levelOr(index, query, { allowed, maxResults, fuzzy = true }) {
  const hits = new Map();
  // 词典词权重高于 bigram：精确命中「主题」比命中「题系」更有说服力。
  accumulate(index, 'words', query.words, 3, hits, allowed);
  accumulate(index, 'titleIndex', query.words, 2, hits, allowed);
  accumulate(index, 'bigrams', query.bigrams, 1, hits, allowed);

  // fuzzy 展开：只在 ≥4 字 CJK 词元上做，且展开出的变体只查倒排表里
  // 真实存在的键（不存在就没有 posting，自然不产生命中）。
  // 这一层是「手误容忍」，不该压过精确命中 —— 权重给 1，与 bigram 同级。
  if (fuzzy) {
    const variants = [];
    for (const word of query.words) variants.push(...expandFuzzy(word));
    accumulate(index, 'words', variants, 1, hits, allowed);
  }
  if (!hits.size) return [];

  let candidates = [...hits.keys()];
  // 候选过多的场景（单字级别的宽查询），先按命中项数粗筛，
  // 避免对上千个文档做摘要计算 —— 那才是真正的性能瓶颈。
  if (candidates.length > maxResults * 20) {
    candidates = candidates
      .sort((a, b) => hits.get(b).hit - hits.get(a).hit)
      .slice(0, maxResults * 20);
  }
  return candidates
    .map((d) => {
      const extra = hits.get(d);
      const scored = scoreDoc(index, d, query, 2);
      scored.hit = extra.hit;
      scored.score += extra.weight;
      return scored;
    })
    .sort(byScoreThenDate(index));
}

// ── Level 3：子串扫底 ─────────────────────────────────────────────
function levelSubstring(index, query, allowed) {
  // 兜底只用 words（含 CJK 单字拼成的整串）与 singles，
  // 不拿 bigram 当针 —— 二字组合能匹配到的东西太多，等于退化成全表扫描。
  const needles = [...query.words].filter((w) => w.length >= 2);
  if (!needles.length) return [];
  const results = [];
  index.docs.forEach((doc, i) => {
    if (allowed !== null && !allowed.has(i)) return;
    const haystack = `${doc.title} ${doc.excerpt} ${doc.terms.join(' ')}`.toLowerCase();
    if (needles.some((n) => haystack.includes(n))) {
      results.push(scoreDoc(index, i, query, 3));
    }
  });
  return results.sort(byScoreThenDate(index));
}

// ── 打分 ──────────────────────────────────────────────────────────
function scoreDoc(index, docIndex, query, level) {
  const doc = index.docs[docIndex];
  const head = `${doc.title} ${(doc.tags ?? []).join(' ')} ${(doc.categories ?? []).join(' ')}`.toLowerCase();
  let score = 0;

  for (const word of query.words) {
    if (head.includes(word)) score += 10;         // 标题/标签命中，最强信号
    if (postingHas(index, 'words', word, docIndex)) score += 4;
  }
  for (const gram of query.bigrams) {
    if (postingHas(index, 'bigrams', gram, docIndex)) score += 1;
  }
  // 标题命中已在上面按 head.includes 加过 10 分；这里不再读 titleIndex，
  // 否则同一件事被计两次，标题文章的分会被抬得过高，挤掉正文更相关的。
  // 整串命中给一个额外奖励：搜「主题系统」时，正文里真的出现这四连字
  // 的文章应当排在只是分别命中「主题」「系统」的文章前面。
  if (query.phrase && head.includes(query.phrase)) score += 12;
  if (query.phrase && index.docs[docIndex]?.terms?.some((t) => t.includes(query.phrase))) score += 6;

  // 级别系数：AND 命中的结果天然比 OR 命中的可信，同级内再按上面的分排。
  score += (4 - level) * 2;

  return { doc: docIndex, score };
}

function byScoreThenDate(index) {
  return (a, b) => b.score - a.score
    || new Date(index.docs[b.doc]?.date ?? 0) - new Date(index.docs[a.doc]?.date ?? 0);
}

// ── 倒排表读取 ────────────────────────────────────────────────────
function postingList(index, table, term) {
  const value = index?.[table]?.[term];
  return Array.isArray(value) ? value : [];
}

function postingHas(index, table, term, docIndex) {
  return postingList(index, table, term).includes(docIndex);
}

function accumulate(index, table, terms, weight, hits, allowed) {
  for (const term of terms) {
    for (const docIndex of postingList(index, table, term)) {
      if (allowed !== null && !allowed.has(docIndex)) continue;
      const entry = hits.get(docIndex) ?? { hit: 0, weight: 0 };
      entry.hit += 1;
      entry.weight += weight;
      hits.set(docIndex, entry);
    }
  }
}

// ── 过滤器 ────────────────────────────────────────────────────────
/**
 * 把过滤器变成候选下标集合。
 *
 * 过滤器在打分**之前**生效：被过滤掉的文档不该参与排序，也不该
 * 影响 total。否则用户会看到「共 12 条，显示 3 条」这种自相矛盾的数字。
 */
export function filterDocs(index, { categories = [], tags = [], from, to } = {}) {
  const hasCategory = categories.length > 0;
  const hasTag = tags.length > 0;
  const hasDate = Boolean(from || to);
  if (!hasCategory && !hasTag && !hasDate) return null;

  const catSet = new Set(categories.map((c) => String(c).toLowerCase()));
  const tagSet = new Set(tags.map((t) => String(t).toLowerCase()));
  const allowed = new Set();
  index.docs.forEach((doc, i) => {
    if (hasCategory && !(doc.categories ?? []).some((c) => catSet.has(String(c).toLowerCase()))) return;
    if (hasTag && !(doc.tags ?? []).some((t) => tagSet.has(String(t).toLowerCase()))) return;
    if (hasDate) {
      const time = new Date(doc.date).getTime();
      if (from && time < new Date(from).getTime()) return;
      if (to && time > new Date(to).getTime()) return;
    }
    allowed.add(i);
  });
  return allowed;
}

// ── 词元规范化 ────────────────────────────────────────────────────
function normalizeTerms(terms) {
  const words = dedupe(terms?.words ?? []);
  const bigrams = dedupe(terms?.bigrams ?? []);
  const singles = dedupe(terms?.singles ?? []);
  // phrase：把查询里的中文串接起来，用于整串奖励。
  // 用 bigram 无法重建原串（bigram 丢了首尾信息），所以这里接受调用方
  // 通过 terms.phrase 传入原文；没有就不做整串奖励，不影响正确性。
  return { words, bigrams, singles, phrase: terms?.phrase ?? '', all: [...words, ...bigrams, ...singles] };
}

function dedupe(list) {
  return [...new Set(list.map((item) => String(item)).filter(Boolean))];
}

/**
 * 对 ≥4 字的 CJK 词元做编辑距离 1 展开。
 *
 * 为什么阈值定在 4：2 字词的编辑距离 1 覆盖了「绝大多数字都不同」的情况
 * （「博客」→「博弈」只差一个字），展开等于把无关结果当命中。
 * 4 字以上时，编辑距离 1 通常只错一个字，是真实的手误场景。
 */
export function expandFuzzy(term, { maxDistance = 1 } = {}) {
  const chars = [...String(term ?? '')];
  if (chars.length < FUZZY_MIN_LENGTH) return [];
  if (!/^[\u4e00-\u9fa5]+$/.test(term)) return [];
  const variants = new Set();
  for (let i = 0; i < chars.length; i += 1) {
    // 删除一个字符
    variants.add([...chars.slice(0, i), ...chars.slice(i + 1)].join(''));
  }
  variants.delete(term);
  return [...variants].filter((v) => v.length >= 2).slice(0, maxDistance * chars.length);
}
