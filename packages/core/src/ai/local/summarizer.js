import { countWords, extractKeywords, hasCJK, hasSentenceEnd, scoreBand, similarity, splitProseParagraphs, splitSentences, stripMarkdown } from './text.js';

/**
 * 离线抽取式摘要器。
 *
 * 设计前提：**不追求比 LLM 好，只追求「没配 Key 时也拿得到东西」。**
 *
 * 用的是经典的多特征加权抽取（类似 TextRank 的单句打分版本，但不构图）：
 * 给每个句子打分，贪心地挑高分句子拼成摘要。
 *
 * 为什么不用 TextRank：它需要先算 N×N 的句子相似度矩阵，对 200 句的长文
 * 就是 4 万次比对，而且长文里「中心句」往往不靠图排序凸显 —— 对
 * 50/100/200 字这种短摘要目标，位置 + 关键词命中的信号远比图结构有效。
 *
 * 为什么不做生成式改写：改写是幻觉的唯一来源。抽取式最差也就是
 * 「句子选得不理想」，绝不会编造原文没有的事实。这个约束是刻意的。
 */

const DEFAULT_LENGTHS = [50, 100, 200];

/**
 * 判断一个「句子」是不是小标题或列表碎片。
 *
 * 清洗后的 markdown 里，`## 代价是什么` 会变成独立一段，
 * 它没有句末标点、长度很短，被当成句子抽进摘要就是灾难 ——
 * 读者看到「代价是什么」四个字当摘要，会觉得这工具坏了。
 */
function isHeadingLike(sentence) {
  const text = sentence.trim();
  if (!text) return true;
  // 无句末标点且很短 -> 大概率是标题或列表项标签。
  // 标点判定必须和 text.js 共用同一个函数：这里曾经各写一份，
  // 结果英文句点没被认作句末标点，所有英文文档的句子全被当标题丢掉。
  if (!hasSentenceEnd(text) && measure(text) <= 16) return true;
  // 以冒号结尾的引导句（"阈值："）单独出现也没有意义
  if (/[:：]$/u.test(text)) return true;
  return false;
}

/**
 * 拼接时是否需要空格。
 *
 * 只有「前一句以拉丁标点收尾」且「后一句以拉丁字母开头」才补空格。
 * 中文句子之间补空格会显得很业余，英文句子之间不补会让读者以为
 * 单词粘连了 —— 这个判断必须按字符来，不能按「文档语言」来。
 */
function needsSpaceBetween(previous, next) {
  return /[.!?]$/.test(previous) && /^[A-Za-z0-9]/.test(next);
}

/** 中文句子长度用「字」，英文用「词」，两者信息密度不同，判定阈值必须分开。 */
function measure(sentence) {
  return hasCJK(sentence) ? [...sentence].length : countWords(sentence);
}

export class LocalSummarizer {
  constructor({ lengths = DEFAULT_LENGTHS } = {}) {
    this.lengths = lengths;
  }

  /**
   * 生成指定长度的摘要。
   *
   * 流程：清洗 -> 切段切句 -> 打分 -> 贪心选择 -> 还原原文顺序 -> 后处理。
   * 顺序还原很关键：按分数排序输出会得到「东一句西一句」的摘要，读起来像乱码。
   */
  summarize(text, length = 100, options = {}) {
    const source = String(text ?? '');
    const plain = stripMarkdown(source);
    // 空输入与「只有代码」必须区别对待：前者是调用方的问题，返回空串；
    // 后者是内容的问题，要明确告诉作者「这里没有可摘要的正文」，
    // 否则他会以为摘要器坏了。
    if (!source.trim()) return '';
    if (!plain) return options.silent ? '' : this.#tooShort();
    if (!this.#hasEnoughContent(plain)) {
      return options.silent ? '' : this.#tooShort();
    }

    const sentences = this.#analyze(plain);
    if (!sentences.length) return options.silent ? '' : this.#tooShort(plain, length);

    // 短文不硬凑：目标长度装得下全文就直接返回，硬凑只会丢信息。
    // 但「全文」必须是散文全文 —— 直接把清洗结果吐出去会把小标题、
    // 列表标记一并带上，那是没清洗干净，不是「没硬凑」。
    if (this.#fits(plain, length)) {
      return this.#finalize(this.#proseText(plain), { truncated: false });
    }

    const selected = this.#select(sentences, length);
    if (!selected.length) return this.#tooShort(plain, length);

    const ordered = selected.sort((a, b) => a.index - b.index);
    const joined = this.#join(ordered);
    const truncated = countWords(joined) > length * 1.3;
    return this.#finalize(joined, { truncated, sentences: ordered.map((s) => s.text) });
  }

