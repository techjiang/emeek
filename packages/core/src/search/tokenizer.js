/**
 * 三类词元分词器 —— 索引与查询共用同一套 analyze()。
 *
 * 为什么是三类而不是一类：
 *   中文没有词边界。把「主题系统」切成一个词元，用户搜「主题」就命中不了；
 *   切成单字，搜「主题系统」又会因为单字组合过多而召回一堆噪声。
 *   一种粒度无法同时满足精度与召回，所以分成三档、各有各的用途：
 *
 *   words    词典词 / 英文词 / 数字串   → 精确匹配，AND 约束的主力
 *   bigrams  CJK 相邻二字              → 放宽级字面召回（搜半截词靠它）
 *   singles  CJK 单字                  → 最后兜底，不参与正常组合
 *
 * 不变量：索引与查询调用同一个 analyze()。两侧一旦分叉（比如索引多切了
 * 一层、查询没切），就会出现「明明在文中却搜不到」——这类 bug 极难定位，
 * 因为两边单独看都对。所以这里只暴露一个入口。
 */

import { isDictionaryLoaded, segmentWords } from '../ai/local/segmenter.js';

// CJK 统一表意文字 + 日文假名。与 segmenter 的范围保持一致，
// 否则「同一个字被两处分到不同类别」会造出无法复现的检索偏差。
const CJK = /[\u4e00-\u9fa5\u3040-\u30ff]/;
const CJK_RUN = /[\u4e00-\u9fa5\u3040-\u30ff]+/g;
const LATIN_RUN = /[A-Za-z0-9][A-Za-z0-9_'’-]*/g;

/**
 * 词元长度下限（CJK）。单字不产生 bigram。
 * 低于 4 个字的 CJK 词元不做 fuzzy 展开（见 query.js）——
 * 2 字词的编辑距离 1 等于换了个词，fuzzy 只会引入语义无关的结果。
 */
export const FUZZY_MIN_LENGTH = 4;

/**
 * 把文本切成三类词元。
 *
 * @param {string} text
 * @param {object} [options]
 *   dictionary  boolean  词典是否可用于分词（默认取 segmenter 的全局状态）
 * @returns {{words: string[], bigrams: string[], singles: string[]}}
 */
export function analyze(text, { dictionary = isDictionaryLoaded() } = {}) {
  const value = normalize(text);
  if (!value) return empty();

  const words = [];
  const bigrams = [];
  const singles = [];
  const seenWord = new Set();
  const seenBigram = new Set();
  const seenSingle = new Set();

  const pushWord = (word) => {
    if (!word || seenWord.has(word)) return;
    seenWord.add(word);
    words.push(word);
  };
  const pushBigram = (gram) => {
    if (!gram || seenBigram.has(gram)) return;
    seenBigram.add(gram);
    bigrams.push(gram);
  };
  const pushSingle = (char) => {
    if (!char || seenSingle.has(char)) return;
    seenSingle.add(char);
    singles.push(char);
  };

  // ── 1. 词典词 / 英文词 / 数字：能切就切，切不出（词典未就绪）就跳过 ──
  if (dictionary) {
    for (const word of segmentWords(value) ?? []) pushWord(word);
  }
  // 英文与数字不依赖词典，独立抽一遍 —— 词典没加载也要能搜英文标题。
  for (const match of value.match(LATIN_RUN) ?? []) {
    const latin = match.toLowerCase();
    if (latin.length >= 2) pushWord(latin);
  }

  // ── 2. CJK：bigram + 单字。这一层永远可用，不依赖词典。 ──
  for (const run of value.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      pushSingle(chars[i]);
      if (i + 1 < chars.length) pushBigram(chars[i] + chars[i + 1]);
    }
  }

  // ── 3. 词典词里的单字也补进 singles ──
  // 词典把「博客」当作一个词，单字层面「博」「客」仍应可兜底命中。
  // 漏掉这一步，搜单字时就只能靠 bigram 里恰好含它的那些，覆盖率不完整。
  for (const word of words) {
    if (!CJK.test(word)) continue;
    for (const char of word) pushSingle(char);
  }

  return { words, bigrams, singles };
}

