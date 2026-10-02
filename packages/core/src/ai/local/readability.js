import { clamp01, countWords, extractKeywords, hasCJK, round, splitParagraphs, splitProseParagraphs, splitSentences, stripMarkdown, tokenSet } from './text.js';

/**
 * 本地可读性分析。
 *
 * 这个模块**故意不走 AI 链路**。
 *
 * 原因很简单：LLM 会给出看起来合理但实际编造的 Flesch 分数。
 * 「可读性 72 分」这种数字如果不可复现、不可解释，它对作者就没有任何价值 ——
 * 作者改了一句话，分数该动就得动；别人拿同一篇文章算，结果该一样。
 * 本地确定性计算能做到这两点，LLM 做不到。
 *
 * 所有阈值都来自既有的可读性研究（句长 15~30 词、段落 3~6 句），
 * 中文阈值按「1 汉字 ≈ 0.6 英文词」换算过，不是把英文数字直接搬过来。
 */

/** 中文与英文的最优区间不同：中文单字信息密度更高，同样字数读起来更短。 */
const THRESHOLDS = {
  zh: { sentence: [15, 35], longSentence: 50 },
  en: { sentence: [12, 25], longSentence: 35 },
  paragraphSentences: [2, 6],
  paragraphChars: [80, 400],
  ttr: [0.4, 0.72],
  passive: 0.2,
  transition: 0.12,
};

/**
 * 中文连接词。分类是为了让「逻辑连贯性」的建议能指明缺的是哪一类，
 * 而不是笼统地说「建议加连接词」。
 */
const TRANSITIONS = {
  转折: ['然而', '但是', '但', '不过', '却', '虽然', '尽管', '反之', '另一方面'],
  因果: ['因此', '所以', '因而', '于是', '由于', '因为', '从而', '导致', '正因如此'],
  递进: ['而且', '并且', '此外', '同时', '不仅', '更', '甚至', '进而', '况且'],
  总结: ['总之', '综上', '由此可见', '最终', '归根结底', '简单说', '换言之'],
  举例: ['例如', '比如', '举例来说', '像', '以', '拿'],
  对比: ['相比', '相比之下', '而', '对应地', '同样', '反之'],
};

const TRANSITION_WORDS_EN = ['however', 'therefore', 'moreover', 'furthermore', 'thus', 'meanwhile', 'consequently', 'nevertheless', 'for example', 'in contrast', 'similarly', 'additionally', 'finally', 'in short', 'that said', 'because', 'although', 'while'];

/**
 * 被动语态模式。
 *
 * 中文的坑：
 * - 「由」要排除「由于」「由此」「由衷」—— 那三个是因果/来源连接词，不是被动
 * - 「给」要排除「给」作动词（"给你看"）的用法，所以要求后接动词性结构
 * - 「所」单独出现不算，必须和「被/由」组合
 *
 * 这些边界不处理，一篇文章的被动语态占比能虚高一倍。
 */
const PASSIVE_ZH = /(?:被(?!动)[\u4e00-\u9fa5]{1,8}|(?:由(?!于|此|衷))[\u4e00-\u9fa5]{1,8}所?|(?:受到|遭到|得到)[\u4e00-\u9fa5]{1,6})/g;
const PASSIVE_EN = /\b(?:is|are|was|were|be|been|being|get|gets|got)\s+(?:\w+ly\s+)?(\w+(?:ed|en|wn|ne|nt))\b/gi;

/**
 * 预置术语词典。
 *
 * 用「命中次数 / 总词数」估术语密度。词表刻意保持小而通用 ——
 * 大而全的词表需要维护，且对「这篇文章术语太多」的判断并不比它更准。
 * 用户可以用 config.readability.terminology 追加自己领域的词。
 */