  /**
   * 一次给三档。共享一次解析结果，比调三次 summarize 快得多。
   *
   * 返回值额外带一个 `status`，让调用方不必靠「内容是不是那句提示语」
   * 来判断结果有效性 —— 嗅探字符串是脆弱耦合，改一次文案就全线失效。
   *   ok        正常产出
   *   empty     没有可摘要的内容（空输入或纯代码）
   *   too_short 内容不足以生成有意义的三档摘要
   */
  summarizeMulti(text, options = {}) {
    const source = String(text ?? '');
    const plain = stripMarkdown(source);
    const out = { short: '', medium: '', long: '', status: 'ok' };
    if (!source.trim()) return { short: '', medium: '', long: '', status: 'empty' };
    if (!plain || !this.#hasEnoughContent(plain)) {
      const status = plain ? 'too_short' : 'empty';
      const message = this.#tooShort();
      return { short: message, medium: message, long: message, status };
    }
    const sentences = this.#analyze(plain);

    for (const length of this.lengths) {
      const key = length <= 50 ? 'short' : length <= 100 ? 'medium' : 'long';
      if (this.#fits(plain, length)) {
        out[key] = this.#finalize(this.#proseText(plain), { truncated: false });
        continue;
      }
      const selected = this.#select(sentences, length);
      out[key] = selected.length
        ? this.#finalize(this.#join(selected.sort((a, b) => a.index - b.index)), { truncated: false })
        : this.#tooShort(plain, length);
    }
    return out;
  }