/**
 * 查询用的词元：与建索引共用 analyze()，保证两侧分叉不了。
 * 单字单独取出（而不是混进 words），因为查询策略里它只在兜底层用。
 */
export function analyzeQuery(text, options) {
  return analyze(text, options);
}

function normalize(text) {
  // 全角转半角（仅 ASCII 可见区）、折叠空白。不转的话「ＢＬＯＧ」与「blog」
  // 在索引里是两个词，而用户看不出区别。
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function empty() {
  return { words: [], bigrams: [], singles: [] };
}
/**
 * 索引感知的查询词元提取 —— 不依赖词典的精确匹配路径。
 *
 * 为什么需要它：
 *   建索引时用了词典（words 表里是「博客」「静态」这样的完整词）。
 *   查询时如果词典还没加载（前端首次打开就是这种情况），
 *   拿同一个 analyze() 去切「博客」，只能切出 bigram —— 于是
 *   words 表里明明有「博客」，却永远匹配不上，精确检索形同虚设。
 *   这就是「索引与查询分叉」，而且是最隐蔽的一种：两边单独看都对。
 *
 * 解法：查询侧不依赖「重新分词」，而是**拿输入串去索引的 words 表里
 * 找已存在的词元**。用最长匹配（从长到短试），因为索引里的词是切好的，
 * 用户输入通常也是整词。这不需要词典，只需要索引自己。
 *
 * 效果：
 *   词典未就绪 → 靠索引里的词元做精确匹配（words 表是构建期切好的）
 *   词典就绪   → analyze() 与索引同源，结果一致
 *   两条路径都指向同一个 words 表，不存在「索引有、查询切不出」。
 */

/**
 * 从文本里找出所有在索引 words 表中存在的词元（最长优先）。
 *
 * @param {object} index  索引对象
 * @param {string} text   用户输入原文
 * @param {object} [options]
 *   maxLength  索引词元的最长长度上限（超出这个长度的输入不会被匹配）
 * @returns {{matched: string[], unmatched: string}} 
 *   matched   在索引里存在的词元
 *   unmatched 切剩下的残片（交给 bigram 层处理）
 */
export function matchIndexedWords(index, text, { maxLength = 8 } = {}) {
  const value = String(text ?? '').toLowerCase().trim();
  if (!value) return { matched: [], unmatched: '' };

  const table = index?.words ?? {};
  const matched = [];
  const seen = new Set();
  // 先把输入切成「CJK 段 / 非 CJK 段」，非 CJK 直接整段试表。
  const runs = value.match(/[\u4e00-\u9fa5\u3040-\u30ff]+|[^\u4e00-\u9fa5\u3040-\u30ff ]+/g) ?? [];
  const rest = [];

  for (const run of runs) {
    if (!/[\u4e00-\u9fa5\u3040-\u30ff]/.test(run)) {
      if (table[run] && !seen.has(run)) {
        seen.add(run);
        matched.push(run);
      } else {
        rest.push(run);
      }
      continue;
    }
    // CJK 段：从前往后贪心取最长匹配
    let i = 0;
    let leftover = '';
    while (i < run.length) {
      let hit = null;
      const limit = Math.min(maxLength, run.length - i);
      for (let len = limit; len >= 2; len -= 1) {
        const candidate = run.slice(i, i + len);
        if (table[candidate]) {
          hit = candidate;
          i += len;
          break;
        }
      }
      if (hit) {
        if (!seen.has(hit)) {
          seen.add(hit);
          matched.push(hit);
        }
      } else {
        leftover += run[i];
        i += 1;
      }
    }
    if (leftover) rest.push(leftover);
  }

  return { matched, unmatched: rest.join(' ') };
}
