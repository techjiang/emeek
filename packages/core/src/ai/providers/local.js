import { AIQuality, AITask, AIError, AIErrorCode } from '../types.js';
import { AIProvider, requireText } from './base.js';
import { LocalSummarizer } from '../local/summarizer.js';
import { ReadabilityAnalyzer } from '../local/readability.js';
import { LocalSEOAnalyzer } from '../local/seo.js';
import { extractKeywords } from '../local/text.js';
import { loadDictionary, loadDictionarySync, isDictionaryLoaded } from '../local/segmenter.js';

/**
 * 本地 Provider —— 离线兜底，永远可用。
 *
 * 与 LLM Provider 的接口完全一致（同样返回 AIResult），
 * 所以上层不需要写 if (offline) 分支：降级链自己会走到这里。
 *
 * `quality` 字段是刻意区分的：
 * - summarize -> medium：抽取式，能用但不精
 * - readability / seo -> high：确定性计算，比 LLM 更可信
 * - tags -> medium：TF-IDF，没有语义理解
 *
 * UI 靠这个字段决定是标「本地算法」还是打 ✨。
 */
export class LocalProvider extends AIProvider {
  constructor({ name = 'local', terminology = [], summarizer, readability, seo, dictionary, dictionaryBytes, promptsDir = null } = {}) {
    super({ name, quality: AIQuality.MEDIUM });
    // promptsDir 目前本地算法用不上（它不拼提示词），但保留这个字段是为了
    // 与 LLM Provider 的配置形状一致 —— 用户改 provider 时不必改配置结构，
    // 也不会出现「设了却被静默丢弃」的情况。
    this.promptsDir = promptsDir;
    this.summarizer = summarizer ?? new LocalSummarizer();
    this.readabilityAnalyzer = readability ?? new ReadabilityAnalyzer({ terminology });
    this.seoAnalyzer = seo ?? new LocalSEOAnalyzer();
    this.dictionaryOptions = dictionary ?? null;
    this.dictionaryBytes = dictionaryBytes ?? null;
    this.tasks = [AITask.SUMMARIZE, AITask.READABILITY, AITask.SEO, AITask.TAGS, AITask.TITLE];
  }

  /** 本地算法没有前置条件。这是整条降级链的底线。 */
  async isAvailable() {
    return true;
  }

  /**
   * 加载分词词典。
   *
   * 分词质量只影响关键词提取与术语密度，不影响摘要主体和可读性指标，
   * 所以词典缺失不是致命错误 —— 但那会让关键词退化成单字，
   * 所以要在第一次真正需要它之前加载好。
   *
   * Node 环境下用同步加载（CLI/构建期没有事件循环顾虑，少一层 await）；
   * 浏览器端传 `dictionary: { file }` 或自行调用 loadDictionary()。
   */
  async ensureDictionary() {
    if (isDictionaryLoaded()) return true;
    if (this.dictionaryBytes) {
      const { decompress } = this.dictionaryOptions ?? {};
      return loadDictionary({ file: this.dictionaryBytes, decompress });
    }
    return loadDictionary(this.dictionaryOptions ?? {});
  }

  /** 同步版，供 CLI 与构建期使用。 */
  ensureDictionarySync() {
    if (isDictionaryLoaded()) return true;
    return loadDictionarySync(this.dictionaryOptions ?? {});
  }

  async complete(input, task = AITask.SUMMARIZE, options = {}) {
    switch (task) {
      case AITask.SUMMARIZE:
        return this.summarize(input, options);
      case AITask.READABILITY:
        return this.readability(input, options);
      case AITask.SEO:
        return this.seo(input, options);
      case AITask.TAGS:
        return this.tags(input, options);
      case AITask.TITLE:
        return this.titles(input, options);
      default:
        // 续写/改写/翻译这类生成任务本地做不了，明确报错而不是给个坏结果
        throw new AIError(
          `${task} 需要 AI 模型，本地算法不提供此能力`,
          { code: AIErrorCode.UNSUPPORTED_TASK, provider: this.name },
        );
    }
  }

