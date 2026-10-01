/**
 * AI 层的共享契约。
 *
 * 这里只有数据形状，没有实现 —— Provider 与本地算法都必须遵守同一套接口，
 * 上层（CLI / Studio / 构建期增强）才不需要关心「结果是谁算出来的」。
 */

/** AI 任务类型。新增能力时先在这里登记，Provider 才能知道要不要接管。 */
export const AITask = Object.freeze({
  SUMMARIZE: 'summarize',
  TAGS: 'tags',
  READABILITY: 'readability',
  SEO: 'seo',
  CONTINUE: 'continue',
  REWRITE: 'rewrite',
  EXPAND: 'expand',
  CONDENSE: 'condense',
  TRANSLATE: 'translate',
  TITLE: 'title',
});

/**
 * 每个任务的能力矩阵。这是降级链路的唯一事实来源：
 * `local: false` 的任务在离线时应当明确告知用户「不可用」，而不是假装成功。
 */
export const TASK_CAPABILITIES = Object.freeze({
  [AITask.SUMMARIZE]: { local: true, label: '快速摘要', aiLabel: 'AI 摘要' },
  [AITask.TAGS]: { local: true, label: '关键词提取', aiLabel: 'AI 标签' },
  [AITask.READABILITY]: { local: true, label: '可读性分析', aiLabel: '可读性分析' },
  [AITask.SEO]: { local: true, label: 'SEO 检查', aiLabel: 'AI SEO 建议' },
  [AITask.TITLE]: { local: true, label: '标题建议', aiLabel: 'AI 标题建议' },
  [AITask.CONTINUE]: { local: false, label: null, aiLabel: 'AI 续写' },
  [AITask.REWRITE]: { local: false, label: null, aiLabel: 'AI 改写' },
  [AITask.EXPAND]: { local: false, label: null, aiLabel: 'AI 扩写' },
  [AITask.CONDENSE]: { local: false, label: null, aiLabel: 'AI 精简' },
  [AITask.TRANSLATE]: { local: false, label: null, aiLabel: 'AI 翻译' },
});

/**
 * 质量档位。
 * - `high`：确定性计算，数字可信（可读性、SEO 的结构检查）
 * - `medium`：算法近似，能用但不精（本地抽取式摘要、TF-IDF 关键词）
 * - `generative`：模型生成，最灵活也最不可控（LLM 续写/改写）
 */
export const AIQuality = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  GENERATIVE: 'generative',
});

/** AI 返回值的来源标记。UI 靠它决定显示「快速摘要」还是「AI 摘要 ✨」。 */
export const AISource = Object.freeze({
  LOCAL: 'local',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  MOCK: 'mock',
  OLLAMA: 'ollama',
});

export class AIError extends Error {
  constructor(message, { code = 'AI_ERROR', provider = null, cause } = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.provider = provider;
    if (cause) this.cause = cause;
  }
}

/** 统一的错误码，调用方按 code 分支，别去匹配 message 文本。 */
export const AIErrorCode = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UNSUPPORTED_TASK: 'UNSUPPORTED_TASK',
  INVALID_INPUT: 'INVALID_INPUT',
});

/** 归一化 Provider 返回值：允许 Provider 只返回字符串，其余字段由这里补齐。 */
export function makeAIResult(content, { source, quality = AIQuality.GENERATIVE, task = null, provider = null, meta = {} } = {}) {
  return {
    content,
    source,
    quality,
    task,
    provider: provider ?? source,
    meta,
  };
}

/**
 * 把任意输入压成纯文本。
 * local 模块只吃文本，但调用方（编辑器）手里通常是 Markdown 或 HTML，
 * 与其让每个模块各自 parse 一遍，不如在入口统一收拾干净。
 */
export function toPlainText(input) {
  if (input == null) return '';
  if (typeof input === 'object') {
    if (typeof input.raw === 'string') return input.raw;
    if (typeof input.markdown === 'string') return input.markdown;
    if (typeof input.content === 'string') return input.content;
    if (typeof input.text === 'string') return input.text;
    return String(input);
  }
  return String(input);
}