const TERMINOLOGY = ['算法', '架构', '接口', '协议', '编译', '渲染', '索引', '缓存', '并发', '异步', '依赖', '模块', '组件', '服务', '容器', '集群', '部署', '构建', '管线', '抽象', '范式', '语义', '序列化', '范式', '拓扑', '幂等', '吞吐', '延迟', '吞吐量', '重构', '范式'];
const TERMINOLOGY_EN = ['algorithm', 'architecture', 'interface', 'protocol', 'compile', 'render', 'index', 'cache', 'concurrency', 'asynchronous', 'dependency', 'module', 'component', 'service', 'container', 'cluster', 'deploy', 'build', 'pipeline', 'abstraction', 'paradigm', 'semantics', 'serialization', 'topology', 'idempotent', 'throughput', 'latency', 'refactor'];

export class ReadabilityAnalyzer {
  constructor({ terminology = [], language = null } = {}) {
    this.terminology = [...TERMINOLOGY, ...terminology];
    this.terminologyEn = [...TERMINOLOGY_EN, ...terminology.map((t) => t.toLowerCase())];
    this.language = language;
  }

  /**
   * 主入口。
   *
   * 输入可以是 Markdown 或纯文本 —— 内部会先清洗，但从 HTML 结构里
   * 能拿到的信息（标题层级、列表、图片）在清洗前先数一遍，
   * 否则「结构化程度」这个指标就永远是 0。
   */
  analyze(input, options = {}) {
    const raw = typeof input === 'object' && input !== null ? String(input.raw ?? input.content ?? input.text ?? '') : String(input ?? '');
    const structure = analyzeStructure(raw, typeof input === 'object' ? input : {});
    const plain = stripMarkdown(raw);
    const paragraphs = splitParagraphs(plain);
    const prose = splitProseParagraphs(plain);
    const sentences = prose.flatMap((paragraph) => splitSentences(paragraph));
    const metrics = this.#metrics({ plain, paragraphs, prose, sentences, structure });
    const { score, breakdown } = this.#score(metrics);
    const suggestions = this.#suggest(metrics, syntaxBreakdown(paragraphs, sentences));

    return {
      score,
      level: level(score),
      source: 'local',
      quality: 'high',
      metrics,
      breakdown,
      suggestions,
      distribution: {
        sentence_lengths: sentences.map((s) => Math.round(sentenceLength(s))),
        paragraph_lengths: paragraphs.map((p) => [...p.replace(/\s/g, '')].length),
      },
    };
  }

  #metrics({ plain, paragraphs, prose, sentences, structure }) {
    const zhSentences = sentences.filter((s) => hasCJK(s));
    const enSentences = sentences.filter((s) => !hasCJK(s));
    const totalChars = [...plain.replace(/\s/g, '')].length;
    const totalWords = countWords(plain);

    const avgSentenceZh = zhSentences.length ? zhSentences.reduce((sum, s) => sum + sentenceLength(s, 'zh'), 0) / zhSentences.length : 0;
    const avgSentenceEn = enSentences.length ? enSentences.reduce((sum, s) => sum + sentenceLength(s, 'en'), 0) / enSentences.length : 0;

    const tokens = tokensOf(plain);
    const unique = new Set(tokens.map((t) => t.toLowerCase()));
    const ttr = tokens.length ? unique.size / tokens.length : 0;

    // 长句判定按句子自身语言选阈值，不然中文长句会被英文标准误判为正常
    const longSentences = sentences.filter((s) => hasCJK(s)
      ? sentenceLength(s, 'zh') > THRESHOLDS.zh.longSentence
      : sentenceLength(s, 'en') > THRESHOLDS.en.longSentence);

    const words = plain.split(/\s+/).filter(Boolean).join(' ');
    const passiveZh = (plain.match(PASSIVE_ZH) ?? []).length;
    const passiveEn = (words.match(PASSIVE_EN) ?? []).length;
    // 按各自语言的句子数归一，再按句子占比加权平均。
    // 直接除以总句数会让「中文长句里塞了 4 个被动」的占比超过 100%。
    const zhPassiveRatio = zhSentences.length ? Math.min(1, passiveZh / zhSentences.length) : 0;
    const enPassiveRatio = enSentences.length ? Math.min(1, passiveEn / enSentences.length) : 0;
    const passiveWeightZh = zhSentences.length / Math.max(1, sentences.length);
    const passiveRatio = zhPassiveRatio * passiveWeightZh + enPassiveRatio * (1 - passiveWeightZh);