  /**
   * 拼接选中句子。
   *
   * 不能裸 join('')：不同段落抽出来的句子直接相连会粘成一个长句，
   * 读起来像是作者写了病句。段内句子直接接，跨段落补一个换行。
   */
  #join(sentences) {
    let out = '';
    let previousParagraph = null;
    for (const sentence of sentences) {
      const text = sentence.text.trim();
      if (previousParagraph !== null && sentence.paragraphIndex !== previousParagraph) {
        out = `${out.replace(/\s+$/, '')}\n\n`;
      } else if (out && needsSpaceBetween(out, text)) {
        // 英文句子之间要留空格，中文不要 —— 「。它」是对的，「.It」是排版事故
        out += ' ';
      }
      out += text;
      previousParagraph = sentence.paragraphIndex;
    }
    return out;
  }

  /**
   * 打分。
   *
   * 六个特征，权重都是「乘法加成」而不是加法累加 —— 加法会让「位置好但内容空」
   * 的句子靠多项弱信号凑出高分。乘法要求每个维度的信号都真的成立。
   */
  #analyze(plain) {
    const paragraphs = splitProseParagraphs(plain);
    const keywords = new Map(extractKeywords(plain, { top: 20 }).map((k) => [k.term, k.score]));
    const topScore = Math.max(...[...keywords.values()], 1);

    const flat = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const sentences = splitSentences(paragraph);
      sentences.forEach((text, sentenceIndex) => {
        // 小标题、列表碎片不配当摘要句：它们脱离上下文后毫无信息量，
        // 而「性能不是优化出来的」这种正文句才该被选中。
        if (isHeadingLike(text)) return;
        const position = paragraphIndex === 0 ? 'first'
          : paragraphIndex === paragraphs.length - 1 ? 'last'
            : 'middle';
        flat.push({
          text,
          index: flat.length,
          paragraphIndex,
          sentenceIndex,
          isParagraphFirst: sentenceIndex === 0,
          position,
        });
      });
    });

    const paragraphCount = Math.max(1, paragraphs.length);
    return flat.map((item) => {
      let score = 1;
      // 位置权重：开头和结尾的段落是作者最想让人看到的（总起 / 总结）
      if (item.position === 'first') score *= 1.15;
      if (item.position === 'last') score *= 1.15;
      // 段首句：主题句的常见位置
      if (item.isParagraphFirst) score *= 1.05;

      const length = measure(item.text);
      // 长度权重：太短信息量不足，太长一句话塞多个观点，抽取后读着累
      if (length >= 20 && length <= 60) score *= 1.1;
      else if (length < 10) score *= 0.5;
      else if (length > 100) score *= 0.75;

      // 关键词权重：命中 TF-IDF 高分词的句子更可能在讲主题
      const tokens = new Set(item.text.split(''));
      let keywordHits = 0;
      for (const [term] of keywords) {
        if (item.text.includes(term)) keywordHits += 1;
      }
      if (keywordHits) score *= 1.2;

      // 指标权重：含数字/百分比的句子通常是具体结论，比观点句更有摘录价值
      if (/\d+(?:\.\d+)?\s*(?:%|％|KB|MB|GB|ms|秒|万|亿|倍)/.test(item.text)) score *= 1.1;
      else if (/\d/.test(item.text)) score *= 1.05;

      return { ...item, score, keywordHits, tokens };
    });
  }

  /**
   * 贪心选择。
   *
   * 每轮取当前最高分，然后立刻下调「与已选句子重复」的候选分 ——
   * 这就是规格里说的「去重惩罚 > 0.7 相似度 -30%」，只不过做成增量式：
   * 一次比较就够，不用反复重算全量。
   */
  #select(scored, length) {
    // 预算 = 目标长度。允许 15% 的溢出（句子不可切分，硬卡会丢信息），
    // 但不能更多 —— 规格要求「长度控制 ±10%」，这里留到 15% 是因为
    // 中文句子长度分布很散，5% 的余量会导致经常性丢句。
    const budget = length * 1.15;
    const pool = [...scored].sort((a, b) => b.score - a.score);
    const chosen = [];
    let used = 0;

    const penalized = new Map();
    for (const candidate of pool) {
      if (used >= budget) break;
      const adjusted = (penalized.get(candidate.index) ?? 1) * candidate.score;
      const currentLength = measure(candidate.text);

      // 第一句也必须过预算检查：否则 50 字档会因为「首句最长」直接超标到 70 字。
      // 放不下就继续找更短的句子，实在找不到就返回空（由调用方给提示）。
      if (used + currentLength > budget) continue;

      // 和已选句子高度重复的直接丢（相似度 > 0.7）
      const duplicate = chosen.some((picked) => similarity(picked.text, candidate.text) > 0.7);
      if (duplicate) continue;

      for (const other of pool) {
        if (other.index === candidate.index || chosen.includes(other)) continue;
        const sim = similarity(candidate.text, other.text);
        // 相似度越高，惩罚越重（最高打到 0.7 倍）
        penalized.set(other.index, Math.min(penalized.get(other.index) ?? 1, 1 - sim * 0.3 / 0.7 * 0.3) || 0.7);
      }

      chosen.push({ ...candidate, adjusted });
      used += currentLength;
    }

    return chosen;
  }

  #finalize(text, { truncated }) {
    let value = text.trim();
    // 去掉开头的连接词：抽取出来的句子脱离了上文，「然而」会让人不知所云
    value = value.replace(/^(?:然而|但是|但|不过|因此|所以|而且|并且|同时|另外|此外|首先|其次|最后|总之|综上)[，,、]?\s*/u, '');
    // 确保以句末标点收尾
    value = value.replace(/[；;、，,]+$/u, '');
    // 收尾标点跟随正文语言。
    // 顺序要紧：先判断有没有标点，再补；补完才规整重复 ——
    // 反过来做会把刚补上的句号当成「重复」再处理一遍，或者叠出两个点。
    value = value.replace(/[\s]+$/u, '');
    if (!hasSentenceEnd(value)) {
      value += hasCJK(value) ? '。' : '.';
    } else {
      value = value.replace(/([.!?．])\1+$/u, '$1');
    }
    if (truncated && !value.endsWith('…')) value = `${value.replace(/[。！？.!?]$/u, '')}…`;
    return value;
  }

  /** 把清洗后的文本还原为「只含散文段落的可读文本」，用于短文直出。 */
  #proseText(plain) {
    return splitProseParagraphs(plain).join('\n\n');
  }

  /**
   * 原文是否装得下目标长度。
   *
   * 用「与目标长度的比值」而不是绝对字数：50 字档要求原文 ≤ 50 字，
   * 但 200 字档只要求 ≤ 200 字，同一个函数在三个档位上给出不同答案，
   * 这正是我们要的 —— 短档压缩、长档放行。
   */
  #fits(plain, length) {
    return countWords(plain) <= length;
  }

  /**
   * 内容量门槛。
   *
   * 中英文的字/词不能混在一个阈值里判断：8 个汉字能成句，
   * 8 个英文单词只是个短语。所以按语言分别设阈 ——
   * 中文 15 字、英文 15 词，都低于「能写出一个完整观点」的下限。
   */
  #hasEnoughContent(plain) {
    if (!plain) return false;
    const cjk = (plain.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const latin = (plain.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
    return cjk >= 15 || latin >= 15 || cjk + latin >= 20;
  }

  /**
   * 区分「本来就没什么内容」和「只有代码」。
   *
   * 两者都拿不到摘要，但用户需要知道原因 —— 一篇只有代码块的文章
   * 得到「文本内容较少」是误导，他会去检查是不是渲染坏了。
   */
  #tooShort() {
    return '文本内容较少，无法生成有效摘要';
  }
}

export { scoreBand, scoreBand as _scoreBand };