  async summarize(input, options = {}) {
    await this.ensureDictionary();
    const text = requireText(input, { what: '待摘要文本' });
    const { status, ...content } = this.summarizer.summarizeMulti(text);
    return this.result(content, {
      task: AITask.SUMMARIZE,
      quality: AIQuality.MEDIUM,
      meta: {
        algorithm: 'extractive-multi-feature',
        degraded: true,
        // UI 靠这个标志决定是展示摘要还是展示「内容太少」的空态
        empty: status !== 'ok',
        status,
      },
    });
  }

  async readability(input, options = {}) {
    await this.ensureDictionary();
    const text = typeof input === 'string' ? input : input;
    const analysis = this.readabilityAnalyzer.analyze(text, options);
    // 本地计算是「高可信」而不是「降级产物」—— 这是唯一一个
    // 离线结果质量高于在线的模块，quality 必须如实反映。
    return this.result(analysis, {
      task: AITask.READABILITY,
      quality: AIQuality.HIGH,
      meta: { algorithm: 'deterministic-metrics' },
    });
  }

  async seo(input, options = {}) {
    await this.ensureDictionary();
    const analysis = this.seoAnalyzer.analyze(input, options);
    return this.result(analysis, {
      task: AITask.SEO,
      quality: AIQuality.HIGH,
      meta: { algorithm: 'rule-based-checks' },
    });
  }

  /**
   * 关键词（离线版的「标签推荐」）。
   *
   * 注意没叫「标签推荐」：TF-IDF 提的是关键词，不是标签。
   * 标签需要理解「这篇文章属于哪个领域」，关键词只反映「哪些词重复得多」。
   * 名字上撒谎会让用户对结果有不切实际的期待。
   */
  async tags(input, { top = 8, existingTags = [] } = {}) {
    await this.ensureDictionary();
    const text = requireText(input, { what: '待提取关键词的文本' });
    const keywords = extractKeywords(text, { top: top * 2 });
    // 已有标签优先：站内标签一致性比新词覆盖更重要
    const existing = new Set(existingTags.map((t) => String(t).toLowerCase()));
    const preferred = keywords.filter((k) => existing.has(k.term.toLowerCase()));
    const rest = keywords.filter((k) => !existing.has(k.term.toLowerCase()));
    const merged = [...preferred, ...rest].slice(0, top).map((k) => k.term);
    return this.result(merged, {
      task: AITask.TAGS,
      quality: AIQuality.MEDIUM,
      meta: { algorithm: 'tfidf', matched_existing: preferred.length },
    });
  }

  /** 标题建议：从正文抽中心句，做成保守的模板，不发明新表述。 */
  async titles(input, { count = 5 } = {}) {
    await this.ensureDictionary();
    const text = requireText(input, { what: '待生成标题的文本' });
    const keywords = extractKeywords(text, { top: 3 }).map((k) => k.term);
    // 只取摘要的第一句当标题素材：多句拼出来的「标题」会是一段话，
    // 那不是标题，是没被裁掉的摘要。
    const summary = this.summarizer.summarize(text, 60);
    const head = (summary.split(/\n+/)[0] ?? '').replace(/[。！？….]$/, '').trim();
    const candidates = [];
    if (keywords.length >= 2) candidates.push(`${keywords[0]}与${keywords[1]}：实践与取舍`);
    if (head && [...head].length <= 40) candidates.push(head);
    if (keywords[0]) candidates.push(`${keywords[0]}：我看到的问题和做法`);
    if (keywords[0] && keywords[2]) candidates.push(`从${keywords[2]}到${keywords[0]}：一次重构记录`);
    if (keywords[0]) candidates.push(`关于${keywords[0]}，我的选择与理由`);
    return this.result([...new Set(candidates)].slice(0, count), {
      task: AITask.TITLE,
      quality: AIQuality.MEDIUM,
      meta: { algorithm: 'template', degraded: true },
    });
  }
}