    const termHits = this.#countTerminology(plain);
    const transitionStats = countTransitions(plain);

    return {
      total_chars: totalChars,
      total_words: totalWords,
      sentence_count: sentences.length,
      paragraph_count: paragraphs.length,
      avg_sentence_length: { zh: round(avgSentenceZh), en: round(avgSentenceEn) },
      avg_paragraph_length: {
        chars: round(paragraphs.length ? paragraphs.reduce((sum, p) => sum + [...p.replace(/\s/g, '')].length, 0) / paragraphs.length : 0),
        sentences: round(paragraphs.length ? sentences.length / paragraphs.length : 0),
      },
      ttr: round(ttr, 3),
      long_sentence_ratio: round(sentences.length ? longSentences.length / sentences.length : 0, 3),
      compound_sentence_ratio: round(compoundRatio(sentences), 3),
      passive_voice_ratio: round(passiveRatio, 3),
      terminology_density: round(totalWords ? termHits / totalWords : 0, 3),
      transition_density: round(sentences.length ? transitionStats.total / sentences.length : 0, 3),
      transition_breakdown: transitionStats.byType,
      structure_score: round(structure.score, 2),
      structure: structure.detail,
      language: this.language ?? (zhSentences.length >= enSentences.length ? 'zh' : 'en'),
      has_headings: structure.detail.headings > 0,
      list_ratio: round(structure.detail.listLines / Math.max(1, structure.detail.bodyLines), 3),
      image_count: structure.detail.images,
    };
  }

  /**
   * 综合评分。
   *
   * 权重与规格一致，但每一项都做成「区间满分 + 线性衰减」而不是
   * 硬性阈值 —— 可读性不是一个有明确及格线的量，把 28 字/句和 29 字/句
   * 判成两个档次没有意义。
   */
  #score(m) {
    const language = m.language;
    const threshold = THRESHOLDS[language === 'en' ? 'en' : 'zh'];

    // 句长适中度：中英分别用各自的最优区间，再按句子数量加权平均
    const sentenceBand = language === 'en' ? sentenceScore(m.avg_sentence_length.en, threshold.sentence)
      : sentenceScore(m.avg_sentence_length.zh, threshold.sentence);
    const sentenceScore100 = sentenceBand * 20;

    const paragraphSentencesBand = band(m.avg_paragraph_length.sentences, THRESHOLDS.paragraphSentences, [1, 12]);
    const paragraphBand = paragraphSentencesBand * 15;

    const ttrBand = band(m.ttr, THRESHOLDS.ttr, [0.15, 0.95]) * 15;
    // 句式多样性：长短句交替好 -> 长句占比在 0.1~0.3 之间最理想
    const diversityBand = band(m.long_sentence_ratio, [0.08, 0.3], [0, 0.7]) * 15;
    const passiveBand = (1 - clamp01(Math.max(0, m.passive_voice_ratio - THRESHOLDS.passive) / 0.3)) * 10;
    const transitionBand = band(m.transition_density, [THRESHOLDS.transition, 0.45], [0, 1.2]) * 15;
    const structureBand = clamp01(m.structure_score) * 10;

    const breakdown = {
      sentence_length: round(sentenceScore100, 1),
      paragraph_length: round(paragraphBand, 1),
      vocabulary_richness: round(ttrBand, 1),
      sentence_variety: round(diversityBand, 1),
      passive_voice: round(passiveBand, 1),
      transition_density: round(transitionBand, 1),
      structure: round(structureBand, 1),
    };
    const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0));
    return { score: Math.max(0, Math.min(100, score)), breakdown };
  }

  /**
   * 建议。每条都要指位置、给改法。
   *
   * 「建议优化段落长度」这种话没有价值，作者看完不知道要改哪一段。
   */
  #suggest(m, syntax) {
    const suggestions = [];
    const language = m.language;

    if (syntax.longestParagraph && syntax.longestParagraph.sentences > 6) {
      suggestions.push(`第 ${syntax.longestParagraph.index + 1} 段有 ${syntax.longestParagraph.sentences} 句，建议拆成两段（一段放观点，一段放论据或例子）。`);
    }
    if (m.avg_sentence_length.zh > THRESHOLDS.zh.sentence[1] && m.avg_sentence_length.zh > 0) {
      suggestions.push(`中文句子平均 ${m.avg_sentence_length.zh} 字，超过 35 字的舒适上限。可以把最长的几处逗号改句号，${syntax.longestSentence ? `比如「${truncateText(syntax.longestSentence, 24)}…」这句。` : '优先处理超过 50 字的句子。'}`);
    }
    if (m.avg_sentence_length.en > THRESHOLDS.en.sentence[1] && m.avg_sentence_length.en > 0) {
      suggestions.push(`英文句子平均 ${m.avg_sentence_length.en} 词，超过 25 词的舒适上限。英文长句可以拆成两句，或用分号替代从句。`);
    }
    if (m.ttr < THRESHOLDS.ttr[0] && m.total_words > 60) {
      suggestions.push(`词汇丰富度 ${m.ttr} 偏低，同一批词反复出现。${syntax.repeatedTerms.length ? `重复最多的是「${syntax.repeatedTerms.slice(0, 3).join('」「')}」，可考虑用同义表达替换部分出现。` : ''}`);
    }
    if (m.passive_voice_ratio > THRESHOLDS.passive) {
      suggestions.push(`被动语态占比 ${Math.round(m.passive_voice_ratio * 100)}%，超过 20%。被动句读起来更绕，能改成主动的地方尽量改。`);
    } else if (m.passive_voice_ratio > 0) {
      suggestions.push(`被动语态占比 ${Math.round(m.passive_voice_ratio * 100)}%，在合理范围内。`);
    }
    if (m.transition_density < THRESHOLDS.transition && m.sentence_count > 5) {
      const missing = Object.entries(m.transition_breakdown).filter(([, count]) => count === 0).map(([type]) => type);
      suggestions.push(`连接词密度 ${m.transition_density}，段落之间跳跃感可能偏强。${missing.length ? `尤其缺少${missing.slice(0, 2).join('、')}类连接词。` : ''}`);
    }
    if (!m.has_headings && m.total_words > 200) {
      suggestions.push('全文没有小标题。超过 200 字的文章建议每 2~3 段加一个##小标题，方便扫读。');
    }
    if (m.structure.images === 0 && m.total_words > 400) {
      suggestions.push('全文没有插图。长文配一张结构图或流程图，能显著降低阅读门槛。');
    }
    if (m.long_sentence_ratio > 0.35) {
      suggestions.push(`长句占比 ${Math.round(m.long_sentence_ratio * 100)}%，偏高。长短句交替会让节奏更好读。`);
    }
    if (!suggestions.length) {
      suggestions.push('各项指标都在健康区间，没有需要特别调整的地方。');
    }
    return suggestions;
  }

  #countTerminology(plain) {
    const lower = plain.toLowerCase();
    let count = 0;
    for (const term of this.terminology) count += countOccurrences(plain, term);
    for (const term of this.terminologyEn) count += countOccurrences(lower, term);
    return count;
  }
}

