import { AITask, AIError, AIErrorCode, AIQuality, makeAIResult, toPlainText } from '../types.js';

/**
 * Provider 基类。
 *
 * 抽象层的价值只有一个：让上层不关心「结果是谁算出来的」。
 * 所以这里刻意不定义任何 prompt 拼装逻辑 —— 那是各 Provider 自己的事，
 * 基类只负责「可用性、超时、错误归一化」这些所有 Provider 都会踩的坑。
 */
export class AIProvider {
  constructor({ name, quality = AIQuality.GENERATIVE, timeout = 30000 } = {}) {
    if (new.target === AIProvider) throw new Error('AIProvider 是抽象类，请继承后使用');
    this.name = name;
    this.quality = quality;
    this.timeout = timeout;
  }

  /** 永远返回布尔值，不抛异常 —— 调用方用它的结果决定要不要降级。 */
  async isAvailable() {
    return false;
  }

  /** 是否支持某类任务。默认全部不支持，由子类显式声明能力范围。 */
  supports(task) {
    return this.tasks?.includes(task) ?? false;
  }

  /**
   * 单轮生成。子类必须实现。
   * 返回值统一为 AIResult，即使内部只是一句字符串。
   */
  async complete(input, task = AITask.SUMMARIZE) {
    throw new AIError(`${this.name} 未实现 complete()`, { code: AIErrorCode.UNSUPPORTED_TASK, provider: this.name });
  }

  /**
   * 流式生成。默认退化为一次性返回 —— 不是所有 Provider 都值得实现真流式，
   * 但上层 UI 需要统一接口，所以给一个诚实的兜底而不是抛异常。
   */
  async *completeStream(input, task = AITask.SUMMARIZE) {
    const result = await this.complete(input, task);
    yield typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  }

  /** 包一层超时。LLM 请求挂死比报错更糟 —— 用户会以为整个编辑器卡了。 */
  async withTimeout(promise, { signal } = {}) {
    if (!this.timeout) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AIError(`${this.name} 请求超时（${this.timeout}ms）`, { code: AIErrorCode.TIMEOUT, provider: this.name })), this.timeout);
      if (timer.unref) timer.unref();
    });
    const abort = new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(new AIError('请求已取消', { code: AIErrorCode.NETWORK, provider: this.name }));
      signal.addEventListener('abort', () => reject(new AIError('请求已取消', { code: AIErrorCode.NETWORK, provider: this.name })), { once: true });
    });
    try {
      return await Promise.race([promise, timeout, abort]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 统一的错误归一化：HTTP 状态码 -> 错误码。上层按 code 分支就够了。 */
  normalizeError(error) {
    if (error instanceof AIError) return error;
    const status = error?.status ?? error?.response?.status;
    const map = {
      401: AIErrorCode.UNAUTHORIZED,
      403: AIErrorCode.UNAUTHORIZED,
      429: AIErrorCode.RATE_LIMITED,
    };
    const code = map[status] ?? (error?.name === 'AbortError' ? AIErrorCode.TIMEOUT : AIErrorCode.NETWORK);
    return new AIError(error?.message ?? `${this.name} 调用失败`, { code, provider: this.name, cause: error });
  }

  result(content, { task, quality = this.quality, meta } = {}) {
    return makeAIResult(content, { source: this.name, provider: this.name, quality, task, meta });
  }
}

/** 校验输入非空，顺手把它压成纯文本。所有 Provider 在入口都该做这一步。 */
export function requireText(input, { what = '输入内容' } = {}) {
  const text = toPlainText(input).trim();
  if (!text) throw new AIError(`${what}为空`, { code: AIErrorCode.INVALID_INPUT });
  return text;
}