/** 段落 / 句子结构统计。可读性评分里「结构化程度」就靠这些数。 */
export function analyzeStructure(raw, meta = {}) {
  const lines = String(raw).split('\n');
  let headings = 0;
  let listLines = 0;
  let bodyLines = 0;
  let tableLines = 0;

  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    if (/^#{1,6}\s/.test(value)) {
      headings += 1;
      continue;
    }
    if (/^(?:[-*+]|\d+[.)])\s/.test(value)) {
      listLines += 1;
      bodyLines += 1;
      continue;
    }
    if (/^\|.*\|$/.test(value)) {
      if (!/^\|[\s:|-]+\|$/.test(value)) tableLines += 1;
      bodyLines += 1;
      continue;
    }
    if (/^```/.test(value)) continue;
    bodyLines += 1;
  }

  const images = (String(raw).match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length + (meta.cover ? 1 : 0);
  // 结构化程度：标题、列表、表格、图片各占一部分，都是「让读者少读字」的手段。
  // 分母按「这篇文章体量下够用的量」算，不是固定值 ——
  // 一个 200 字的短文有 1 个小标题就已经很结构化了，拿 3 个当满分是错的。
  const scale = bodyLines <= 12 ? 1 : bodyLines <= 40 ? 2 : 3;
  const score = clamp01(
    Math.min(headings / scale, 1) * 0.4
    + Math.min(listLines / (scale * 2), 1) * 0.25
    + Math.min(tableLines / scale, 1) * 0.15
    + Math.min(images / 1, 1) * 0.2,
  );

  return { score, detail: { headings, listLines, tableLines, images, bodyLines } };
}

function syntaxBreakdown(paragraphs, sentences) {
  const sentencesPerParagraph = paragraphs.map((p) => splitSentences(p).length);
  let longestParagraph = null;
  sentencesPerParagraph.forEach((count, index) => {
    if (count > 4 && (!longestParagraph || count > longestParagraph.sentences)) longestParagraph = { index, sentences: count };
  });

  let longestSentence = '';
  for (const sentence of sentences) {
    if (sentenceLength(sentence) > sentenceLength(longestSentence)) longestSentence = sentence;
  }

  const counts = new Map();
  for (const sentence of sentences) {
    for (const token of tokenSet(sentence)) {
      if (token.length < 2) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const repeatedTerms = [...counts.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]).map(([term]) => term);

  return { longestParagraph, longestSentence, repeatedTerms };
}

function countTransitions(text) {
  const byType = {};
  let total = 0;
  for (const [type, words] of Object.entries(TRANSITIONS)) {
    let count = 0;
    for (const word of words) count += countOccurrences(text, word);
    byType[type] = count;
    total += count;
  }
  const lower = text.toLowerCase();
  for (const word of TRANSITION_WORDS_EN) {
    const count = countOccurrences(lower, word);
    byType['英文连接词'] = (byType['英文连接词'] ?? 0) + count;
    total += count;
  }
  return { total, byType };
}

/** 句子长度：中文数「字」，英文数「词」。 */
export function sentenceLength(sentence, language = null) {
  const value = String(sentence ?? '').trim();
  const isZh = language ? language === 'zh' : hasCJK(value);
  return isZh ? [...value].length : countWords(value);
}

function sentenceScore(value, [lo, hi]) {
  if (!value) return 0.5; // 没有该语言的句子，不奖不罚
  if (value >= lo && value <= hi) return 1;
  const distance = value < lo ? lo - value : value - hi;
  const span = value < lo ? lo : hi * 1.5;
  return clamp01(1 - distance / span);
}

/**
 * 区间打分：区间内满分，区间外按到边界的距离线性衰减到 hard 边界处的 0 分。
 * 比硬阈值好在「接近最优」和「恰好最优」不会差 10 分。
 */
function band(value, ideal, hard) {
  const [lo, hi] = ideal;
  if (value >= lo && value <= hi) return 1;
  const [hardLo, hardHi] = hard;
  if (value < lo) {
    const span = lo - hardLo;
    return span <= 0 ? 0 : clamp01(1 - (lo - value) / span);
  }
  const span = hardHi - hi;
  return span <= 0 ? 0 : clamp01(1 - (value - hi) / span);
}

function compoundRatio(sentences) {
  if (!sentences.length) return 0;
  let compound = 0;
  for (const sentence of sentences) {
    // 含连接词或逗号分句，视为复合句
    if (/[，,；;]/.test(sentence) || /(?:但是|然而|虽然|因为|所以|因此|并且|而且|however|although|because|therefore)/i.test(sentence)) compound += 1;
  }
  return compound / sentences.length;
}

function level(score) {
  if (score >= 90) return '极佳';
  if (score >= 70) return '良好';
  if (score >= 50) return '一般';
  return '困难';
}

function tokensOf(text) {
  const tokens = [];
  for (const match of String(text).matchAll(/[\u4e00-\u9fa5]|[A-Za-z0-9][A-Za-z0-9'’-]*/g)) tokens.push(match[0]);
  return tokens;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function truncateText(value, limit) {
  const text = String(value).trim();
  return text.length > limit ? `${text.slice(0, limit)}` : text;
}

export { THRESHOLDS, TRANSITIONS };
